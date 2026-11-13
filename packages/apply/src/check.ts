// The apply job's check, before it gets a write token: result.json and the git bundle against the rules of
// docs/result.md, in a fresh checkout of the repository. The workflow decides the issue, the playbook and the base
// commit; the agent's output decides none of them.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { git, GitError, isAncestor, resolve } from './git'
import type { Git } from './git'
import { checkPaths } from './paths'
import type { Violation } from './paths'
import { LIMITS, parseResult } from './result'
import type { AgentResult } from './result'

export const BUNDLE_LIMITS = { bytes: 50_000_000, commits: 50 }

/** The ref the bundle's commits are fetched to in the checkout. */
export const HEAD_REF = 'refs/c8y-ui-apply/head'

export class UsageError extends Error {}

export interface CheckOptions {
  /** The fresh checkout, with the history of the default branch (and of the agent branch, if it exists). */
  dir: string
  resultFile: string
  /** The agent's git bundle; a run without commits has none. */
  bundleFile?: string
  /** The commit the agent started from: the default branch, or the agent branch in a rework round. */
  base: string
  defaultBranch: string
  /** Where the default branch is in the checkout (default `origin/<defaultBranch>`). */
  defaultRef?: string
  /** The issue or pull request the run is for. */
  number: number
  playbook: string
  /**
   * The playbook's result, from its resolution in the workflow (`c8y-ui-apply playbook`): `comment` allows no pull
   * request. Without it, both are allowed.
   */
  playbookResult?: 'pull-request' | 'comment'
}

export interface CheckReport {
  ok: boolean
  violations: Violation[]
  result?: AgentResult
  /** `agent/<number>-<playbook>`. */
  branch: string
  base: string
  /** The bundle's commit, fetched to HEAD_REF. */
  head?: string
  commits: number
  /** Every path the commits add, change, or delete. */
  files: string[]
}

export const PLAYBOOK = /^[a-z0-9][a-z0-9-]{0,39}$/

export function branchName(number: number, playbook: string): string {
  return `agent/${number}-${playbook}`
}

function validate(options: CheckOptions): void {
  if (!Number.isSafeInteger(options.number) || options.number < 1)
    throw new UsageError(`the issue or pull request number must be a positive integer, not ${options.number}`)
  if (!PLAYBOOK.test(options.playbook))
    throw new UsageError(`the playbook must be a lowercase name, not ${JSON.stringify(options.playbook)}`)
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.base))
    throw new UsageError(`the base must be a full commit id, not ${JSON.stringify(options.base)}`)
  if (!/^[\w./-]+$/.test(options.defaultBranch) || options.defaultBranch.startsWith('-'))
    throw new UsageError(`invalid default branch ${JSON.stringify(options.defaultBranch)}`)
  if (options.playbookResult !== undefined && options.playbookResult !== 'pull-request' && options.playbookResult !== 'comment')
    throw new UsageError(`the playbook result must be pull-request or comment, not ${JSON.stringify(options.playbookResult)}`)
}

/** `protect` of `.c8y-agent/config.yml` on the default branch: the agent's commits cannot change it. */
function protectList(run: Git, defaultRef: string, violations: Violation[]): string[] {
  const source = run(['show', `${defaultRef}:.c8y-agent/config.yml`], { allowFail: true })
  if (!source)
    return []
  let config: unknown
  try {
    config = parseYaml(source)
  }
  catch (error) {
    violations.push({ rule: 'config', file: '.c8y-agent/config.yml', message: `.c8y-agent/config.yml on ${defaultRef} is not valid YAML, so its protect list cannot be read: ${(error as Error).message.split('\n')[0]}` })
    return []
  }
  const protect = (config as { protect?: unknown } | null)?.protect
  if (protect === undefined || protect === null)
    return []
  if (!Array.isArray(protect) || protect.some(p => typeof p !== 'string' || p.trim() === '')) {
    violations.push({ rule: 'config', file: '.c8y-agent/config.yml', message: 'protect in .c8y-agent/config.yml must be a list of paths' })
    return []
  }
  return protect as string[]
}

/** Workspace package globs on the default branch, for the lockfile rule; none when unreadable (the stricter rule). */
function workspaceGlobs(run: Git, defaultRef: string): string[] {
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  const globs: string[] = []
  try {
    globs.push(...strings((parseYaml(run(['show', `${defaultRef}:pnpm-workspace.yaml`], { allowFail: true })) as { packages?: unknown } | null)?.packages))
  }
  catch {}
  try {
    const workspaces = (JSON.parse(run(['show', `${defaultRef}:package.json`], { allowFail: true }) || '{}') as { workspaces?: unknown }).workspaces
    globs.push(...strings(Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages))
  }
  catch {}
  return globs
}

/** Commit message directives that make GitHub Actions skip the push's workflows. */
const SKIP_CI = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks:\s*true\s*$/im

/**
 * Every path any of the commits adds, changes, or deletes, sorted: a file added in one commit and removed in the next
 * still counts, because a rebase merge keeps both commits. Gitlinks count even if .gitmodules says `ignore = all`.
 */
function changedPaths(run: Git, base: string, head: string): string[] {
  const paths = new Set<string>()
  for (const commit of run(['rev-list', '--reverse', `${base}..${head}`]).trim().split('\n').filter(Boolean)) {
    const names = run(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', '--ignore-submodules=none', commit])
    for (const path of names.split('\0').filter(Boolean))
      paths.add(path)
  }
  return [...paths].sort()
}

function fetchBundle(run: Git, file: string, violations: Violation[]): string | undefined {
  const size = statSync(file).size
  if (size > BUNDLE_LIMITS.bytes) {
    violations.push({ rule: 'bundle', message: `the bundle has ${size} bytes, at most ${BUNDLE_LIMITS.bytes}` })
    return undefined
  }
  try {
    run(['bundle', 'verify', '--quiet', file])
  }
  catch (error) {
    violations.push({ rule: 'bundle', message: `the bundle does not apply to this repository: ${(error as Error).message}` })
    return undefined
  }
  const heads = run(['bundle', 'list-heads', file]).trim().split('\n').filter(Boolean)
  if (heads.length !== 1) {
    violations.push({ rule: 'bundle', message: `the bundle must have one head, not ${heads.length}` })
    return undefined
  }
  const [, ref] = heads[0]!.split(' ')
  run(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--force', file, `${ref}:${HEAD_REF}`])
  return resolve(run, HEAD_REF)
}

export function check(options: CheckOptions): CheckReport {
  validate(options)
  const run = git(options.dir)
  const branch = branchName(options.number, options.playbook)
  const defaultRef = options.defaultRef ?? `origin/${options.defaultBranch}`
  const violations: Violation[] = []
  const report = (extra: Partial<CheckReport>): CheckReport =>
    ({ ok: violations.length === 0, violations, branch, base: options.base, commits: 0, files: [], ...extra })

  let result: AgentResult | undefined
  const resultStat = statSync(options.resultFile, { throwIfNoEntry: false })
  if (!resultStat?.isFile()) {
    violations.push({ rule: 'result', message: 'the run wrote no result.json' })
  }
  else if (resultStat.size > LIMITS.resultBytes) {
    violations.push({ rule: 'result', message: `result.json: ${resultStat.size} bytes, at most ${LIMITS.resultBytes}` })
  }
  else {
    const parsed = parseResult(readFileSync(options.resultFile, 'utf8'))
    if (parsed.ok)
      result = parsed.result
    else
      violations.push(...parsed.errors.map(message => ({ rule: 'result', message: `result.json: ${message}` })))
  }

  if (!resolve(run, defaultRef))
    throw new UsageError(`${defaultRef} is not in the checkout ${options.dir}: check out with fetch-depth 0`)
  if (!resolve(run, options.base)) {
    violations.push({ rule: 'base', message: `the base commit ${options.base} is not in the checkout` })
    return report({ result })
  }
  let head: string | undefined
  let commits = 0
  let files: string[] = []
  if (options.bundleFile && existsSync(options.bundleFile)) {
    try {
      head = fetchBundle(run, options.bundleFile, violations)
      if (head && !isAncestor(run, options.base, head)) {
        violations.push({ rule: 'bundle', message: `the bundle's commits do not start from the base ${options.base.slice(0, 12)}` })
        head = undefined
      }
      else if (head) {
        commits = Number(run(['rev-list', '--count', `${options.base}..${head}`]).trim())
        if (commits > BUNDLE_LIMITS.commits)
          violations.push({ rule: 'bundle', message: `the bundle has ${commits} commits, at most ${BUNDLE_LIMITS.commits}` })
        const merges = run(['rev-list', '--merges', `${options.base}..${head}`]).trim()
        if (merges)
          violations.push({ rule: 'bundle', message: `the bundle has merge commits (${merges.split('\n').map(c => c.slice(0, 12)).join(', ')}); rebase instead` })
        files = changedPaths(run, options.base, head)
        const skipping = run(['log', '--format=%H%x00%B%x00', `${options.base}..${head}`]).split('\0')
        for (let i = 0; i + 1 < skipping.length; i += 2) {
          if (SKIP_CI.test(skipping[i + 1]!))
            violations.push({ rule: 'bundle', message: `commit ${skipping[i]!.trim().slice(0, 12)} tells GitHub Actions to skip CI ([skip ci] or similar)` })
        }
      }
    }
    catch (error) {
      if (!(error instanceof GitError))
        throw error
      violations.push({ rule: 'bundle', message: error.message })
    }
  }

  // A new branch starts from the default branch; a rework round from the agent branch's head. The branch may also be
  // at the bundle's head already: a re-run of an apply job whose push succeeded before a later write failed.
  const branchHead = resolve(run, `origin/${branch}`)
  if (branchHead ? branchHead !== options.base && branchHead !== head : !isAncestor(run, options.base, defaultRef)) {
    violations.push({
      rule: 'base',
      message: branchHead
        ? `${branch} is at ${branchHead.slice(0, 12)}, not at the base ${options.base.slice(0, 12)} the run started from`
        : `the base ${options.base.slice(0, 12)} is not on ${options.defaultBranch}`,
    })
  }

  if (result?.outcome === 'pull-request' && options.playbookResult === 'comment')
    violations.push({ rule: 'result', message: `outcome pull-request, but the playbook ${options.playbook} answers with the status comment only` })
  if (result?.outcome === 'pull-request' && commits === 0 && !violations.some(v => v.rule === 'bundle'))
    violations.push({ rule: 'result', message: 'outcome pull-request, but the run made no commits' })
  if (result && result.outcome !== 'pull-request' && commits > 0)
    violations.push({ rule: 'result', message: `outcome ${result.outcome}, but the run made ${commits} commit(s): use outcome pull-request, or drop the commits` })

  const protect = protectList(run, defaultRef, violations)
  const allowAgentConfig = options.playbook === 'setup' && result?.pullRequest?.draft === true
  violations.push(...checkPaths(files, { protect, allowAgentConfig, workspaces: workspaceGlobs(run, defaultRef) }))

  return report({ result, head, commits, files })
}

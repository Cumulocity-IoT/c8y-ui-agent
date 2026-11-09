// The apply job's check, before it gets a write token: result.json and the git bundle against the rules of
// docs/result.md, in a fresh checkout of the repository. The workflow decides the issue, the playbook and the base
// commit; the agent's output decides none of them.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { git, GitError, isAncestor, resolve } from './git'
import type { Git } from './git'
import { checkPaths } from './paths'
import type { Violation } from './paths'
import { parseResult } from './result'
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
  run(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--force', file, `${ref}:${HEAD_REF}`])
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
  if (!existsSync(options.resultFile)) {
    violations.push({ rule: 'result', message: 'the run wrote no result.json' })
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
  const branchHead = resolve(run, `origin/${branch}`)
  if (branchHead ? branchHead !== options.base : !isAncestor(run, options.base, defaultRef)) {
    violations.push({
      rule: 'base',
      message: branchHead
        ? `${branch} is at ${branchHead.slice(0, 12)}, not at the base ${options.base.slice(0, 12)} the run started from`
        : `the base ${options.base.slice(0, 12)} is not on ${options.defaultBranch}`,
    })
  }

  let head: string | undefined
  let commits = 0
  let files: string[] = []
  if (options.bundleFile && existsSync(options.bundleFile)) {
    try {
      head = fetchBundle(run, options.bundleFile, violations)
    }
    catch (error) {
      if (!(error instanceof GitError))
        throw error
      violations.push({ rule: 'bundle', message: error.message })
    }
    if (head && !isAncestor(run, options.base, head)) {
      violations.push({ rule: 'bundle', message: `the bundle's commits do not start from the base ${options.base.slice(0, 12)}` })
    }
    else if (head) {
      commits = Number(run(['rev-list', '--count', `${options.base}..${head}`]).trim())
      if (commits > BUNDLE_LIMITS.commits)
        violations.push({ rule: 'bundle', message: `the bundle has ${commits} commits, at most ${BUNDLE_LIMITS.commits}` })
      const merges = run(['rev-list', '--merges', `${options.base}..${head}`]).trim()
      if (merges)
        violations.push({ rule: 'bundle', message: `the bundle has merge commits (${merges.split('\n').map(c => c.slice(0, 12)).join(', ')}); rebase instead` })
      files = run(['diff', '--name-only', '--no-renames', '-z', options.base, head]).split('\0').filter(Boolean)
    }
  }

  if (result?.outcome === 'pull-request' && commits === 0 && !violations.some(v => v.rule === 'bundle'))
    violations.push({ rule: 'result', message: 'outcome pull-request, but the run made no commits' })
  if (result && result.outcome !== 'pull-request' && commits > 0)
    violations.push({ rule: 'result', message: `outcome ${result.outcome}, but the run made ${commits} commit(s): use outcome pull-request, or drop the commits` })

  const protect = protectList(run, defaultRef, violations)
  const allowAgentConfig = options.playbook === 'setup' && result?.pullRequest?.draft === true
  violations.push(...checkPaths(files, { protect, allowAgentConfig }))

  return report({ result, head, commits, files })
}

// prove_regression: run the changed e2e tests on the base commit without the product change, then twice on the
// change, and decide whether they prove it (evaluate.ts). The base runs in a git worktree outside the checkout, with
// the change's test files copied in; the checkout itself is not modified.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { evaluate } from './evaluate'
import type { Evaluation } from './evaluate'
import { resolveApp, WorkbenchError } from './target'
import type { Target } from './target'
import { runTests } from './tests'
import type { TestRun } from './tests'
import { LogTail } from './util'

export interface ProveRegressionOptions {
  target: Target
  app: string
  /** The commit without the product change (default: the merge base of HEAD and the remote's default branch). */
  base?: string
  /** Spec files, relative to the repository (default: the changed spec files among the test files). */
  specs?: string[]
  /** Tests that must prove the change, as `<spec> › <suite> › … › <test>` (default: any test of the specs). */
  tests?: string[]
  /** Run the base and the first change run at the same time (default true). */
  parallel?: boolean
  signal?: AbortSignal
  /** Progress messages. */
  log?: (line: string) => void
}

export interface RegressionResult extends Evaluation {
  app: string
  /** The base commit. */
  base: string
  /** The change: HEAD, plus uncommitted and untracked files. */
  head: string
  specs: string[]
  /** Files that differ from the base and count as tests: they are copied into the base checkout. */
  testFiles: string[]
  /** Files that differ from the base outside the tests: the product change, left out on the base. */
  productFiles: string[]
  runs: TestRun[]
}

interface Change {
  path: string
  deleted: boolean
}

export function run(command: string, args: string[], cwd: string, output?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    const stderr = new LogTail(40)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => chunk.toString().split('\n').filter(Boolean).forEach((line) => {
      stderr.push(line)
      output?.(line)
    }))
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve(stdout)
      : reject(new WorkbenchError(`${command} ${args.join(' ')} failed (${code}): ${stderr.tail(10).join('\n')}`)))
  })
}

const git = (repo: string, ...args: string[]): Promise<string> => run('git', ['-C', repo, ...args], repo)

async function defaultBase(repo: string): Promise<string> {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try {
      return (await git(repo, 'merge-base', 'HEAD', ref)).trim()
    }
    catch {}
  }
  throw new WorkbenchError('no base given, and HEAD has no merge base with origin/HEAD, origin/main or origin/master')
}

/** Every file that differs between `base` and the working tree: committed, staged, unstaged and untracked. */
async function changedFiles(repo: string, base: string): Promise<Change[]> {
  const diff = (await git(repo, 'diff', '--name-status', '--no-renames', '-z', base)).split('\0').filter(Boolean)
  const changes: Change[] = []
  for (let i = 0; i < diff.length; i += 2)
    changes.push({ path: diff[i + 1]!, deleted: diff[i] === 'D' })
  const untracked = (await git(repo, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean)
  return [...changes, ...untracked.map(path => ({ path, deleted: false }))]
}

/** Files under the e2e root are tests; with the e2e root at the repository root, Cypress folders and specs are. */
export function isTestFile(path: string, e2eRoot = '.'): boolean {
  const root = posix.normalize(e2eRoot.replaceAll('\\', '/')).replace(/\/$/, '')
  if (root !== '.' && root !== '')
    return path.startsWith(`${root}/`)
  return /(^|\/)cypress\//.test(path) || /\.cy\.[cm]?[jt]sx?$/.test(path)
}

export const isSpec = (path: string): boolean => /\.cy\.[cm]?[jt]sx?$/.test(path)

async function install(dir: string, log: (line: string) => void): Promise<void> {
  if (existsSync(join(dir, 'pnpm-lock.yaml')))
    await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], dir, log)
  else if (existsSync(join(dir, 'package-lock.json')))
    await run('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], dir, log)
  else if (existsSync(join(dir, 'package.json')))
    throw new WorkbenchError(`${dir}: no pnpm-lock.yaml or package-lock.json; other package managers are not supported yet`)
}

export async function proveRegression(options: ProveRegressionOptions): Promise<RegressionResult> {
  const { target, signal, log = () => {} } = options
  const repo = (await git(target.repo, 'rev-parse', '--show-toplevel')).trim()
  const scoped: Target = { ...target, repo }
  const app = resolveApp(repo, options.app)
  const base = (await git(repo, 'rev-parse', '--verify', `${options.base ?? await defaultBase(repo)}^{commit}`)).trim()
  const head = (await git(repo, 'rev-parse', 'HEAD')).trim()

  const changes = await changedFiles(repo, base)
  const testFiles = changes.filter(c => isTestFile(c.path, target.e2eRoot))
  const productFiles = changes.filter(c => !isTestFile(c.path, target.e2eRoot)).map(c => c.path)
  const specs = options.specs ?? testFiles.filter(c => !c.deleted && isSpec(c.path)).map(c => c.path)
  if (specs.length === 0)
    throw new WorkbenchError(`no spec files changed since ${base.slice(0, 12)} under ${target.e2eRoot ?? 'the repository'}; name them with specs`)
  const dirty = changes.length > 0 && (await git(repo, 'status', '--porcelain')).trim() !== ''
  const result = {
    app: app.name,
    base,
    head: dirty ? `${head} with uncommitted changes` : head,
    specs,
    testFiles: testFiles.map(c => c.path),
    productFiles,
  }

  const temp = await mkdtemp(join(tmpdir(), 'c8y-ui-workbench-base-'))
  const checkout = join(temp, 'checkout')
  try {
    log(`base ${base.slice(0, 12)}: worktree, ${testFiles.length} test files from the change`)
    await git(repo, 'worktree', 'add', '--detach', checkout, base)
    for (const change of testFiles) {
      const to = join(checkout, change.path)
      if (change.deleted) {
        await rm(to, { force: true })
      }
      else {
        await mkdir(dirname(to), { recursive: true })
        await copyFile(join(repo, change.path), to)
      }
    }
    log('base: installing dependencies')
    const installLog = new LogTail(80)
    try {
      await install(checkout, installLog.push)
      const e2eRoot = join(checkout, target.e2eRoot ?? '.')
      if (e2eRoot !== checkout && (existsSync(join(e2eRoot, 'pnpm-lock.yaml')) || existsSync(join(e2eRoot, 'package-lock.json'))))
        await install(e2eRoot, installLog.push)
    }
    catch (error) {
      const failed: TestRun = { label: 'base', outcome: 'error', tests: [], gaps: [], error: `install failed: ${(error as Error).message}`, log: installLog.tail() }
      return { ...result, ...evaluate(failed, []), runs: [failed] }
    }
    signal?.throwIfAborted()

    const runOn = (dir: string, label: string): Promise<TestRun> => {
      log(`${label}: running ${specs.length} spec(s)`)
      return runTests({ target: scoped, app, checkout: dir, specs, label, signal }).then((run) => {
        log(`${label}: ${run.outcome}${run.outcome === 'completed' ? `, ${run.tests.filter(t => t.state === 'failed').length} of ${run.tests.length} tests failed` : ''}`)
        return run
      })
    }
    const [baseRun, first] = options.parallel === false
      ? [await runOn(checkout, 'base'), await runOn(repo, 'change 1')]
      : await Promise.all([runOn(checkout, 'base'), runOn(repo, 'change 1')])
    // A second run on the change catches flaky tests. Skipped when the first round already decides: a run did not
    // complete, or no test failed on the base in its own body.
    const runs = [baseRun, first]
    if (baseRun.outcome === 'completed' && first.outcome === 'completed' && baseRun.tests.some(t => t.state === 'failed' && t.failedIn === 'test'))
      runs.push(await runOn(repo, 'change 2'))
    return { ...result, ...evaluate(baseRun, runs.slice(1), options.tests), runs }
  }
  finally {
    await git(repo, 'worktree', 'remove', '--force', checkout).catch(() => {})
    await rm(temp, { recursive: true, force: true })
    await git(repo, 'worktree', 'prune').catch(() => {})
  }
}

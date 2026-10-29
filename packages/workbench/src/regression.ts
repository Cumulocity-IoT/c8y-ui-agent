// prove_regression: run the changed e2e tests on the base commit without the product change, then twice on the
// change, and decide whether they prove it (evaluate.ts).
//
// Both sides are built the same way, outside the repository's checkout: two git worktrees of the base commit, one with
// the change's test files copied in (the base), one with all changed files (the change), each with a fresh install.
// Files that git ignores (cypress.env.json, .env, build output) reach neither side, so they cannot make a test fail on
// one side only. The checkout itself is not modified.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readlink, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, posix, relative, resolve } from 'node:path'
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
  /** Files that differ from the base and count as tests: both sides get them. */
  testFiles: string[]
  /** Files that differ from the base outside the tests: the product change, which only the change side gets. */
  productFiles: string[]
  /** Untracked build output in the checkout (dist/, .angular/): left out on both sides. */
  ignoredFiles: string[]
  runs: TestRun[]
}

export interface Change {
  path: string
  deleted: boolean
}

export function run(command: string, args: string[], cwd: string, output?: (line: string) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal })
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

// Hooks off: `worktree add` would run the repository's post-checkout hook (also from a tracked core.hooksPath).
const git = (repo: string, ...args: string[]): Promise<string> => run('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], repo)

async function defaultBase(repo: string): Promise<string> {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try {
      return (await git(repo, 'merge-base', 'HEAD', ref)).trim()
    }
    catch {}
  }
  throw new WorkbenchError('no base given, and HEAD has no merge base with origin/HEAD, origin/main or origin/master')
}

/** What dev servers write next to the sources; untracked files there are build output, not part of the change. */
export const isBuildOutput = (path: string): boolean => /(^|\/)(dist|\.angular)\//.test(path)

/** Every file that differs between `base` and the working tree: committed, staged, unstaged and untracked. */
export async function changedFiles(repo: string, base: string): Promise<{ changes: Change[], ignored: string[] }> {
  const diff = (await git(repo, 'diff', '--name-status', '--no-renames', '-z', base, '--')).split('\0').filter(Boolean)
  const changes: Change[] = []
  for (let i = 0; i < diff.length; i += 2)
    changes.push({ path: diff[i + 1]!, deleted: diff[i] === 'D' })
  const untracked = (await git(repo, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean)
  return {
    changes: [...changes, ...untracked.filter(path => !isBuildOutput(path)).map(path => ({ path, deleted: false }))],
    ignored: untracked.filter(isBuildOutput),
  }
}

/**
 * Whether a changed file belongs to the tests: everything under the e2e root; with the e2e root at the repository
 * root, Cypress folders, specs, configs and cypress.env.json, and the configured Cypress config file.
 */
export function isTestFile(path: string, e2eRoot = '.', e2eConfig?: string): boolean {
  const root = posix.normalize(e2eRoot.replaceAll('\\', '/')).replace(/\/$/, '')
  if (root !== '.' && root !== '')
    return path.startsWith(`${root}/`)
  if (e2eConfig) {
    const pattern = new RegExp(`^${posix.normalize(e2eConfig).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\\{app\\\}|\{app\}/g, '[^/]+')}$`)
    if (pattern.test(path))
      return true
  }
  return /(^|\/)cypress\//.test(path) || /\.cy\.[cm]?[jt]sx?$/.test(path) || /(^|\/)cypress\.(config\.[cm]?[jt]s|env\.json)$/.test(path)
}

export const isSpec = (path: string): boolean => /\.cy\.[cm]?[jt]sx?$/.test(path)

/** A path given to a tool, relative to the repository, that must stay inside it. */
function inside(repo: string, path: string, what: string): string {
  const rel = relative(repo, resolve(repo, path))
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new WorkbenchError(`${what} ${path} is outside the repository`)
  return normalize(rel).replaceAll('\\', '/')
}

async function install(dir: string, log: (line: string) => void, signal?: AbortSignal): Promise<void> {
  if (existsSync(join(dir, 'pnpm-lock.yaml')))
    await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], dir, log, signal)
  else if (existsSync(join(dir, 'package-lock.json')))
    await run('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], dir, log, signal)
  else if (existsSync(join(dir, 'package.json')))
    throw new WorkbenchError(`${dir}: no pnpm-lock.yaml or package-lock.json; other package managers are not supported yet`)
}

/** A worktree of `commit` at `dir` with `files` taken from the repository's working tree (deleted ones removed). */
export async function prepareCheckout(repo: string, commit: string, files: Change[], dir: string): Promise<void> {
  await git(repo, 'worktree', 'add', '--detach', dir, commit)
  for (const file of files) {
    const to = join(dir, file.path)
    await rm(to, { force: true })
    if (file.deleted)
      continue
    const from = join(repo, file.path)
    await mkdir(dirname(to), { recursive: true })
    const stat = await lstat(from)
    if (stat.isSymbolicLink())
      await symlink(await readlink(from), to)
    else
      await copyFile(from, to)
  }
}

async function installCheckout(checkout: string, target: Target, label: string, signal?: AbortSignal): Promise<TestRun | undefined> {
  const log = new LogTail(80)
  try {
    await install(checkout, log.push, signal)
    const e2eRoot = join(checkout, target.e2eRoot ?? '.')
    if (e2eRoot !== checkout && (existsSync(join(e2eRoot, 'pnpm-lock.yaml')) || existsSync(join(e2eRoot, 'package-lock.json'))))
      await install(e2eRoot, log.push, signal)
    return undefined
  }
  catch (error) {
    signal?.throwIfAborted()
    return { label, outcome: 'error', tests: [], gaps: [], error: `install failed: ${(error as Error).message}`, log: log.tail() }
  }
}

/** Both settled, then the first rejection: cleanup must not remove a worktree that a run still uses. */
async function both<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [ra, rb] = await Promise.allSettled([a, b])
  if (ra.status === 'rejected')
    throw ra.reason
  if (rb.status === 'rejected')
    throw rb.reason
  return [ra.value, rb.value]
}

export async function proveRegression(options: ProveRegressionOptions): Promise<RegressionResult> {
  const { target, signal, log = () => {} } = options
  const repo = (await git(target.repo, 'rev-parse', '--show-toplevel')).trim()
  const e2eRoot = inside(repo, target.e2eRoot ?? '.', 'the e2e root')
  const scoped: Target = { ...target, repo, e2eRoot }
  const app = resolveApp(repo, options.app)
  const baseRef = options.base ?? await defaultBase(repo)
  const base = (await git(repo, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`)).trim()
  const head = (await git(repo, 'rev-parse', 'HEAD')).trim()
  // Worktrees of runs that were killed (their directories are gone).
  await git(repo, 'worktree', 'prune').catch(() => {})

  const { changes, ignored } = await changedFiles(repo, base)
  const testFiles = changes.filter(c => isTestFile(c.path, e2eRoot, target.e2eConfig && posix.join(e2eRoot, target.e2eConfig)))
  const productFiles = changes.filter(c => !testFiles.includes(c)).map(c => c.path)
  const specs = options.specs?.map(spec => inside(repo, spec, 'spec')) ?? testFiles.filter(c => !c.deleted && isSpec(c.path)).map(c => c.path)
  if (specs.length === 0)
    throw new WorkbenchError(`no spec files changed since ${base.slice(0, 12)} under ${e2eRoot === '.' ? 'the repository' : e2eRoot}; name them with specs`)
  const dirty = changes.length > 0 && (await git(repo, 'status', '--porcelain')).trim() !== ''
  const result = {
    app: app.name,
    base,
    head: dirty ? `${head} with uncommitted changes` : head,
    specs,
    testFiles: testFiles.map(c => c.path),
    productFiles,
    ignoredFiles: ignored,
  }
  // Without a product change, both sides run the same code: a failure on one side only is chance, not proof.
  if (productFiles.length === 0)
    return { ...result, verdict: 'not-proven', reasons: ['no product change: every changed file is a test file, so both sides run the same code'], proving: [], tests: [], gaps: [], runs: [] }

  const temp = await mkdtemp(join(tmpdir(), 'c8y-ui-workbench-proof-'))
  const checkouts = { base: join(temp, 'base'), change: join(temp, 'change') }
  try {
    log(`checkouts of ${base.slice(0, 12)}: base with ${testFiles.length} test files, change with ${changes.length} changed files`)
    await prepareCheckout(repo, base, testFiles, checkouts.base)
    await prepareCheckout(repo, base, changes, checkouts.change)
    log('installing dependencies in both checkouts')
    const [baseInstall, changeInstall] = await both(installCheckout(checkouts.base, scoped, 'base', signal), installCheckout(checkouts.change, scoped, 'change', signal))
    if (baseInstall || changeInstall) {
      const failed = [baseInstall, changeInstall].filter((r): r is TestRun => r !== undefined)
      return { ...result, ...evaluate(failed[0]!, failed.slice(1), { specs: [], tests: options.tests }), runs: failed }
    }

    const specsInRoot = specs.map(spec => posix.relative(e2eRoot === '.' ? '' : e2eRoot, spec))
    const runOn = (dir: string, label: string): Promise<TestRun> => {
      log(`${label}: running ${specs.length} spec(s)`)
      return runTests({ target: scoped, app, checkout: dir, specs, label, signal }).then((run) => {
        log(`${label}: ${run.outcome}${run.outcome === 'completed' ? `, ${run.tests.filter(t => t.state === 'failed').length} of ${run.tests.length} tests failed` : ''}`)
        return run
      })
    }
    const [baseRun, first] = options.parallel === false
      ? [await runOn(checkouts.base, 'base'), await runOn(checkouts.change, 'change 1')]
      : await both(runOn(checkouts.base, 'base'), runOn(checkouts.change, 'change 1'))
    // A second run on the change catches flaky tests. Skipped when the first round already decides: a run did not
    // complete, or no test failed on the base in its own body.
    const runs = [baseRun, first]
    if (baseRun.outcome === 'completed' && first.outcome === 'completed' && baseRun.tests.some(t => t.state === 'failed' && t.failedIn === 'test'))
      runs.push(await runOn(checkouts.change, 'change 2'))
    return { ...result, ...evaluate(baseRun, runs.slice(1), { specs: specsInRoot, tests: options.tests }), runs }
  }
  finally {
    for (const dir of Object.values(checkouts))
      await git(repo, 'worktree', 'remove', '--force', dir).catch(() => {})
    await rm(temp, { recursive: true, force: true })
    await git(repo, 'worktree', 'prune').catch(() => {})
  }
}

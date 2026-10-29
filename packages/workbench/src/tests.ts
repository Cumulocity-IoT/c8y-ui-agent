// One e2e run of an app in a checkout: the emulated tenant, the app's dev server (`ng serve`) and Cypress, through the
// Cumulocity UI SDK (runE2e), with every test's outcome as data (reporter/index.cjs) and the emulator's gaps.
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runE2e } from '@cumulocity-iot/ui-sdk'
import type { GapRecord } from '@cumulocity-iot/ui-sdk'
import { e2eConfigFile, worldFile } from './target'
import type { App, Target } from './target'
import { errorMessage, freePort, LogTail } from './util'

/** The same relative path from src/ (tests) and dist/ (the package). */
export const REPORTER = fileURLToPath(new URL('../reporter/index.cjs', import.meta.url))

/**
 * How Angular dev servers report a failed build. `ng serve` keeps running after one, so the run would otherwise wait
 * for the app until the SDK's timeout (5 minutes).
 */
const BUILD_FAILED = /Failed to compile|Application bundle generation failed|✘ \[ERROR\]|^\s*ERROR in /

export interface TestResult {
  /** `<spec> › <suite> › … › <test>`, as the emulator's gap report names tests. */
  id: string
  /** Relative to the e2e root. */
  spec: string
  title: string[]
  state: 'passed' | 'failed' | 'pending' | 'skipped'
  /** Where it failed: its own body, or a hook (also its own beforeEach and afterEach, as Cypress reports them). */
  failedIn?: 'test' | 'hook'
  /** The failed hook: `before each`, `before all`, `after each`, `after all`. */
  hook?: string
  error?: string
  /** More than 1 when it passed only on a retry. */
  attempts?: number
}

export interface TestRun {
  label: string
  /** `completed`: Cypress ran (see exitCode and tests). `build-failed`: the app did not build. `error`: anything else. */
  outcome: 'completed' | 'build-failed' | 'error'
  exitCode?: number
  tests: TestResult[]
  /** The requests the emulator could not answer as a tenant would (`expected: false` are its shortcomings). */
  gaps: GapRecord[]
  error?: string
  /** The last lines of the dev server's and Cypress' output, when the run did not pass. */
  log?: string[]
}

export interface RunTestsOptions {
  target: Target
  app: App
  /** The checkout to run in: the repository, or a worktree of it. */
  checkout: string
  /** Spec files, relative to the checkout. */
  specs: string[]
  label: string
  signal?: AbortSignal
}

export function testId(spec: string, title: string[]): string {
  return [spec, ...title].join(' › ')
}

/** The reporter's lines; a run that Cypress ended early leaves fewer, or none. */
export function readResults(file: string): TestResult[] {
  if (!existsSync(file))
    return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const raw = JSON.parse(line) as Omit<TestResult, 'id'>
    return { id: testId(raw.spec, raw.title), ...raw }
  })
}

function substitute(env: Record<string, string> | undefined, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, value.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match)]))
}

export async function runTests(options: RunTestsOptions): Promise<TestRun> {
  const { target, app, checkout, label } = options
  const e2eRoot = resolve(checkout, target.e2eRoot ?? '.')
  const dir = await mkdtemp(join(tmpdir(), 'c8y-ui-workbench-'))
  const results = join(dir, 'results.jsonl')
  const log = new LogTail(400)
  const port = await freePort()
  const devPort = await freePort()
  const urls = { devUrl: `http://localhost:${devPort}`, mockUrl: `http://127.0.0.1:${port}` }

  // Until the app is served, a build error ends the run.
  const build = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, build.signal]) : build.signal
  let served = false
  let buildError: string | undefined
  const output = (line: string): void => {
    log.push(line)
    if (!served && !buildError && BUILD_FAILED.test(line)) {
      buildError = line.trim()
      build.abort(new Error('build failed'))
    }
  }
  const watchServed = (async () => {
    while (!served && !signal.aborted) {
      served = await fetch(`${urls.devUrl}/apps/${app.config.contextPath}/cumulocity.json`).then(r => r.ok, () => false)
      await new Promise(r => setTimeout(r, 1000))
    }
  })()

  try {
    const result = await runE2e({
      root: e2eRoot,
      project: app.project,
      configFile: e2eConfigFile(target, app),
      contextPath: app.config.contextPath,
      config: app.config,
      world: worldFile(target),
      auth: target.e2eAuth ?? 'open',
      port,
      devPort,
      spec: options.specs.map(spec => relative(e2eRoot, resolve(checkout, spec))).join(','),
      env: { ...substitute(target.e2eEnv, urls), CYPRESS_REPORTER: REPORTER, C8Y_WORKBENCH_RESULTS: results },
      output,
      log: log.push,
      signal,
    })
    const tests = readResults(results)
    if (tests.length === 0)
      return { label, outcome: 'error', exitCode: result.exitCode, tests, gaps: result.gaps, error: 'Cypress reported no tests: check the spec paths and the Cypress config', log: log.tail(80) }
    return { label, outcome: 'completed', exitCode: result.exitCode, tests, gaps: result.gaps, ...(result.exitCode === 0 ? {} : { log: log.tail(80) }) }
  }
  catch (error) {
    options.signal?.throwIfAborted()
    return { label, outcome: buildError ? 'build-failed' : 'error', tests: [], gaps: [], error: buildError ?? errorMessage(error), log: log.tail(80) }
  }
  finally {
    served = true
    await watchServed
    await rm(dir, { recursive: true, force: true })
  }
}

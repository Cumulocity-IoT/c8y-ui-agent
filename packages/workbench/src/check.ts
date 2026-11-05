// check: one e2e run of an app on the working tree, on the emulated tenant: the developer's quick check between edits.
// prove_regression is the proof: base and change in fresh worktrees, three runs. check runs in the checkout as it is,
// with its installed dependencies and ignored files, once.
import { statSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import type { GapRecord } from '@cumulocity-iot/ui-sdk'
import { inside } from './regression'
import { resolveApp, WorkbenchError } from './target'
import type { Target } from './target'
import { runTests } from './tests'
import type { TestResult, TestRun } from './tests'

export interface CheckOptions {
  target: Target
  app: string
  /** Spec files, relative to the repository (default: every spec of the app's Cypress config). */
  specs?: string[]
  signal?: AbortSignal
  /** Progress messages. */
  log?: (line: string) => void
}

export interface CheckResult {
  app: string
  /** The specs given; empty: every spec of the app's Cypress config. */
  specs: string[]
  /**
   * `passed`: every test passed or is pending, at least one passed, and Cypress' exit code is 0. `failed`: a test
   * failed or was skipped after a failed hook, a named spec reported no tests, or Cypress counted failures without a
   * test. `build-failed`: the app did not build. `error`: Cypress did not run, reported no tests, or every test is pending.
   */
  status: 'passed' | 'failed' | 'build-failed' | 'error'
  counts: Record<TestResult['state'], number>
  /** Tests that passed only on a retry: flaky, even when the status is `passed`. */
  retried: string[]
  /** Tests that did not pass, with where and why. */
  failures: TestResult[]
  /** Every test, by `<spec> › <suite> › … › <test>`, with the spec relative to the e2e root. */
  tests: TestResult[]
  /** Requests the emulator could not answer as a tenant would, except those a fresh tenant misses too. */
  gaps: GapRecord[]
  error?: string
  /** The last lines of the dev server's and Cypress' output, when the check did not pass. */
  log?: string[]
}

/**
 * The result of a check from its run: pure, for tests. `specs` relative to the repository, `e2eRoot` too; the tests
 * name their spec relative to the e2e root.
 */
export function checkResult(app: string, specs: string[], run: TestRun, e2eRoot = '.'): CheckResult {
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 }
  for (const test of run.tests)
    counts[test.state]++
  const failures = run.tests.filter(test => test.state === 'failed' || test.state === 'skipped')
  // A named spec without tests: it did not load, does not match the Cypress config's specPattern, or has none.
  const silent = specs.filter(spec => !run.tests.some(test => test.spec === posix.relative(e2eRoot === '.' ? '' : e2eRoot, spec)))
  // Cypress' exit code counts failed tests; a spec that does not load or ends early counts as one, without a test.
  const unexplained = run.outcome === 'completed' ? (run.exitCode ?? 0) - failures.filter(test => test.state === 'failed').length : 0
  const problems = run.outcome !== 'completed'
    ? []
    : [
        ...silent.map(spec => `${spec}: no test results (the spec did not load, does not match the Cypress config's specPattern, or has no tests)`),
        ...unexplained > 0 ? [`Cypress counted ${unexplained} failure(s) without a failed test: a spec did not load or ended early (see log)`] : [],
        ...counts.passed === 0 && failures.length === 0 && run.tests.length > 0 ? [`no test ran: all ${counts.pending} tests are pending`] : [],
      ]
  const status = run.outcome !== 'completed'
    ? run.outcome
    : counts.passed === 0 && failures.length === 0 && unexplained <= 0 && silent.length === 0
      ? 'error'
      : failures.length === 0 && run.exitCode === 0 && problems.length === 0 ? 'passed' : 'failed'
  const error = run.error ?? (problems.length > 0 ? problems.join('; ') : undefined)
  return {
    app,
    specs,
    status,
    counts,
    retried: run.tests.filter(test => test.state === 'passed' && (test.attempts ?? 1) > 1).map(test => test.id),
    failures,
    tests: run.tests,
    gaps: run.gaps.filter(gap => !gap.expected),
    ...(error ? { error } : {}),
    ...(status !== 'passed' && run.log ? { log: run.log } : {}),
  }
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const { target, log = () => {} } = options
  const specs = (options.specs ?? []).map((spec) => {
    const path = inside(target.repo, spec, 'spec')
    if (!statSync(resolve(target.repo, path), { throwIfNoEntry: false })?.isFile())
      throw new WorkbenchError(`spec ${spec} is not a file`)
    return path
  })
  const e2eRoot = inside(target.repo, target.e2eRoot ?? '.', 'the e2e root')
  const app = resolveApp(target.repo, options.app)
  log(`${app.name}: running ${specs.length > 0 ? `${specs.length} spec(s)` : 'every spec of the Cypress config'}`)
  const run = await runTests({ target, app, checkout: target.repo, specs, label: 'check', signal: options.signal })
  const result = checkResult(app.name, specs, run, e2eRoot)
  log(`${app.name}: ${result.status}, ${result.counts.passed} passed, ${result.counts.failed} failed`)
  return result
}

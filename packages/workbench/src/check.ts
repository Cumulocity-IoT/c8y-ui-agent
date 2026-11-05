// check: one e2e run of an app on the working tree, on the emulated tenant: the developer's quick check between edits.
// prove_regression is the proof: base and change in fresh worktrees, three runs. check runs in the checkout as it is,
// with its installed dependencies and ignored files, once.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
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
}

export interface CheckResult {
  app: string
  /** The specs given; empty: every spec of the app's Cypress config. */
  specs: string[]
  /**
   * `passed`: Cypress ran, every test passed or is pending, and its exit code is 0. `failed`: a test failed or was
   * skipped after a failed hook, or a spec did not load. `build-failed`: the app did not build. `error`: Cypress did
   * not run or reported no tests.
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

/** The result of a check from its run: pure, for tests. */
export function checkResult(app: string, specs: string[], run: TestRun): CheckResult {
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 }
  for (const test of run.tests)
    counts[test.state]++
  const failures = run.tests.filter(test => test.state === 'failed' || test.state === 'skipped')
  const status = run.outcome !== 'completed'
    ? run.outcome
    : failures.length === 0 && run.exitCode === 0 ? 'passed' : 'failed'
  // Cypress' exit code counts failed tests; a spec that does not load counts as one, without a test.
  const unexplained = run.outcome === 'completed' ? (run.exitCode ?? 0) - failures.filter(test => test.state === 'failed').length : 0
  const error = run.error ?? (unexplained > 0 ? `Cypress counted ${unexplained} more failure(s) than failed tests: a spec did not load (see log)` : undefined)
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
  const { target } = options
  const specs = (options.specs ?? []).map((spec) => {
    const path = inside(target.repo, spec, 'spec')
    if (!existsSync(resolve(target.repo, path)))
      throw new WorkbenchError(`spec ${spec} does not exist`)
    return path
  })
  const app = resolveApp(target.repo, options.app)
  const run = await runTests({ target, app, checkout: target.repo, specs, label: 'check', signal: options.signal })
  return checkResult(app.name, specs, run)
}

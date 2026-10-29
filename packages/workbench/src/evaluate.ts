// The rules of prove_regression, as a pure function of the runs: which tests prove the change, and what limits the
// evidence. See docs/prove-regression.md.
import type { GapRecord } from '@cumulocity-iot/ui-sdk'
import type { TestResult, TestRun } from './tests'

/**
 * - `regression`: the tests fail on the base commit in their own body and pass twice on the change, without emulator
 *   gaps that could explain either.
 * - `observed`: the same outcomes, but an emulator gap may explain them: the change is observed, not proven.
 * - `not-proven`: the tests do not show the change (they pass on the base, fail only in a hook, or fail or are flaky
 *   on the change).
 * - `inconclusive`: a run did not complete (build failure, setup error, no results).
 */
export type Verdict = 'regression' | 'observed' | 'not-proven' | 'inconclusive'

export interface TestVerdict {
  id: string
  spec: string
  base: string
  change: string[]
  proves: boolean
  /** Why it does not prove the change. */
  reason?: string
}

export interface Evaluation {
  verdict: Verdict
  reasons: string[]
  /** The tests that prove the change. */
  proving: string[]
  tests: TestVerdict[]
  /** Unexpected gaps of all runs that concern a tested spec, or cannot be attributed. */
  gaps: GapRecord[]
}

const outcome = (test: TestResult | undefined): string => {
  if (!test)
    return 'missing'
  if (test.state === 'failed')
    return test.failedIn === 'hook' ? `failed in ${test.hook ?? 'a'} hook` : 'failed'
  return test.attempts && test.attempts > 1 ? `${test.state} on attempt ${test.attempts}` : test.state
}

/**
 * Whether a gap concerns a tested spec: the gap report attributes it to one of the spec's tests or hooks
 * (`<spec> › …`), or to no test at all (a repository whose Cypress support file does not report tests to the
 * emulator). Any test of a spec can set up state that its other tests depend on, so the whole spec counts.
 */
export function gapTouches(gap: GapRecord, spec: string): boolean {
  if (!gap.tests || gap.tests.length === 0)
    return true
  return gap.tests.some(name => name.startsWith(`${spec} › `))
}

const unexpected = (run: TestRun): GapRecord[] => run.gaps.filter(gap => !gap.expected)

export interface EvaluateOptions {
  /** The specs that ran, relative to the e2e root: each must report tests in every change run. */
  specs: string[]
  /** Tests that must prove the change (default: any test of the specs). */
  tests?: string[]
}

export function evaluate(base: TestRun, changes: TestRun[], options: EvaluateOptions): Evaluation {
  const named = options.tests && options.tests.length > 0 ? options.tests : undefined
  const reasons: string[] = []
  for (const run of [base, ...changes]) {
    if (run.outcome !== 'completed')
      reasons.push(`${run.label}: ${run.outcome === 'build-failed' ? 'the build failed' : 'the run failed'}: ${run.error ?? ''}`.trim())
  }
  if (reasons.length > 0)
    return { verdict: 'inconclusive', reasons, proving: [], tests: [], gaps: [] }

  // A spec that does not load (a missing import) reports no tests, and Cypress' exit code counts it as a failure.
  for (const run of changes) {
    for (const spec of options.specs) {
      if (!run.tests.some(t => t.spec === spec))
        reasons.push(`${spec}: no test results in ${run.label} (the spec did not load, or has no tests)`)
    }
    const failed = run.tests.filter(t => t.state === 'failed').length
    if (run.exitCode !== undefined && run.exitCode > failed)
      reasons.push(`${run.label}: Cypress reported ${run.exitCode} failures, but only ${failed} failed tests`)
  }

  // The tests of the change define what was run; the base may lack a test that the change adds to an existing spec.
  const ids = [...new Set(changes.flatMap(run => run.tests.map(t => t.id)))]
  const missing = (named ?? []).filter(id => !ids.includes(id))
  for (const id of missing)
    reasons.push(`${id}: no such test in the change's runs (name tests as <spec> › <suite> › … › <test>, spec relative to the e2e root)`)
  const candidates = named ? named.filter(id => ids.includes(id)) : ids

  const find = (run: TestRun, id: string): TestResult | undefined => run.tests.find(t => t.id === id)
  const tests: TestVerdict[] = []

  // Every test of the change must pass in every change run: a failure elsewhere means the change broke something.
  for (const id of ids) {
    const results = changes.map(run => find(run, id))
    const failing = results.filter(t => t?.state === 'failed')
    const retried = results.filter(t => t?.state === 'passed' && (t.attempts ?? 1) > 1)
    if (failing.length === changes.length)
      reasons.push(`${id}: fails on the change`)
    else if (failing.length > 0 || retried.length > 0)
      reasons.push(`${id}: flaky on the change (${results.map(outcome).join(', ')})`)
  }

  for (const id of candidates) {
    const onBase = find(base, id)
    const onChange = changes.map(run => find(run, id))
    const reference = onChange.find(Boolean) ?? onBase
    const verdict: TestVerdict = { id, spec: reference?.spec ?? '', base: outcome(onBase), change: onChange.map(outcome), proves: false }
    if (onChange.some(t => t?.state !== 'passed' || (t.attempts ?? 1) > 1))
      verdict.reason = 'does not pass on every change run'
    else if (!onBase)
      verdict.reason = 'not run on the base commit'
    else if (onBase.state === 'passed')
      verdict.reason = 'passes on the base commit: proves nothing'
    else if (onBase.state === 'failed' && onBase.failedIn === 'hook')
      verdict.reason = `fails in the ${onBase.hook ?? ''} hook on the base commit, not in its own body`
    else if (onBase.state !== 'failed')
      verdict.reason = `${onBase.state} on the base commit`
    else
      verdict.proves = true
    tests.push(verdict)
  }

  // Unexpected gaps of any run that concern a tested spec.
  const specs = [...new Set([...options.specs, ...tests.map(t => t.spec)])]
  const gaps = [...new Set([base, ...changes].flatMap(unexpected).filter(gap => specs.some(spec => gapTouches(gap, spec))))]
  const proving = tests.filter(t => t.proves).map(t => t.id)
  if (named) {
    for (const t of tests.filter(t => !t.proves))
      reasons.push(`${t.id}: ${t.reason}`)
  }
  else if (proving.length === 0) {
    reasons.push('no test fails on the base commit in its own body and passes on the change')
  }
  if (reasons.length > 0)
    return { verdict: 'not-proven', reasons, proving: [], tests, gaps }

  if (gaps.length > 0) {
    const unattributed = gaps.some(gap => !gap.tests?.length)
    return {
      verdict: 'observed',
      reasons: [unattributed
        ? 'the emulator could not answer some requests, and the gap report does not attribute them to tests (the Cypress support file needs @cumulocity-iot/ui-sdk/cypress from SDK 2.3): a gap may explain the outcome'
        : 'the emulator could not answer requests of the tested specs: a gap may explain the outcome'],
      proving,
      tests,
      gaps,
    }
  }
  return { verdict: 'regression', reasons: [], proving, tests, gaps }
}

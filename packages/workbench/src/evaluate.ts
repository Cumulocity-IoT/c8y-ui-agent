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
  /** Unexpected gaps that touch the tests (or cannot be attributed), from all runs. */
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
 * Whether a gap may have affected a test: the gap report attributes it to the test (its body and its each-hooks,
 * or what follows it), to its spec's `before all` hooks, or to no test at all (a repository whose Cypress support
 * file does not report tests to the emulator).
 */
export function gapTouches(gap: GapRecord, test: Pick<TestResult, 'id' | 'spec'>): boolean {
  if (!gap.tests || gap.tests.length === 0)
    return true
  return gap.tests.some(name => name === test.id || name === `${test.id} › after` || name === `${test.spec} › before all`)
}

const unexpected = (run: TestRun): GapRecord[] => run.gaps.filter(gap => !gap.expected)

export function evaluate(base: TestRun, changes: TestRun[], named?: string[]): Evaluation {
  const reasons: string[] = []
  for (const run of [base, ...changes]) {
    if (run.outcome !== 'completed')
      reasons.push(`${run.label}: ${run.outcome === 'build-failed' ? 'the build failed' : 'the run failed'}: ${run.error ?? ''}`.trim())
  }
  if (reasons.length > 0)
    return { verdict: 'inconclusive', reasons, proving: [], tests: [], gaps: [] }

  // The tests of the change define what was run; the base may lack a test that the change adds to an existing spec.
  const ids = [...new Set(changes.flatMap(run => run.tests.map(t => t.id)))]
  const candidates = named && named.length > 0 ? named : ids
  for (const id of named ?? []) {
    if (!ids.includes(id))
      reasons.push(`${id}: no such test in the change's runs (name tests as <spec> › <suite> › … › <test>, spec relative to the e2e root)`)
  }

  const find = (run: TestRun, id: string): TestResult | undefined => run.tests.find(t => t.id === id)
  const tests: TestVerdict[] = []
  const touchingGaps = new Set<GapRecord>()

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
    for (const gap of [base, ...changes].flatMap(unexpected).filter(gap => gapTouches(gap, verdict)))
      touchingGaps.add(gap)

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

  const proving = tests.filter(t => t.proves).map(t => t.id)
  const gaps = [...touchingGaps]
  if (named && named.length > 0) {
    for (const t of tests.filter(t => !t.proves))
      reasons.push(`${t.id}: ${t.reason}`)
  }
  else if (proving.length === 0) {
    reasons.push('no test fails on the base commit in its own body and passes on the change')
  }
  if (reasons.length > 0)
    return { verdict: 'not-proven', reasons, proving: [], tests, gaps }

  const provingGaps = gaps.filter(gap => tests.some(t => t.proves && gapTouches(gap, t)))
  if (provingGaps.length > 0) {
    const unattributed = provingGaps.some(gap => !gap.tests?.length)
    return {
      verdict: 'observed',
      reasons: [unattributed
        ? 'the emulator could not answer some requests, and the gap report does not attribute them to tests (the Cypress support file needs @cumulocity-iot/ui-sdk/cypress from SDK 2.3): a gap may explain the outcome'
        : 'the emulator could not answer requests of the proving tests: a gap may explain the outcome'],
      proving,
      tests,
      gaps,
    }
  }
  return { verdict: 'regression', reasons: [], proving, tests, gaps }
}

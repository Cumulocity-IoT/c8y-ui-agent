import type { GapRecord } from '@cumulocity-iot/ui-sdk'
import { describe, expect, it } from 'vitest'
import { evaluate, gapTouches } from '../src/evaluate'
import { testId } from '../src/tests'
import type { TestResult, TestRun } from '../src/tests'

const SPEC = 'cypress/e2e/a.cy.ts'
const ID = testId(SPEC, ['A', 'shows the fix'])
const OTHER = testId(SPEC, ['A', 'still works'])

const test = (title: string, result: Partial<TestResult> = {}): TestResult =>
  ({ id: testId(SPEC, ['A', title]), spec: SPEC, title: ['A', title], state: 'passed', ...result })
const failed = (title: string, result: Partial<TestResult> = {}): TestResult =>
  test(title, { state: 'failed', failedIn: 'test', error: 'expected', ...result })
const run = (label: string, tests: TestResult[], extra: Partial<TestRun> = {}): TestRun =>
  ({ label, outcome: 'completed', exitCode: tests.some(t => t.state === 'failed') ? 1 : 0, tests, gaps: [], ...extra })
const gap = (extra: Partial<GapRecord> = {}): GapRecord =>
  ({ kind: 'unknown-endpoint', method: 'GET', path: '/x', status: 404, count: 1, firstAt: 0, lastAt: 0, expected: false, ...extra })

const passing = [test('shows the fix'), test('still works')]
const O = { specs: [SPEC] }

describe('evaluate', () => {
  it('proves a test that fails on the base in its body and passes twice on the change', () => {
    const result = evaluate(run('base', [failed('shows the fix'), test('still works')]), [run('change 1', passing), run('change 2', passing)], O)
    expect(result.verdict).toBe('regression')
    expect(result.proving).toEqual([ID])
    expect(result.tests.find(t => t.id === OTHER)?.reason).toBe('passes on the base commit: proves nothing')
  })

  it('does not count a failure in a hook', () => {
    const result = evaluate(run('base', [failed('shows the fix', { failedIn: 'hook', hook: 'before each' }), test('still works')]), [run('change 1', passing), run('change 2', passing)], O)
    expect(result.verdict).toBe('not-proven')
    expect(result.tests[0]?.reason).toContain('before each hook')
  })

  it('does not count tests that pass on the base', () => {
    const result = evaluate(run('base', passing), [run('change 1', passing)], O)
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons).toEqual(['no test fails on the base commit in its own body and passes on the change'])
  })

  it('requires every test to pass on the change', () => {
    const result = evaluate(run('base', [failed('shows the fix'), test('still works')]), [run('change 1', [test('shows the fix'), failed('still works')]), run('change 2', [test('shows the fix'), failed('still works')])], O)
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons).toContain(`${OTHER}: fails on the change`)
  })

  it('reports a test that passes only once, or only on a retry, as flaky', () => {
    const flaky = evaluate(run('base', [failed('shows the fix')]), [run('change 1', [test('shows the fix')]), run('change 2', [failed('shows the fix')])], O)
    expect(flaky.verdict).toBe('not-proven')
    expect(flaky.reasons[0]).toBe(`${ID}: flaky on the change (passed, failed)`)
    const retried = evaluate(run('base', [failed('shows the fix')]), [run('change 1', [test('shows the fix', { attempts: 2 })]), run('change 2', [test('shows the fix')])], O)
    expect(retried.verdict).toBe('not-proven')
    expect(retried.reasons[0]).toContain('passed on attempt 2')
  })

  it('counts a test that the change adds to an existing spec', () => {
    const result = evaluate(run('base', [test('still works')]), [run('change 1', passing), run('change 2', passing)], { ...O, tests: [ID] })
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons).toEqual([`${ID}: not run on the base commit`])
  })

  it('requires every named test to prove the change', () => {
    const base = run('base', [failed('shows the fix'), test('still works')])
    expect(evaluate(base, [run('change 1', passing), run('change 2', passing)], { ...O, tests: [ID] }).verdict).toBe('regression')
    const result = evaluate(base, [run('change 1', passing), run('change 2', passing)], { ...O, tests: [ID, OTHER] })
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons).toEqual([`${OTHER}: passes on the base commit: proves nothing`])
  })

  it('rejects a named test that did not run', () => {
    const result = evaluate(run('base', [failed('shows the fix')]), [run('change 1', [test('shows the fix')])], { ...O, tests: ['A › typo'] })
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons[0]).toContain('A › typo: no such test')
  })

  it('is inconclusive when a run did not complete', () => {
    const result = evaluate(run('base', [], { outcome: 'build-failed', error: 'ERROR in x.ts' }), [run('change 1', passing)], O)
    expect(result.verdict).toBe('inconclusive')
    expect(result.reasons).toEqual(['base: the build failed: ERROR in x.ts'])
  })

  it('limits the evidence to observed when a gap touches a proving test', () => {
    const base = run('base', [failed('shows the fix'), test('still works')], { gaps: [gap({ tests: [ID] })] })
    const result = evaluate(base, [run('change 1', passing), run('change 2', passing)], O)
    expect(result.verdict).toBe('observed')
    expect(result.gaps).toHaveLength(1)
  })

  it('treats gaps without test attribution as touching every test', () => {
    const base = run('base', [failed('shows the fix')], { gaps: [gap()] })
    const result = evaluate(base, [run('change 1', [test('shows the fix')]), run('change 2', [test('shows the fix')])], O)
    expect(result.verdict).toBe('observed')
    expect(result.reasons[0]).toContain('does not attribute them to tests')
  })

  it('limits the evidence to observed when a gap concerns another test of a tested spec', () => {
    const base = run('base', [failed('shows the fix'), test('still works')], { gaps: [gap({ tests: [OTHER] })] })
    const result = evaluate(base, [run('change 1', passing), run('change 2', passing)], O)
    expect(result.verdict).toBe('observed')
    expect(result.reasons[0]).toContain('requests of the tested specs')
  })

  it('ignores expected gaps and gaps of other specs', () => {
    const elsewhere = gap({ tests: [testId('cypress/e2e/b.cy.ts', ['B', 'other'])] })
    const base = run('base', [failed('shows the fix'), test('still works')], { gaps: [gap({ expected: true }), elsewhere] })
    const result = evaluate(base, [run('change 1', passing), run('change 2', passing)], O)
    expect(result.verdict).toBe('regression')
    expect(result.gaps).toEqual([])
  })

  it('requires results from every spec in every change run', () => {
    const other = 'cypress/e2e/b.cy.ts'
    const result = evaluate(run('base', [failed('shows the fix')]), [run('change 1', [test('shows the fix')], { exitCode: 1 }), run('change 2', [test('shows the fix')], { exitCode: 1 })], { specs: [SPEC, other] })
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons).toEqual([
      `${other}: no test results in change 1 (the spec did not load, or has no tests)`,
      'change 1: Cypress reported 1 failures, but only 0 failed tests',
      `${other}: no test results in change 2 (the spec did not load, or has no tests)`,
      'change 2: Cypress reported 1 failures, but only 0 failed tests',
    ])
  })

  it('reports a named test that did not run once', () => {
    const result = evaluate(run('base', [failed('shows the fix')]), [run('change 1', [test('shows the fix')])], { ...O, tests: [ID, 'A › typo'] })
    expect(result.reasons.filter(r => r.startsWith('A › typo'))).toHaveLength(1)
  })
})

describe('gapTouches', () => {
  it('matches every test and hook of the spec, and unattributed gaps', () => {
    expect(gapTouches(gap({ tests: [ID] }), SPEC)).toBe(true)
    expect(gapTouches(gap({ tests: [`${ID} › after`] }), SPEC)).toBe(true)
    expect(gapTouches(gap({ tests: [`${SPEC} › before all`] }), SPEC)).toBe(true)
    expect(gapTouches(gap(), SPEC)).toBe(true)
    expect(gapTouches(gap({ tests: [testId('cypress/e2e/b.cy.ts', ['before all'])] }), SPEC)).toBe(false)
    expect(gapTouches(gap({ tests: [testId(`${SPEC}x`, ['T'])] }), SPEC)).toBe(false)
  })
})

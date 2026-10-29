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

describe('evaluate', () => {
  it('proves a test that fails on the base in its body and passes twice on the change', () => {
    const result = evaluate(run('base', [failed('shows the fix'), test('still works')]), [run('change 1', passing), run('change 2', passing)])
    expect(result.verdict).toBe('regression')
    expect(result.proving).toEqual([ID])
    expect(result.tests.find(t => t.id === OTHER)?.reason).toBe('passes on the base commit: proves nothing')
  })

  it('does not count a failure in a hook', () => {
    const result = evaluate(run('base', [failed('shows the fix', { failedIn: 'hook', hook: 'before each' }), test('still works')]), [run('change 1', passing), run('change 2', passing)])
    expect(result.verdict).toBe('not-proven')
    expect(result.tests[0]?.reason).toContain('before each hook')
  })

  it('does not count tests that pass on the base', () => {
    const result = evaluate(run('base', passing), [run('change 1', passing)])
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons).toEqual(['no test fails on the base commit in its own body and passes on the change'])
  })

  it('requires every test to pass on the change', () => {
    const result = evaluate(run('base', [failed('shows the fix'), test('still works')]), [run('change 1', [test('shows the fix'), failed('still works')]), run('change 2', [test('shows the fix'), failed('still works')])])
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons).toContain(`${OTHER}: fails on the change`)
  })

  it('reports a test that passes only once, or only on a retry, as flaky', () => {
    const flaky = evaluate(run('base', [failed('shows the fix')]), [run('change 1', [test('shows the fix')]), run('change 2', [failed('shows the fix')])])
    expect(flaky.verdict).toBe('not-proven')
    expect(flaky.reasons[0]).toBe(`${ID}: flaky on the change (passed, failed)`)
    const retried = evaluate(run('base', [failed('shows the fix')]), [run('change 1', [test('shows the fix', { attempts: 2 })]), run('change 2', [test('shows the fix')])])
    expect(retried.verdict).toBe('not-proven')
    expect(retried.reasons[0]).toContain('passed on attempt 2')
  })

  it('counts a test that the change adds to an existing spec', () => {
    const result = evaluate(run('base', [test('still works')]), [run('change 1', passing), run('change 2', passing)], [ID])
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons).toEqual([`${ID}: not run on the base commit`])
  })

  it('requires every named test to prove the change', () => {
    const base = run('base', [failed('shows the fix'), test('still works')])
    expect(evaluate(base, [run('change 1', passing), run('change 2', passing)], [ID]).verdict).toBe('regression')
    const result = evaluate(base, [run('change 1', passing), run('change 2', passing)], [ID, OTHER])
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons).toEqual([`${OTHER}: passes on the base commit: proves nothing`])
  })

  it('rejects a named test that did not run', () => {
    const result = evaluate(run('base', [failed('shows the fix')]), [run('change 1', [test('shows the fix')])], ['A › typo'])
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons[0]).toContain('A › typo: no such test')
  })

  it('is inconclusive when a run did not complete', () => {
    const result = evaluate(run('base', [], { outcome: 'build-failed', error: 'ERROR in x.ts' }), [run('change 1', passing)])
    expect(result.verdict).toBe('inconclusive')
    expect(result.reasons).toEqual(['base: the build failed: ERROR in x.ts'])
  })

  it('limits the evidence to observed when a gap touches a proving test', () => {
    const base = run('base', [failed('shows the fix'), test('still works')], { gaps: [gap({ tests: [ID] })] })
    const result = evaluate(base, [run('change 1', passing), run('change 2', passing)])
    expect(result.verdict).toBe('observed')
    expect(result.gaps).toHaveLength(1)
  })

  it('treats gaps without test attribution as touching every test', () => {
    const base = run('base', [failed('shows the fix')], { gaps: [gap()] })
    const result = evaluate(base, [run('change 1', [test('shows the fix')]), run('change 2', [test('shows the fix')])])
    expect(result.verdict).toBe('observed')
    expect(result.reasons[0]).toContain('does not attribute them to tests')
  })

  it('ignores expected gaps and gaps of other tests', () => {
    const base = run('base', [failed('shows the fix'), test('still works')], { gaps: [gap({ expected: true }), gap({ tests: [OTHER] })] })
    const result = evaluate(base, [run('change 1', passing), run('change 2', passing)])
    expect(result.verdict).toBe('regression')
    expect(result.gaps).toHaveLength(1)
  })
})

describe('gapTouches', () => {
  const t = { id: ID, spec: SPEC }
  it('matches the test, what follows it, and its spec\'s before-all hooks', () => {
    expect(gapTouches(gap({ tests: [ID] }), t)).toBe(true)
    expect(gapTouches(gap({ tests: [`${ID} › after`] }), t)).toBe(true)
    expect(gapTouches(gap({ tests: [`${SPEC} › before all`] }), t)).toBe(true)
    expect(gapTouches(gap({ tests: [OTHER] }), t)).toBe(false)
    expect(gapTouches(gap({ tests: [testId('cypress/e2e/b.cy.ts', ['before all'])] }), t)).toBe(false)
  })
})

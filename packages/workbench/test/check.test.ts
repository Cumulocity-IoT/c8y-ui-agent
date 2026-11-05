import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GapRecord } from '@cumulocity-iot/ui-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { check, checkResult } from '../src/check'
import { testId } from '../src/tests'
import type { TestResult, TestRun } from '../src/tests'

const SPEC = 'cypress/e2e/kpi.cy.ts'

function test(title: string, state: TestResult['state'], extra: Partial<TestResult> = {}): TestResult {
  return { id: testId(SPEC, ['KPI', title]), spec: SPEC, title: ['KPI', title], state, ...extra }
}

function gap(path: string, expected: boolean): GapRecord {
  return { kind: 'not-found', method: 'GET', path, status: 404, count: 1, firstAt: 1, lastAt: 1, expected }
}

function run(tests: TestResult[], extra: Partial<TestRun> = {}): TestRun {
  const failed = tests.filter(t => t.state === 'failed').length
  return { label: 'check', outcome: 'completed', exitCode: failed, tests, gaps: [], log: ['last line'], ...extra }
}

describe('checkResult', () => {
  it('passes when every test passed or is pending, and lists retried tests', () => {
    const result = checkResult('kpi', [], run([test('shows', 'passed'), test('later', 'pending'), test('flaky', 'passed', { attempts: 2 })]))
    expect(result).toMatchObject({ app: 'kpi', specs: [], status: 'passed', counts: { passed: 2, failed: 0, pending: 1, skipped: 0 }, failures: [] })
    expect(result.retried).toEqual([`${SPEC} › KPI › flaky`])
    expect(result.log).toBeUndefined()
    expect(result.error).toBeUndefined()
  })

  it('fails on a failed test, and on a test skipped after a failed hook', () => {
    const failed = test('breaks', 'failed', { failedIn: 'test', error: 'AssertionError: expected 1 to equal 2' })
    const hook = test('setup', 'failed', { failedIn: 'hook', hook: 'before each' })
    const skipped = test('after setup', 'skipped')
    const result = checkResult('kpi', [SPEC], run([test('shows', 'passed'), failed, hook, skipped]))
    expect(result.status).toBe('failed')
    expect(result.failures).toEqual([failed, hook, skipped])
    expect(result.counts).toEqual({ passed: 1, failed: 2, pending: 0, skipped: 1 })
    expect(result.log).toEqual(['last line'])
    expect(result.error).toBeUndefined()
  })

  it('fails when Cypress counts failures without a failed test: a spec did not load or ended early', () => {
    const result = checkResult('kpi', [], run([test('shows', 'passed')], { exitCode: 1 }))
    expect(result.status).toBe('failed')
    expect(result.failures).toEqual([])
    expect(result.error).toContain('1 failure(s) without a failed test')
  })

  it('fails when a named spec reports no tests', () => {
    const other = 'cypress/e2e/other.cy.ts'
    const result = checkResult('kpi', [SPEC, other], run([test('shows', 'passed')]))
    expect(result.status).toBe('failed')
    expect(result.error).toBe(`${other}: no test results (the spec did not load, does not match the Cypress config's specPattern, or has no tests)`)
  })

  it('matches named specs relative to the e2e root', () => {
    expect(checkResult('kpi', [`test/${SPEC}`], run([test('shows', 'passed')]), 'test').status).toBe('passed')
    expect(checkResult('kpi', [SPEC], run([test('shows', 'passed')]), 'test').status).toBe('failed')
  })

  it('is an error when every test is pending', () => {
    const result = checkResult('kpi', [SPEC], run([test('later', 'pending'), test('much later', 'pending')]))
    expect(result).toMatchObject({ status: 'error', error: 'no test ran: all 2 tests are pending' })
  })

  it('fails on skipped tests even when the exit code is 0', () => {
    expect(checkResult('kpi', [], run([test('shows', 'passed'), test('skipped', 'skipped')], { exitCode: 0 })).status).toBe('failed')
  })

  it('lists a test that failed after retries as a failure, not as retried', () => {
    const flaky = test('flaky', 'failed', { failedIn: 'test', attempts: 3 })
    const result = checkResult('kpi', [], run([test('shows', 'passed'), flaky]))
    expect(result).toMatchObject({ status: 'failed', failures: [flaky], retried: [] })
  })

  it('passes build failures and errors through', () => {
    expect(checkResult('kpi', [], { label: 'check', outcome: 'build-failed', tests: [], gaps: [], error: 'Failed to compile', log: ['x'] }))
      .toMatchObject({ status: 'build-failed', error: 'Failed to compile', log: ['x'] })
    expect(checkResult('kpi', [], { label: 'check', outcome: 'error', exitCode: 0, tests: [], gaps: [], error: 'Cypress reported no tests' }))
      .toMatchObject({ status: 'error', error: 'Cypress reported no tests' })
  })

  it('reports only unexpected gaps', () => {
    const result = checkResult('kpi', [], run([test('shows', 'passed')], { gaps: [gap('/service/x', false), gap('/favicon.ico', true)] }))
    expect(result.gaps.map(g => g.path)).toEqual(['/service/x'])
  })
})

describe('check', () => {
  let repo: string
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'workbench-check-'))
    mkdirSync(join(repo, 'cypress/e2e'), { recursive: true })
    writeFileSync(join(repo, SPEC), '')
  })
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('rejects specs outside the repository, missing, or not files, before anything starts', async () => {
    const target = { repo, world: 'world.json' }
    await expect(check({ target, app: 'kpi', specs: ['../x.cy.ts'] })).rejects.toThrow('spec ../x.cy.ts is outside the repository')
    await expect(check({ target, app: 'kpi', specs: [SPEC, 'cypress/e2e/missing.cy.ts'] })).rejects.toThrow('spec cypress/e2e/missing.cy.ts is not a file')
    await expect(check({ target, app: 'kpi', specs: ['.'] })).rejects.toThrow('spec . is not a file')
    await expect(check({ target, app: 'kpi', specs: ['cypress'] })).rejects.toThrow('spec cypress is not a file')
    await expect(check({ target, app: 'kpi', specs: [SPEC] })).rejects.toThrow('no app kpi')
  })
})

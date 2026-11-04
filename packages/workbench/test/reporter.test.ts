// The reporter against a runner shaped like Cypress' (observed with Cypress 15.15): `test end` once per test after
// its last attempt, hook failures as failed tests with `hookName`, no event for tests a failed hook skipped.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readResults, REPORTER } from '../src/tests'

interface Node { id: string, title: string, parent?: Suite, pending?: boolean, state?: string, hookName?: string, err?: { message: string }, _currentRetry?: number }
interface Suite { title: string, parent?: Suite, tests: Node[], suites: Suite[], file?: string }

const Reporter = createRequire(import.meta.url)(REPORTER) as new (runner: EventEmitter & { suite: Suite }) => unknown

function suite(title: string, parent?: Suite): Suite {
  const s: Suite = { title, parent, tests: [], suites: [] }
  parent?.suites.push(s)
  return s
}
function node(id: string, title: string, parent: Suite, extra: Partial<Node> = {}): Node {
  const n: Node = { id, title, parent, ...extra }
  parent.tests.push(n)
  return n
}

describe('reporter', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reporter-'))
    process.env.C8Y_WORKBENCH_RESULTS = join(dir, 'results.jsonl')
  })
  afterEach(() => {
    delete process.env.C8Y_WORKBENCH_RESULTS
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes every test with its outcome', () => {
    const root = suite('')
    root.file = 'cypress/e2e/probe.cy.ts'
    const outer = suite('outer', root)
    const hooked = suite('hooked', outer)
    const tests = {
      passes: node('r1', 'passes', outer),
      fails: node('r2', 'fails', outer),
      pending: node('r3', 'pending', outer, { pending: true }),
      retried: node('r4', 'retried', outer),
      first: node('r5', 'first', hooked),
      skipped: node('r6', 'skipped', hooked),
    }
    const runner = Object.assign(new EventEmitter(), { suite: root })
    void new Reporter(runner)
    // Cypress emits copies, not the tree's objects.
    const end = (n: Node, extra: Partial<Node>): void => void runner.emit('test end', { ...n, ...extra })
    end(tests.passes, { state: 'passed' })
    end(tests.fails, { state: 'failed', err: { message: 'expected 1 to equal 2' } })
    end(tests.retried, { state: 'passed', _currentRetry: 2 })
    end(tests.first, { state: 'failed', hookName: 'before each', err: { message: 'hook boom' } })
    runner.emit('end')

    const results = readResults(process.env.C8Y_WORKBENCH_RESULTS!)
    expect(results.map(r => [r.id, r.state, r.failedIn, r.hook, r.attempts])).toEqual([
      ['cypress/e2e/probe.cy.ts › outer › passes', 'passed', undefined, undefined, undefined],
      ['cypress/e2e/probe.cy.ts › outer › fails', 'failed', 'test', undefined, undefined],
      ['cypress/e2e/probe.cy.ts › outer › pending', 'pending', undefined, undefined, undefined],
      ['cypress/e2e/probe.cy.ts › outer › retried', 'passed', undefined, undefined, 3],
      ['cypress/e2e/probe.cy.ts › outer › hooked › first', 'failed', 'hook', 'before each', undefined],
      ['cypress/e2e/probe.cy.ts › outer › hooked › skipped', 'skipped', undefined, undefined, undefined],
    ])
    expect(results[1]?.error).toBe('expected 1 to equal 2')
  })

  it('appends the specs of one run', () => {
    for (const file of ['a.cy.ts', 'b.cy.ts']) {
      const root = suite('')
      root.file = file
      const n = node('r1', 'works', root)
      const runner = Object.assign(new EventEmitter(), { suite: root })
      void new Reporter(runner)
      runner.emit('test end', { ...n, state: 'passed' })
      runner.emit('end')
    }
    expect(readResults(process.env.C8Y_WORKBENCH_RESULTS!).map(r => r.id)).toEqual(['a.cy.ts › works', 'b.cy.ts › works'])
  })
})

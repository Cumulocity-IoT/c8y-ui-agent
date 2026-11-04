// A Cypress (Mocha) reporter: writes the outcome of every test to the file in C8Y_WORKBENCH_RESULTS, one JSON line
// per test. runTests sets it with CYPRESS_REPORTER, which takes precedence over the reporter of the repository's
// Cypress config. CommonJS without dependencies: Cypress requires it in its own Node.
//
// Cypress reports each test once in `test end` (after its last retry), a failed hook as a failed test with `hookName`
// ('before each', 'before all', 'after each', …). Tests that a failed hook skipped get no event.
'use strict'
const { appendFileSync } = require('node:fs')

const titlePath = runnable => (runnable.parent ? [...titlePath(runnable.parent), runnable.title] : []).filter(Boolean)
const key = test => test.id || JSON.stringify(titlePath(test))

function WorkbenchReporter(runner) {
  const file = process.env.C8Y_WORKBENCH_RESULTS
  const ended = new Map()
  runner.on('test end', test => ended.set(key(test), test))
  runner.once('end', () => {
    const spec = runner.suite.file || ''
    const lines = []
    const visit = (suite) => {
      for (const node of suite.tests) {
        const test = ended.get(key(node))
        let result
        if (!test)
          result = { state: node.pending ? 'pending' : 'skipped' }
        else if (test.state === 'failed') {
          const error = String((test.err && (test.err.message || test.err)) || '').slice(0, 2000)
          result = test.hookName ? { state: 'failed', failedIn: 'hook', hook: test.hookName, error } : { state: 'failed', failedIn: 'test', error }
        }
        else
          result = { state: test.state === 'passed' ? 'passed' : test.pending ? 'pending' : 'skipped' }
        if (test && test._currentRetry > 0)
          result.attempts = test._currentRetry + 1
        lines.push(JSON.stringify({ spec, title: titlePath(node), ...result }))
      }
      suite.suites.forEach(visit)
    }
    visit(runner.suite)
    if (file && lines.length)
      appendFileSync(file, `${lines.join('\n')}\n`)
  })
}

module.exports = WorkbenchReporter

#!/usr/bin/env node
// c8y-ui-apply: the agent job's bundle and result check, and the apply job's check and writes. See docs/result.md.
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { apply } from './apply'
import { bundle } from './bundle'
import { check, UsageError } from './check'
import type { CheckOptions } from './check'
import { GitHub } from './github'
import { parseResult } from './result'

const USAGE = `Usage:
  c8y-ui-apply validate <result.json>        check result.json (for the agent; exit 1 with the errors)
  c8y-ui-apply bundle --base <sha> --out <file> [--dir <checkout>]
                                             the agent's commits since the base as a git bundle
  c8y-ui-apply check <options>               check result and bundle in a fresh checkout; no token
  c8y-ui-apply apply <options> --bot-login <login> [--run-url <url>]
                                             check again, then push, open the pull request, label and comment;
                                             token in GH_TOKEN, repository in GITHUB_REPOSITORY

Options of check and apply:
  --result <file>          result.json of the agent job
  --bundle <file>          its git bundle, if it made commits
  --base <sha>             the commit the run started from (from the workflow, not the agent job)
  --default-branch <name>  the repository's default branch
  --number <n>             the issue or pull request of the run
  --playbook <name>        the run's playbook
  --dir <checkout>         the fresh checkout, with fetch-depth 0 (default: the working directory)
  --default-ref <ref>      the default branch in the checkout (default: origin/<default-branch>)
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'result': { type: 'string' },
    'bundle': { type: 'string' },
    'base': { type: 'string' },
    'default-branch': { type: 'string' },
    'default-ref': { type: 'string' },
    'number': { type: 'string' },
    'playbook': { type: 'string' },
    'dir': { type: 'string' },
    'out': { type: 'string' },
    'bot-login': { type: 'string' },
    'run-url': { type: 'string' },
    'help': { type: 'boolean', short: 'h' },
  },
})

const out = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
// One line per message: a newline in the agent's text must not start a line the runner reads as a workflow command.
const log = (line: string): void => void process.stderr.write(`${line.replace(/[\r\n]+/g, ' ')}\n`)

function required(name: keyof typeof values): string {
  const value = values[name]
  if (typeof value !== 'string' || value === '')
    throw new UsageError(`--${name} is required\n\n${USAGE}`)
  return value
}

function checkOptions(): CheckOptions {
  return {
    dir: resolve(values.dir ?? '.'),
    resultFile: resolve(required('result')),
    bundleFile: values.bundle ? resolve(values.bundle) : undefined,
    base: required('base'),
    defaultBranch: required('default-branch'),
    defaultRef: values['default-ref'],
    number: Number(required('number')),
    playbook: required('playbook'),
  }
}

/** A step output for the workflow, when run in GitHub Actions. */
function output(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

async function main(): Promise<number> {
  const [command, file] = positionals
  if (values.help || !command) {
    process.stdout.write(USAGE)
    return values.help ? 0 : 2
  }
  switch (command) {
    case 'validate': {
      if (!file)
        throw new UsageError('validate needs a result.json')
      const parsed = parseResult(readFileSync(file, 'utf8'))
      if (parsed.ok) {
        log('result.json is valid')
        return 0
      }
      for (const error of parsed.errors)
        log(error)
      return 1
    }
    case 'bundle': {
      const result = bundle({ dir: resolve(values.dir ?? '.'), base: required('base'), file: resolve(required('out')) })
      if (result.uncommitted.length > 0)
        log(`not in the bundle, because not committed: ${result.uncommitted.join(', ')}`)
      out(result)
      return 0
    }
    case 'check': {
      const report = check(checkOptions())
      output('ok', String(report.ok))
      for (const violation of report.violations)
        log(`${violation.rule}: ${violation.message}`)
      out({ ...report, result: undefined })
      return 0
    }
    case 'apply': {
      const token = process.env.GH_TOKEN
      const repository = process.env.GITHUB_REPOSITORY
      if (!token || !repository)
        throw new UsageError('apply needs GH_TOKEN and GITHUB_REPOSITORY in the environment')
      const applied = await apply({
        ...checkOptions(),
        github: new GitHub({ token, repository }),
        repository,
        token,
        botLogin: required('bot-login'),
        runUrl: values['run-url'],
        log,
      })
      if (applied.pullRequest)
        output('pull-request', String(applied.pullRequest.number))
      out({ ok: applied.ok, error: applied.error, violations: applied.report.violations, pullRequest: applied.pullRequest, comment: applied.comment })
      return applied.ok ? 0 : 1
    }
    default:
      throw new UsageError(`unknown command ${command}\n\n${USAGE}`)
  }
}

main().then((code) => {
  process.exitCode = code
}, (error: unknown) => {
  log(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
})

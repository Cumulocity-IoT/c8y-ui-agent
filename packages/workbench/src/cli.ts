#!/usr/bin/env node
// c8y-ui-workbench: the MCP server (default), or its tools from a shell.
import { basename, dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { check } from './check'
import { PreviewError, Previews } from './preview'
import { proveRegression } from './regression'
import { checkLanguage, Screenshots, VIEWPORT } from './screenshot'
import { serve, version } from './server'
import { listApps, WorkbenchError } from './target'
import type { AuthMode, Target } from './target'
import { errorMessage } from './util'

const USAGE = `c8y-ui-workbench ${version}

Usage:
  c8y-ui-workbench [mcp] [options]                  MCP server on stdio
  c8y-ui-workbench apps [options]                   list the apps
  c8y-ui-workbench preview <app> [options]          serve an app until Ctrl+C
  c8y-ui-workbench screenshot <app> [options] [--path <route>] [--wait-for <css>] [--selector <css>] [--full-page]
                   [--width <px>] [--height <px>] [--language <code>] [--out <file>]
  c8y-ui-workbench check <app> [options] [--spec <file>]…
  c8y-ui-workbench prove-regression <app> [options] [--base <commit>] [--spec <file>]… [--test <name>]…

Options:
  --repo <dir>          the repository (default: the working directory)
  --world <file>        world file for the emulator, relative to the repository (required for all but apps)
  --e2e-root <dir>      Cypress project directory, relative to the repository (default: the repository)
  --e2e-config <file>   Cypress config file, relative to the e2e root; {app} is replaced by the app name
  --e2e-auth <mode>     emulator login mode in e2e runs: open (default) or login
  --e2e-env <K=V>       more Cypress environment, repeatable; {devUrl} and {mockUrl} are replaced
  --screenshots <dir>   directory for screenshots (default: a new private directory in the temp directory)
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'repo': { type: 'string' },
    'world': { type: 'string' },
    'e2e-root': { type: 'string' },
    'e2e-config': { type: 'string' },
    'e2e-auth': { type: 'string' },
    'e2e-env': { type: 'string', multiple: true },
    'screenshots': { type: 'string' },
    'path': { type: 'string' },
    'wait-for': { type: 'string' },
    'selector': { type: 'string' },
    'full-page': { type: 'boolean' },
    'width': { type: 'string' },
    'height': { type: 'string' },
    'language': { type: 'string' },
    'out': { type: 'string' },
    'base': { type: 'string' },
    'spec': { type: 'string', multiple: true },
    'test': { type: 'string', multiple: true },
    'help': { type: 'boolean', short: 'h' },
  },
})

function target(): Target {
  const auth = values['e2e-auth']
  if (auth !== undefined && auth !== 'open' && auth !== 'login')
    throw new WorkbenchError(`--e2e-auth must be open or login, not ${auth}`)
  const env = Object.fromEntries((values['e2e-env'] ?? []).map((pair) => {
    const at = pair.indexOf('=')
    if (at < 1)
      throw new WorkbenchError(`--e2e-env takes KEY=VALUE, not ${pair}`)
    return [pair.slice(0, at), pair.slice(at + 1)]
  }))
  return {
    repo: resolve(values.repo ?? '.'),
    world: values.world ?? '',
    e2eRoot: values['e2e-root'],
    e2eConfig: values['e2e-config'],
    e2eAuth: auth as AuthMode | undefined,
    e2eEnv: env,
    screenshots: values.screenshots && resolve(values.screenshots),
  }
}

function requireWorld(t: Target): Target {
  if (!t.world)
    throw new WorkbenchError('--world is required')
  return t
}

function pixels(option: 'width' | 'height'): number | undefined {
  const value = values[option]
  if (value === undefined)
    return undefined
  const { min, max } = VIEWPORT[option]
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    throw new WorkbenchError(`--${option} takes ${min} to ${max} pixels, not ${value}`)
  return Number(value)
}

/**
 * Aborts on SIGINT and SIGTERM, so that dev servers, Cypress, worktrees and temp files are cleaned up. Further signals
 * must not kill the process before that: the dev server runs in its own process group and would outlive it.
 */
function interruptible(progress: (line: string) => void): AbortSignal {
  const abort = new AbortController()
  const stop = (): void => {
    if (!abort.signal.aborted)
      progress('interrupted: cleaning up …')
    abort.abort(new Error('interrupted'))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return abort.signal
}

async function main(): Promise<void> {
  const [command = 'mcp', app] = positionals
  if (values.help) {
    process.stdout.write(USAGE)
    return
  }
  const progress = (line: string): void => void process.stderr.write(`${line}\n`)
  switch (command) {
    case 'mcp':
      return serve(target())
    case 'apps':
      process.stdout.write(`${JSON.stringify(listApps(target().repo), null, 2)}\n`)
      return
    case 'preview': {
      if (!app)
        throw new WorkbenchError('preview needs an app')
      const previews = new Previews(requireWorld(target()))
      const preview = await previews.up(app)
      process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`)
      // The dev server runs in its own process group: stop it on SIGTERM too, or it outlives the preview.
      const stop = (): void => void previews.closeAll()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      await previews.ended(preview.id)
      return
    }
    case 'screenshot': {
      if (!app)
        throw new WorkbenchError('screenshot needs an app')
      const t = requireWorld(target())
      // Check the options before the preview starts, which takes minutes.
      const width = pixels('width')
      const height = pixels('height')
      if (values.language !== undefined)
        checkLanguage(values.language)
      const out = values.out ? resolve(values.out) : undefined
      const screenshots = new Screenshots(out ? dirname(out) : t.screenshots)
      const previews = new Previews(t)
      const signal = interruptible(progress)
      try {
        const preview = await previews.up(app, signal)
        progress(`preview ${preview.url}`)
        const shot = await screenshots.take({
          url: preview.url,
          mockUrl: preview.mockUrl,
          path: values.path,
          waitFor: values['wait-for'],
          selector: values.selector,
          fullPage: values['full-page'],
          width,
          height,
          language: values.language,
          file: screenshots.file(preview.id, out && basename(out)),
          signal,
        })
        process.stdout.write(`${JSON.stringify(shot, null, 2)}\n`)
      }
      finally {
        await Promise.all([previews.closeAll(), screenshots.close()])
      }
      return
    }
    case 'check': {
      if (!app)
        throw new WorkbenchError('check needs an app')
      const t = requireWorld(target())
      const signal = interruptible(progress)
      const result = await check({ target: t, app, specs: values.spec, signal, log: progress })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      process.exitCode = result.status === 'passed' ? 0 : 1
      return
    }
    case 'prove-regression': {
      if (!app)
        throw new WorkbenchError('prove-regression needs an app')
      const signal = interruptible(progress)
      const result = await proveRegression({ target: requireWorld(target()), app, base: values.base, specs: values.spec, tests: values.test, log: progress, signal })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      process.exitCode = result.verdict === 'regression' ? 0 : 1
      return
    }
    default:
      throw new WorkbenchError(`unknown command ${command}\n\n${USAGE}`)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`)
  if (error instanceof PreviewError)
    process.stderr.write(`\nLast output:\n${error.log.join('\n')}\n`)
  process.exit(2)
})

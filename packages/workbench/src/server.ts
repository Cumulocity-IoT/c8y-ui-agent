// The workbench as a Model Context Protocol (MCP) server on stdio. Nothing else may write to stdout: every child
// process' output goes to a callback (runTests, Previews) or to stderr.
import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { PreviewError, Previews } from './preview'
import { proveRegression } from './regression'
import { listApps } from './target'
import type { Target } from './target'
import { errorMessage } from './util'

// Read at runtime: semantic-release sets the version after the build.
export const version: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })

const failure = (error: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: [errorMessage(error), ...(error instanceof PreviewError ? ['', 'Last output:', ...error.log] : [])].join('\n') }],
})

export interface Workbench {
  server: McpServer
  previews: Previews
  /** Abort a running proof and wait for its cleanup (worktrees, dev servers). */
  stopProof: () => Promise<void>
}

export function createServer(target: Target): Workbench {
  const server = new McpServer({ name: 'c8y-ui-workbench', version })
  const previews = new Previews(target)
  // One proof at a time: two would share the checkout's .git/worktrees and compete for CPU, which makes tests flaky.
  let proof: { abort: AbortController, done: Promise<unknown> } | undefined

  server.registerTool('list_apps', {
    title: 'List apps',
    description: 'The apps of the repository that preview_up and prove_regression take: Angular projects with a serve target, by folder name.',
    annotations: { readOnlyHint: true },
  }, async () => json(listApps(target.repo)))

  server.registerTool('preview_up', {
    title: 'Start a preview',
    description: 'Serve an app of the working tree with its dev server (ng serve) on the emulated Cumulocity tenant of the Cumulocity UI SDK, '
      + 'and return the URL to open: the shell with the app loaded, no login needed. Takes 1 to 3 minutes. The dev server rebuilds on file changes; '
      + 'preview_log shows build errors. Stop it with preview_down.',
    inputSchema: { app: z.string().describe('App name from list_apps') },
  }, async ({ app }, extra) => {
    try {
      return json(await previews.up(app, extra.signal))
    }
    catch (error) {
      return failure(error)
    }
  })

  server.registerTool('preview_log', {
    title: 'Preview output',
    description: 'The last lines of a preview\'s dev server output, e.g. build errors after a change.',
    inputSchema: { id: z.string(), lines: z.number().int().min(1).max(400).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ id, lines }) => {
    const log = previews.log(id, lines)
    return log ? { content: [{ type: 'text', text: log.join('\n') || '(no output)' }] } : failure(`no preview ${id}; running: ${previews.list().map(p => p.id).join(', ') || 'none'}`)
  })

  server.registerTool('preview_down', {
    title: 'Stop previews',
    description: 'Stop a preview, or all previews when no id is given.',
    inputSchema: { id: z.string().optional() },
  }, async ({ id }) => {
    if (!id) {
      const ids = previews.list().map(p => p.id)
      await previews.closeAll()
      return json({ stopped: ids })
    }
    return (await previews.down(id)) ? json({ stopped: [id] }) : failure(`no preview ${id}`)
  })

  server.registerTool('prove_regression', {
    title: 'Prove a regression',
    description: 'Prove that e2e (Cypress) tests show the change: run them on the base commit without the product change, then twice on the working tree, '
      + 'all on the emulated tenant. Verdict "regression": the tests fail on the base in their own body and pass on the change. "observed": the same, '
      + 'but an emulator gap may explain it. "not-proven": they pass on the base, fail only in a hook, or fail or are flaky on the change. '
      + '"inconclusive": a build or run failed. Test files are the files under the e2e root; everything else counts as the product change. '
      + 'Both sides run in git worktrees with a fresh install; files git ignores reach neither. Commit or keep the change in the working tree; '
      + 'it is not modified. One proof at a time; takes 2 to 10 minutes.',
    inputSchema: {
      app: z.string().describe('App name from list_apps'),
      base: z.string().optional().describe('Commit without the change (default: merge base with the remote default branch)'),
      specs: z.array(z.string()).optional().describe('Spec files relative to the repository (default: the changed spec files)'),
      tests: z.array(z.string()).optional().describe('Tests that must prove the change, as "<spec> › <suite> › <test>" with the spec relative to the e2e root (default: any test of the specs)'),
    },
  }, async ({ app, base, specs, tests }, extra) => {
    if (proof)
      return failure('a proof is already running; wait for its result')
    const token = extra._meta?.progressToken
    let step = 0
    const log = (message: string): void => {
      if (token !== undefined)
        extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } }).catch(() => {})
    }
    const abort = new AbortController()
    const run = proveRegression({ target, app, base, specs, tests, signal: AbortSignal.any([extra.signal, abort.signal]), log })
    proof = { abort, done: run.catch(() => {}) }
    try {
      return json(await run)
    }
    catch (error) {
      return failure(error)
    }
    finally {
      proof = undefined
    }
  })

  const stopProof = async (): Promise<void> => {
    if (!proof)
      return
    proof.abort.abort(new Error('the workbench stops'))
    await proof.done
  }
  return { server, previews, stopProof }
}

export async function serve(target: Target): Promise<void> {
  const { server, previews, stopProof } = createServer(target)
  let closing = false
  const shutdown = async (): Promise<void> => {
    if (closing)
      return
    closing = true
    await Promise.all([stopProof(), previews.closeAll()])
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
  process.stdin.once('end', () => void shutdown())
  await server.connect(new StdioServerTransport())
}

// preview_up: an app on the emulated tenant, served by its own dev server (`ng serve`), as a URL that opens without a
// login. Previews run until preview_down or until the workbench stops.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { startDev } from '@cumulocity-iot/ui-sdk'
import type { DevSession } from '@cumulocity-iot/ui-sdk'
import { resolveApp, worldFile } from './target'
import type { Target } from './target'
import { errorMessage, freePort, LogTail } from './util'

export interface Preview {
  id: string
  app: string
  /** Open this: the shell with the app's dev build, or the standalone app. */
  url: string
  devUrl: string
  mockUrl: string
  startedAt: string
}

interface Running {
  preview: Preview
  session: DevSession
  log: LogTail
}

export class PreviewError extends Error {
  override name = 'PreviewError'
  constructor(message: string, readonly log: string[]) {
    super(message)
  }
}

/**
 * startDev runs `pnpm exec ng serve` in the app's directory, and pnpm finds no `ng` in a workspace package: the
 * Angular CLI is installed at the workspace root. Add the root's bin directory to the PATH, which pnpm exec searches
 * too. At the end: the repository's bins must not shadow git, pnpm or node for the workbench's other processes.
 * Not needed once startDev takes an Angular project, as runE2e does.
 */
function useWorkspaceBin(repo: string, dir: string): void {
  const bin = join(repo, 'node_modules', '.bin')
  const path = process.env.PATH ?? ''
  if (dir && existsSync(bin) && !path.split(delimiter).includes(bin))
    process.env.PATH = `${path}${delimiter}${bin}`
}

export class Previews {
  private readonly running = new Map<string, Running>()
  private next = 1

  constructor(private readonly target: Target) {}

  /** Start a preview of `app`; rejects with the dev server's last output when it does not come up. */
  async up(app: string, signal?: AbortSignal): Promise<Preview> {
    const resolved = resolveApp(this.target.repo, app)
    useWorkspaceBin(this.target.repo, resolved.dir)
    const log = new LogTail()
    let session: DevSession
    try {
      session = await startDev({
        // `ng serve` in the app's directory: the Angular CLI serves the project that contains the working directory.
        root: join(this.target.repo, resolved.dir),
        config: resolved.config,
        world: worldFile(this.target),
        auth: 'open',
        watch: false,
        port: await freePort(),
        devPort: await freePort(),
        output: log.push,
        log: log.push,
        signal,
      })
    }
    catch (error) {
      throw new PreviewError(`${app}: the preview did not start: ${errorMessage(error)}`, log.tail(60))
    }
    const id = `preview-${this.next++}`
    const preview: Preview = { id, app: resolved.name, url: session.appUrl, devUrl: session.devUrl, mockUrl: session.mockUrl, startedAt: new Date().toISOString() }
    this.running.set(id, { preview, session, log })
    // A dev server that stops on its own ends the preview.
    void session.done.then(() => this.running.delete(id))
    return preview
  }

  /** Resolves when the preview has ended: preview_down, or its dev server stopped on its own. */
  ended(id: string): Promise<void> {
    return this.running.get(id)?.session.done.then(() => {}) ?? Promise.resolve()
  }

  list(): Preview[] {
    return [...this.running.values()].map(r => r.preview)
  }

  /** The last lines of a preview's dev server output: build errors after a change. */
  log(id: string, lines = 60): string[] | undefined {
    return this.running.get(id)?.log.tail(lines)
  }

  /** Stop one preview; false when there is none with this id. */
  async down(id: string): Promise<boolean> {
    const running = this.running.get(id)
    if (!running)
      return false
    this.running.delete(id)
    await running.session.close()
    return true
  }

  async closeAll(): Promise<void> {
    const all = [...this.running.values()]
    this.running.clear()
    await Promise.all(all.map(r => r.session.close()))
  }
}

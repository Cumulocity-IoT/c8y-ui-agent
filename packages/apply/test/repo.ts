// Temporary git repositories: an origin, a fresh checkout as the apply job has it, and the agent's checkout.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const run = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim()

export function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

export function commit(dir: string, files: Record<string, string>, message = 'change'): string {
  write(dir, files)
  run(dir, 'add', '-A')
  run(dir, 'commit', '--quiet', '-m', message)
  return run(dir, 'rev-parse', 'HEAD')
}

export interface Repos {
  root: string
  origin: string
  /** The apply job's fresh checkout. */
  fresh: string
  /** The agent's checkout, at the base. */
  agent: string
  base: string
  /** Clone origin again into `fresh`, as a new apply job would. */
  refresh: () => void
  cleanup: () => void
}

export function repos(files: Record<string, string> = { 'src/app.ts': 'export {}\n' }): Repos {
  const root = mkdtempSync(join(tmpdir(), 'c8y-ui-apply-'))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  run(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
  run(root, 'init', '--quiet', '--initial-branch=main', seed)
  const base = commit(seed, files, 'initial')
  run(seed, 'push', '--quiet', origin, 'main')
  const fresh = join(root, 'fresh')
  const agent = join(root, 'agent')
  run(root, 'clone', '--quiet', origin, agent)
  const refresh = (): void => {
    rmSync(fresh, { recursive: true, force: true })
    run(root, 'clone', '--quiet', origin, fresh)
  }
  refresh()
  return { root, origin, fresh, agent, base, refresh, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

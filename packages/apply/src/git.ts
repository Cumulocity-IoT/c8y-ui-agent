// git in the apply job's fresh checkout. No hooks, no fsmonitor, no pager, no prompts: the checkout's configuration comes
// from actions/checkout, but git must not run code from anything the agent produced.
import { execFileSync } from 'node:child_process'

export class GitError extends Error {}

export interface Git {
  (args: string[], options?: { env?: Record<string, string>, allowFail?: boolean }): string
  dir: string
}

const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'protocol.ext.allow=never']

export function git(dir: string): Git {
  const run = ((args: string[], options: { env?: Record<string, string>, allowFail?: boolean } = {}): string => {
    try {
      return execFileSync('git', [...SAFE, ...args], {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', ...options.env },
      })
    }
    catch (error) {
      if (options.allowFail)
        return ''
      const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
      throw new GitError(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`)
    }
  }) as Git
  run.dir = dir
  return run
}

/** Whether `ancestor` is an ancestor of `descendant`, or the same commit. */
export function isAncestor(run: Git, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', [...SAFE, 'merge-base', '--is-ancestor', ancestor, descendant], { cwd: run.dir, stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

/** The commit a revision names, or undefined. */
export function resolve(run: Git, rev: string): string | undefined {
  return run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true }).trim() || undefined
}

// The agent job's last step: its commits since the base, as one git bundle for the apply job. Uncommitted changes are
// not part of the result.
import { existsSync, rmSync } from 'node:fs'
import { git, isAncestor, resolve } from './git'

export interface BundleOptions {
  /** The agent's checkout. */
  dir: string
  /** The commit the run started from. */
  base: string
  /** The bundle file to write. */
  file: string
}

export interface Bundled {
  /** Undefined when the run made no commits: no bundle is written. */
  file?: string
  head: string
  commits: number
  /** Changed files the agent did not commit. */
  uncommitted: string[]
}

export function bundle(options: BundleOptions): Bundled {
  const run = git(options.dir)
  const head = resolve(run, 'HEAD')
  if (!head)
    throw new Error(`no commit checked out in ${options.dir}`)
  if (!resolve(run, options.base))
    throw new Error(`the base ${options.base} is not in ${options.dir}`)
  if (!isAncestor(run, options.base, head))
    throw new Error(`HEAD ${head.slice(0, 12)} does not descend from the base ${options.base.slice(0, 12)}`)
  const entries = run(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean)
  const uncommitted: string[] = []
  for (let i = 0; i < entries.length; i++) {
    uncommitted.push(entries[i]!.slice(3))
    // A rename or copy is followed by its source path.
    if (/^[RC]/.test(entries[i]!))
      i++
  }
  const commits = Number(run(['rev-list', '--count', `${options.base}..${head}`]).trim())
  if (existsSync(options.file))
    rmSync(options.file)
  if (commits === 0)
    return { head, commits, uncommitted }
  // One head, named HEAD; the base is the bundle's prerequisite, so it holds only the new commits.
  run(['bundle', 'create', '--quiet', options.file, 'HEAD', `^${options.base}`])
  return { file: options.file, head, commits, uncommitted }
}

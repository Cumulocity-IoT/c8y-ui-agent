// Protected paths (D2, D16): files the agent's commits must not add, change, delete, or rename. See docs/result.md.
import { posix } from 'node:path'

export interface Violation {
  rule: string
  file?: string
  message: string
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
/** A changed lockfile needs one of these changed in its package: a dependency change, not only a new resolution. */
const MANIFESTS = ['package.json', 'pnpm-workspace.yaml']

const segments = (path: string): string[] => path.toLowerCase().split('/')
const name = (path: string): string => posix.basename(path).toLowerCase()

/**
 * Built-in rules. Matching ignores case: a checkout on macOS or Windows reads `.Claude/` and `claude.md` as well.
 */
const RULES: Array<{ rule: string, matches: (path: string) => boolean, why: string }> = [
  { rule: 'github', matches: p => segments(p)[0] === '.github', why: 'workflows and repository automation' },
  { rule: 'agent-config', matches: p => segments(p)[0] === '.c8y-agent', why: 'the agent configuration' },
  {
    rule: 'agent-instructions',
    matches: p => segments(p).includes('.claude') || ['agents.md', 'claude.md', 'claude.local.md', '.mcp.json'].includes(name(p)),
    why: 'instructions and tools for agents',
  },
  {
    rule: 'package-sources',
    matches: p => ['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.pnpmfile.cjs', '.pnpmfile.mjs'].includes(name(p))
      || segments(p)[0] === '.gitmodules'
      || /^\.yarn\/(?:releases|plugins)\//.test(p.toLowerCase()),
    why: 'where code and packages come from, or code that runs on install',
  },
  {
    rule: 'developer-tools',
    matches: p => ['.husky', '.vscode', '.devcontainer'].includes(segments(p)[0]!),
    why: 'code that runs on developers\' machines',
  },
]

/**
 * `*` matches within one path segment, `**` any number of segments; a pattern that ends in `/` matches everything
 * below it; any other pattern matches the path itself.
 */
export function globMatches(pattern: string, path: string): boolean {
  const clean = pattern.replace(/^\.?\//, '')
  if (clean.endsWith('/'))
    return path.startsWith(clean)
  let source = ''
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!
    if (c === '*' && clean[i + 1] === '*') {
      // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
      if (clean[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      }
      else {
        source += '.*'
        i += 1
      }
    }
    else if (c === '*') {
      source += '[^/]*'
    }
    else if (c === '?') {
      source += '[^/]'
    }
    else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`).test(path)
}

export interface PathOptions {
  /** Patterns from `protect` in `.c8y-agent/config.yml` on the default branch. */
  protect?: string[]
  /** The `setup` playbook may change `.c8y-agent/`, in a draft pull request only. */
  allowAgentConfig?: boolean
  /** Workspace package globs of the root lockfile (pnpm-workspace.yaml `packages`, package.json `workspaces`). */
  workspaces?: string[]
}

const dir = (path: string): string => posix.dirname(path)

/** Whether a changed manifest belongs to the lockfile's package: the same directory, or a workspace package of a root lockfile. */
function justifies(lockfile: string, manifest: string, workspaces: string[]): boolean {
  if (dir(manifest) === dir(lockfile))
    return true
  return dir(lockfile) === '.' && name(manifest) === 'package.json'
    && workspaces.some(glob => !glob.startsWith('!') && globMatches(glob.replace(/\/$/, ''), dir(manifest)))
}

/** The violations of a change, given every path its commits add, change, or delete (both sides of a rename). */
export function checkPaths(paths: string[], options: PathOptions = {}): Violation[] {
  const violations: Violation[] = []
  for (const path of paths) {
    for (const { rule, matches, why } of RULES) {
      if (rule === 'agent-config' && options.allowAgentConfig)
        continue
      if (matches(path))
        violations.push({ rule, file: path, message: `${path} is protected: ${why}` })
    }
    for (const pattern of options.protect ?? []) {
      if (globMatches(pattern, path))
        violations.push({ rule: 'protect', file: path, message: `${path} is protected by "${pattern}" in .c8y-agent/config.yml` })
    }
  }
  const manifests = paths.filter(p => MANIFESTS.includes(name(p)))
  for (const file of paths.filter(p => LOCKFILES.includes(name(p)))) {
    if (!manifests.some(manifest => justifies(file, manifest, options.workspaces ?? [])))
      violations.push({ rule: 'lockfile', file, message: `${file} changes without a change to a package.json or pnpm-workspace.yaml of its package` })
  }
  return violations
}

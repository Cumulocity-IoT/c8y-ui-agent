// Protected paths (D2): files the agent's commits must not add, change, delete, or rename. See docs/result.md.
import { posix } from 'node:path'

export interface Violation {
  rule: string
  file?: string
  message: string
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
/** A changed lockfile needs one of these changed too: a dependency change, not only a new resolution. */
const MANIFESTS = ['package.json', 'pnpm-workspace.yaml']

/** Built-in rules: a path, and why it is protected. */
const RULES: Array<{ rule: string, matches: (path: string) => boolean, why: string }> = [
  { rule: 'github', matches: p => p.startsWith('.github/'), why: 'workflows and repository automation' },
  { rule: 'agent-config', matches: p => p.startsWith('.c8y-agent/'), why: 'the agent configuration' },
  {
    rule: 'agent-instructions',
    matches: p => p.split('/').includes('.claude') || ['AGENTS.md', 'CLAUDE.md'].includes(posix.basename(p)),
    why: 'instructions for agents (.claude/, AGENTS.md, CLAUDE.md)',
  },
  {
    rule: 'package-sources',
    matches: p => ['.gitmodules', '.npmrc', '.yarnrc.yml', '.pnpmfile.cjs', '.pnpmfile.mjs'].includes(p),
    why: 'where code and packages come from, or code that runs on install',
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
}

/** The violations of a change, given every path it adds, changes, or deletes (both sides of a rename). */
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
  const lockfiles = paths.filter(p => LOCKFILES.includes(posix.basename(p)))
  if (lockfiles.length > 0 && !paths.some(p => MANIFESTS.includes(posix.basename(p)))) {
    for (const file of lockfiles)
      violations.push({ rule: 'lockfile', file, message: `${file} changes without a change to a package.json or pnpm-workspace.yaml` })
  }
  return violations
}

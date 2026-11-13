// Playbooks: the built-in ones of the agent pack and the repository's own in `.c8y-agent/playbooks/`, as the workflow
// resolves them in its trusted jobs. A playbook's evidence level and result decide what the apply job accepts, so they
// come from here, never from the agent's files. See docs/pack.md.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { PLAYBOOK, UsageError } from './check'

export type Evidence = 'static' | 'observed' | 'regression'
export type PlaybookResult = 'pull-request' | 'comment'

export interface Playbook {
  /** The command (`@c8y-ui-agent <name>`) and the label (`agent:<name>`). */
  name: string
  /** When to use it; the router matches free-text requests against it. */
  description: string
  /** The minimum evidence the result needs. */
  evidence: Evidence
  /** What the run produces: a pull request, or only the status comment. */
  result: PlaybookResult
  /** `builtin`: the agent pack's. `repository`: a new playbook of the repository. `extended`: a built-in with the repository's rules. */
  source: 'builtin' | 'repository' | 'extended'
  /** The instructions: the built-in's, then the repository's rules. */
  body: string
}

export const PLAYBOOK_LIMITS = {
  /** A playbook file. */
  fileBytes: 64_000,
  description: 1_024,
}

const FIELDS = ['description', 'name', 'extends', 'gate', 'evidence', 'result']
const EVIDENCE: Evidence[] = ['static', 'observed', 'regression']
const RESULTS: PlaybookResult[] = ['pull-request', 'comment']
const PLAYBOOKS_DIR = '.c8y-agent/playbooks'
const CONFIG_FILE = '.c8y-agent/config.yml'

export interface PlaybookOptions {
  /** The agent pack: `run.md` and `playbooks/`. */
  pack: string
  /** A checkout of the repository's default branch. */
  dir: string
}

interface Parsed {
  file: string
  name?: string
  fields: { description?: string, extends?: 'builtin', evidence?: Evidence, result?: PlaybookResult }
  body: string
}

/** A playbook file: optional YAML frontmatter, then the Markdown body. Throws with every problem of the file. */
function parsePlaybook(file: string, label: string): Parsed {
  const errors: string[] = []
  const size = lstatSync(file).size
  if (size > PLAYBOOK_LIMITS.fileBytes)
    throw new UsageError(`${label}: ${size} bytes, at most ${PLAYBOOK_LIMITS.fileBytes}`)
  const source = readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(source)
  let data: unknown = {}
  if (match) {
    try {
      data = parseYaml(match[1]!) ?? {}
    }
    catch (error) {
      throw new UsageError(`${label}: the frontmatter is not valid YAML: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new UsageError(`${label}: the frontmatter must be a map of fields`)
  const value = data as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (key === 'models')
      errors.push(`${label}: models is not supported yet`)
    else if (!FIELDS.includes(key))
      errors.push(`${label}: unknown field ${JSON.stringify(key)} (${FIELDS.join(', ')})`)
  }
  const fields: Parsed['fields'] = {}
  if (value.description !== undefined) {
    if (typeof value.description !== 'string' || value.description.trim() === '')
      errors.push(`${label}: description must be a non-empty string`)
    else if (value.description.length > PLAYBOOK_LIMITS.description)
      errors.push(`${label}: description has ${value.description.length} characters, at most ${PLAYBOOK_LIMITS.description}`)
    else
      fields.description = value.description.trim()
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || !PLAYBOOK.test(value.name)))
    errors.push(`${label}: name must be a lowercase name (letters, digits, hyphens), not ${JSON.stringify(value.name)}`)
  if (value.extends !== undefined) {
    if (value.extends !== 'builtin')
      errors.push(`${label}: extends must be builtin`)
    else
      fields.extends = 'builtin'
  }
  if (value.gate !== undefined && value.gate !== 'none')
    errors.push(`${label}: gate ${JSON.stringify(value.gate)} is not supported yet; only none`)
  if (value.evidence !== undefined) {
    if (!EVIDENCE.includes(value.evidence as Evidence))
      errors.push(`${label}: evidence must be one of ${EVIDENCE.join(', ')}`)
    else
      fields.evidence = value.evidence as Evidence
  }
  if (value.result !== undefined) {
    if (!RESULTS.includes(value.result as PlaybookResult))
      errors.push(`${label}: result must be one of ${RESULTS.join(', ')}${value.result === 'review' ? ' (review is not supported yet)' : ''}`)
    else
      fields.result = value.result as PlaybookResult
  }
  const body = (match ? match[2]! : source).trim()
  if (body === '')
    errors.push(`${label}: the playbook has no instructions`)
  if (errors.length > 0)
    throw new UsageError(errors.join('\n'))
  return { file, name: typeof value.name === 'string' ? value.name : undefined, fields, body }
}

/** Regular `.md` files of a directory, sorted; symbolic links are not followed. */
function markdownFiles(dir: string): string[] {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory())
    return []
  return readdirSync(dir).filter(file => file.endsWith('.md') && lstatSync(join(dir, file)).isFile()).sort()
}

function nameOf(parsed: Parsed, file: string, label: string): string {
  const name = parsed.name ?? file.replace(/\.md$/, '')
  if (!PLAYBOOK.test(name))
    throw new UsageError(`${label}: the file name is not a playbook name (lowercase letters, digits, hyphens); set name`)
  return name
}

function builtins(pack: string): Map<string, Playbook> {
  const playbooks = new Map<string, Playbook>()
  for (const file of markdownFiles(join(pack, 'playbooks'))) {
    const label = `pack playbooks/${file}`
    const parsed = parsePlaybook(join(pack, 'playbooks', file), label)
    const name = nameOf(parsed, file, label)
    const { description, evidence, result } = parsed.fields
    if (!description || !evidence || !result || parsed.fields.extends)
      throw new UsageError(`${label}: a built-in playbook sets description, evidence, and result, and no extends`)
    playbooks.set(name, { name, description, evidence, result, source: 'builtin', body: parsed.body })
  }
  if (playbooks.size === 0)
    throw new UsageError(`${pack} has no playbooks/: not an agent pack`)
  return playbooks
}

/** `playbooks` of `.c8y-agent/config.yml`: playbook names switched off. An invalid file is an error. */
function disabled(dir: string): Map<string, boolean> {
  const file = join(dir, CONFIG_FILE)
  if (!existsSync(file))
    return new Map()
  let config: unknown
  try {
    config = parseYaml(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new UsageError(`${CONFIG_FILE} is not valid YAML: ${(error as Error).message.split('\n')[0]}`)
  }
  const playbooks = (config as { playbooks?: unknown } | null)?.playbooks
  if (playbooks === undefined || playbooks === null)
    return new Map()
  if (typeof playbooks !== 'object' || Array.isArray(playbooks) || Object.values(playbooks).some(on => typeof on !== 'boolean'))
    throw new UsageError(`playbooks in ${CONFIG_FILE} must map playbook names to true or false`)
  return new Map(Object.entries(playbooks as Record<string, boolean>))
}

export interface PlaybookList {
  playbooks: Playbook[]
  /** Playbooks `config.yml` switches off. */
  disabled: string[]
  /** Repository playbook files that cannot be used, and `config.yml` entries that name no playbook. */
  errors: string[]
}

/**
 * Every playbook the repository can run: the pack's built-ins, extended or added to by `.c8y-agent/playbooks/`, without
 * those `config.yml` switches off. A repository file with errors is left out and named in `errors`; the pack's own
 * playbooks and an invalid `config.yml` throw.
 */
export function listPlaybooks(options: PlaybookOptions): PlaybookList {
  const playbooks = builtins(options.pack)
  const builtinNames = new Set(playbooks.keys())
  const errors: string[] = []
  const seen = new Map<string, string>()
  for (const file of markdownFiles(join(options.dir, PLAYBOOKS_DIR))) {
    const label = `${PLAYBOOKS_DIR}/${file}`
    try {
      const parsed = parsePlaybook(join(options.dir, PLAYBOOKS_DIR, file), label)
      const name = nameOf(parsed, file, label)
      if (seen.has(name))
        throw new UsageError(`${label}: the playbook ${name} is already defined in ${seen.get(name)}`)
      seen.set(name, label)
      const builtin = builtinNames.has(name) ? playbooks.get(name) : undefined
      if (builtin && !parsed.fields.extends)
        throw new UsageError(`${label}: ${name} is a built-in playbook; set extends: builtin to add rules to it (replacing a built-in is not supported yet)`)
      if (!builtin && parsed.fields.extends)
        throw new UsageError(`${label}: extends: builtin, but there is no built-in playbook ${name}`)
      if (builtin) {
        playbooks.set(name, {
          ...builtin,
          ...parsed.fields,
          name,
          source: 'extended',
          body: `${builtin.body}\n\n## Repository rules\n\nThe repository adds these rules (${label}):\n\n${parsed.body}`,
        })
      }
      else {
        if (!parsed.fields.description)
          throw new UsageError(`${label}: description is required`)
        playbooks.set(name, {
          name,
          description: parsed.fields.description,
          evidence: parsed.fields.evidence ?? 'observed',
          result: parsed.fields.result ?? 'pull-request',
          source: 'repository',
          body: parsed.body,
        })
      }
    }
    catch (error) {
      if (!(error instanceof UsageError))
        throw error
      errors.push(...error.message.split('\n'))
    }
  }
  const off: string[] = []
  for (const [name, on] of disabled(options.dir)) {
    if (!playbooks.has(name) && !seen.has(name)) {
      errors.push(`playbooks.${name} in ${CONFIG_FILE}: there is no playbook ${name}`)
    }
    else if (!on) {
      playbooks.delete(name)
      off.push(name)
    }
  }
  return { playbooks: [...playbooks.values()].sort((a, b) => a.name.localeCompare(b.name)), disabled: off.sort(), errors }
}

/** One playbook by name. Throws when it does not exist, is switched off, or its repository file has errors. */
export function resolvePlaybook(name: string, options: PlaybookOptions): Playbook {
  if (!PLAYBOOK.test(name))
    throw new UsageError(`the playbook must be a lowercase name, not ${JSON.stringify(name)}`)
  const { playbooks, disabled: off, errors } = listPlaybooks(options)
  const playbook = playbooks.find(p => p.name === name)
  if (playbook)
    return playbook
  if (off.includes(name))
    throw new UsageError(`the playbook ${name} is switched off in ${CONFIG_FILE}`)
  const own = errors.filter(error => error.startsWith(`${PLAYBOOKS_DIR}/${name}.md:`) || error.includes(`playbook ${name} `))
  if (own.length > 0)
    throw new UsageError(own.join('\n'))
  throw new UsageError(`no playbook ${name}; available: ${playbooks.map(p => p.name).join(', ') || 'none'}`)
}

/** The system prompt of a run: the pack's `run.md`, then the playbook. */
export function runPrompt(playbook: Playbook, pack: string): string {
  const run = readFileSync(join(pack, 'run.md'), 'utf8').trim()
  return `${run}\n\n# Playbook: ${playbook.name}\n\n${playbook.description}\n\nMinimum evidence: \`${playbook.evidence}\`. Result: ${playbook.result === 'pull-request' ? 'a pull request' : 'the status comment only, no commits'}.\n\n${playbook.body}\n`
}

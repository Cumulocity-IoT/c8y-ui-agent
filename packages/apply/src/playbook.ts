// Playbooks: the built-in ones of the agent pack and the repository's own in `.c8y-agent/playbooks/`, as the workflow
// resolves them in its trusted jobs. A playbook's evidence level and result decide what the apply job accepts, so they
// come from here, never from the agent's files. See docs/pack.md.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
  label: string
  /** The `name` field, else the file name; undefined when neither is a playbook name. */
  name?: string
  fields: { description?: string, extends?: 'builtin', evidence?: Evidence, result?: PlaybookResult }
  body: string
  /** Every problem of the file; a file with errors is not used. */
  errors: string[]
}

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/

/** A playbook file: optional YAML frontmatter, then the Markdown body, with every problem of the file. */
function parsePlaybook(path: string, label: string): Parsed {
  const errors: string[] = []
  const stem = basename(path).replace(/\.md$/, '')
  const fallbackName = PLAYBOOK.test(stem) ? stem : undefined
  const size = lstatSync(path).size
  if (size > PLAYBOOK_LIMITS.fileBytes)
    return { label, name: fallbackName, fields: {}, body: '', errors: [`${label}: ${size} bytes, at most ${PLAYBOOK_LIMITS.fileBytes}`] }
  const source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  const match = FRONTMATTER.exec(source)
  let data: unknown = {}
  if (match) {
    try {
      data = parseYaml(match[1] ?? '') ?? {}
    }
    catch (error) {
      errors.push(`${label}: the frontmatter is not valid YAML: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    errors.push(`${label}: the frontmatter must be a map of fields`)
    data = {}
  }
  const value = data as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (key === 'models')
      errors.push(`${label}: models is not supported yet`)
    else if (!FIELDS.includes(key))
      errors.push(`${label}: unknown field ${JSON.stringify(key)} (${FIELDS.join(', ')})`)
  }
  let name = fallbackName
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || !PLAYBOOK.test(value.name))
      errors.push(`${label}: name must be a lowercase name (letters, digits, hyphens), not ${JSON.stringify(value.name)}`)
    else
      name = value.name
  }
  else if (!fallbackName) {
    errors.push(`${label}: the file name is not a playbook name (lowercase letters, digits, hyphens); set name`)
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
  return { label, name, fields, body, errors }
}

/** Regular `.md` files of a directory, sorted; symbolic links are not followed. */
function markdownFiles(dir: string): string[] {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory())
    return []
  return readdirSync(dir).filter(file => file.endsWith('.md') && lstatSync(join(dir, file)).isFile()).sort()
}

function builtins(pack: string): Map<string, Playbook> {
  const playbooks = new Map<string, Playbook>()
  for (const file of markdownFiles(join(pack, 'playbooks'))) {
    const parsed = parsePlaybook(join(pack, 'playbooks', file), `pack playbooks/${file}`)
    if (parsed.errors.length > 0)
      throw new UsageError(parsed.errors.join('\n'))
    const { description, evidence, result } = parsed.fields
    if (!parsed.name || !description || !evidence || !result || parsed.fields.extends)
      throw new UsageError(`${parsed.label}: a built-in playbook sets description, evidence, and result, and no extends`)
    playbooks.set(parsed.name, { name: parsed.name, description, evidence, result, source: 'builtin', body: parsed.body })
  }
  if (playbooks.size === 0)
    throw new UsageError(`${pack} has no playbooks/: not an agent pack`)
  return playbooks
}

/** The repository cannot run the playbook: unknown, switched off, broken, or an invalid `config.yml`. */
export class PlaybookError extends UsageError {}

/** `playbooks` of `.c8y-agent/config.yml`: playbook names switched off. An invalid file is an error. */
function switches(dir: string): Map<string, boolean> {
  const file = join(dir, CONFIG_FILE)
  if (!existsSync(file))
    return new Map()
  let config: unknown
  try {
    config = parseYaml(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new PlaybookError(`${CONFIG_FILE} is not valid YAML: ${(error as Error).message.split('\n')[0]}`)
  }
  const playbooks = (config as { playbooks?: unknown } | null)?.playbooks
  if (playbooks === undefined || playbooks === null)
    return new Map()
  if (typeof playbooks !== 'object' || Array.isArray(playbooks) || Object.values(playbooks).some(on => typeof on !== 'boolean'))
    throw new PlaybookError(`playbooks in ${CONFIG_FILE} must map playbook names to true or false`)
  return new Map(Object.entries(playbooks as Record<string, boolean>))
}

export interface PlaybookList {
  playbooks: Playbook[]
  /** Playbooks `config.yml` switches off. */
  disabled: string[]
  /** Repository playbook files that cannot be used, and `config.yml` entries that name no playbook. */
  errors: string[]
}

interface Collected extends PlaybookList {
  /** The errors of the repository files that define each name. */
  byName: Map<string, string[]>
}

function collect(options: PlaybookOptions): Collected {
  const playbooks = builtins(options.pack)
  const errors: string[] = []
  const byName = new Map<string, string[]>()
  const fail = (name: string | undefined, messages: string[]): void => {
    errors.push(...messages)
    if (name)
      byName.set(name, [...(byName.get(name) ?? []), ...messages])
  }
  const files = markdownFiles(join(options.dir, PLAYBOOKS_DIR)).map(file => parsePlaybook(join(options.dir, PLAYBOOKS_DIR, file), `${PLAYBOOKS_DIR}/${file}`))
  const defined = new Map<string, Parsed[]>()
  for (const parsed of files) {
    if (parsed.name)
      defined.set(parsed.name, [...(defined.get(parsed.name) ?? []), parsed])
    else
      fail(undefined, parsed.errors)
  }
  for (const [name, parsedFiles] of defined) {
    if (parsedFiles.length > 1) {
      fail(name, [`${parsedFiles.map(p => p.label).join(', ')}: each defines the playbook ${name}; keep one`])
      continue
    }
    const parsed = parsedFiles[0]!
    const builtin = playbooks.get(name)
    const problems = [...parsed.errors]
    if (builtin && !parsed.fields.extends)
      problems.push(`${parsed.label}: ${name} is a built-in playbook; set extends: builtin to add rules to it (replacing a built-in is not supported yet)`)
    if (!builtin && parsed.fields.extends)
      problems.push(`${parsed.label}: extends: builtin, but there is no built-in playbook ${name}`)
    if (!builtin && !parsed.fields.extends && !parsed.fields.description && parsed.errors.length === 0)
      problems.push(`${parsed.label}: description is required`)
    if (problems.length > 0) {
      fail(name, problems)
      continue
    }
    if (builtin) {
      playbooks.set(name, {
        ...builtin,
        ...parsed.fields,
        name,
        source: 'extended',
        body: `${builtin.body}\n\n## Repository rules\n\nThe repository adds these rules (${parsed.label}):\n\n${parsed.body}`,
      })
    }
    else {
      playbooks.set(name, {
        name,
        description: parsed.fields.description!,
        evidence: parsed.fields.evidence ?? 'observed',
        result: parsed.fields.result ?? 'pull-request',
        source: 'repository',
        body: parsed.body,
      })
    }
  }
  const off: string[] = []
  for (const [name, on] of switches(options.dir)) {
    if (!playbooks.has(name) && !defined.has(name)) {
      errors.push(`playbooks.${name} in ${CONFIG_FILE}: there is no playbook ${name}`)
    }
    else if (!on) {
      playbooks.delete(name)
      off.push(name)
    }
  }
  return { playbooks: [...playbooks.values()].sort((a, b) => a.name.localeCompare(b.name)), disabled: off.sort(), errors, byName }
}

/**
 * Every playbook the repository can run: the pack's built-ins, extended or added to by `.c8y-agent/playbooks/`, without
 * those `config.yml` switches off. A repository file with errors is not used and is named in `errors`; a built-in it
 * would extend stays as it is. The pack's own playbooks and an invalid `config.yml` throw.
 */
export function listPlaybooks(options: PlaybookOptions): PlaybookList {
  const { byName: _byName, ...list } = collect(options)
  return list
}

/**
 * One playbook by name. Throws when it does not exist, is switched off, or a repository file that defines it has
 * errors: a built-in whose extension is broken does not run without the repository's rules.
 */
export function resolvePlaybook(name: string, options: PlaybookOptions): Playbook {
  if (!PLAYBOOK.test(name))
    throw new PlaybookError(`the playbook must be a lowercase name, not ${JSON.stringify(name)}`)
  const { playbooks, disabled: off, byName } = collect(options)
  if (off.includes(name))
    throw new PlaybookError(`the playbook ${name} is switched off in ${CONFIG_FILE}`)
  const problems = byName.get(name)
  if (problems)
    throw new PlaybookError(problems.join('\n'))
  const playbook = playbooks.find(p => p.name === name)
  if (playbook)
    return playbook
  throw new PlaybookError(`no playbook ${name}; available: ${playbooks.map(p => p.name).join(', ') || 'none'}`)
}

/** The system prompt of a run: the pack's `run.md`, then the playbook. */
export function runPrompt(playbook: Playbook, pack: string): string {
  const run = readFileSync(join(pack, 'run.md'), 'utf8').trim()
  return `${run}\n\n# Playbook: ${playbook.name}\n\n${playbook.description}\n\nMinimum evidence: \`${playbook.evidence}\`. Result: ${playbook.result === 'pull-request' ? 'a pull request' : 'the status comment only, no commits'}.\n\n${playbook.body}\n`
}

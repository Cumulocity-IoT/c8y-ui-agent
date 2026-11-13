// Discovery: the repository profile, from the checkout and its install alone. The workbench takes its settings from
// it; `.c8y-agent/config.yml` corrects it. Rules: docs/discovery.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, posix, resolve } from 'node:path'
import { detectConfig, readConfig } from '@cumulocity-iot/ui-sdk'
import { CONFIG_FILE, readAgentConfig } from './config'
import type { AgentConfig } from './config'
import { listApps } from './target'
import type { AuthMode, Target } from './target'
import { errorMessage } from './util'

export interface ProfileApp {
  name: string
  dir: string
  project?: string
  /** The app's context path on the tenant (cumulocity.config.ts). */
  contextPath?: string
  /** Package scripts for this app, by verb: `test`, `build`, `e2e:run` … */
  commands: Record<string, string>
  /** Its Cypress config file, relative to the e2e root, when the e2e config pattern names an existing file. */
  e2eConfig?: string
}

export interface Profile {
  packageManager?: { name: 'pnpm' | 'npm' | 'yarn' | 'bun', version?: string }
  node?: { version: string, from: string }
  /** Installed versions, not the ranges of package.json. */
  versions: { webSdk?: string, angular?: string }
  apps: ProfileApp[]
  /** Package scripts of the whole repository: lint, test, build, typecheck. */
  commands: Record<string, string>
  e2e?: {
    /** Cypress project directory, relative to the repository; without it, the repository. */
    root?: string
    /** Cypress config file relative to the root, with `{app}` for the app name; the default config without it. */
    config?: string
    auth?: AuthMode
    env?: Record<string, string>
  }
  world?: { file: string, exists: boolean }
  /** Instruction files for every role, relative to the repository. */
  instructions: string[]
  /** Skill directories (`<dir>/SKILL.md`), relative to the repository. */
  skills: string[]
  /** `.c8y-agent/config.yml`, when the repository has one. Its values win over what discovery detects. */
  config?: string
  /** The fields `.c8y-agent/config.yml` set, e.g. `e2e.env`, `world.file`, `projects.kpi.commands`. */
  configured: string[]
  /** Fields discovery could not settle, with the reason when one is known. */
  unknown: string[]
}

export interface DiscoverOptions {
  /** `.c8y-agent/config.yml`; default: the repository's. */
  config?: AgentConfig
  /** An e2e root given explicitly: the settings that depend on it (config pattern, login mode, world) follow it. */
  e2eRoot?: string
}

const CYPRESS_CONFIGS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(ext => `cypress.config.${ext}`)
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'out-tsc'])
const LOCKFILES: Array<[string, NonNullable<Profile['packageManager']>['name']]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
]
const REPOSITORY_COMMANDS = ['lint', 'test', 'build', 'typecheck']
const INTERACTIVE = ['watch', 'open', 'dev', 'start', 'serve']
// Config files of other tools, which a per-app Cypress config pattern must not match: `eslint.config.mjs` in a checkout
// folder named `eslint` is not that app's Cypress config.
const TOOL_CONFIGS = new Set(['angular', 'astro', 'babel', 'commitlint', 'cypress', 'eslint', 'jest', 'karma', 'lint-staged', 'next', 'nuxt', 'playwright', 'postcss', 'prettier', 'rollup', 'stylelint', 'svelte', 'tailwind', 'tsup', 'vite', 'vitest', 'webpack'])
const INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'CONTRIBUTING.md']

interface PackageJson {
  packageManager?: string
  engines?: { node?: string }
  scripts?: Record<string, unknown>
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }
  catch {
    return undefined
  }
}

/** A JSON file, or undefined without one; unreadable or invalid content throws. */
function readJsonStrict<T>(file: string): T | undefined {
  if (!existsSync(file))
    return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }
  catch (error) {
    throw new Error(`${basename(file)}: ${errorMessage(error)}`)
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  }
  catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  }
  catch {
    return false
  }
}

/** Subdirectories a search enters, symbolic links to directories included: no dot directories, dependencies or build output. */
function subdirectories(dir: string): string[] {
  if (!isDir(dir))
    return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && !SKIP.has(entry.name)
      && (entry.isDirectory() || (entry.isSymbolicLink() && isDir(join(dir, entry.name)))))
    .map(entry => entry.name)
    .sort()
}

function packageManager(repo: string, pkg: PackageJson | undefined): Profile['packageManager'] {
  const declared = /^(pnpm|npm|yarn|bun)@(\d[^+\s]*)/.exec(typeof pkg?.packageManager === 'string' ? pkg.packageManager : '')
  if (declared)
    return { name: declared[1] as 'pnpm', version: declared[2] }
  const lock = LOCKFILES.find(([file]) => isFile(join(repo, file)))
  return lock && { name: lock[1] }
}

function nodeVersion(repo: string, pkg: PackageJson | undefined): Profile['node'] {
  for (const from of ['.nvmrc', '.node-version']) {
    const file = join(repo, from)
    if (isFile(file)) {
      const version = readFileSync(file, 'utf8').trim().split(/\s/)[0]
      if (version)
        return { version, from }
    }
  }
  const engine = pkg?.engines?.node
  return typeof engine === 'string' && engine ? { version: engine, from: 'package.json engines' } : undefined
}

/** The installed version of a package, resolved from the given directories as Node would. */
function installed(name: string, from: string[]): string | undefined {
  for (const dir of from) {
    try {
      const file = createRequire(join(dir, 'package.json')).resolve(`${name}/package.json`)
      return readJson<{ version?: string }>(file)?.version
    }
    catch {}
  }
  return undefined
}

/** `<pm> run <script>`, as the repository's package manager runs it. */
function run(pm: Profile['packageManager'], script: string): string {
  return `${pm?.name ?? 'npm'} run ${script}`
}

/**
 * Scripts named for an app: `<verb>:<name>`, where the name is the app's folder name or Angular project, e.g.
 * `test:kpi-widget` or `e2e:run:kpi-widget`. The verb is the script name without the app. Scripts that do not end
 * (`watch`, `open`, `dev`, `start`, `serve`) are left out: `preview_up` serves an app.
 */
function appCommands(scripts: string[], names: string[], pm: Profile['packageManager']): Record<string, string> {
  const commands: Record<string, string> = {}
  for (const script of [...scripts].sort()) {
    const parts = script.split(':')
    const verb = parts.slice(0, -1)
    if (verb.length > 0 && names.includes(parts.at(-1)!) && !verb.some(part => INTERACTIVE.includes(part)))
      commands[verb.join(':')] = run(pm, script)
  }
  return commands
}

/** The Cypress projects: the repository itself or directories one level below it with a Cypress config. */
function e2eRoots(repo: string): string[] {
  return ['.', ...subdirectories(repo)].filter(dir => CYPRESS_CONFIGS.some(file => isFile(join(repo, dir, file))))
}

/** Config files of the e2e root and one level below it, relative to the root. */
function configFiles(root: string): string[] {
  const files: string[] = []
  for (const dir of ['', ...subdirectories(root)]) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (/\.config\.[cm]?[jt]s$/.test(entry.name) && isFile(join(root, dir, entry.name)))
        files.push(posix.join(dir, entry.name))
    }
  }
  return files
}

/**
 * The per-app Cypress config pattern: a config file name with the app's name as one of its dot-separated parts
 * (`config/kpi.config.ts`, `cypress.kpi.config.ts`), for at least two apps, or for the only app.
 */
function e2eConfigPattern(root: string, apps: string[]): string | undefined {
  const matches = new Map<string, Set<string>>()
  for (const file of configFiles(root)) {
    const parts = basename(file).split('.')
    if (TOOL_CONFIGS.has(parts[0]!) && parts.length === 3)
      continue
    for (const app of apps) {
      const at = parts.indexOf(app)
      if (at < 0)
        continue
      const pattern = posix.join(posix.dirname(file), parts.map((part, i) => (i === at ? '{app}' : part)).join('.'))
      matches.set(pattern, (matches.get(pattern) ?? new Set()).add(app))
    }
  }
  const [best] = [...matches].sort(([a, x], [b, y]) => y.size - x.size || a.localeCompare(b))
  if (!best || (best[1].size < 2 && apps.length > 1))
    return undefined
  return best[0]
}

/**
 * `auth` and `world` of the UI SDK project file `c8y-ui.json` of the e2e root, or else of the repository, through the SDK's
 * `readConfig` (with its defaults). `readConfig` also settles the Web SDK version, which discovery does not need: when
 * only that fails, the file's own `auth` and `world` count, without defaults.
 */
function sdkProject(repo: string, root: string | undefined): { dir: string, auth?: AuthMode, world?: string } | undefined {
  for (const dir of [...new Set([root, '.'])]) {
    if (dir === undefined || !isFile(join(repo, dir, 'c8y-ui.json')))
      continue
    const file = readJsonStrict<Record<string, unknown>>(join(repo, dir, 'c8y-ui.json'))
    let config: Record<string, unknown> = file ?? {}
    try {
      config = readConfig(join(repo, dir)) as unknown as Record<string, unknown>
    }
    catch {}
    const auth = config.auth === 'login' || config.auth === 'open' ? config.auth : undefined
    return { dir, auth, world: typeof config.world === 'string' && config.world ? config.world : undefined }
  }
  return undefined
}

function skillDirs(repo: string): string[] {
  return ['.claude/skills', '.c8y-agent/skills'].flatMap(base => subdirectories(join(repo, base))
    .filter(name => isFile(join(repo, base, name, 'SKILL.md')))
    .map(name => `${base}/${name}`))
}

/** The fields of config.yml that discovery uses, as dotted names. */
function configuredFields(config: AgentConfig | undefined): string[] {
  if (!config)
    return []
  const fields: string[] = []
  if (config.world?.file)
    fields.push('world.file')
  for (const key of ['root', 'config', 'auth', 'env'] as const) {
    if (config.e2e?.[key] !== undefined)
      fields.push(`e2e.${key}`)
  }
  if (config.commands)
    fields.push('commands')
  for (const [app, project] of Object.entries(config.projects ?? {})) {
    if (project.commands)
      fields.push(`projects.${app}.commands`)
  }
  return fields
}

/**
 * The repository profile. Each field is settled on its own: a file discovery cannot read leaves its field unknown,
 * with the reason. Only an invalid `.c8y-agent/config.yml` is an error.
 */
export function discover(repo: string, options: DiscoverOptions = {}): Profile {
  const config = options.config ?? readAgentConfig(repo)
  const unknown: string[] = []
  const settle = <T>(field: string, work: () => T): T | undefined => {
    try {
      return work()
    }
    catch (error) {
      unknown.push(`${field} (${errorMessage(error).split('\n')[0]})`)
      return undefined
    }
  }

  const pkg = settle('package.json', () => readJsonStrict<PackageJson>(join(repo, 'package.json')))
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts).filter(name => typeof pkg.scripts![name] === 'string') : []
  const pm = settle('packageManager', () => packageManager(repo, pkg))

  const apps: ProfileApp[] = (settle('apps', () => listApps(repo)) ?? []).map((app) => {
    const contextPath = settle(`apps.${app.name}.contextPath`, () => detectConfig(join(repo, app.dir)).contextPath)
    const commands = { ...appCommands(scripts, [app.name, ...(app.project ? [app.project] : [])], pm), ...config?.projects?.[app.name]?.commands }
    return { ...app, ...(contextPath && { contextPath }), commands }
  })

  const commands: Record<string, string> = {}
  for (const script of REPOSITORY_COMMANDS) {
    if (scripts.includes(script))
      commands[script] = run(pm, script)
  }
  Object.assign(commands, config?.commands)

  // e2e: an explicit root, then config.yml, then the single Cypress project; then its per-app configs and c8y-ui.json.
  // Without a root, Cypress runs in the repository: config.yml's e2e settings still apply, nothing is detected for it.
  const roots = settle('e2e.root', () => e2eRoots(repo)) ?? []
  const root = options.e2eRoot ?? config?.e2e?.root ?? (roots.length === 1 ? roots[0] : undefined)
  if (root === undefined && roots.length > 1)
    unknown.push(`e2e.root (Cypress projects in ${roots.join(', ')})`)
  else if (root === undefined && !unknown.some(field => field.startsWith('e2e.root')))
    unknown.push('e2e.root')
  const project = settle('c8y-ui.json', () => sdkProject(repo, root))
  const pattern = config?.e2e?.config ?? (root === undefined ? undefined : settle('e2e.config', () => e2eConfigPattern(join(repo, root), apps.map(a => a.name))))
  const auth = config?.e2e?.auth ?? project?.auth
  const e2e: Profile['e2e'] = { ...(root !== undefined && { root }), ...(pattern && { config: pattern }), ...(auth && { auth }), ...(config?.e2e?.env && { env: config.e2e.env }) }
  if (pattern) {
    for (const app of apps) {
      const file = pattern.replaceAll('{app}', app.name)
      if (isFile(join(repo, root ?? '.', file)))
        app.e2eConfig = file
    }
  }

  const projectWorld = project?.world && (posix.isAbsolute(project.world) ? project.world : posix.join(project.dir, project.world))
  const worldFile = config?.world?.file ?? projectWorld
  const world = worldFile ? { file: worldFile, exists: isFile(resolve(repo, worldFile)) } : undefined
  if (!world)
    unknown.push('world')

  const appDirs = [...new Set(apps.map(a => join(repo, a.dir)))]
  const versions = { webSdk: installed('@c8y/ngx-components', [repo, ...appDirs]), angular: installed('@angular/core', [repo, ...appDirs]) }
  const node = settle('node', () => nodeVersion(repo, pkg))
  for (const [field, value] of [['packageManager', pm], ['node', node], ['versions.webSdk', versions.webSdk], ['versions.angular', versions.angular]] as const) {
    if (value === undefined && !unknown.some(entry => entry.startsWith(`${field} (`)))
      unknown.push(field)
  }

  return {
    ...(pm && { packageManager: pm }),
    ...(node && { node }),
    versions,
    apps,
    commands,
    ...(Object.keys(e2e).length > 0 && { e2e }),
    ...(world && { world }),
    instructions: INSTRUCTIONS.filter(file => isFile(join(repo, file))),
    skills: settle('skills', () => skillDirs(repo)) ?? [],
    ...(isFile(join(repo, CONFIG_FILE)) && { config: CONFIG_FILE }),
    configured: configuredFields(config),
    unknown,
  }
}

/** Settings the caller gives explicitly; they win over the profile. */
export type TargetOverrides = Partial<Omit<Target, 'repo'>>

/** The workbench's settings: explicit values, then the profile (config.yml, then detection). */
export function targetFromProfile(repo: string, profile: Profile, overrides: TargetOverrides = {}): Target {
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) as TargetOverrides
  const e2e = profile.e2e
  const env = { ...e2e?.env, ...defined.e2eEnv }
  return {
    repo,
    world: profile.world?.file ?? '',
    ...(e2e && {
      ...(e2e.root !== undefined && { e2eRoot: e2e.root }),
      ...(e2e.config && { e2eConfig: e2e.config, e2eConfigOptional: !profile.configured.includes('e2e.config') }),
      ...(e2e.auth && { e2eAuth: e2e.auth }),
    }),
    ...defined,
    // An explicit pattern is strict, as a configured one is.
    ...(defined.e2eConfig && { e2eConfigOptional: false }),
    // Environment adds up: explicit variables on top of config.yml's.
    ...(Object.keys(env).length > 0 && { e2eEnv: env }),
  }
}

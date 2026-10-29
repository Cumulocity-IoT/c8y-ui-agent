// The repository the workbench works on, and its apps: Angular projects (angular.json) or the repository itself,
// each with the Cumulocity UI SDK configuration that `c8y-ui init` would write for it (detectConfig), passed in code.
import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { detectConfig } from '@cumulocity-iot/ui-sdk'
import type { ProjectConfigInput } from '@cumulocity-iot/ui-sdk'

export type AuthMode = 'open' | 'login'

export interface Target {
  /** The repository: a git checkout. */
  repo: string
  /** World file the emulator serves, absolute or relative to `repo`. Not copied: the base runs use the same file. */
  world: string
  /** e2e (Cypress) project directory, relative to `repo`: Cypress runs there, and its files count as tests. */
  e2eRoot?: string
  /** Cypress config file, relative to `e2eRoot`; `{app}` is replaced by the app name. */
  e2eConfig?: string
  /** Login mode of the emulator in e2e runs (default `open`). Previews always use `open`. */
  e2eAuth?: AuthMode
  /** More environment for Cypress; `{devUrl}` and `{mockUrl}` are replaced with the run's URLs. */
  e2eEnv?: Record<string, string>
}

export interface App {
  /** The name tools use: the project folder name. */
  name: string
  /** Its directory, relative to the repository. */
  dir: string
  /** Its Angular project, when the repository has an angular.json. */
  project?: string
  config: ProjectConfigInput
}

export class WorkbenchError extends Error {
  override name = 'WorkbenchError'
}

interface AngularWorkspace {
  projects: Record<string, { root?: string, projectType?: string, architect?: Record<string, unknown> }>
}

function angularProjects(repo: string): Array<{ project: string, dir: string }> | undefined {
  const file = join(repo, 'angular.json')
  if (!existsSync(file))
    return undefined
  const workspace = JSON.parse(readFileSync(file, 'utf8')) as AngularWorkspace
  // Only what `ng serve` can serve: libraries have no serve target.
  return Object.entries(workspace.projects)
    .filter(([, project]) => project.architect?.serve !== undefined)
    .map(([project, { root }]) => ({ project, dir: root ?? '' }))
}

/** The apps of the repository: every Angular project with a serve target, or the repository itself. */
export function listApps(repo: string): Array<{ name: string, dir: string, project?: string }> {
  const projects = angularProjects(repo)
  if (!projects)
    return [{ name: basename(resolve(repo)), dir: '' }]
  return projects.map(({ project, dir }) => ({ name: dir ? basename(dir) : project, dir, project }))
}

/** An app by its name, its Angular project name or its directory. */
export function resolveApp(repo: string, name: string): App {
  const apps = listApps(repo)
  const wanted = isAbsolute(name) ? relative(resolve(repo), name) : name.replace(/\/$/, '')
  const app = apps.find(a => a.name === wanted || a.project === wanted || a.dir === wanted)
  if (!app)
    throw new WorkbenchError(`no app ${name} in ${repo}; apps: ${apps.map(a => a.name).join(', ')}`)
  const detected = detectConfig(join(repo, app.dir))
  return { ...app, config: { version: detected.version, contextPath: detected.contextPath, shell: detected.shell, shells: detected.shells } }
}

/** The Cypress config file for an app, relative to the e2e root. */
export function e2eConfigFile(target: Target, app: App): string | undefined {
  return target.e2eConfig?.replaceAll('{app}', app.name)
}

/** The world file as an absolute path; it must exist. */
export function worldFile(target: Target): string {
  const file = resolve(target.repo, target.world)
  if (!existsSync(file))
    throw new WorkbenchError(`world file ${file} not found`)
  return file
}

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAgentConfig } from '../src/config'
import { discover, targetFromProfile } from '../src/discover'
import { e2eConfigFile, resolveApp, WorkbenchError } from '../src/target'

const repos: string[] = []
afterEach(() => {
  for (const repo of repos.splice(0))
    rmSync(repo, { recursive: true, force: true })
})

function repo(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-discover-'))
  repos.push(dir)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

/** A workspace like cumulocity-ui-toolkit: plugins in angular.json, a Cypress project in test/ with one config per plugin. */
const WORKSPACE = {
  'package.json': {
    packageManager: 'pnpm@10.6.0',
    dependencies: { '@c8y/ngx-components': '1024.21.3' },
    scripts: {
      'lint': 'eslint .',
      'test': 'ng test',
      'test:kpi': 'ng test plugin.kpi',
      'test:watch:kpi': 'ng test plugin.kpi --watch',
      'serve:kpi': 'ng serve plugin.kpi',
      'build:plugin.map': 'ng build plugin.map',
      'e2e:run:kpi': 'cypress run --config-file config/kpi.config.ts',
      'e2e:open:kpi': 'cypress open --config-file config/kpi.config.ts',
      'e2e:run:kpi-extra': 'cypress run',
    },
  },
  'pnpm-lock.yaml': '',
  '.nvmrc': 'v24.11.0\n',
  'angular.json': {
    projects: {
      'shared': { root: 'packages/shared', architect: { build: {} } },
      'plugin.kpi': { root: 'packages/kpi', architect: { serve: {} } },
      'plugin.map': { root: 'packages/map', architect: { serve: {} } },
    },
  },
  'packages/kpi/package.json': { name: '@scope/kpi-plugin' },
  'packages/map/package.json': { name: '@scope/map-plugin' },
  'packages/kpi/cumulocity.config.ts': `export default { runTime: { contextPath: 'kpi-plugin', isPackage: true } }`,
  'packages/map/cumulocity.config.ts': `export default { runTime: { contextPath: 'map-plugin', isPackage: true } }`,
  'node_modules/@c8y/ngx-components/package.json': { name: '@c8y/ngx-components', version: '1024.21.3' },
  'node_modules/@angular/core/package.json': { name: '@angular/core', version: '21.2.25' },
  'test/cypress.config.ts': 'export default {}',
  'test/config/base.config.ts': 'export {}',
  'test/config/kpi.config.ts': 'export {}',
  'test/config/map.config.ts': 'export {}',
  'test/c8y-ui.json': { shells: ['cockpit'], world: 'mock/world.json', auth: 'login', version: '1024.21.3' },
  'test/mock/world.json': {},
  'AGENTS.md': '# Agents',
  '.claude/skills/e2e/SKILL.md': '---\nname: e2e\n---',
  '.claude/skills/empty/README.md': '',
}

describe('discover', () => {
  it('profiles a workspace with plugins and a Cypress project', () => {
    const dir = repo(WORKSPACE)
    expect(discover(dir)).toEqual({
      packageManager: { name: 'pnpm', version: '10.6.0' },
      node: { version: 'v24.11.0', from: '.nvmrc' },
      versions: { webSdk: '1024.21.3', angular: '21.2.25' },
      apps: [
        {
          name: 'kpi',
          dir: 'packages/kpi',
          project: 'plugin.kpi',
          contextPath: 'kpi-plugin',
          // Not the watch, open and serve scripts, and not e2e:run:kpi-extra of another name.
          commands: { 'e2e:run': 'pnpm run e2e:run:kpi', 'test': 'pnpm run test:kpi' },
          e2eConfig: 'config/kpi.config.ts',
        },
        { name: 'map', dir: 'packages/map', project: 'plugin.map', contextPath: 'map-plugin', commands: { build: 'pnpm run build:plugin.map' }, e2eConfig: 'config/map.config.ts' },
      ],
      commands: { lint: 'pnpm run lint', test: 'pnpm run test' },
      e2e: { root: 'test', config: 'config/{app}.config.ts', auth: 'login' },
      world: { file: 'test/mock/world.json', exists: true },
      instructions: ['AGENTS.md'],
      skills: ['.claude/skills/e2e'],
      configured: [],
      unknown: [],
    })
  })

  it('takes corrections from .c8y-agent/config.yml', () => {
    const dir = repo({
      ...WORKSPACE,
      '.c8y-agent/config.yml': [
        'protect: [packages/shared/]',
        'world: { file: mock/windy-dev.json, pull: { roots: ["1"] } }',
        'e2e: { auth: open, env: { C8Y_CYPRESS_URL: "{devUrl}" } }',
        'commands: { lint: pnpm run lint:ci }',
        'projects: { kpi: { commands: { test: pnpm run test:kpi:ci } } }',
      ].join('\n'),
    })
    const profile = discover(dir)
    expect(profile.e2e).toEqual({ root: 'test', config: 'config/{app}.config.ts', auth: 'open', env: { C8Y_CYPRESS_URL: '{devUrl}' } })
    expect(profile.world).toEqual({ file: 'mock/windy-dev.json', exists: false })
    expect(profile.commands.lint).toBe('pnpm run lint:ci')
    expect(profile.apps[0]!.commands.test).toBe('pnpm run test:kpi:ci')
    expect(profile.config).toBe('.c8y-agent/config.yml')
    expect(profile.configured).toEqual(['world.file', 'e2e.auth', 'e2e.env', 'commands', 'projects.kpi.commands'])
  })

  it('follows an explicit or configured e2e root with the settings that depend on it', () => {
    const files = {
      'angular.json': WORKSPACE['angular.json'],
      'e2e/cypress.config.ts': '',
      'test/cypress.config.ts': '',
      'test/c8y-ui.json': { world: 'mock/w.json', auth: 'login', version: '1024.21.3' },
      'test/config/kpi.config.ts': '',
      'test/config/map.config.ts': '',
    }
    const dir = repo(files)
    expect(discover(dir, { e2eRoot: 'test' })).toMatchObject({ e2e: { root: 'test', config: 'config/{app}.config.ts', auth: 'login' }, world: { file: 'test/mock/w.json' } })
    expect(discover(dir, { e2eRoot: 'e2e' }).e2e).toEqual({ root: 'e2e' })
    expect(discover(repo({ ...files, '.c8y-agent/config.yml': 'e2e: { root: test }' })).e2e?.auth).toBe('login')
  })

  it('reads a c8y-ui create layout: Cypress and c8y-ui.json at the root', () => {
    const dir = repo({
      'package.json': { name: 'app', dependencies: { '@c8y/ngx-components': '1024.21.3' } },
      'cypress.config.ts': '',
      'c8y-ui.json': { world: 'mock/world.json', auth: 'open', version: '1024.21.3' },
      'mock/world.json': {},
    })
    expect(discover(dir)).toMatchObject({ e2e: { root: '.', auth: 'open' }, world: { file: 'mock/world.json', exists: true } })
  })

  it('leaves a field unknown when its files cannot be read, instead of failing', () => {
    const dir = repo({
      'package.json': { dependencies: { '@c8y/ngx-components': '>=1024.0.0' } },
      'angular.json': { version: 1 },
      'cypress.config.ts': '',
      'c8y-ui.json': '{bad',
      '.nvmrc/x': '',
    })
    const profile = discover(dir)
    expect(profile.apps).toEqual([])
    expect(profile.unknown).toEqual(expect.arrayContaining([expect.stringMatching(/^apps \(/), expect.stringMatching(/^c8y-ui\.json \(c8y-ui\.json: /), 'world', 'node']))
    const broken = discover(repo({ 'package.json': '{bad', 'cypress.config.ts': '' }))
    expect(broken.unknown).toEqual(expect.arrayContaining([expect.stringMatching(/^package\.json \(package\.json: /)]))
    expect(broken.apps).toEqual([expect.objectContaining({ commands: {} })])
    expect(broken.unknown).toEqual(expect.arrayContaining([expect.stringMatching(/^apps\..+\.contextPath \(/)]))
    expect(discover(repo({ '.c8y-agent/config.yml': 'e2e: { root: missing }' })).unknown).toEqual(expect.arrayContaining([expect.stringMatching(/^e2e\.config \(/)]))
  })

  it('keeps an absolute world path, and finds skills behind symbolic links', () => {
    const dir = repo({ 'cypress.config.ts': '', 'c8y-ui.json': { world: '/abs/world.json', version: '1024.21.3' }, 'shared/skill/SKILL.md': '' })
    mkdirSync(join(dir, '.claude/skills'), { recursive: true })
    symlinkSync(join(dir, 'shared/skill'), join(dir, '.claude/skills/linked'))
    const profile = discover(dir)
    expect(profile.world).toEqual({ file: '/abs/world.json', exists: false })
    expect(profile.skills).toEqual(['.claude/skills/linked'])
  })

  it('profiles a single app with Cypress at the root, and names what it cannot settle', () => {
    const dir = repo({
      'package.json': { name: 'app', scripts: { 'e2e': 'cypress run' } },
      'package-lock.json': '{}',
      'cypress.config.ts': 'export default {}',
    })
    const profile = discover(dir)
    expect(profile.packageManager).toEqual({ name: 'npm' })
    expect(profile.apps).toEqual([{ name: dir.split('/').pop(), dir: '', commands: expect.any(Object) }])
    expect(profile.e2e).toEqual({ root: '.' })
    expect(profile.unknown).toEqual([expect.stringMatching(/^apps\..+\.contextPath \(no package\.json /), 'world', 'node', 'versions.webSdk', 'versions.angular'])
  })

  it('does not guess between two Cypress projects or from one config file of several apps', () => {
    const dir = repo({
      'angular.json': WORKSPACE['angular.json'],
      'e2e/cypress.config.ts': '',
      'test/cypress.config.ts': '',
    })
    expect(discover(dir).unknown).toContain('e2e.root (Cypress projects in e2e, test)')
    const one = repo({ 'angular.json': WORKSPACE['angular.json'], 'test/cypress.config.ts': '', 'test/config/kpi.config.ts': '' })
    expect(discover(one).e2e).toEqual({ root: 'test' })
  })

  it('applies config.yml\'s e2e settings when no e2e root is settled', () => {
    const dir = repo({
      'e2e/cypress.config.ts': '',
      'test/cypress.config.ts': '',
      '.c8y-agent/config.yml': 'e2e: { auth: login, env: { C8Y_CYPRESS_URL: "{devUrl}" } }',
    })
    const profile = discover(dir)
    expect(profile.e2e).toEqual({ auth: 'login', env: { C8Y_CYPRESS_URL: '{devUrl}' } })
    expect(profile.unknown).toContain('e2e.root (Cypress projects in e2e, test)')
    const target = targetFromProfile(dir, profile)
    expect(target).toMatchObject({ e2eAuth: 'login', e2eEnv: { C8Y_CYPRESS_URL: '{devUrl}' } })
    expect(target.e2eRoot).toBeUndefined()
  })

  it('does not take another tool\'s config file for an app\'s Cypress config', () => {
    const dir = repo({
      'angular.json': { projects: { vite: { root: 'packages/vite', architect: { serve: {} } } } },
      'packages/vite/package.json': { name: 'vite' },
      'cypress.config.ts': '',
      'vite.config.ts': '',
    })
    expect(discover(dir).e2e).toEqual({ root: '.' })
  })

  it('keeps auth and world of a c8y-ui.json whose Web SDK version the SDK cannot settle', () => {
    const dir = repo({
      'package.json': { dependencies: { '@c8y/ngx-components': '>=1024.0.0' } },
      'test/cypress.config.ts': '',
      'test/c8y-ui.json': { auth: 'login', version: 'auto', world: 'mock/world.json' },
    })
    const profile = discover(dir)
    expect(profile.e2e).toEqual({ root: 'test', auth: 'login' })
    expect(profile.world).toEqual({ file: 'test/mock/world.json', exists: false })
  })
})

describe('readAgentConfig', () => {
  it('rejects invalid YAML and wrong types, and names the key', () => {
    expect(() => readAgentConfig(repo({ '.c8y-agent/config.yml': 'e2e: [' }))).toThrow(WorkbenchError)
    expect(() => readAgentConfig(repo({ '.c8y-agent/config.yml': 'e2e: { auth: sso }' }))).toThrow(/e2e\.auth/)
    expect(() => readAgentConfig(repo({ '.c8y-agent/config.yml': 'e2e: { env: { "A B": x } }' }))).toThrow(/e2e\.env\.A B/)
    expect(() => readAgentConfig(repo({ '.c8y-agent/config.yml': 'e2e: { roots: test }' }))).toThrow(/roots/)
  })

  it('leaves the keys of other components alone, and accepts an empty file', () => {
    expect(readAgentConfig(repo({ '.c8y-agent/config.yml': 'protect: [a]\nlimits: { rounds: 3 }' }))).toEqual({})
    expect(readAgentConfig(repo({ '.c8y-agent/config.yml': '' }))).toEqual({})
    expect(readAgentConfig(repo({}))).toBeUndefined()
  })
})

describe('targetFromProfile', () => {
  it('takes explicit settings over the profile, and adds up the environment', () => {
    const dir = repo({ ...WORKSPACE, '.c8y-agent/config.yml': 'e2e: { env: { A: "1", B: "2" } }' })
    const profile = discover(dir)
    expect(targetFromProfile(dir, profile)).toEqual({ repo: dir, world: 'test/mock/world.json', e2eRoot: 'test', e2eConfig: 'config/{app}.config.ts', e2eConfigOptional: true, e2eAuth: 'login', e2eEnv: { A: '1', B: '2' } })
    expect(targetFromProfile(dir, profile, { world: 'other.json', e2eAuth: 'open', e2eConfig: undefined, e2eEnv: { B: '3' } })).toEqual({
      repo: dir,
      world: 'other.json',
      e2eRoot: 'test',
      e2eConfig: 'config/{app}.config.ts',
      e2eConfigOptional: true,
      e2eAuth: 'open',
      e2eEnv: { A: '1', B: '3' },
    })
  })

  it('uses a detected config pattern only for apps with the file, and a configured or explicit one strictly', () => {
    const files = { ...WORKSPACE, 'angular.json': { projects: { ...WORKSPACE['angular.json'].projects, 'plugin.new': { root: 'packages/new', architect: { serve: {} } } } }, 'packages/new/package.json': { name: '@scope/new-plugin' }, 'packages/new/cumulocity.config.ts': `export default { runTime: { contextPath: 'new-plugin', isPackage: true } }` }
    const dir = repo(files)
    const fresh = resolveApp(dir, 'new')
    const detected = targetFromProfile(dir, discover(dir))
    expect(e2eConfigFile(detected, resolveApp(dir, 'kpi'))).toBe('config/kpi.config.ts')
    expect(e2eConfigFile(detected, fresh)).toBeUndefined()
    expect(e2eConfigFile(targetFromProfile(dir, discover(dir), { e2eConfig: 'config/{app}.config.ts' }), fresh)).toBe('config/new.config.ts')
    const configured = repo({ ...files, '.c8y-agent/config.yml': 'e2e: { config: "config/{app}.config.ts" }' })
    expect(e2eConfigFile(targetFromProfile(configured, discover(configured)), resolveApp(configured, 'new'))).toBe('config/new.config.ts')
  })
})

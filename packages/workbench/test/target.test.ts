import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { e2eConfigFile, listApps, resolveApp, WorkbenchError } from '../src/target'

describe('apps', () => {
  let repo: string
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'workbench-target-'))
    const write = (file: string, content: unknown): void => {
      mkdirSync(join(repo, file, '..'), { recursive: true })
      writeFileSync(join(repo, file), typeof content === 'string' ? content : JSON.stringify(content))
    }
    write('package.json', { name: 'workspace', dependencies: { '@c8y/ngx-components': '1024.21.3' } })
    write('angular.json', {
      projects: {
        'shared': { root: 'packages/shared', architect: { build: {} } },
        'plugin.kpi': { root: 'packages/kpi', architect: { serve: {} } },
      },
    })
    write('packages/kpi/package.json', { name: '@scope/kpi-plugin' })
    write('packages/kpi/cumulocity.config.ts', `export default { runTime: { contextPath: 'kpi-plugin', isPackage: true } }`)
  })
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('lists the Angular projects that can be served', () => {
    expect(listApps(repo)).toEqual([{ name: 'kpi', dir: 'packages/kpi', project: 'plugin.kpi' }])
  })

  it('resolves an app by folder, project or directory, with its SDK configuration', () => {
    const expected = { name: 'kpi', dir: 'packages/kpi', project: 'plugin.kpi', config: { version: '1024.21.3', contextPath: 'kpi-plugin', shell: 'cockpit', shells: ['cockpit'] } }
    expect(resolveApp(repo, 'kpi')).toEqual(expected)
    expect(resolveApp(repo, 'plugin.kpi')).toEqual(expected)
    expect(resolveApp(repo, 'packages/kpi/')).toEqual(expected)
    expect(() => resolveApp(repo, 'shared')).toThrow(WorkbenchError)
  })

  it('fills the app name into the Cypress config file', () => {
    const app = resolveApp(repo, 'kpi')
    expect(e2eConfigFile({ repo, world: 'w.json', e2eConfig: 'config/{app}.config.ts' }, app)).toBe('config/kpi.config.ts')
    expect(e2eConfigFile({ repo, world: 'w.json' }, app)).toBeUndefined()
  })
})

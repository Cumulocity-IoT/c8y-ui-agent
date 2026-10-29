import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changedFiles, isSpec, isTestFile, prepareCheckout, proveRegression } from '../src/regression'

let repo: string
let base: string
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
const write = (file: string, content: string): void => {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), content)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'workbench-regression-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  write('package.json', JSON.stringify({ name: 'app', dependencies: { '@c8y/ngx-components': '1024.21.3' } }))
  write('src/app.ts', 'export const a = 1\n')
  write('src/gone.ts', 'export const b = 1\n')
  write('test/cypress/e2e/a.cy.ts', 'it("a", () => {})\n')
  write('.gitignore', 'cypress.env.json\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  base = git('rev-parse', 'HEAD')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('changedFiles', () => {
  it('finds committed, staged, unstaged, untracked and deleted files, and leaves out build output', async () => {
    write('src/app.ts', 'export const a = 2\n')
    git('commit', '-qam', 'change')
    write('test/cypress/e2e/a.cy.ts', 'it("a", () => { expect(2).to.eq(2) })\n')
    write('test/cypress/e2e/new.cy.ts', 'it("new", () => {})\n')
    unlinkSync(join(repo, 'src/gone.ts'))
    write('packages/x/dist/monaco-workers/w.js', '')
    write('cypress.env.json', '{}')
    const { changes, ignored } = await changedFiles(repo, base)
    expect(changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'src/app.ts', deleted: false },
      { path: 'src/gone.ts', deleted: true },
      { path: 'test/cypress/e2e/a.cy.ts', deleted: false },
      { path: 'test/cypress/e2e/new.cy.ts', deleted: false },
    ])
    expect(ignored).toEqual(['packages/x/dist/monaco-workers/w.js'])
  })
})

describe('prepareCheckout', () => {
  it('checks out the commit with the given files, without running hooks', async () => {
    write('.hooks/post-checkout', '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/hook-ran"\n')
    chmodSync(join(repo, '.hooks/post-checkout'), 0o755)
    git('config', 'core.hooksPath', '.hooks')
    write('test/cypress/e2e/a.cy.ts', 'changed\n')
    unlinkSync(join(repo, 'src/gone.ts'))
    symlinkSync('a.cy.ts', join(repo, 'test/cypress/e2e/link.cy.ts'))
    const dir = join(mkdtempSync(join(tmpdir(), 'workbench-checkout-')), 'co')
    try {
      await prepareCheckout(repo, base, [
        { path: 'test/cypress/e2e/a.cy.ts', deleted: false },
        { path: 'src/gone.ts', deleted: true },
        { path: 'test/cypress/e2e/link.cy.ts', deleted: false },
      ], dir)
      expect(readFileSync(join(dir, 'test/cypress/e2e/a.cy.ts'), 'utf8')).toBe('changed\n')
      expect(existsSync(join(dir, 'src/gone.ts'))).toBe(false)
      expect(readlinkSync(join(dir, 'test/cypress/e2e/link.cy.ts'))).toBe('a.cy.ts')
      expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toBe('export const a = 1\n')
      expect(existsSync(join(dir, 'hook-ran'))).toBe(false)
    }
    finally {
      git('worktree', 'remove', '--force', dir)
      rmSync(dirname(dir), { recursive: true, force: true })
    }
  })
})

describe('proveRegression', () => {
  it('does not run without a product change', async () => {
    write('test/cypress/e2e/a.cy.ts', 'it("a", () => { expect(1).to.eq(2) })\n')
    const result = await proveRegression({ target: { repo, world: 'w.json', e2eRoot: 'test' }, app: basename(repo), base })
    expect(result.verdict).toBe('not-proven')
    expect(result.reasons[0]).toContain('no product change')
    expect(result.runs).toEqual([])
    expect(git('worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('rejects specs and an e2e root outside the repository', async () => {
    write('src/app.ts', 'export const a = 2\n')
    await expect(proveRegression({ target: { repo, world: 'w.json', e2eRoot: 'test' }, app: basename(repo), base, specs: ['../x.cy.ts'] })).rejects.toThrow('outside the repository')
    await expect(proveRegression({ target: { repo, world: 'w.json', e2eRoot: '/tmp' }, app: basename(repo), base })).rejects.toThrow('outside the repository')
  })

  it('rejects an option as base', async () => {
    await expect(proveRegression({ target: { repo, world: 'w.json', e2eRoot: 'test' }, app: basename(repo), base: '--output=/tmp/x' })).rejects.toThrow()
  })
})

describe('test files', () => {
  it('are the files under the e2e root', () => {
    expect(isTestFile('test/cypress/e2e/a.cy.ts', 'test')).toBe(true)
    expect(isTestFile('test/config/a.config.ts', './test/')).toBe(true)
    expect(isTestFile('testing/a.ts', 'test')).toBe(false)
    expect(isTestFile('packages/a/src/a.ts', 'test')).toBe(false)
  })

  it('are Cypress folders, specs, configs and the configured config file with the e2e root at the repository root', () => {
    expect(isTestFile('cypress/support/e2e.ts')).toBe(true)
    expect(isTestFile('src/app.cy.ts', '.')).toBe(true)
    expect(isTestFile('cypress.config.ts')).toBe(true)
    expect(isTestFile('apps/x/cypress.config.mjs')).toBe(true)
    expect(isTestFile('cypress.env.json')).toBe(true)
    expect(isTestFile('e2e/kpi.config.ts', '.', 'e2e/{app}.config.ts')).toBe(true)
    expect(isTestFile('e2e/kpi.config.ts')).toBe(false)
    expect(isTestFile('src/app.ts')).toBe(false)
  })

  it('specs are Cypress spec files', () => {
    expect(isSpec('test/cypress/e2e/a.cy.ts')).toBe(true)
    expect(isSpec('test/cypress/e2e/a.cy.mjs')).toBe(true)
    expect(isSpec('test/config/a.config.ts')).toBe(false)
  })
})

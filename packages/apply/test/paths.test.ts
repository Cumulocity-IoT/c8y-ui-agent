import { describe, expect, it } from 'vitest'
import { checkPaths, globMatches } from '../src/paths'

const rules = (paths: string[], options = {}): string[] => checkPaths(paths, options).map(v => `${v.rule} ${v.file}`)

describe('checkPaths', () => {
  it('allows product and test files', () => {
    expect(rules(['src/app.ts', 'test/cypress/e2e/a.cy.ts', 'packages/x/package.json', 'docs/github.md'])).toEqual([])
  })

  it('protects .github, the agent configuration and instructions at any depth', () => {
    expect(rules(['.github/workflows/ci.yml', '.c8y-agent/config.yml', '.claude/settings.json', 'packages/x/.claude/skills/a/SKILL.md', 'AGENTS.md', 'packages/x/CLAUDE.md'])).toEqual([
      'github .github/workflows/ci.yml',
      'agent-config .c8y-agent/config.yml',
      'agent-instructions .claude/settings.json',
      'agent-instructions packages/x/.claude/skills/a/SKILL.md',
      'agent-instructions AGENTS.md',
      'agent-instructions packages/x/CLAUDE.md',
    ])
  })

  it('protects package sources and install hooks at the root', () => {
    expect(rules(['.npmrc', '.gitmodules', '.pnpmfile.cjs', 'packages/x/.npmrc'])).toEqual([
      'package-sources .npmrc',
      'package-sources .gitmodules',
      'package-sources .pnpmfile.cjs',
    ])
  })

  it('allows .c8y-agent/ only when the setup playbook asks for it', () => {
    expect(rules(['.c8y-agent/config.yml', '.github/x.yml'], { allowAgentConfig: true })).toEqual(['github .github/x.yml'])
  })

  it('allows a lockfile change only with a manifest change', () => {
    expect(rules(['pnpm-lock.yaml'])).toEqual(['lockfile pnpm-lock.yaml'])
    expect(rules(['pnpm-lock.yaml', 'packages/x/package.json'])).toEqual([])
    expect(rules(['package-lock.json', 'pnpm-workspace.yaml'])).toEqual([])
  })

  it('applies the protect list', () => {
    expect(rules(['packages/shared/src/index.ts', 'packages/shared/README.md', 'src/a.ts'], { protect: ['packages/shared/src/index.ts', '*.md', 'packages/**/README.md'] }))
      .toEqual(['protect packages/shared/src/index.ts', 'protect packages/shared/README.md'])
  })
})

describe('globMatches', () => {
  it('matches paths, directories and globs', () => {
    expect(globMatches('packages/shared/', 'packages/shared/a/b.ts')).toBe(true)
    expect(globMatches('./src/a.ts', 'src/a.ts')).toBe(true)
    expect(globMatches('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(globMatches('src/**/*.ts', 'src/b.ts')).toBe(true)
    expect(globMatches('src/**/*.ts', 'src/a/b.ts')).toBe(true)
    expect(globMatches('src/**', 'src/a/b.ts')).toBe(true)
    expect(globMatches('a.b', 'axb')).toBe(false)
  })
})

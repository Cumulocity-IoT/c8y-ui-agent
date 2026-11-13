import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decide } from '../hooks/guard.mjs'

const bash = command => decide({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' })
const edit = (file_path, tool_name = 'Edit') => decide({ tool_name, tool_input: { file_path }, cwd: '/repo' })

describe('guard', () => {
  it('denies pushes, remote changes, merges, and the GitHub CLI, also inside compound commands', () => {
    for (const command of [
      'git push',
      'git push origin HEAD:main',
      'cd packages/kpi && git push',
      'git -C /repo push --force',
      'GIT_TRACE=1 git push',
      'sudo git push',
      'echo $(git push)',
      'git remote add evil https://example.com/x.git',
      'git remote set-url origin x',
      'git pull',
      'git merge main',
      'gh issue comment 1 --body x',
      '/usr/bin/gh pr create',
    ])
      expect(bash(command), command).toBeTypeOf('string')
  })

  it('denies staging everything, and allows staging named files', () => {
    for (const command of ['git add -A', 'git add .', 'git add --all', 'git add -Av', 'git add :/', 'git status && git add .'])
      expect(bash(command), command).toMatch(/by name/)
    for (const command of ['git add packages/kpi/src/a.ts test/cypress/e2e/kpi.cy.ts', 'git add -u', 'git add -p src/a.ts'])
      expect(bash(command), command).toBeUndefined()
  })

  it('allows reading and committing', () => {
    for (const command of [
      'git status',
      'git diff abc..HEAD',
      'git log --oneline',
      'git commit -m "fix(kpi): x (#1)"',
      'git remote -v',
      'pnpm run lint',
      'echo "git push is not allowed"',
      'c8y-ui-apply validate /run/result.json',
    ])
      expect(bash(command), command).toBeUndefined()
  })

  it('denies edits of protected paths, case-insensitive and at any depth for agent instructions', () => {
    for (const file of ['.github/workflows/ci.yml', '/repo/.c8y-agent/config.yml', 'AGENTS.md', 'packages/kpi/CLAUDE.md', 'packages/x/.claude/settings.json', '.mcp.json', 'Agents.md'])
      expect(edit(file), file).toMatch(/is protected/)
    expect(decide({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '.github/x.ipynb' }, cwd: '/repo' })).toMatch(/is protected/)
  })

  it('allows edits of product code, and of files outside the checkout such as result.json', () => {
    for (const file of ['packages/kpi/src/kpi.component.ts', '/repo/test/cypress/e2e/kpi.cy.ts', '/run/result.json', '../run/result.json', 'docs/github.md'])
      expect(edit(file, 'Write'), file).toBeUndefined()
  })

  it('leaves other tools and malformed events to the permission rules', () => {
    expect(decide({ tool_name: 'Read', tool_input: { file_path: '.github/x' } })).toBeUndefined()
    expect(decide(undefined)).toBeUndefined()
    expect(decide({ tool_name: 'Bash', tool_input: {} })).toBeUndefined()
  })

  it('answers Claude Code with a deny decision on stdout, and nothing for an allowed call', () => {
    const script = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url))
    const run = event => spawnSync(process.execPath, [script], { input: JSON.stringify(event), encoding: 'utf8' })
    const denied = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: '/repo' })
    expect(denied.status).toBe(0)
    expect(JSON.parse(denied.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    const allowed = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: '/repo' })
    expect(allowed.status).toBe(0)
    expect(allowed.stdout).toBe('')
    expect(spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' }).stdout).toBe('')
  })
})

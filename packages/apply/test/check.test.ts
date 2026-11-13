import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundle } from '../src/bundle'
import { check, UsageError } from '../src/check'
import type { CheckOptions } from '../src/check'
import { commit, repos, run, write } from './repo'
import type { Repos } from './repo'

const PR = { version: 1, outcome: 'pull-request', summary: 'Fixed.', pullRequest: { title: 'fix: x', body: 'Body' } }

let r: Repos
beforeEach(() => {
  r = repos({ 'src/app.ts': 'export {}\n', '.c8y-agent/config.yml': 'protect:\n  - src/generated/\n' })
})
afterEach(() => r.cleanup())

/** The agent's result and bundle, then the check in the fresh checkout. */
function agentRun(result: unknown, options: Partial<CheckOptions> = {}): ReturnType<typeof check> {
  const resultFile = join(r.root, 'result.json')
  writeFileSync(resultFile, JSON.stringify(result))
  const bundled = bundle({ dir: r.agent, base: options.base ?? r.base, file: join(r.root, 'agent.bundle') })
  return check({ dir: r.fresh, resultFile, bundleFile: bundled.file, base: r.base, defaultBranch: 'main', number: 12, playbook: 'fix', ...options })
}

const rules = (report: ReturnType<typeof check>): string[] => report.violations.map(v => v.rule)

describe('check', () => {
  it('passes a pull request with commits from the base', () => {
    commit(r.agent, { 'src/app.ts': 'export const a = 1\n' })
    const head = commit(r.agent, { 'test/a.cy.ts': 'it()\n' })
    const report = agentRun(PR)
    expect(report).toMatchObject({ ok: true, violations: [], branch: 'agent/12-fix', head, commits: 2, files: ['src/app.ts', 'test/a.cy.ts'] })
  })

  it('passes a comment without commits, and reports a missing result', () => {
    expect(agentRun({ version: 1, outcome: 'comment', summary: 'Triage.' }).ok).toBe(true)
    const report = check({ dir: r.fresh, resultFile: join(r.root, 'none.json'), base: r.base, defaultBranch: 'main', number: 12, playbook: 'fix' })
    expect(report.violations).toEqual([{ rule: 'result', message: 'the run wrote no result.json' }])
  })

  it('ties the outcome to the commits', () => {
    expect(agentRun(PR).violations.map(v => v.message)).toEqual(['outcome pull-request, but the run made no commits'])
    commit(r.agent, { 'src/app.ts': 'x\n' })
    expect(agentRun({ version: 1, outcome: 'comment', summary: 's' }).violations.map(v => v.message))
      .toEqual(['outcome comment, but the run made 1 commit(s): use outcome pull-request, or drop the commits'])
  })

  it('rejects protected paths, deletions and renames included, and the protect list of the default branch', () => {
    commit(r.agent, { '.github/workflows/x.yml': 'on: push\n', 'src/generated/a.ts': 'x\n' })
    run(r.agent, 'mv', 'src/app.ts', 'AGENTS.md')
    run(r.agent, 'commit', '--quiet', '-am', 'rename')
    const report = agentRun(PR)
    expect(report.violations.map(v => `${v.rule} ${v.file}`)).toEqual([
      'github .github/workflows/x.yml',
      'agent-instructions AGENTS.md',
      'protect src/generated/a.ts',
    ])
    expect(report.files).toContain('src/app.ts')
  })

  it('checks the paths of every commit, not only the net change', () => {
    commit(r.agent, { '.github/workflows/x.yml': 'on: push\n' })
    run(r.agent, 'rm', '--quiet', '.github/workflows/x.yml')
    run(r.agent, 'commit', '--quiet', '-m', 'remove')
    commit(r.agent, { 'src/app.ts': 'x\n' })
    const report = agentRun(PR)
    expect(report.files).toEqual(['.github/workflows/x.yml', 'src/app.ts'])
    expect(rules(report)).toEqual(['github'])
  })

  it('rejects commits that skip CI', () => {
    commit(r.agent, { 'src/app.ts': 'x\n' }, 'fix: x [skip ci]')
    commit(r.agent, { 'src/app.ts': 'y\n' }, 'fix: y\n\nskip-checks: true')
    expect(agentRun(PR).violations.map(v => v.message)).toEqual([
      expect.stringMatching(/^commit [0-9a-f]{12} tells GitHub Actions to skip CI/),
      expect.stringMatching(/^commit [0-9a-f]{12} tells GitHub Actions to skip CI/),
    ])
  })

  it('reports a result.json that is not a file', () => {
    const report = check({ dir: r.fresh, resultFile: r.root, base: r.base, defaultBranch: 'main', number: 12, playbook: 'fix' })
    expect(report.violations).toEqual([{ rule: 'result', message: 'the run wrote no result.json' }])
  })

  it('reads protect from the default branch, not from the agent\'s commits', () => {
    commit(r.agent, { '.c8y-agent/config.yml': 'protect: []\n', 'src/generated/a.ts': 'x\n' })
    expect(rules(agentRun(PR))).toEqual(['agent-config', 'protect'])
  })

  it('lets the setup playbook change .c8y-agent/ in a draft only', () => {
    commit(r.agent, { '.c8y-agent/playbooks/x.md': '---\ndescription: x\n---\n' })
    expect(agentRun({ ...PR, pullRequest: { ...PR.pullRequest, draft: true } }, { playbook: 'setup' }).ok).toBe(true)
    expect(rules(agentRun(PR, { playbook: 'setup' }))).toEqual(['agent-config'])
  })

  it('fails closed on an unreadable protect list', () => {
    const seed = join(r.root, 'seed')
    commit(seed, { '.c8y-agent/config.yml': 'protect: [\n' })
    run(seed, 'push', '--quiet', r.origin, 'main')
    r.refresh()
    expect(rules(agentRun({ version: 1, outcome: 'comment', summary: 's' }))).toEqual(['config'])
  })

  it('rejects merge commits', () => {
    run(r.agent, 'checkout', '--quiet', '-b', 'side')
    commit(r.agent, { 'src/b.ts': 'b\n' })
    run(r.agent, 'checkout', '--quiet', 'main')
    commit(r.agent, { 'src/c.ts': 'c\n' })
    run(r.agent, 'merge', '--quiet', '--no-edit', 'side')
    expect(agentRun(PR).violations[0]?.message).toMatch(/^the bundle has merge commits/)
  })

  it('rejects a base that is not on the default branch, and a bundle from another base', () => {
    run(r.agent, 'checkout', '--quiet', '--orphan', 'other')
    const other = commit(r.agent, { 'x.ts': 'x\n' })
    run(join(r.root, 'agent'), 'push', '--quiet', r.origin, 'other')
    r.refresh()
    commit(r.agent, { 'y.ts': 'y\n' })
    const report = agentRun(PR, { base: other })
    expect(report.violations.map(v => v.message)).toEqual([`the base ${other.slice(0, 12)} is not on main`])

    // The bundle starts from `other`; the workflow says the run started from main.
    const mismatch = check({ dir: r.fresh, resultFile: join(r.root, 'result.json'), bundleFile: join(r.root, 'agent.bundle'), base: r.base, defaultBranch: 'main', number: 12, playbook: 'fix' })
    expect(mismatch.violations[0]?.message).toMatch(/^the bundle's commits do not start from the base/)
  })

  it('rejects a bundle whose prerequisites the repository lacks', () => {
    const elsewhere = repos()
    try {
      commit(elsewhere.agent, { 'z.ts': 'z\n' })
      const file = bundle({ dir: elsewhere.agent, base: elsewhere.base, file: join(r.root, 'agent.bundle') }).file
      writeFileSync(join(r.root, 'result.json'), JSON.stringify(PR))
      const report = check({ dir: r.fresh, resultFile: join(r.root, 'result.json'), bundleFile: file, base: r.base, defaultBranch: 'main', number: 12, playbook: 'fix' })
      expect(report.violations[0]?.message).toMatch(/^the bundle does not apply to this repository/)
    }
    finally {
      elsewhere.cleanup()
    }
  })

  it('requires the base to be the agent branch\'s head in a rework round', () => {
    commit(r.agent, { 'src/app.ts': 'one\n' })
    run(r.agent, 'push', '--quiet', r.origin, 'HEAD:refs/heads/agent/12-fix')
    const branchHead = run(r.agent, 'rev-parse', 'HEAD')
    r.refresh()
    commit(r.agent, { 'src/app.ts': 'two\n' })
    expect(agentRun(PR, { base: branchHead }).ok).toBe(true)
    expect(agentRun(PR, { base: r.base }).violations[0]?.message).toBe(`agent/12-fix is at ${branchHead.slice(0, 12)}, not at the base ${r.base.slice(0, 12)} the run started from`)
  })

  it('throws on invalid workflow inputs', () => {
    const base = { dir: r.fresh, resultFile: 'x', base: r.base, defaultBranch: 'main', number: 1, playbook: 'fix' }
    expect(() => check({ ...base, number: 0 })).toThrow(UsageError)
    expect(() => check({ ...base, playbook: '../x' })).toThrow(UsageError)
    expect(() => check({ ...base, base: 'main' })).toThrow(UsageError)
    expect(() => check({ ...base, defaultBranch: 'gone' })).toThrow(/origin\/gone is not in the checkout/)
  })

  it('limits the commits and the heads of a bundle', () => {
    for (let i = 0; i < 51; i++)
      commit(r.agent, { 'src/app.ts': `${i}\n` })
    expect(agentRun(PR).violations.map(v => v.message)).toEqual(['the bundle has 51 commits, at most 50'])

    run(r.agent, 'branch', 'second')
    run(r.agent, 'bundle', 'create', '--quiet', join(r.root, 'two.bundle'), 'main', 'second', `^${r.base}`)
    const report = check({ dir: r.fresh, resultFile: join(r.root, 'result.json'), bundleFile: join(r.root, 'two.bundle'), base: r.base, defaultBranch: 'main', number: 12, playbook: 'fix' })
    expect(report.violations.map(v => v.message)).toContain('the bundle must have one head, not 2')
  })
})

describe('bundle', () => {
  it('writes no bundle without commits and lists uncommitted files', () => {
    write(r.agent, { 'loose.ts': 'x\n' })
    const bundled = bundle({ dir: r.agent, base: r.base, file: join(r.root, 'b.bundle') })
    expect(bundled).toMatchObject({ commits: 0, uncommitted: ['loose.ts'] })
    expect(bundled.file).toBeUndefined()
  })
})

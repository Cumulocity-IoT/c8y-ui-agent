import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageError } from '../src/check'
import { listPlaybooks, resolvePlaybook, runPrompt } from '../src/playbook'

const PACK = resolve(__dirname, '../../../pack')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'apply-playbook-'))
  dirs.push(dir)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}

const pack = (): string => tree({
  'run.md': '# Run\n\nShared rules.',
  'playbooks/fix.md': '---\ndescription: Fix a bug.\nevidence: regression\nresult: pull-request\n---\nFix steps.',
  'playbooks/triage.md': '---\ndescription: Triage an issue.\nevidence: observed\nresult: comment\n---\nTriage steps.',
})

describe('playbooks', () => {
  it('lists the pack\'s built-ins without a repository folder', () => {
    const { playbooks, errors } = listPlaybooks({ pack: pack(), dir: tree({}) })
    expect(errors).toEqual([])
    expect(playbooks.map(p => [p.name, p.source, p.evidence, p.result])).toEqual([['fix', 'builtin', 'regression', 'pull-request'], ['triage', 'builtin', 'observed', 'comment']])
  })

  it('extends a built-in with the repository\'s rules and fields, and adds new playbooks with defaults', () => {
    const dir = tree({
      '.c8y-agent/playbooks/fix.md': '---\ndescription: Fix a bug in one plugin.\nextends: builtin\n---\n- Add a CHANGELOG entry.',
      '.c8y-agent/playbooks/translate.md': '---\ndescription: Add German translations.\nevidence: static\n---\n1. Find strings.',
    })
    const { playbooks, errors } = listPlaybooks({ pack: pack(), dir })
    expect(errors).toEqual([])
    const fix = playbooks.find(p => p.name === 'fix')!
    expect(fix).toMatchObject({ source: 'extended', description: 'Fix a bug in one plugin.', evidence: 'regression', result: 'pull-request' })
    expect(fix.body).toBe('Fix steps.\n\n## Repository rules\n\nThe repository adds these rules (.c8y-agent/playbooks/fix.md):\n\n- Add a CHANGELOG entry.')
    expect(playbooks.find(p => p.name === 'translate')).toEqual({ name: 'translate', description: 'Add German translations.', evidence: 'static', result: 'pull-request', source: 'repository', body: '1. Find strings.' })
  })

  it('names a playbook by its name field, and switches playbooks off in config.yml', () => {
    const dir = tree({
      '.c8y-agent/playbooks/de.md': '---\nname: translate\ndescription: Translate.\n---\nSteps.',
      '.c8y-agent/config.yml': 'playbooks:\n  triage: false\n  fix: true\n  missing: false\nprotect: [a]\n',
    })
    const list = listPlaybooks({ pack: pack(), dir })
    expect(list.playbooks.map(p => p.name)).toEqual(['fix', 'translate'])
    expect(list.disabled).toEqual(['triage'])
    expect(list.errors).toEqual(['playbooks.missing in .c8y-agent/config.yml: there is no playbook missing'])
    expect(() => resolvePlaybook('triage', { pack: pack(), dir })).toThrow('the playbook triage is switched off in .c8y-agent/config.yml')
  })

  it('leaves out repository files with errors, names every error, and keeps the others', () => {
    const dir = tree({
      '.c8y-agent/playbooks/fix.md': '---\ndescription: Replace fix.\n---\nOther steps.',
      '.c8y-agent/playbooks/new.md': '---\nextends: builtin\n---\nSteps.',
      '.c8y-agent/playbooks/bad.md': '---\ndescription: x\nevidence: proof\nresult: review\ngate: plan\nmodels: { developer: x }\ncolor: red\n---\nSteps.',
      '.c8y-agent/playbooks/empty.md': '---\ndescription: Nothing to do.\n---\n',
      '.c8y-agent/playbooks/nodesc.md': 'Just steps.',
      '.c8y-agent/playbooks/yaml.md': '---\ndescription: [\n---\nSteps.',
      '.c8y-agent/playbooks/Upper.md': '---\ndescription: x\n---\nSteps.',
      '.c8y-agent/playbooks/ok.md': '---\ndescription: Fine.\n---\nSteps.',
      '.c8y-agent/playbooks/notes.txt': 'not a playbook',
    })
    const { playbooks, errors } = listPlaybooks({ pack: pack(), dir })
    expect(playbooks.map(p => p.name)).toEqual(['fix', 'ok', 'triage'])
    expect(playbooks.find(p => p.name === 'fix')!.source).toBe('builtin')
    expect(errors).toEqual([
      '.c8y-agent/playbooks/Upper.md: the file name is not a playbook name (lowercase letters, digits, hyphens); set name',
      '.c8y-agent/playbooks/bad.md: models is not supported yet',
      '.c8y-agent/playbooks/bad.md: unknown field "color" (description, name, extends, gate, evidence, result)',
      '.c8y-agent/playbooks/bad.md: gate "plan" is not supported yet; only none',
      '.c8y-agent/playbooks/bad.md: evidence must be one of static, observed, regression',
      '.c8y-agent/playbooks/bad.md: result must be one of pull-request, comment (review is not supported yet)',
      '.c8y-agent/playbooks/empty.md: the playbook has no instructions',
      '.c8y-agent/playbooks/fix.md: fix is a built-in playbook; set extends: builtin to add rules to it (replacing a built-in is not supported yet)',
      '.c8y-agent/playbooks/new.md: extends: builtin, but there is no built-in playbook new',
      '.c8y-agent/playbooks/nodesc.md: description is required',
      expect.stringMatching(/^\.c8y-agent\/playbooks\/yaml\.md: the frontmatter is not valid YAML: /),
    ])
    expect(() => resolvePlaybook('new', { pack: pack(), dir })).toThrow('extends: builtin, but there is no built-in playbook new')
    expect(() => resolvePlaybook('bad', { pack: pack(), dir })).toThrow(/models is not supported yet/)
  })

  it('rejects two files for one playbook, and does not follow symbolic links', () => {
    const dir = tree({
      '.c8y-agent/playbooks/a.md': '---\nname: same\ndescription: A.\n---\nA.',
      '.c8y-agent/playbooks/b.md': '---\nname: same\ndescription: B.\n---\nB.',
      'outside.md': '---\ndescription: Outside.\n---\nSecret steps.',
    })
    symlinkSync(join(dir, 'outside.md'), join(dir, '.c8y-agent/playbooks/linked.md'))
    const { playbooks, errors } = listPlaybooks({ pack: pack(), dir })
    expect(playbooks.map(p => p.name)).toEqual(['fix', 'same', 'triage'])
    expect(errors).toEqual(['.c8y-agent/playbooks/b.md: the playbook same is already defined in .c8y-agent/playbooks/a.md'])
  })

  it('fails on an invalid config.yml, a playbooks entry that is not a switch, an unknown name, and a missing pack', () => {
    const p = pack()
    expect(() => listPlaybooks({ pack: p, dir: tree({ '.c8y-agent/config.yml': 'playbooks: [' }) })).toThrow(/not valid YAML/)
    expect(() => listPlaybooks({ pack: p, dir: tree({ '.c8y-agent/config.yml': 'playbooks: { fix: no-thanks }' }) })).toThrow(/must map playbook names to true or false/)
    expect(() => resolvePlaybook('deploy', { pack: p, dir: tree({}) })).toThrow('no playbook deploy; available: fix, triage')
    expect(() => resolvePlaybook('../fix', { pack: p, dir: tree({}) })).toThrow(UsageError)
    expect(() => listPlaybooks({ pack: tree({}), dir: tree({}) })).toThrow(/not an agent pack/)
  })

  it('writes the run prompt: run.md, then the playbook', () => {
    const p = pack()
    const prompt = runPrompt(resolvePlaybook('triage', { pack: p, dir: tree({}) }), p)
    expect(prompt).toBe('# Run\n\nShared rules.\n\n# Playbook: triage\n\nTriage an issue.\n\nMinimum evidence: `observed`. Result: the status comment only, no commits.\n\nTriage steps.\n')
  })
})

describe('the agent pack', () => {
  it('has the built-in playbooks triage and fix, valid and resolvable into a prompt', () => {
    const { playbooks, errors } = listPlaybooks({ pack: PACK, dir: tree({}) })
    expect(errors).toEqual([])
    expect(playbooks.map(p => [p.name, p.evidence, p.result])).toEqual([['fix', 'regression', 'pull-request'], ['triage', 'observed', 'comment']])
    const prompt = runPrompt(playbooks[0]!, PACK)
    expect(prompt.startsWith(readFileSync(join(PACK, 'run.md'), 'utf8').trim())).toBe(true)
    expect(prompt).toContain('# Playbook: fix')
  })
})

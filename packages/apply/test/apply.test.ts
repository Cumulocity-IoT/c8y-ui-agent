import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, FAILED_LABEL, STATUS_MARKER } from '../src/apply'
import type { ApplyOptions } from '../src/apply'
import { bundle } from '../src/bundle'
import { GitHub } from '../src/github'
import { commit, repos, run } from './repo'
import type { Repos } from './repo'

const BOT = 'c8y-ui-agent[bot]'
const PR = { version: 1, outcome: 'pull-request', summary: 'Fixed the empty state.', labels: { add: ['agent:done'], remove: ['agent:fix'] }, pullRequest: { title: 'fix: x', body: 'Body' } }

interface Call { method: string, path: string, body?: unknown }

/** A GitHub API double: records calls, answers from `comments` and `pulls`. */
function fakeGitHub(state: { comments?: Array<{ id: number, body: string, user: { login: string } }>, pulls?: Array<{ number: number, html_url: string }> } = {}): { github: GitHub, calls: Call[] } {
  const calls: Call[] = []
  const fake = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace('https://api.test/repos/o/r', '')
    const body = init.body ? JSON.parse(String(init.body)) as unknown : undefined
    calls.push({ method: init.method!, path, ...(body === undefined ? {} : { body }) })
    const reply = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status })
    if (init.method === 'GET' && path.startsWith('/issues/12/comments'))
      return reply(state.comments ?? [])
    if (init.method === 'GET' && path.startsWith('/pulls'))
      return reply(state.pulls ?? [])
    if (path === '/pulls')
      return reply({ number: 40, html_url: 'https://github.test/o/r/pull/40' }, 201)
    if (path.startsWith('/pulls/'))
      return reply({ number: 31, html_url: 'https://github.test/o/r/pull/31' })
    if (path.includes('/comments'))
      return reply({ id: 7 }, init.method === 'POST' ? 201 : 200)
    if (init.method === 'DELETE')
      return reply({ message: 'Label does not exist' }, 404)
    return reply([])
  }
  return { github: new GitHub({ token: 't', repository: 'o/r', apiUrl: 'https://api.test', fetch: fake as unknown as typeof fetch }), calls }
}

let r: Repos
beforeEach(() => {
  r = repos()
})
afterEach(() => r.cleanup())

function options(result: unknown, github: GitHub): ApplyOptions {
  const resultFile = join(r.root, 'result.json')
  writeFileSync(resultFile, JSON.stringify(result))
  const bundled = bundle({ dir: r.agent, base: r.base, file: join(r.root, 'agent.bundle') })
  return { dir: r.fresh, resultFile, bundleFile: bundled.file, base: r.base, defaultBranch: 'main', number: 12, playbook: 'fix', github, repository: 'o/r', botLogin: BOT, token: 't', remote: r.origin, runUrl: 'https://github.test/run/1' }
}

describe('apply', () => {
  it('pushes the branch, opens the pull request, labels and comments', async () => {
    const head = commit(r.agent, { 'src/app.ts': 'fixed\n' })
    const { github, calls } = fakeGitHub()
    const applied = await apply(options(PR, github))
    expect(applied).toMatchObject({ ok: true, pullRequest: { number: 40 }, comment: 7 })
    expect(run(r.origin, 'rev-parse', 'refs/heads/agent/12-fix')).toBe(head)
    expect(calls.map(c => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
      'GET /pulls',
      'POST /pulls',
      'DELETE /issues/12/labels/agent%3Afix',
      'POST /issues/12/labels',
      'GET /issues/12/comments',
      'POST /issues/12/comments',
    ])
    expect(calls[1]?.body).toEqual({ title: 'fix: x', body: 'Body', head: 'agent/12-fix', base: 'main', draft: false })
    expect(calls[3]?.body).toEqual({ labels: ['agent:done'] })
    expect(calls[5]?.body).toEqual({ body: `${STATUS_MARKER}\nFixed the empty state.\n\nPull request: #40\n\n<sub>[Run](https://github.test/run/1)</sub>` })
  })

  it('updates the open pull request and only the App\'s status comment', async () => {
    commit(r.agent, { 'src/app.ts': 'fixed\n' })
    const { github, calls } = fakeGitHub({
      pulls: [{ number: 31, html_url: 'u' }],
      comments: [{ id: 5, body: STATUS_MARKER, user: { login: 'someone' } }, { id: 6, body: `${STATUS_MARKER}\nold`, user: { login: BOT } }],
    })
    await apply(options(PR, github))
    expect(calls.filter(c => c.method === 'PATCH').map(c => c.path)).toEqual(['/pulls/31', '/issues/comments/6'])
  })

  it('rejects without pushing: a comment with the rules and agent:failed', async () => {
    commit(r.agent, { '.github/workflows/x.yml': 'on: push\n' })
    const { github, calls } = fakeGitHub({ comments: [{ id: 5, body: STATUS_MARKER, user: { login: 'someone' } }] })
    const applied = await apply(options(PR, github))
    expect(applied.ok).toBe(false)
    expect(run(r.origin, 'branch', '--list', 'agent/*')).toBe('')
    expect(calls.map(c => `${c.method} ${c.path.split('?')[0]}`)).toEqual(['GET /issues/12/comments', 'POST /issues/12/comments', 'POST /issues/12/labels'])
    expect(String((calls[1]?.body as { body: string }).body)).toContain('- `github`: .github/workflows/x.yml is protected')
    expect(calls[2]?.body).toEqual({ labels: [FAILED_LABEL] })
  })

  it('reports a push the remote refuses, and labels the run failed', async () => {
    commit(r.agent, { 'src/app.ts': 'fixed\n' })
    const { github, calls } = fakeGitHub()
    const applied = await apply({ ...options(PR, github), remote: join(r.root, 'missing.git') })
    expect(applied).toMatchObject({ ok: false, error: expect.stringMatching(/^git push failed/) })
    expect(String((calls.find(c => c.method === 'POST' && c.path.endsWith('/comments'))?.body as { body: string }).body)).toContain('writing it failed')
    expect(calls.at(-1)?.body).toEqual({ labels: [FAILED_LABEL] })
  })

  it('adds agent:failed for outcome failed', async () => {
    const { github, calls } = fakeGitHub()
    await apply(options({ version: 1, outcome: 'failed', summary: 'Could not reproduce.' }, github))
    expect(calls.find(c => c.path === '/issues/12/labels')?.body).toEqual({ labels: [FAILED_LABEL] })
  })
})

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, FAILED_LABEL, pushEnv, STATUS_MARKER } from '../src/apply'
import type { ApplyOptions } from '../src/apply'
import { bundle } from '../src/bundle'
import { GitHub } from '../src/github'
import { commit, repos, run } from './repo'
import type { Repos } from './repo'

const BOT = 'c8y-ui-agent[bot]'
const PR = { version: 1, outcome: 'pull-request', summary: 'Fixed the empty state.', labels: { add: ['agent:done'], remove: ['agent:fix'] }, pullRequest: { title: 'fix: x', body: 'Body' } }

interface Call { method: string, path: string, body?: unknown }

/** A GitHub API double: records calls, answers from `comments` and `pulls`. */
function fakeGitHub(state: { comments?: Array<{ id: number, body: string, user: { login: string } }>, pulls?: Array<{ number: number, html_url: string, draft?: boolean }> } = {}): { github: GitHub, calls: Call[] } {
  const calls: Call[] = []
  const fake = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace('https://api.test/repos/o/r', '')
    const body = init.body ? JSON.parse(String(init.body)) as unknown : undefined
    calls.push({ method: init.method!, path, ...(body === undefined ? {} : { body }) })
    const reply = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status })
    if (init.method === 'GET' && path.startsWith('/issues/12/comments')) {
      const page = Number(new URL(path, 'https://x').searchParams.get('page'))
      return reply((state.comments ?? []).slice((page - 1) * 100, page * 100))
    }
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
      'DELETE /issues/12/labels/agent%3Afailed',
      'POST /issues/12/labels',
      'GET /issues/12/comments',
      'POST /issues/12/comments',
    ])
    expect(calls[1]?.body).toEqual({ title: 'fix: x', body: 'Body', head: 'agent/12-fix', base: 'main', draft: false })
    expect(calls[4]?.body).toEqual({ labels: ['agent:done'] })
    expect(calls[6]?.body).toEqual({ body: `${STATUS_MARKER}\nFixed the empty state.\n\nPull request: #40\n\n<sub>[Run](https://github.test/run/1)</sub>` })
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

  it('does not force-push over a branch that appeared after the check\'s checkout', async () => {
    commit(r.agent, { 'src/app.ts': 'fixed\n' })
    const seed = join(r.root, 'seed')
    const other = commit(seed, { 'src/other.ts': 'x\n' })
    run(seed, 'push', '--quiet', r.origin, 'HEAD:refs/heads/agent/12-fix')
    const { github, calls } = fakeGitHub()
    const applied = await apply(options(PR, github))
    expect(applied).toMatchObject({ ok: false, error: expect.stringMatching(/^git push failed/) })
    expect(run(r.origin, 'rev-parse', 'agent/12-fix')).toBe(other)
    expect(String((calls.find(c => c.method === 'POST' && c.path.endsWith('/comments'))?.body as { body: string }).body)).toContain('writing it failed')
    expect(calls.at(-1)?.body).toEqual({ labels: [FAILED_LABEL] })
  })

  it('adds agent:failed for outcome failed', async () => {
    const { github, calls } = fakeGitHub()
    await apply(options({ version: 1, outcome: 'failed', summary: 'Could not reproduce.' }, github))
    expect(calls.find(c => c.path === '/issues/12/labels')?.body).toEqual({ labels: [FAILED_LABEL] })
  })

  it('fast-forwards the agent branch in a rework round, and accepts a re-run after the push', async () => {
    commit(r.agent, { 'src/app.ts': 'one\n' })
    run(r.agent, 'push', '--quiet', r.origin, 'HEAD:refs/heads/agent/12-fix')
    const branchHead = run(r.agent, 'rev-parse', 'HEAD')
    r.refresh()
    const head = commit(r.agent, { 'src/app.ts': 'two\n' })
    const { github } = fakeGitHub({ pulls: [{ number: 31, html_url: 'u' }] })
    const rework = { ...options(PR, github), base: branchHead }
    expect(await apply(rework)).toMatchObject({ ok: true, pullRequest: { number: 31 } })
    expect(run(r.origin, 'rev-parse', 'agent/12-fix')).toBe(head)
    // The pull request call failed after the push; the job runs again on a fresh checkout.
    r.refresh()
    expect(await apply({ ...rework, dir: r.fresh })).toMatchObject({ ok: true })
  })

  it('keeps .c8y-agent/ changes of the setup playbook out of a pull request that is not a draft', async () => {
    commit(r.agent, { '.c8y-agent/playbooks/x.md': 'x\n' })
    const result = { ...PR, pullRequest: { ...PR.pullRequest, draft: true } }
    const { github, calls } = fakeGitHub({ pulls: [{ number: 31, html_url: 'u', draft: false }] })
    const applied = await apply({ ...options(result, github), playbook: 'setup' })
    expect(applied.ok).toBe(false)
    expect(applied.report.violations.map(v => v.message)).toEqual(['.c8y-agent/playbooks/x.md is protected: pull request #31 is not a draft'])
    expect(run(r.origin, 'branch', '--list', 'agent/*')).toBe('')
    expect(calls.at(-1)?.body).toEqual({ labels: [FAILED_LABEL] })
  })

  it('finds the status comment on a later page', async () => {
    const comments = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, body: 'x', user: { login: 'someone' } }))
    comments[120] = { id: 121, body: STATUS_MARKER, user: { login: BOT } }
    const { github, calls } = fakeGitHub({ comments })
    await apply(options({ version: 1, outcome: 'comment', summary: 'Triage.' }, github))
    expect(calls.filter(c => c.method === 'GET').map(c => c.path)).toEqual(['/issues/12/comments?per_page=100&page=1', '/issues/12/comments?per_page=100&page=2'])
    expect(calls.find(c => c.method === 'PATCH')?.path).toBe('/issues/comments/121')
  })

  it('reports a failed write after the push, and keeps going when even that fails', async () => {
    commit(r.agent, { 'src/app.ts': 'fixed\n' })
    const { github } = fakeGitHub()
    github.createPullRequest = () => Promise.reject(new Error('POST /pulls: 422 Validation Failed'))
    github.createComment = () => Promise.reject(new Error('POST /issues/12/comments: 502'))
    const applied = await apply(options(PR, github))
    expect(applied).toEqual(expect.objectContaining({ ok: false, error: 'POST /pulls: 422 Validation Failed' }))
    expect(applied.comment).toBeUndefined()
  })
})

describe('pushEnv', () => {
  it('passes the token as an HTTP header for the remote\'s origin only', () => {
    expect(pushEnv('https://github.com/o/r.git', 't')).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:t').toString('base64')}`,
    })
    expect(pushEnv('/tmp/origin.git', 't')).toEqual({})
  })
})

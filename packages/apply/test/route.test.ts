import { describe, expect, it } from 'vitest'
import { parseCommand, route, RouteError } from '../src/route'

const comment = (body: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'created',
  sender: { login: 'alice', type: 'User' },
  issue: { number: 61 },
  comment: { id: 900, body, author_association: 'MEMBER' },
  ...extra,
})

describe('parseCommand', () => {
  it('reads the playbook and the request from the first command line', () => {
    expect(parseCommand('@c8y-ui-agent fix, but do not change packages/shared')).toEqual({ name: 'fix', request: 'but do not change packages/shared' })
    expect(parseCommand('Thanks!\n\n  @C8Y-UI-Agent Triage')).toEqual({ name: 'triage', request: '' })
  })

  it('defaults to triage', () => {
    expect(parseCommand('@c8y-ui-agent')).toEqual({ name: 'triage', request: '' })
  })

  it('ignores mentions inside a line, quotes, and fenced code', () => {
    expect(parseCommand('ask @c8y-ui-agent fix')).toBeUndefined()
    expect(parseCommand('> @c8y-ui-agent fix')).toBeUndefined()
    expect(parseCommand('```\n@c8y-ui-agent fix\n```')).toBeUndefined()
    expect(parseCommand('~~~md\n```\n@c8y-ui-agent fix\n~~~\n@c8y-ui-agent triage')).toEqual({ name: 'triage', request: '' })
    expect(parseCommand('@c8y-ui-agent-bot fix')).toBeUndefined()
  })
})

describe('route', () => {
  it('starts a run for a member\'s command on an issue', () => {
    expect(route('issue_comment', comment('@c8y-ui-agent fix'))).toEqual({ run: true, number: 61, playbook: 'fix', trigger: 'comment', comment: 900 })
  })

  it('leaves the playbook name to the context job, as long as it is a name', () => {
    expect(route('issue_comment', comment('@c8y-ui-agent the widget is broken'))).toMatchObject({ run: true, playbook: 'the' })
    expect(route('issue_comment', comment('@c8y-ui-agent über'))).toMatchObject({ run: false, reason: 'the command names no valid playbook' })
  })

  it('does not run for others, bots, pull requests, or edits', () => {
    expect(route('issue_comment', comment('@c8y-ui-agent fix', { comment: { id: 1, body: '@c8y-ui-agent fix', author_association: 'CONTRIBUTOR' } })))
      .toMatchObject({ run: false, reason: expect.stringContaining('CONTRIBUTOR') })
    expect(route('issue_comment', comment('@c8y-ui-agent fix', { comment: { id: 1, body: '@c8y-ui-agent fix' } })))
      .toMatchObject({ run: false, reason: expect.stringContaining('NONE') })
    expect(route('issue_comment', comment('@c8y-ui-agent fix', { sender: { login: 'c8y-ui-agent[bot]', type: 'Bot' } })))
      .toMatchObject({ run: false })
    expect(route('issue_comment', comment('@c8y-ui-agent fix', { issue: { number: 61, pull_request: { url: 'x' } } })))
      .toMatchObject({ run: false, reason: expect.stringContaining('pull request') })
    expect(route('issue_comment', comment('@c8y-ui-agent fix', { action: 'edited' }))).toMatchObject({ run: false })
    expect(route('issue_comment', comment('Looks good'))).toMatchObject({ run: false })
  })

  it('starts a run for a playbook label, not for a state label', () => {
    const labeled = (name: string): Record<string, unknown> => ({ action: 'labeled', sender: { login: 'alice', type: 'User' }, issue: { number: 7 }, label: { name } })
    expect(route('issues', labeled('agent:fix'))).toEqual({ run: true, number: 7, playbook: 'fix', trigger: 'label' })
    expect(route('issues', labeled('agent:done'))).toMatchObject({ run: false })
    expect(route('issues', labeled('bug'))).toMatchObject({ run: false })
    expect(route('issues', labeled('agent:Fix'))).toMatchObject({ run: false })
    expect(route('issues', { ...labeled('agent:fix'), sender: { login: 'c8y-ui-agent[bot]', type: 'Bot' } })).toMatchObject({ run: false })
    expect(route('issues', { ...labeled('agent:fix'), action: 'opened' })).toMatchObject({ run: false })
  })

  it('takes a dispatch\'s inputs, and rejects invalid ones', () => {
    expect(route('workflow_dispatch', { inputs: { issue: '61', playbook: 'triage' } })).toEqual({ run: true, number: 61, playbook: 'triage', trigger: 'dispatch' })
    expect(() => route('workflow_dispatch', { inputs: { issue: '0', playbook: 'triage' } })).toThrow(RouteError)
    expect(() => route('workflow_dispatch', { inputs: { issue: '61', playbook: '../x' } })).toThrow(RouteError)
    expect(() => route('workflow_dispatch', { inputs: {} })).toThrow(RouteError)
  })

  it('does not run for other events', () => {
    expect(route('pull_request', { action: 'opened', issue: { number: 1 } })).toMatchObject({ run: false })
    expect(route('push', {})).toMatchObject({ run: false })
  })
})

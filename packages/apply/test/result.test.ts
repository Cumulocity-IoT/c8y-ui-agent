import { describe, expect, it } from 'vitest'
import { LIMITS, parseResult } from '../src/result'

const json = (value: unknown): string => JSON.stringify(value)
const errors = (value: unknown): string[] => {
  const parsed = parseResult(json(value))
  return parsed.ok ? [] : parsed.errors
}

const PR = { version: 1, outcome: 'pull-request', summary: 'Fixed.', pullRequest: { title: 'fix: x', body: 'Body' } }

describe('parseResult', () => {
  it('accepts a comment and a pull request', () => {
    expect(parseResult(json({ version: 1, outcome: 'comment', summary: 'Triage: …', labels: { add: ['agent:needs-info'] } })).ok).toBe(true)
    expect(parseResult(json({ ...PR, pullRequest: { ...PR.pullRequest, draft: true }, labels: { remove: ['agent:fix'] } })).ok).toBe(true)
  })

  it('rejects invalid JSON, other types and versions', () => {
    expect(parseResult('{').ok).toBe(false)
    expect(errors([])).toEqual(['result.json must be a JSON object'])
    expect(errors({ ...PR, version: 2 })).toEqual(['version: must be 1'])
  })

  it('reports every error at once', () => {
    expect(errors({ version: 1, outcome: 'merged', summary: '', extra: 1, labels: { add: ['bug', 'agent:Fix'], other: [] } })).toEqual([
      '"extra": unknown field',
      'outcome: must be one of pull-request, comment, failed',
      'summary: must be a non-empty string',
      'labels."other": unknown field',
      'labels.add: "bug" is not an agent:<name> label (lowercase letters, digits, hyphens)',
      'labels.add: "agent:Fix" is not an agent:<name> label (lowercase letters, digits, hyphens)',
    ])
  })

  it('adds state labels only, and removes any agent: label', () => {
    expect(errors({ ...PR, labels: { add: ['agent:setup'], remove: ['agent:fix'] } })).toEqual([
      'labels.add: agent:setup is not a state label (agent:working, agent:needs-info, agent:needs-approval, agent:done, agent:failed, agent:not-runtime-verified)',
    ])
  })

  it('quotes unknown keys, so that a key cannot start a new log line', () => {
    expect(errors({ ...PR, 'x\n::error::y': 1 })).toEqual(['"x\\n::error::y": unknown field'])
  })

  it('ties pullRequest to outcome pull-request', () => {
    expect(errors({ version: 1, outcome: 'pull-request', summary: 's' })).toEqual(['pullRequest: required with outcome pull-request'])
    expect(errors({ ...PR, outcome: 'comment' })).toEqual(['pullRequest: only allowed with outcome pull-request, not comment'])
  })

  it('limits sizes and the title to one line', () => {
    const long = 'x'.repeat(LIMITS.text + 1)
    expect(errors({ ...PR, summary: long })).toEqual([`summary: ${LIMITS.text + 1} characters, at most ${LIMITS.text}`])
    expect(errors({ ...PR, pullRequest: { title: 'a\nb', body: 'b', draft: 'yes' } })).toEqual([
      'pullRequest.title: must be one line',
      'pullRequest.draft: must be true or false',
    ])
    const many = Array.from({ length: 11 }, (_, i) => `agent:l${i}`)
    expect(errors({ ...PR, labels: { remove: many } })).toEqual(['labels: 11 labels, at most 10'])
    expect(errors({ ...PR, labels: { remove: [`agent:${'x'.repeat(45)}`] } })).toHaveLength(1)
    expect(parseResult(' '.repeat(LIMITS.resultBytes + 1)).ok).toBe(false)
  })
})

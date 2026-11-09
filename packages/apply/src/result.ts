// result.json: what an agent run asks the apply job to write to GitHub. The agent writes it, so it is untrusted: every
// field is checked here, and nothing in it decides where the result goes (issue, branch, base): those come from the
// workflow. See docs/result.md.

export const RESULT_VERSION = 1

export const LIMITS = {
  /** result.json itself. */
  resultBytes: 1_000_000,
  /** The status comment and the pull request body (GitHub allows 65,536 characters). */
  text: 60_000,
  title: 256,
  labels: 10,
}

/** Labels the agent may add or remove: the `agent:` namespace. */
export const LABEL = /^agent:[a-z0-9][a-z0-9-]{0,49}$/

export type Outcome = 'pull-request' | 'comment' | 'failed'

export interface AgentResult {
  version: typeof RESULT_VERSION
  /**
   * `pull-request`: the bundle holds commits for a pull request. `comment`: no commits, only the status comment.
   * `failed`: the playbook did not reach its result; the status comment says why.
   */
  outcome: Outcome
  /** The status comment, Markdown. */
  summary: string
  labels?: { add?: string[], remove?: string[] }
  /** Required with outcome `pull-request`, not allowed otherwise. */
  pullRequest?: { title: string, body: string, draft?: boolean }
}

export type Parsed = { ok: true, result: AgentResult } | { ok: false, errors: string[] }

const OUTCOMES: Outcome[] = ['pull-request', 'comment', 'failed']

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function unknownKeys(value: Record<string, unknown>, allowed: string[], at: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      errors.push(`${at}${key}: unknown field`)
  }
}

function text(value: unknown, at: string, max: number, errors: string[]): void {
  if (typeof value !== 'string' || value.trim() === '')
    errors.push(`${at}: must be a non-empty string`)
  else if (value.length > max)
    errors.push(`${at}: ${value.length} characters, at most ${max}`)
}

function labels(value: unknown, at: string, errors: string[]): number {
  if (value === undefined)
    return 0
  if (!Array.isArray(value)) {
    errors.push(`${at}: must be a list of labels`)
    return 0
  }
  for (const label of value) {
    if (typeof label !== 'string' || !LABEL.test(label))
      errors.push(`${at}: ${JSON.stringify(label)} is not an agent:<name> label (lowercase letters, digits, hyphens)`)
  }
  return value.length
}

/** Parses and checks result.json. All errors at once, so that one run can fix them all. */
export function parseResult(source: string): Parsed {
  if (Buffer.byteLength(source) > LIMITS.resultBytes)
    return { ok: false, errors: [`result.json: ${Buffer.byteLength(source)} bytes, at most ${LIMITS.resultBytes}`] }
  let value: unknown
  try {
    value = JSON.parse(source)
  }
  catch (error) {
    return { ok: false, errors: [`result.json is not valid JSON: ${(error as Error).message}`] }
  }
  if (!isObject(value))
    return { ok: false, errors: ['result.json must be a JSON object'] }

  const errors: string[] = []
  unknownKeys(value, ['version', 'outcome', 'summary', 'labels', 'pullRequest'], '', errors)
  if (value.version !== RESULT_VERSION)
    errors.push(`version: must be ${RESULT_VERSION}`)
  if (!OUTCOMES.includes(value.outcome as Outcome))
    errors.push(`outcome: must be one of ${OUTCOMES.join(', ')}`)
  text(value.summary, 'summary', LIMITS.text, errors)

  if (value.labels !== undefined) {
    if (!isObject(value.labels)) {
      errors.push('labels: must be an object with add and remove')
    }
    else {
      unknownKeys(value.labels, ['add', 'remove'], 'labels.', errors)
      const count = labels(value.labels.add, 'labels.add', errors) + labels(value.labels.remove, 'labels.remove', errors)
      if (count > LIMITS.labels)
        errors.push(`labels: ${count} labels, at most ${LIMITS.labels}`)
    }
  }

  if (value.pullRequest !== undefined) {
    if (!isObject(value.pullRequest)) {
      errors.push('pullRequest: must be an object with title and body')
    }
    else {
      unknownKeys(value.pullRequest, ['title', 'body', 'draft'], 'pullRequest.', errors)
      text(value.pullRequest.title, 'pullRequest.title', LIMITS.title, errors)
      if (typeof value.pullRequest.title === 'string' && /[\r\n]/.test(value.pullRequest.title))
        errors.push('pullRequest.title: must be one line')
      text(value.pullRequest.body, 'pullRequest.body', LIMITS.text, errors)
      if (value.pullRequest.draft !== undefined && typeof value.pullRequest.draft !== 'boolean')
        errors.push('pullRequest.draft: must be true or false')
    }
  }
  if (value.outcome === 'pull-request' && value.pullRequest === undefined)
    errors.push('pullRequest: required with outcome pull-request')
  if (value.outcome !== 'pull-request' && value.pullRequest !== undefined)
    errors.push(`pullRequest: only allowed with outcome pull-request, not ${String(value.outcome)}`)

  return errors.length > 0 ? { ok: false, errors } : { ok: true, result: value as unknown as AgentResult }
}

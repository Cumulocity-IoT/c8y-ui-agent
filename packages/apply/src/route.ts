// The filter job: decides from the event alone whether a run starts, for which issue and playbook. No token, no
// checkout. See docs/workflow.md.
import { PLAYBOOK } from './check'
import { STATE_LABELS } from './result'

export const HANDLE = '@c8y-ui-agent'

/** Who may start a run with a comment. Labels need triage access anyway; a dispatch needs write access. */
export const ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']

export type Trigger = 'label' | 'comment' | 'dispatch'

export type Route =
  | { run: false, reason: string }
  | { run: true, number: number, playbook: string, trigger: Trigger, comment?: number }

/** The fields of the event payloads that routing reads. */
export interface RouteEvent {
  action?: string
  sender?: { login?: string, type?: string }
  label?: { name?: string }
  issue?: { number?: number, pull_request?: unknown }
  comment?: { id?: number, body?: string, author_association?: string }
  inputs?: Record<string, unknown>
}

export class RouteError extends Error {}

const skip = (reason: string): Route => ({ run: false, reason })

/**
 * The command in a comment: the first line that starts with the handle, outside fenced code and block quotes, so a
 * quoted earlier command does not start a run again. The word after the handle is the playbook (default `triage`);
 * the rest of the line is the request. Returns undefined without a command, and a name that is no valid playbook name
 * as is, for the caller to reject.
 */
export function parseCommand(body: string): { name: string, request: string } | undefined {
  let fence: string | undefined
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (fence === undefined)
        fence = marker[0]
      else if (marker[0] === fence)
        fence = undefined
      continue
    }
    if (fence !== undefined || line.startsWith('>'))
      continue
    const match = new RegExp(`^${HANDLE}(?![\\w-])(.*)$`, 'i').exec(line)
    if (!match)
      continue
    const [word = '', ...rest] = match[1]!.trim().split(/\s+/)
    return { name: word.replace(/[,.:;!?]+$/, '').toLowerCase() || 'triage', request: rest.join(' ') }
  }
  return undefined
}

function dispatch(event: RouteEvent): Route {
  const issue = String(event.inputs?.issue ?? '').trim()
  const playbook = String(event.inputs?.playbook ?? '').trim()
  if (!/^[1-9]\d{0,9}$/.test(issue))
    throw new RouteError(`workflow_dispatch needs the input issue, an issue number, not "${issue.slice(0, 20)}"`)
  if (!PLAYBOOK.test(playbook))
    throw new RouteError('workflow_dispatch needs the input playbook, a playbook name')
  return { run: true, number: Number(issue), playbook, trigger: 'dispatch' }
}

/** Decides whether the event starts a run. Throws RouteError for a dispatch with invalid inputs. */
export function route(eventName: string, event: RouteEvent): Route {
  if (eventName === 'workflow_dispatch')
    return dispatch(event)
  if (event.sender?.type === 'Bot')
    return skip(`sent by the bot ${event.sender.login ?? ''}`.trim())
  const number = event.issue?.number
  if (typeof number !== 'number')
    return skip(`no issue in the ${eventName} event`)

  if (eventName === 'issues') {
    if (event.action !== 'labeled')
      return skip(`issues ${event.action ?? ''}: only labeled starts a run`)
    const label = event.label?.name ?? ''
    if (!label.startsWith('agent:') || STATE_LABELS.includes(label))
      return skip(`the label ${label} is no playbook label`)
    const playbook = label.slice('agent:'.length)
    if (!PLAYBOOK.test(playbook))
      return skip(`the label ${label} is no playbook label`)
    return { run: true, number, playbook, trigger: 'label' }
  }

  if (eventName === 'issue_comment') {
    if (event.action !== 'created')
      return skip(`issue_comment ${event.action ?? ''}: only created starts a run`)
    const command = parseCommand(event.comment?.body ?? '')
    if (!command)
      return skip(`no ${HANDLE} command`)
    if (event.issue?.pull_request)
      return skip('a command on a pull request: rework rounds are not supported yet')
    const association = event.comment?.author_association ?? 'NONE'
    if (!ASSOCIATIONS.includes(association))
      return skip(`the author's association ${association} cannot start a run`)
    if (!PLAYBOOK.test(command.name))
      return skip('the command names no valid playbook')
    return { run: true, number, playbook: command.name, trigger: 'comment', ...(event.comment?.id ? { comment: event.comment.id } : {}) }
  }

  return skip(`the event ${eventName} starts no run`)
}

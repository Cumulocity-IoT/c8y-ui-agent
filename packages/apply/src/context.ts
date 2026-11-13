// The context job: the issue thread and the request as files for the agent, and the run's base commit. A read token;
// the agent job gets the files, never the token. See docs/workflow.md.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { branchName } from './check'
import type { Comment, GitHub, Issue } from './github'

/** Characters of issue.md: the issue and as many of the newest comments as fit. */
export const CONTEXT_LIMIT = 400_000

export interface ContextOptions {
  github: GitHub
  number: number
  playbook: string
  /** The head of the default branch, from the context job's checkout. */
  defaultSha: string
  /** The comment that started the run. */
  comment?: number
  /** The directory for issue.md and request.md. */
  out: string
}

export interface Context {
  /** The agent branch's head if it exists (a rework round continues it), otherwise the default branch's head. */
  base: string
  /** Whether the agent branch exists. */
  rework: boolean
  files: string[]
  /** Comments left out of issue.md for its size. */
  omitted: number
}

const by = (user: { login: string } | null | undefined, association?: string): string =>
  `@${user?.login ?? 'ghost'}${association ? ` (${association})` : ''}`

const labelName = (label: { name?: string } | string): string => typeof label === 'string' ? label : label.name ?? ''

function header(issue: Issue): string {
  const labels = (issue.labels ?? []).map(labelName).filter(Boolean)
  return [
    `# #${issue.number}: ${issue.title}`,
    '',
    `${issue.pull_request ? 'Pull request' : 'Issue'}, ${issue.state ?? 'open'}, opened by ${by(issue.user, issue.author_association)}${labels.length > 0 ? `. Labels: ${labels.join(', ')}` : ''}`,
    '',
    issue.body?.trim() || '(no description)',
  ].join('\n')
}

const section = (comment: Comment): string =>
  [`## Comment ${comment.id} by ${by(comment.user, comment.author_association)}, ${comment.created_at ?? ''}`.trim(), '', comment.body?.trim() ?? ''].join('\n')

/** The thread as Markdown: the issue, then its comments, oldest first; the oldest comments go first when it is too long. */
export function threadMarkdown(issue: Issue, comments: Comment[], limit = CONTEXT_LIMIT): { text: string, omitted: number } {
  const head = header(issue)
  const kept: string[] = []
  let size = head.length
  for (const comment of [...comments].reverse()) {
    const text = section(comment)
    if (size + text.length + 2 > limit)
      break
    kept.unshift(text)
    size += text.length + 2
  }
  const omitted = comments.length - kept.length
  const note = omitted > 0 ? [`(${omitted} older comment(s) left out for size.)`] : []
  return { text: `${[head, ...note, ...kept].join('\n\n')}\n`, omitted }
}

export async function writeContext(options: ContextOptions): Promise<Context> {
  const { github, number } = options
  const [issue, comments, branchHead] = await Promise.all([
    github.issue(number),
    github.comments(number),
    github.branchHead(branchName(number, options.playbook)),
  ])
  mkdirSync(options.out, { recursive: true })
  const thread = threadMarkdown(issue, comments)
  writeFileSync(join(options.out, 'issue.md'), thread.text)
  const files = ['issue.md']
  if (options.comment !== undefined) {
    const request = comments.find(c => c.id === options.comment) ?? await github.comment(options.comment)
    writeFileSync(join(options.out, 'request.md'), [
      `# The request`,
      '',
      `Comment ${request.id} by ${by(request.user, request.author_association)} started this run:`,
      '',
      request.body?.trim() ?? '',
      '',
    ].join('\n'))
    files.push('request.md')
  }
  return { base: branchHead ?? options.defaultSha, rework: branchHead !== undefined, files, omitted: thread.omitted }
}

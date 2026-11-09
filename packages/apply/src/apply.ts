// The apply job's writes, after check(): push the agent branch, open or update the pull request, set labels, and edit
// the status comment. A rejected result pushes nothing and only reports why. See docs/result.md.
import { check } from './check'
import type { CheckOptions, CheckReport } from './check'
import { git } from './git'
import type { GitHub, PullRequest } from './github'
import type { Violation } from './paths'

/** Marks the status comment, together with the App's login as its author. */
export const STATUS_MARKER = '<!-- c8y-ui-agent:status -->'
export const FAILED_LABEL = 'agent:failed'

export interface ApplyOptions extends CheckOptions {
  github: GitHub
  /** `owner/name`. */
  repository: string
  /** The App's bot login (`<app-slug>[bot]`): only its comments are status comments. */
  botLogin: string
  /** Token for `git push`; the GitHub client has its own. */
  token: string
  /** Default: `<GITHUB_SERVER_URL>/<repository>.git`. */
  remote?: string
  /** Link to the workflow run, for the status comment. */
  runUrl?: string
  log?: (line: string) => void
}

export interface Applied {
  ok: boolean
  report: CheckReport
  /** Set when the push or a GitHub call failed after the check passed. */
  error?: string
  pullRequest?: { number: number, url: string }
  comment?: number
}

const footer = (runUrl?: string): string => runUrl ? `\n\n<sub>[Run](${runUrl})</sub>` : ''

export function rejection(violations: Violation[], runUrl?: string): string {
  return [
    STATUS_MARKER,
    '**The run\'s result was rejected. Nothing was pushed.**',
    '',
    ...violations.map(v => `- \`${v.rule}\`: ${v.message.replace(/\r?\n/g, ' ')}`),
    '',
    'The commits are kept in the run\'s artifacts.',
  ].join('\n') + footer(runUrl)
}

async function upsertStatus(options: ApplyOptions, body: string): Promise<number> {
  const existing = (await options.github.comments(options.number))
    .find(c => c.user?.login === options.botLogin && c.body?.includes(STATUS_MARKER))
  return existing
    ? (await options.github.updateComment(existing.id, body)).id
    : (await options.github.createComment(options.number, body)).id
}

function push(options: ApplyOptions, head: string, branch: string): void {
  const remote = options.remote ?? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${options.repository}.git`
  // The token goes to git through the environment, not the command line or the checkout's config.
  const env: Record<string, string> = /^https?:\/\//.test(remote)
    ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${new URL(remote).origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`,
      }
    : {}
  // No --force: a branch that moved since the run started rejects the push.
  git(options.dir)(['push', '--quiet', '--no-verify', remote, `${head}:refs/heads/${branch}`], { env })
}

export async function apply(options: ApplyOptions): Promise<Applied> {
  const log = options.log ?? (() => {})
  const report = check(options)
  if (!report.ok || !report.result) {
    log(`rejected: ${report.violations.length} violation(s)`)
    const comment = await upsertStatus(options, rejection(report.violations, options.runUrl))
    await options.github.addLabels(options.number, [FAILED_LABEL])
    return { ok: false, report, comment }
  }

  const result = report.result
  let pullRequest: PullRequest | undefined
  try {
    if (result.outcome === 'pull-request' && report.head && result.pullRequest) {
      push(options, report.head, report.branch)
      log(`pushed ${report.commits} commit(s) to ${report.branch}`)
      const { title, body, draft = false } = result.pullRequest
      const open = await options.github.openPullRequest(report.branch)
      pullRequest = open
        ? await options.github.updatePullRequest(open.number, { title, body })
        : await options.github.createPullRequest({ title, body, head: report.branch, base: options.defaultBranch, draft })
      log(`pull request #${pullRequest.number}`)
    }
  }
  catch (error) {
    const message = (error as Error).message
    log(`failed: ${message}`)
    const comment = await upsertStatus(options, [
      STATUS_MARKER,
      `**The result passed its checks, but writing it failed:** ${message.replace(/\r?\n/g, ' ')}`,
      '',
      result.summary,
    ].join('\n') + footer(options.runUrl))
    await options.github.addLabels(options.number, [FAILED_LABEL])
    return { ok: false, report, error: message, comment }
  }

  for (const label of result.labels?.remove ?? [])
    await options.github.removeLabel(options.number, label)
  await options.github.addLabels(options.number, [...new Set([...result.labels?.add ?? [], ...result.outcome === 'failed' ? [FAILED_LABEL] : []])])
  const link = pullRequest ? `\n\nPull request: #${pullRequest.number}` : ''
  const comment = await upsertStatus(options, `${STATUS_MARKER}\n${result.summary}${link}${footer(options.runUrl)}`)
  return {
    ok: true,
    report,
    comment,
    ...(pullRequest ? { pullRequest: { number: pullRequest.number, url: pullRequest.html_url } } : {}),
  }
}

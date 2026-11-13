// The apply job's writes, after check(): push the agent branch, open or update the pull request, set labels, and edit
// the status comment. A rejected result pushes nothing and only reports why. See docs/result.md.
import { branchName, check, UsageError } from './check'
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
  /** Labels the run removes whatever its result, such as the playbook label that started it, so it can start again. */
  removeLabels?: string[]
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

const oneLine = (text: string): string => text.replace(/\r?\n/g, ' ')

const footer = (runUrl?: string): string => runUrl ? `\n\n<sub>[Run](${runUrl})</sub>` : ''

export function rejection(violations: Violation[], runUrl?: string): string {
  return [
    STATUS_MARKER,
    '**The run\'s result was rejected. Nothing was pushed.**',
    '',
    ...violations.map(v => `- \`${v.rule}\`: ${oneLine(v.message)}`),
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

/** git configuration for the push, through the environment: the token is not on the command line or in the checkout's config. */
export function pushEnv(remote: string, token: string): Record<string, string> {
  if (!/^https?:\/\//.test(remote))
    return {}
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${new URL(remote).origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

function push(options: ApplyOptions, head: string, branch: string): void {
  const remote = options.remote ?? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${options.repository}.git`
  // No --force: a branch that moved since the run started rejects the push. A branch already at head is a no-op.
  git(options.dir)(['push', '--quiet', '--no-verify', remote, `${head}:refs/heads/${branch}`], { env: pushEnv(remote, options.token) })
}

/** Pushes nothing: the status comment names the rules, and agent:failed is added. */
async function reject(options: ApplyOptions, report: CheckReport, violations: Violation[]): Promise<Applied> {
  options.log?.(`rejected: ${violations.length} violation(s)`)
  try {
    const comment = await upsertStatus(options, rejection(violations, options.runUrl))
    for (const label of options.removeLabels ?? [])
      await options.github.removeLabel(options.number, label)
    await options.github.addLabels(options.number, [FAILED_LABEL])
    return { ok: false, report: { ...report, ok: false, violations }, comment }
  }
  catch (error) {
    return { ok: false, report: { ...report, ok: false, violations }, error: `reporting the rejection failed: ${(error as Error).message}` }
  }
}

export async function apply(options: ApplyOptions): Promise<Applied> {
  const log = options.log ?? (() => {})
  let report: CheckReport
  try {
    report = check(options)
  }
  catch (error) {
    // Invalid workflow inputs are the workflow's bug; anything else the agent's output caused gets a status comment.
    if (error instanceof UsageError)
      throw error
    const violation = { rule: 'check', message: `the check failed: ${(error as Error).message}` }
    return reject(options, { ok: false, violations: [violation], branch: branchName(options.number, options.playbook), base: options.base, commits: 0, files: [] }, [violation])
  }
  if (!report.ok || !report.result)
    return reject(options, report, report.violations)

  const result = report.result
  let pullRequest: PullRequest | undefined
  try {
    if (result.outcome === 'pull-request' && report.head && result.pullRequest) {
      const { title, body, draft = false } = result.pullRequest
      const open = await options.github.openPullRequest(report.branch)
      // The setup playbook changes .c8y-agent/ only in a draft; a pull request someone marked ready is not one.
      const config = report.files.filter(file => file.startsWith('.c8y-agent/'))
      if (open && !open.draft && config.length > 0) {
        return reject(options, report, config.map(file =>
          ({ rule: 'agent-config', file, message: `${file} is protected: pull request #${open.number} is not a draft` })))
      }
      push(options, report.head, report.branch)
      log(`pushed ${report.commits} commit(s) to ${report.branch}`)
      pullRequest = open
        ? await options.github.updatePullRequest(open.number, { title, body })
        : await options.github.createPullRequest({ title, body, head: report.branch, base: options.defaultBranch, draft })
      log(`pull request #${pullRequest.number}`)
    }
    const add = [...new Set([...result.labels?.add ?? [], ...result.outcome === 'failed' ? [FAILED_LABEL] : []])]
    // A result that did not fail clears agent:failed from an earlier run, unless it adds it itself.
    const remove = [...new Set([...result.labels?.remove ?? [], ...options.removeLabels ?? [], ...add.includes(FAILED_LABEL) ? [] : [FAILED_LABEL]])]
    for (const label of remove.filter(label => !add.includes(label)))
      await options.github.removeLabel(options.number, label)
    await options.github.addLabels(options.number, add)
    const link = pullRequest ? `\n\nPull request: #${pullRequest.number}` : ''
    const comment = await upsertStatus(options, `${STATUS_MARKER}\n${result.summary}${link}${footer(options.runUrl)}`)
    return {
      ok: true,
      report,
      comment,
      ...(pullRequest ? { pullRequest: { number: pullRequest.number, url: pullRequest.html_url } } : {}),
    }
  }
  catch (error) {
    const message = (error as Error).message
    log(`failed: ${message}`)
    let comment: number | undefined
    try {
      comment = await upsertStatus(options, [
        STATUS_MARKER,
        `**The result passed its checks, but writing it failed:** ${oneLine(message)}`,
        '',
        result.summary,
      ].join('\n') + footer(options.runUrl))
      await options.github.addLabels(options.number, [FAILED_LABEL])
    }
    catch (reportError) {
      log(`reporting the failure failed: ${(reportError as Error).message}`)
    }
    return { ok: false, report, error: message, ...(comment === undefined ? {} : { comment }) }
  }
}

// The few GitHub REST calls the apply job makes, with fetch: no client library in the job that holds the write token.

export interface GitHubOptions {
  token: string
  /** `owner/name`. */
  repository: string
  /** Default: GITHUB_API_URL, else https://api.github.com. */
  apiUrl?: string
  fetch?: typeof fetch
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface Comment { id: number, body?: string, user?: { login: string } | null }
export interface PullRequest { number: number, html_url: string, draft?: boolean }

export class GitHub {
  private readonly api: string
  private readonly fetch: typeof fetch

  constructor(private readonly options: GitHubOptions) {
    this.api = (options.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '')
    this.fetch = options.fetch ?? globalThis.fetch
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetch(`${this.api}/repos/${this.options.repository}${path}`, {
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${this.options.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'c8y-ui-apply',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let message = text
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text
      }
      catch {}
      throw new GitHubError(`${method} ${path}: ${response.status} ${message}`.trim(), response.status)
    }
    return (response.status === 204 ? undefined : await response.json()) as T
  }

  /** Every comment of an issue or pull request, oldest first. */
  async comments(number: number): Promise<Comment[]> {
    const all: Comment[] = []
    for (let page = 1; ; page++) {
      const batch = await this.request<Comment[]>('GET', `/issues/${number}/comments?per_page=100&page=${page}`)
      all.push(...batch)
      if (batch.length < 100)
        return all
    }
  }

  createComment(number: number, body: string): Promise<Comment> {
    return this.request('POST', `/issues/${number}/comments`, { body })
  }

  updateComment(id: number, body: string): Promise<Comment> {
    return this.request('PATCH', `/issues/comments/${id}`, { body })
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length > 0)
      await this.request('POST', `/issues/${number}/labels`, { labels })
  }

  async removeLabel(number: number, label: string): Promise<void> {
    try {
      await this.request('DELETE', `/issues/${number}/labels/${encodeURIComponent(label)}`)
    }
    catch (error) {
      // Not on the issue: nothing to remove.
      if (!(error instanceof GitHubError && error.status === 404))
        throw error
    }
  }

  async openPullRequest(branch: string): Promise<PullRequest | undefined> {
    const owner = this.options.repository.split('/')[0]
    const pulls = await this.request<PullRequest[]>('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
    return pulls[0]
  }

  createPullRequest(pull: { title: string, body: string, head: string, base: string, draft: boolean }): Promise<PullRequest> {
    return this.request('POST', '/pulls', pull)
  }

  updatePullRequest(number: number, pull: { title: string, body: string }): Promise<PullRequest> {
    return this.request('PATCH', `/pulls/${number}`, pull)
  }
}

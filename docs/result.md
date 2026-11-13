# Result file and apply job

An agent run writes nothing to GitHub. Its job ends with two files, and a separate apply job, on a fresh runner, checks them and writes (D2). The package [`@cumulocity-iot/c8y-ui-apply`](../packages/apply) implements both ends; the reusable workflow ([workflow.md](workflow.md)) runs it.

| Job | Holds | Does |
|---|---|---|
| Agent | No GitHub credential | Writes `result.json`; `c8y-ui-apply bundle` packs its commits since the base into `agent.bundle`. Uploads both as an artifact. |
| Apply | First no token, then an App token | `c8y-ui-apply check` in a fresh checkout. Then `c8y-ui-apply apply` with a token whose permissions depend on the check: push, pull request, labels, status comment; or only the status comment that names the rejected rules. |

Everything the agent job produces is untrusted: the agent can change any file on its runner, including the artifact. The apply job therefore takes the number, the playbook, the playbook's result (`pull-request` or `comment`, from `c8y-ui-apply playbook`, [pack.md](pack.md)), the base commit, and the default branch from the workflow (the filter and context jobs), never from the agent's files. The number is the issue the run works on: it names the branch `agent/<number>-<playbook>` and receives the status comment. A rework round started on the agent's pull request passes the issue number from the branch name.

## result.json

```json
{
  "version": 1,
  "outcome": "pull-request",
  "summary": "Fixed the empty state of the favorites manager. Proof: `regression`, 2 of 2 tests.",
  "labels": { "add": ["agent:done"], "remove": ["agent:fix"] },
  "pullRequest": { "title": "fix(favorites-manager): explain how to add a favorite", "body": "…", "draft": false }
}
```

| Field | Required | Rule |
|---|---|---|
| `version` | Yes | `1` |
| `outcome` | Yes | `pull-request`: the bundle holds commits for a pull request. `comment`: no commits, only the status comment. `failed`: the playbook did not reach its result; no commits, and the apply job adds `agent:failed`. |
| `summary` | Yes | The status comment, Markdown, at most 60,000 characters |
| `labels.add` | No | State labels only: `agent:working`, `agent:needs-info`, `agent:needs-approval`, `agent:done`, `agent:failed`, `agent:not-runtime-verified`. Playbook labels (`agent:fix`) start runs when the App adds them, so the agent cannot add them. |
| `labels.remove` | No | Any `agent:<name>` label (lowercase letters, digits, hyphens; at most 50 characters). With `labels.add`, at most 10 labels. |
| `pullRequest` | With `pull-request` only | `title` (one line, at most 256 characters), `body` (at most 60,000 characters), `draft` (default `false`) |

Unknown fields are errors, so a typo does not pass silently. The file is at most 1 MB. `c8y-ui-apply validate result.json` reports every error at once; the agent runs it before it ends.

## The bundle

`c8y-ui-apply bundle --base <sha> --out agent.bundle` writes the commits from the base to `HEAD` as a git bundle with one head. Without commits it writes no file. Uncommitted changes are not part of the result; the command lists them on stderr.

## Checks

`c8y-ui-apply check` runs in a checkout with the history of the default branch (`actions/checkout` with `fetch-depth: 0`). git runs with hooks and fsmonitor off. The check needs no token and changes nothing on GitHub. A result fails on any of these:

| Rule | Fails when |
|---|---|
| `result` | `result.json` is missing, not a file, larger than 1 MB, or invalid; `pull-request` without commits, or from a playbook whose result is `comment`; `comment` or `failed` with commits |
| `base` | The base is not in the checkout; or the agent branch `agent/<number>-<playbook>` exists and is neither at the base (a rework round starts from the branch) nor at the bundle's head (a re-run after a push that succeeded); or the branch does not exist and the base is not on the default branch |
| `bundle` | Larger than 50 MB; its prerequisites are not in the repository; more than one head; commits that do not descend from the base; more than 50 commits; merge commits; a commit message that skips CI (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`, `skip-checks: true`) |
| `github` | A changed path under `.github/` |
| `agent-config` | A changed path under `.c8y-agent/`, except from the `setup` playbook in a draft pull request |
| `agent-instructions` | A changed `.claude/` directory, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, or `.mcp.json`, at any depth |
| `package-sources` | A changed `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `.pnpmfile.cjs`, or `.pnpmfile.mjs` at any depth; `.gitmodules`, `.yarn/releases/`, or `.yarn/plugins/` at the root |
| `developer-tools` | A changed path under `.husky/`, `.vscode/`, or `.devcontainer/`: code that runs on developers' machines |
| `lockfile` | A changed lockfile (`pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `bun.lock`, `bun.lockb`) without a changed `package.json` or `pnpm-workspace.yaml` in its directory; for a root lockfile, also a `package.json` of a workspace package (`pnpm-workspace.yaml` `packages` or `package.json` `workspaces` on the default branch) |
| `protect` | A changed path that matches `protect` in `.c8y-agent/config.yml` on the default branch: a path, a directory ending in `/`, or a glob (`*` within a segment, `**` across segments) |
| `config` | `.c8y-agent/config.yml` on the default branch is not valid YAML, or `protect` is not a list of paths: the check fails closed |
| `check` | The check itself failed on the agent's output (for example a git error); `apply` reports it like a violation |

"Changed" covers added, modified, and deleted files, both paths of a rename, and gitlinks (submodule commits) even when `.gitmodules` ignores them. Each commit counts, not only the net change: a rebase merge keeps a commit that adds a workflow file even if a later one removes it. Matching ignores case, because macOS and Windows checkouts read `.Claude/` as `.claude/`. The protect list and the workspaces are read from the default branch, so the agent's commits cannot change them.

## Apply

`c8y-ui-apply apply` runs the check again, then:

- **Check passed, `pull-request`:** pushes the bundle's head to `agent/<number>-<playbook>` without force, so a branch that moved since the run started rejects the push; a branch already at the head is left as it is. Opens a pull request against the default branch, or updates the title and body of the open one. If the commits change `.c8y-agent/` (the `setup` playbook) and the open pull request is not a draft, nothing is pushed and the result is rejected. Then the labels, then the status comment with a link to the pull request.
- **Check passed, `comment` or `failed`:** the labels and the status comment.
- **Labels:** `labels.remove`, then `labels.add`. Outcome `failed` adds `agent:failed`; any other outcome removes it, unless `labels.add` has it.
- **Check failed:** pushes nothing. The status comment lists each rule and file; `agent:failed` is added. The commits stay in the run's artifact.
- **A push or GitHub call failed after the check:** the status comment says so, with the summary; `agent:failed` is added. If that comment fails too, the error goes to stderr. Re-running the job continues where it stopped: the branch is at the bundle's head, so the push does nothing.

The status comment is the App's comment that contains `<!-- c8y-ui-agent:status -->`; it is edited in place. Comments by anyone else with that marker are ignored. The token reaches `git push` through the environment (`GIT_CONFIG_*`), not the command line or the checkout's configuration.

Exit codes: `check` 0 when it ran (step output `ok`: `true` or `false`), 2 when it crashed or the workflow's inputs are invalid; `apply` 0 when it wrote the result (step output `pull-request`: its number), 1 when it rejected the result or a write failed, 2 for invalid workflow inputs. Messages on stderr are one line each, so text from the agent cannot start a line the runner reads as a workflow command.

## The apply job

The apply job of [`run.yml`](../.github/workflows/run.yml) runs it ([workflow.md](workflow.md)). Its trusted inputs are the context job's outputs:

1. A fresh checkout of the default branch with its history (`fetch-depth: 0`), no stored credentials, and no cache: the agent job can write the default branch's Actions caches.
2. `c8y-ui-apply` installed with `--ignore-scripts`, at the release of the workflow (D19).
3. The agent's artifact, downloaded after the install, outside the checkout. Without it, `check` reports the missing `result.json`.
4. `check`, without a token. A crash leaves `ok` unset, so the job continues with the comment-only token.
5. An App token from `actions/create-github-app-token` that can push (contents, pull requests, issues) only when `ok` is `true`; otherwise one that can only comment and label (pull requests, issues).
6. `apply` with that token, the bot login `<app-slug>[bot]`, the run's URL, and `--remove-label agent:<playbook>` when a label started the run.

## Limits

- The summary and the pull request body are the model's Markdown: they can mention people. Review and CI stay the gate for the code; the size limits bound the text.
- The check reads which files changed, not what a lockfile resolves to: a changed lockfile with a changed manifest of its package can still point a dependency at another tarball. Review the lockfile diff of an agent pull request.
- Commit authors and messages are the agent's: an author can name a maintainer. Only `[skip ci]` and similar directives are rejected.
- The agent job holds the Actions runtime token of its run and a read-only job token ([workflow.md](workflow.md), Limits). The runtime token can upload artifacts and write Actions caches of the default branch. Artifacts from the run are untrusted anyway; workflows with secrets or write tokens must not restore caches that an agent run can write.
- A change to `package.json` scripts or the Cypress configuration passes the check. CI jobs with secrets need an environment with required reviewers for `agent/*` branches (D2).
- The agent job's network is not restricted yet ([workflow.md](workflow.md), Not yet).

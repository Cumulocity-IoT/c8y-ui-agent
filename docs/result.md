# Result file and apply job

An agent run writes nothing to GitHub. Its job ends with two files, and a separate apply job, on a fresh runner, checks them and writes (D2). The package [`@cumulocity-iot/c8y-ui-apply`](../packages/apply) implements both ends; the reusable workflow (phase 3) runs it.

| Job | Holds | Does |
|---|---|---|
| Agent | No GitHub credential | Writes `result.json`; `c8y-ui-apply bundle` packs its commits since the base into `agent.bundle`. Uploads both as an artifact. |
| Apply | First no token, then an App token | `c8y-ui-apply check` in a fresh checkout. Then `c8y-ui-apply apply` with a token whose permissions depend on the check: push, pull request, labels, status comment; or only the status comment that names the rejected rules. |

Everything the agent job produces is untrusted: the agent can change any file on its runner, including the artifact. The apply job therefore takes the issue or pull request number, the playbook, the base commit, and the default branch from the workflow (the filter and context jobs), never from the agent's files.

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
| `labels.add`, `labels.remove` | No | `agent:<name>` labels only (lowercase letters, digits, hyphens), at most 10 in all |
| `pullRequest` | With `pull-request` only | `title` (one line, at most 256 characters), `body` (at most 60,000 characters), `draft` (default `false`) |

Unknown fields are errors, so a typo does not pass silently. The file is at most 1 MB. `c8y-ui-apply validate result.json` reports every error at once; the agent runs it before it ends.

## The bundle

`c8y-ui-apply bundle --base <sha> --out agent.bundle` writes the commits from the base to `HEAD` as a git bundle with one head. Without commits it writes no file. Uncommitted changes are not part of the result; the command lists them on stderr.

## Checks

`c8y-ui-apply check` runs in a checkout with the history of the default branch (`actions/checkout` with `fetch-depth: 0`). git runs with hooks and fsmonitor off. The check needs no token and changes nothing on GitHub. A result fails on any of these:

| Rule | Fails when |
|---|---|
| `result` | `result.json` is missing or invalid; `pull-request` without commits; `comment` or `failed` with commits |
| `base` | The base is not in the checkout; or the agent branch `agent/<number>-<playbook>` exists and is not at the base (a rework round starts from the branch); or the branch does not exist and the base is not on the default branch |
| `bundle` | Larger than 50 MB; its prerequisites are not in the repository; more than one head; commits that do not descend from the base; more than 50 commits; merge commits |
| `github` | A changed path under `.github/` |
| `agent-config` | A changed path under `.c8y-agent/`, except from the `setup` playbook in a draft pull request |
| `agent-instructions` | A changed `.claude/` directory, `AGENTS.md`, or `CLAUDE.md`, at any depth |
| `package-sources` | A changed `.gitmodules`, `.npmrc`, `.yarnrc.yml`, `.pnpmfile.cjs`, or `.pnpmfile.mjs` at the root |
| `lockfile` | A changed lockfile (`pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `bun.lock`, `bun.lockb`) without a changed `package.json` or `pnpm-workspace.yaml` |
| `protect` | A changed path that matches `protect` in `.c8y-agent/config.yml` on the default branch: a path, a directory ending in `/`, or a glob (`*` within a segment, `**` across segments) |
| `config` | `.c8y-agent/config.yml` on the default branch is not valid YAML, or `protect` is not a list of paths: the check fails closed |

"Changed" covers added, modified, and deleted files, and both paths of a rename. The protect list is read from the default branch, so the agent's commits cannot change it.

## Apply

`c8y-ui-apply apply` runs the check again, then:

- **Check passed, `pull-request`:** pushes the bundle's head to `agent/<number>-<playbook>` without force, so a branch that moved since the run started rejects the push. Opens a pull request against the default branch, or updates the title and body of the open one. Then the labels, then the status comment with a link to the pull request.
- **Check passed, `comment` or `failed`:** the labels and the status comment.
- **Check failed:** pushes nothing. The status comment lists each rule and file; `agent:failed` is added. The commits stay in the run's artifact.
- **A push or GitHub call failed after the check:** the status comment says so, with the summary; `agent:failed` is added.

The status comment is the App's comment that contains `<!-- c8y-ui-agent:status -->`; it is edited in place. Comments by anyone else with that marker are ignored. The token reaches `git push` through the environment (`GIT_CONFIG_*`), not the command line or the checkout's configuration.

Exit codes: `check` 0 when it ran (the step output `ok` is `true` or `false`); `apply` 0 when it wrote the result, 1 when it rejected it or a write failed; 2 for invalid inputs.

## The apply job

The reusable workflow (phase 3) gets this job. `needs.context.outputs` are the trusted inputs.

```yaml
apply:
  needs: [context, agent]
  if: ${{ !cancelled() && needs.context.result == 'success' }}   # also after a failed agent job
  runs-on: ubuntu-latest
  permissions:
    contents: read
    packages: read
  env:
    NUMBER: ${{ needs.context.outputs.number }}
    PLAYBOOK: ${{ needs.context.outputs.playbook }}
    BASE: ${{ needs.context.outputs.base }}
    DEFAULT_BRANCH: ${{ needs.context.outputs.default-branch }}
    APPLY: ${{ runner.temp }}/apply/node_modules/.bin/c8y-ui-apply
  steps:
    - uses: actions/checkout@v7
      with: { path: repo, fetch-depth: 0, persist-credentials: false }
    - uses: actions/download-artifact@v8
      continue-on-error: true            # no artifact: check reports the missing result.json
      with: { name: agent-result, path: agent }
    - uses: actions/setup-node@v7
      with: { node-version: 24, registry-url: https://npm.pkg.github.com, scope: '@cumulocity-iot' }
    - run: npm install --ignore-scripts --no-save --prefix "$RUNNER_TEMP/apply" @cumulocity-iot/c8y-ui-apply@<version>
      env: { NODE_AUTH_TOKEN: '${{ github.token }}' }
    - id: check
      run: >-
        "$APPLY" check --dir repo --result agent/result.json --bundle agent/agent.bundle
        --base "$BASE" --default-branch "$DEFAULT_BRANCH" --number "$NUMBER" --playbook "$PLAYBOOK"
    # A passed check gets a token that can push; a failed one only a token that can comment.
    - id: write
      if: steps.check.outputs.ok == 'true'
      uses: actions/create-github-app-token@v3
      with:
        client-id: ${{ secrets.C8Y_UI_AGENT_CLIENT_ID }}
        private-key: ${{ secrets.C8Y_UI_AGENT_APP_KEY }}
        permission-contents: write
        permission-pull-requests: write
        permission-issues: write
    - id: report
      if: steps.check.outputs.ok != 'true'
      uses: actions/create-github-app-token@v3
      with:
        client-id: ${{ secrets.C8Y_UI_AGENT_CLIENT_ID }}
        private-key: ${{ secrets.C8Y_UI_AGENT_APP_KEY }}
        permission-pull-requests: write
        permission-issues: write
    - run: >-
        "$APPLY" apply --dir repo --result agent/result.json --bundle agent/agent.bundle
        --base "$BASE" --default-branch "$DEFAULT_BRANCH" --number "$NUMBER" --playbook "$PLAYBOOK"
        --bot-login "$SLUG[bot]" --run-url "$RUN_URL"
      env:
        GH_TOKEN: ${{ steps.write.outputs.token || steps.report.outputs.token }}
        SLUG: ${{ steps.write.outputs.app-slug || steps.report.outputs.app-slug }}
        RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

Open for phase 3: how `run.yml` pins `<version>` to its own tag.

## Limits

- The summary and the pull request body are the model's Markdown: they can mention people. Review and CI stay the gate for the code; the size limits bound the text.
- A change to `package.json` scripts or the Cypress configuration passes the check. CI jobs with secrets need an environment with required reviewers for `agent/*` branches (D2).
- The egress allowlist of the agent job belongs to the agent job, which the reusable workflow defines (phase 3).

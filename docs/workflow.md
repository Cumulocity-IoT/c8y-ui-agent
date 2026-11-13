# The reusable workflow

[`.github/workflows/run.yml`](../.github/workflows/run.yml) runs the agent on an issue of the calling repository: four jobs, each on a fresh runner, which pass data only as job outputs and artifacts (D2, D19). Nothing here has run on GitHub yet: the apply job needs the App ([github-app.md](github-app.md)).

## Calling it

```yaml
# .github/workflows/c8y-ui-agent.yml
name: C8Y UI Agent
on:
  issues: { types: [labeled] }
  issue_comment: { types: [created] }
  workflow_dispatch:
    inputs:
      issue: { description: Issue number, required: true, type: number }
      playbook: { description: Playbook, required: true, type: string, default: triage }
permissions:
  contents: read
  issues: read
  pull-requests: read
  packages: read
jobs:
  agent:
    uses: Cumulocity-IoT/c8y-ui-agent/.github/workflows/run.yml@v0.8.0
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      C8Y_UI_AGENT_CLIENT_ID: ${{ secrets.C8Y_UI_AGENT_CLIENT_ID }}
      C8Y_UI_AGENT_APP_KEY: ${{ secrets.C8Y_UI_AGENT_APP_KEY }}
```

Pin an exact release tag while the version is 0.x (CONTRIBUTING.md). The permissions are the most any job of the run gets; each job asks for less. Pass the three secrets by name rather than `secrets: inherit`, so the run gets no others. Turn on "Automatically delete head branches" in the repository's settings: a run continues an existing agent branch (see Jobs).

| Input | Default | Meaning |
|---|---|---|
| `model` | `claude-opus-5-5` | The orchestrator's and the developer's model; the verifier uses `sonnet` |
| `rounds` | `3` | Develop-and-prove rounds of a playbook |
| `max-budget-usd` | `10` | Model spend limit of one run (Claude Code `--max-budget-usd`) |
| `timeout-minutes` | `60` | Time limit of the agent's step, at most 150. The job has 180 minutes, so a stopped agent's commits are still bundled and reported. |
| `package-version` | The release at the workflow's commit | The packages' version, for testing the workflow from a branch |

| Secret | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | The agent job's Claude Code step |
| `C8Y_UI_AGENT_CLIENT_ID`, `C8Y_UI_AGENT_APP_KEY` | The apply job's App tokens (organization secrets) |

## Starting a run

| Trigger | Who | Playbook |
|---|---|---|
| A comment whose line starts with `@c8y-ui-agent <playbook> [request]` | Owners, members, and collaborators (`author_association`) | The word after the handle; `triage` without one |
| The label `agent:<playbook>` | Anyone who can label (triage access). A label that an issue template adds counts only if the issue's author could start a run. | The label's name; the apply job removes it after the run, so adding it again starts the next one |
| `workflow_dispatch` with `issue` and `playbook` | Anyone who can run workflows (write access) | The input |

`c8y-ui-apply route` decides ([`src/route.ts`](../packages/apply/src/route.ts)). A command in a block quote or fenced code does not count, so quoting an earlier command does not start a run again. Bots never start a run, nor do state labels (`agent:done`, …). The rest of the command line is the request: the agent gets it as `context/request.md`; the whole comment stays in the thread. A word that is no playbook, such as free text after the handle, gets a status comment that lists the available playbooks.

Not supported yet: commands on pull requests (rework rounds from a review), automatic triage of new issues (`auto.triage`), and free-text routing.

## Jobs

| Job | Holds | Does |
|---|---|---|
| filter | `packages: read` | Finds the release of the workflow, installs `c8y-ui-apply`, and runs `route`. Comments without the handle, labels without `agent:`, and events from bots end in the job's `if`, without a runner. |
| context | A read token (`contents`, `issues`, `pull-requests`, `packages`) | Checks out `.c8y-agent/` of the default branch and the pack (`job.workflow_sha`). `c8y-ui-apply playbook` resolves the playbook and writes the system prompt; `c8y-ui-apply context` writes the issue thread and the request, and sets the base: the agent branch's head if it exists, else the default branch's head. Uploads `c8y-ui-agent-context`. |
| agent | `contents: read`, `packages: read`, for checkout and installs; no token in the agent's step | Checks out the repository at the base with its history, installs its dependencies (pnpm or npm) and the agent's tools, takes the profile, and runs Claude Code. Bundles the commits and uploads `c8y-ui-agent-result`. |
| apply | First no token, then an App token | Checks the result in a fresh checkout and writes it ([result.md](result.md)). A playbook the repository cannot run (unknown, switched off, broken) gets a status comment from here instead of an agent run. |

One run per issue at a time: the agent job's concurrency group is the repository and the issue number. A newer trigger replaces a pending one, whose run then ends without a report; a running agent finishes. The apply job of one run can still overlap with the agent job of the next: if it pushes the agent branch after the next run took its base, the next result fails the `base` rule and is reported.

## The agent job

- **Tools:** `@cumulocity-iot/c8y-ui-workbench` and `@cumulocity-iot/c8y-ui-apply` at the release's version, `@cumulocity-iot/c8y-web-sdk-knowledge-mcp` and `@anthropic-ai/claude-code` at versions pinned in `run.yml`. Node 24 runs the tools and the repository's scripts.
- **Run directory** `$RUNNER_TEMP/run`, outside the checkout: `system.md`, `context/`, `profile.json` (`c8y-ui-workbench profile`), `mcp.json`, `screenshots/`, and the agent's `result.json`.
- **Claude Code:**
  - `--setting-sources user` and `--strict-mcp-config`: the repository's `.claude/settings.json`, hooks, and `.mcp.json` do not load. The MCP servers are the workbench and the knowledge server, named as the pack expects.
  - `--plugin-dir` loads the pack, and a second plugin, `repository`, with the skills of `.claude/skills/` and `.c8y-agent/skills/`. Project skills do not load with `--setting-sources user` (verified with Claude Code 2.1.323); plugin skills do, as `repository:<skill>`.
  - `--permission-mode dontAsk` with the allowed tools: the shell, file tools, subagents, skills, and the two MCP servers. Web fetch and web search are not allowed.
  - `--max-budget-usd` and the step's `timeout-minutes` from the inputs.
  - Without the workflow command files (`GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`) in its environment. Only the four tools' binaries are added to the `PATH`.
- **After the agent:** the job summary gets the outcome, turns, cost, and duration; the transcript stays on the runner, because it can hold anything the agent read. `c8y-ui-apply bundle` packs the commits. If `result.json` or a commit contains the model key, nothing is uploaded: a check against a careless result, not a boundary, because the agent controls this runner.
- **Failures:** an agent step that fails or runs out of time still gets its commits bundled; without `result.json`, the apply job reports the run as failed. A failed install or a job timeout leaves no artifact, with the same report.

## Versions

The context and agent jobs check out the pack at `job.workflow_sha`, the commit of the `run.yml` that runs. The filter job looks up the release tag `v<version>` that points to that commit (`git ls-remote` on this public repository) and installs the packages of that version, so a caller pinned to `run.yml@v0.8.0` gets the pack and the packages of 0.8.0. A call at a commit without a release tag stops, unless the input `package-version` names the packages to use: for testing a branch of the workflow with released packages.

## Limits

- **The agent job's tokens.** The agent's step gets no token, but the agent controls its runner (with `sudo`): it can reach the job token (read-only `contents` and `packages` of the calling repository, valid until the job ends) and the Actions runtime token ([result.md](result.md), Limits). A run that continues an agent branch also runs that branch's install scripts with the job token in the environment, so an earlier run's change to `package.json` scripts runs there.
- **The model key.** `ANTHROPIC_API_KEY` is in the agent's environment. An instruction in an issue that the model follows could send it out: to another host while the network is open (Not yet), and also through channels an egress allowlist does not close: the job log, the job summary, the artifact, a comment, or a commit. The check before the upload catches only the plain key. Use a key of a workspace with a spend limit for the agent, and rotate it.
- **A stale agent branch.** If `agent/<number>-<playbook>` still exists after its pull request was merged or closed, the next run on the issue continues it. Delete such branches (the repository setting above does it on merge).
- **The trigger label** stays when the filter or context job fails, or the apply job does not run.

## Not yet

- **Egress allowlist.** The agent job's network is not restricted (D19).
- **The prepare job:** pulling a world from a tenant (`world.pull`, D8). The world comes from the repository (`world.file` or `c8y-ui.json`).
- **The first reply** with the detected profile, and the `agent:working` label at the start of a run.
- **The repository's Node version:** the agent job uses Node 24 for everything.
- **Yarn** repositories.

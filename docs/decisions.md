# Decisions

Decisions taken for the C8Y UI Agent. Add a decision here when it is taken, with the date and the rejected alternatives. Numbers follow the design specification; open decisions (D3 to D6, D8) are added once they are taken.

## D1: Claude Code is the agent runtime

Claude Code runs headless and reads `CLAUDE.md`, `.claude/skills`, and subagent definitions natively, so repositories that use it need no translation layer. It ships the agent pack as a plugin, enforces guardrails with hooks, and sets a model per role.

Trade-off: a single model vendor. Docker Agent remains an option: playbooks, skills, the workbench, and the result file do not depend on the runtime, and runtime-specific code stays in one adapter in the reusable workflow.

Decided on 2026-10-28.

## D2: Only a separate apply job writes to GitHub

The agent job holds no GitHub credential. The apply job runs on a fresh runner and receives only the result file and the agent's commits as a git bundle. It checks out the repository with git hooks disabled, verifies that the bundle fast-forwards from the base commit without merge commits, validates the result, and only then mints the write token. A step on the agent's runner would not protect the token, because the agent can change that runner.

The apply job rejects changes to protected paths:

- all of `.github/`;
- the agent configuration (`.c8y-agent/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`), except `.c8y-agent/` from the `setup` playbook as a draft pull request;
- lockfile changes without a `package.json` change;
- the paths in `protect` of `.c8y-agent/config.yml`, read from the default branch.

A rejection pushes nothing, names the rule and the file in the status comment, and keeps the commits as a run artifact.

CI jobs that use secrets run in an environment with required reviewers for `agent/*` branches.

Decided on 2026-10-29.

## D7: This repository is public; the App installs only in `Cumulocity-IoT`

GitHub does not let public repositories use reusable workflows stored in internal repositories, and most target repositories are public. This repository holds the reusable workflow and the agent pack, so it is public. It holds no secrets; playbooks and role prompts are readable by anyone.

The agent stays unusable outside the organization: the App is registered with "Only on this account", and the packages it installs (UI SDK, workbench, Web SDK knowledge server) stay internal and need per-repository access grants. Either can be widened later.

Fork pull requests are the remaining path to the internal packages: GitHub lets forks of a public repository that has access to private packages read them. Runs for external contributors therefore need a maintainer's approval, after a review of workflow changes.

Rejected: an internal repository, which excludes public target repositories; a public workflow repository plus an internal agent pack package, which keeps prompts internal at the cost of one more package to release.

Decided on 2026-10-29.

Update on 2026-11-04: the organization lets only owners change a package's visibility, so the workbench stays private for now. Teams that use it get the Read role under the package's Manage access; repositories get Manage Actions access as before. Internal remains the target.

## D9: The App is named "C8Y UI Agent", handle `@c8y-ui-agent`

GitHub derives the App's slug from its display name: handle `c8y-ui-agent`, bot login `c8y-ui-agent[bot]`, matching the repository name. C8Y is a widely recognized abbreviation for Cumulocity; `cumulocity-ui-agent` is too long to type in every mention.

An App cannot be mentioned like a user; the filter job matches the text `@c8y-ui-agent`. The organization registers the user login `c8y-ui-agent` as a placeholder machine account, so nobody else can take the handle and receive the mentions.

Decided on 2026-10-29.

## D10: The workbench runs on Linux and macOS only

The agent runs in GitHub Actions on Linux runners; developers run the workbench locally on macOS or Linux. The workbench's `package.json` declares `"os": ["darwin", "linux"]`, so an install on Windows fails at once instead of in the middle of a proof.

Rejected: Windows support. It needs a process tree stop in the UI SDK (`startDev` and `runE2e` stop only the direct child on Windows), a cleanup without renaming directories that running processes still use, a way to start `pnpm` and `npm` without `sh`, and Windows runners in CI. It can be added once a user needs it, after the SDK change.

Decided on 2026-11-04.

## D11: Screenshots use Playwright with Chromium

The workbench takes screenshots with `playwright-core` in headless Chromium: Playwright's own Chromium when installed, otherwise the installed Google Chrome (`channel: 'chrome'`), which GitHub's Ubuntu runners have. `playwright-core` downloads no browser on install. One browser serves all screenshots; each screenshot gets a fresh browser context.

A screenshot waits until no HTTP request is in flight and the DOM has not changed for 1 s, at most 15 s. The shell slides its navigator in about 0.7 s after its last request, so waiting for the network alone captures it half open. Running animations that end are then finished on the page, and the page must be quiet again: Playwright's `animations: 'disabled'` finishes them at the capture too, but their end handlers run after it has measured the page. The emulator's gap report (`/_mock/gaps?since=`) adds the requests the emulator could not answer while the page loaded.

Rejected:

- `cy.screenshot` in a Cypress run: a spec file and a Cypress start (10 s or more) per screenshot, and the repository's Cypress setup.
- The agent's own browser tool (Playwright MCP server): no gap report, and every agent repeats the waiting and the route handling. It stays useful for exploring a preview.
- A screenshot API in the UI SDK: the SDK has no browser dependency. The workbench can move to one if the SDK adds it.

Decided on 2026-11-05.

## D12: `check` is one e2e run on the working tree

`check` runs the app's e2e (Cypress) tests once, in the repository's checkout as it is, on a fresh emulated tenant (SDK `runE2e`, `ng serve`), and returns a status (`passed`, `failed`, `build-failed`, `error`) with the failures, retried tests, and unexpected gaps. Without `specs`, it runs every spec of the app's Cypress config. It is the developer's check between edits: 10 to 30 seconds on the pilot. `prove_regression` remains the proof.

`check` and `prove_regression` share one slot: one e2e run at a time per workbench, because parallel Cypress runs compete for CPU and make tests flaky.

Rejected:

- Lint, type check, and unit tests in `check`: they are the repository's own scripts, which the agent runs with its shell, and finding them is discovery (phase 3). `check` covers what needs the emulator.
- A git worktree with a fresh install, as in `prove_regression`: the install takes minutes, and ignored files such as `cypress.env.json` would be missing. The checkout as it is answers the developer's question: do the tests pass on my working tree.

Decided on 2026-11-05.

## D13: Phase 1 ends without switching the toolkit's issue loop

Phase 1 ends with the four workbench tools (`preview_up`, `screenshot`, `check`, `prove_regression`) working on the `cumulocity-ui-toolkit` pilot from the command line. The toolkit's own issue loop does not switch to them: the agent's `triage` and `fix` playbooks and the reusable workflow (phase 3) replace that loop, so switching it now builds what phase 3 removes. Phase 2 does not depend on it.

What the switch would have tested, an agent that works a whole issue with the tools, gets a cheaper check before the phase 3 playbooks are written: one Claude Code session in the pilot worktree, with the workbench as its MCP server, works one issue. Unclear tool descriptions, oversized results and misread statuses become workbench changes.

The toolkit runs SDK 2.3.3 since its pull request #117, so its gap reports name the tests behind each gap. On 2026-11-06, the pilot proof, rebased onto that version, returned `regression`: each run had 3 gaps, all expected.

Rejected: switching the toolkit's issue loop to the workbench tools, as planned. The loop is replaced in phase 3.

Decided on 2026-11-05.

The session ran on 2026-11-13 on toolkit issue #61: [pilot-sessions.md](pilot-sessions.md).

## D14: Every unexpected gap of a proof limits it to `observed`

`prove_regression` counts every unexpected gap of its runs (`expected: false`), whichever tests the gap report names. Each run has its own emulator and runs only the tested specs, so their tests, hooks and app start sent every request of the run. The gap report's test names (SDK 2.3) help find a gap's cause; they do not change the verdict.

Rejected: counting only the gaps the report attributes to a tested spec, or to no test, as the specification's evidence rules said and the workbench did until 0.3.0. In a proof it removes no gap that came from another spec, because no other spec runs. It only drops gaps whose test names differ from the reporter's, for example a spec path relative to another root, and turns `observed` into `regression`.

## D15: Phase 2 builds the result file and the apply job here, not in the toolkit's loop

The specification adds `result.json`, the git bundle, the apply job and App tokens to the toolkit's current issue loop. Phase 2 builds them in this repository instead, as the package `@cumulocity-iot/c8y-ui-apply` with the job definition in [result.md](result.md), tested against local git repositories. Phase 3's reusable workflow runs them. The toolkit's loop, with its personal access token, stays as it is until phase 3 replaces it, as in D13.

The egress allowlist belongs to the agent job, and the required reviewers for CI jobs with secrets to the onboarding of each repository: both come with the reusable workflow and the `setup` playbook. The App is not registered yet; [github-app.md](github-app.md) lists the steps for an organization owner.

Rejected: changing the toolkit's docker-agent loop to write `result.json` and to push from an apply job. It removes the personal access token months earlier, but phase 3 replaces the loop.

Decided on 2026-11-09.

## D16: The apply step trusts only the workflow, checks before it gets a token, and has no runtime dependencies

- **Trusted inputs:** the issue or pull request number, the playbook, the base commit, and the default branch come from the workflow's filter and context jobs. `result.json` and the bundle come from the agent's runner and decide none of them; the branch is always `agent/<number>-<playbook>`.
- **Check first:** `c8y-ui-apply check` needs no token. The job then mints a token that can push only when the check passed, otherwise one that can only comment. `apply` runs the check again before it writes.
- **No runtime dependencies:** the package is bundled (`yaml` inlined), uses `fetch` for the GitHub API and the `git` CLI with hooks off, and installs with `--ignore-scripts`. Nothing resolves a version range in the job that holds the write token.
- **Protected paths** beyond D2: files that decide where code and packages come from or run code on install (`.gitmodules`, `.npmrc`, `.yarnrc*`, `bunfig.toml`, `.pnpmfile.*`, `.yarn/releases/`, `.yarn/plugins/`), and tools that run on developers' machines (`.husky/`, `.vscode/`, `.devcontainer/`). Agent instructions (`.claude/`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`) are protected at any depth, because agents read nested ones too. Matching ignores case. Every commit's paths count, not only the net change. A lockfile needs a manifest change in its own package. A `protect` list that cannot be read fails the check.
- **Labels:** the agent may add state labels only. A label the App adds starts workflows, so a playbook label (`agent:setup`) would let the agent start another playbook or a loop.
- **Secrets:** `C8Y_UI_AGENT_CLIENT_ID` replaces the specification's `C8Y_UI_AGENT_APP_ID`: `actions/create-github-app-token` v3 deprecates the App ID input.

Rejected:

- A JavaScript action in this repository: it needs its build output committed, and releases commit nothing back.
- Octokit: a dependency tree in the job that holds the write token, for seven REST calls.
- Validating in the agent job: the agent can change its runner, so a check there proves nothing. The agent runs `c8y-ui-apply validate` only to find its own mistakes early.

Decided on 2026-11-09.

## D17: Discovery lives in the workbench and reads installed versions

Discovery runs in the agent job after the install, next to the workbench, which is its first user: the workbench's settings (e2e root, per-app Cypress config, login mode, world) come from the profile instead of command-line options. `c8y-ui-workbench profile` and the MCP tool `profile` give it to the workflow and the agent.

- **Order:** an explicit option wins, then `.c8y-agent/config.yml`, then detection. The workbench reads only its own keys of `config.yml` (`world.file`, `e2e`, `commands`, `projects.<app>.commands`) and leaves the others to the components that use them; an invalid file is an error.
- **`e2e` and `commands` in config.yml:** the specification corrects commands under `projects` only. The workbench also needs the e2e setup, and a repository needs to correct its lint and test commands, so both are added.
- **Versions from the install:** the Web SDK and Angular versions are those Node resolves from the repository and the app folders, not parsed from the four lockfile formats. The profile is taken after the install, so the result is the same; without an install, they are unknown.
- **No guessed Cypress environment:** a Cypress config that reads the app's URL from its own variable needs `e2e.env` in `config.yml`. Reading variable names out of Cypress configs would be a guess.

Not yet detected, from the specification's table: the test stack beyond Cypress, CI workflows, changelogs. They come when a playbook needs them.

Rejected: a separate discovery package, which the agent job would install next to the workbench for the same data; discovery in the filter or context job, before the install, without installed versions.

Decided on 2026-11-13.

## D18: The agent pack is a Claude Code plugin in this repository; the apply package resolves playbooks

The pack (`pack/`, [pack.md](pack.md)) holds the run prompt, the built-in playbooks `triage` and `fix`, the roles, and the guardrail hooks.

- **A plugin, loaded from a checkout:** Claude Code loads the roles and hooks with `--plugin-dir` (verified with Claude Code 2.1.323: plugin hooks run with `--setting-sources user`, and plugin roles are named `c8y-ui-agent:<role>`). The reusable workflow checks out this repository at `job.workflow_sha`, so the pack has the version of the workflow that runs it. It is not published: a package would be a second version to keep in step.
- **Playbook resolution in the apply package:** a playbook's evidence level and result decide what the apply job may accept, so the workflow resolves them in its trusted jobs, from the default branch, and passes them on; the agent's files decide nothing (D16). The apply package already runs there, reads `.c8y-agent/config.yml`, and has no runtime dependencies; the workbench is installed only in the agent job. `c8y-ui-apply playbook` also writes the system prompt.
- **Roles:** the orchestrator is the main session, so the playbook is its system prompt. The developer and the verifier are subagents; the verifier gets a fresh context, read tools, and the sonnet model. The verdict that counts is `prove_regression`'s, which the orchestrator runs, not the verifier's.
- **Hooks against mistakes:** the D13 pilot lost turns to denied shell calls. The agent job's runner is discarded and holds no credential (D2), so the workflow will allow the shell, and the guard denies a few mistakes that cost a run: pushes, merges, `gh`, staging everything, and edits of the agent configuration and `.github/`. The apply job's check covers more (D16); the guard is not a security boundary.
- **Unsupported fields are errors:** `gate: plan` and `choice`, `result: review`, and `models` need the status comment and the playbooks of phase 5. A repository that sets them gets an error, not a playbook that ignores them.

Rejected: playbook resolution in the workbench, which the filter, context, and apply jobs do not install; the agent reading playbook files itself, which lets the agent's runner decide the evidence level; a published pack package.

Decided on 2026-11-13.

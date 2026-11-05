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

A screenshot waits until no HTTP request is in flight and the DOM has not changed for 1 s, at most 15 s. The shell slides its navigator in about 0.7 s after its last request, so waiting for the network alone captures it half open. The emulator's gap report (`/_mock/gaps?since=`) adds the requests the emulator could not answer while the page loaded.

Rejected:

- `cy.screenshot` in a Cypress run: a spec file and a Cypress start (10 s or more) per screenshot, and the repository's Cypress setup.
- The agent's own browser tool (Playwright MCP server): no gap report, and every agent repeats the waiting and the route handling. It stays useful for exploring a preview.
- A screenshot API in the UI SDK: the SDK has no browser dependency. The workbench can move to one if the SDK adds it.

Decided on 2026-11-05.

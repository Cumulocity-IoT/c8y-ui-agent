# Decisions

Decisions taken for the C8Y UI Agent. Add a decision here when it is taken, with the date and the rejected alternatives.

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

Rejected: an internal repository, which excludes public target repositories; a public workflow repository plus an internal agent pack package, which keeps prompts internal at the cost of one more package to release.

Decided on 2026-10-29.

## D9: The App is named "C8Y UI Agent", handle `@c8y-ui-agent`

GitHub derives the App's slug from its display name: handle `c8y-ui-agent`, bot login `c8y-ui-agent[bot]`, matching the repository name. C8Y is a widely recognized abbreviation for Cumulocity; `cumulocity-ui-agent` is too long to type in every mention.

An App cannot be mentioned like a user; the filter job matches the text `@c8y-ui-agent`. The organization registers the user login `c8y-ui-agent` as a placeholder machine account, so nobody else can take the handle and receive the mentions.

Decided on 2026-10-29.

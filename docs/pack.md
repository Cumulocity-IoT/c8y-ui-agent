# The agent pack

The agent pack is what the agent runs with: the run prompt, the built-in playbooks, the roles, and the guardrail hooks. It lives in [`pack/`](../pack), is versioned by the repository's tag `v<version>`, and is not published as a package: the reusable workflow checks out this repository at its own commit (`job.workflow_sha`) and loads the pack from there (D18).

```
pack/
  .claude-plugin/plugin.json   the Claude Code plugin "c8y-ui-agent": roles and hooks
  run.md                       the run prompt: task, trust, roles, tools, evidence, commits, result.json
  playbooks/triage.md          built-in playbooks: frontmatter, then the steps
  playbooks/fix.md
  agents/developer.md          role c8y-ui-agent:developer
  agents/verifier.md           role c8y-ui-agent:verifier
  hooks/hooks.json             PreToolUse: hooks/guard.mjs
  hooks/guard.mjs
```

## Playbooks

A playbook is one Markdown file: optional YAML frontmatter, then the instructions.

| Field | Default | Meaning |
|---|---|---|
| `description` | Required, except with `extends` | When to use the playbook |
| `name` | The file name | The command (`@c8y-ui-agent <name>`) and the label (`agent:<name>`): lowercase letters, digits, hyphens |
| `extends` | None | `builtin`: add the body to the built-in playbook of the same name, as "Repository rules"; the fields set here replace the built-in's |
| `evidence` | `observed` | The minimum evidence: `static`, `observed`, or `regression` |
| `result` | `pull-request` | `pull-request` or `comment` (the status comment only) |
| `gate` | `none` | Only `none` so far |

`gate: plan`, `gate: choice`, `result: review`, and `models` come with the playbooks that need them (phase 5); until then they are errors, not ignored.

Resolution, by `c8y-ui-apply playbooks` and `c8y-ui-apply playbook <name>` (packages/apply/src/playbook.ts):

- The built-in playbooks are `pack/playbooks/*.md`. Each sets `description`, `evidence`, and `result`.
- The repository's are the regular `.md` files of `.c8y-agent/playbooks/` in a checkout of the default branch; symbolic links are skipped. A file with a built-in's name must set `extends: builtin`: replacing a built-in is not supported yet. Two files with the same name are an error.
- `playbooks` in `.c8y-agent/config.yml` switches playbooks off: `playbooks: { triage: false }`. A name that is no playbook is reported.
- A repository file with errors is left out, and `playbooks` lists the error; `playbook <name>` fails with it. An invalid `config.yml` fails both.
- `c8y-ui-apply playbook <name> --prompt <file>` writes the run's system prompt: `run.md`, then the playbook's name, description, evidence, result, and body. Its step outputs `evidence` and `result` come from the default branch, not from the agent (D16): the apply job's `check --playbook-result comment` rejects a pull request from a playbook such as `triage`. The evidence level is not checked by code yet: `prove_regression`'s verdict reaches the apply job only through the agent's `result.json`.

## Roles

| Role | Where | Changes code | Model |
|---|---|---|---|
| Orchestrator | The main session: `run.md` and the playbook as appended system prompt | No | The workflow's `--model` |
| Developer | `c8y-ui-agent:developer` | Yes: code, tests, local commits | The orchestrator's (`inherit`) |
| Verifier | `c8y-ui-agent:verifier` | No: read tools, the shell for checks, the workbench without `prove_regression` | `sonnet` |

The orchestrator runs `prove_regression` itself and gives the verifier the base commit, the acceptance criteria, and the verdict, never the developer's report. The verifier has no edit tools; the shell is not restricted, so "does not change files" is an instruction.

## Hooks

`hooks/guard.mjs` runs before every `Bash`, `Edit`, `Write`, `MultiEdit`, and `NotebookEdit` call and denies, with the reason for the agent:

- `git push`, changes to git remotes, `git pull`, `git merge`, and the GitHub CLI `gh`: the apply job writes to GitHub, and rejects merge commits.
- `git add -A`, `git add .`, `git add --all`, `git add :/`: builds and previews leave output in the checkout (`dist/`), so the agent stages files by name.
- Edits of `.github/` and `.c8y-agent/` at the root, and of agent instructions at any depth (`.claude/`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`), case-insensitive: the apply job rejects a result that changes them. Files outside the checkout, such as `result.json`, are allowed.

The guard reads shell commands word by word, split at `;`, `&&`, `||`, `|`, and subshells, after variable assignments and wrappers (`env`, `sudo`). It prevents mistakes that would cost the run; it is not a security boundary. The agent can reach the same effects another way (a script, an alias), and the security model does not depend on it: the agent job holds no credential, and the apply job checks every result (D2).

## A run

The workflow (`run.yml`, next) prepares a run directory outside the checkout and starts Claude Code in the checkout:

```
<run>/context/issue.md   the issue thread, from the context job
<run>/context/…          related issues
<run>/profile.json       c8y-ui-workbench profile
<run>/result.json        written by the agent
```

```sh
c8y-ui-apply playbook "$PLAYBOOK" --pack "$PACK" --dir "$DEFAULT_BRANCH_CHECKOUT" --prompt "$RUN/system.md"
claude -p "Playbook: $PLAYBOOK
Issue: #$NUMBER in $REPOSITORY
Base: $BASE
Run directory: $RUN
Rounds: $ROUNDS" \
  --append-system-prompt-file "$RUN/system.md" \
  --plugin-dir "$PACK" \
  --strict-mcp-config --mcp-config "$RUN/mcp.json" \
  --add-dir "$RUN"
```

`mcp.json` names the servers `c8y-ui-workbench` and `c8y-web-sdk-knowledge`: the verifier's tool list uses these names. `c8y-ui-apply` is on the `PATH`, for `validate`. Settings sources, permissions, and the egress allowlist come with `run.yml`.

The task message is plain text with the five fields that `run.md` describes. The issue thread is never in the prompt: it is a file that `run.md` marks as untrusted.

# Pilot sessions

Agent sessions on real issues before the playbooks exist (D13). Each records the setup, the outcome, and what it changes.

## 2026-11-13: draft `fix` playbook on cumulocity-ui-toolkit#61

**Setup.**
- **Issue:** toolkit issue #61, "Reminder Plugin: Indicator close not visible": one sentence, no steps.
- **Checkout:** a toolkit worktree at main (be9ba0c, Angular 21, UI SDK 2.3.3) on the branch `agent/61-fix`.
- **Agent:** headless Claude Code 2.1.323 with Opus 5.5. A draft of the `fix` playbook was appended to the system prompt: triage, reproduce, regression test first, fix, prove, commit, `result.json`.
- **Context:** the issue thread as a file, as the context job will pass it. No GitHub access.
- **MCP servers:** only the workbench (0.5.0) and the Web SDK knowledge server (`--strict-mcp-config`). Project settings only; the toolkit has none besides skills.
- **Shell:** permission mode `dontAsk`, with a shell allowlist: pnpm lint and test scripts, read and commit git commands, `ls`, and `c8y-ui-apply validate`.
- **World:** the UI SDK's template world. The reminder spec creates its own devices.

**Outcome.** 17 minutes, 66 turns, USD 2.52.
- **The agent's report:** it could not reproduce the issue on main. It wrote `result.json` with outcome `comment` and `agent:needs-info`.
- **The cause it found:** in the version the issue was filed against, the indicator subscribed to the drawer state before the plugin created it. The Angular 21 migration (#98) removed that race.
- **The comment:** lists seven sequences it tried, and asks for versions, steps, and a screenshot.
- **The apply check:** `c8y-ui-apply check` accepted the result in a fresh clone.

**Findings.**

| Finding | Change |
|---|---|
| `preview_up` fails for 8 of the 12 toolkit apps: those whose product code imports a path alias. `startDev` runs `ng serve` in the app's folder, and there the dev server cannot resolve the root `tsconfig.json` path aliases (`~services/*`). `ng serve <project>` from the root compiles, which is how `runE2e` serves, so `check` works. `screenshot` needs a preview. | UI SDK issue #42 (`startDev` takes a project). Until then, `triage` cannot take screenshots of these plugins. |
| The agent reproduced through `check` with a throwaway Cypress spec instead, and could not delete it afterwards (`rm` denied). | Plan for the `fix` playbook: a reproduction spec becomes the regression test or is deleted. |
| The emulator reports `GET /tenant/options/c8y.reminder/{config,defaults}` (404, option not set) as an unexpected gap, although a real tenant answers the same. Under D14, every proof of the reminder plugin would end `observed`. | UI SDK issue #57: a 404 the platform also gives is not a gap. A world with the options set avoids it. |
| Three shell calls were denied: a compound `cd … && cat …`, a pipe into `head`, and `rm`. The allowlist cannot express what the agent needs without allowing the shell. | Plan for the agent pack: the agent job's runner holds no credentials and is discarded (D2), so the shell is allowed there; hooks block pushes, and the egress allowlist limits the network. |
| The agent searched minified `@c8y` bundles in `node_modules` for header internals, and used the knowledge server once. | Plan for the playbooks: the knowledge server answers API questions; no reading of bundles. |
| `check` and preview builds leave `packages/<app>/dist/` untracked in the checkout. The toolkit does not ignore it. | Plan for the playbooks: commit named files only (`git add <file>`, never `git add -A`). `c8y-ui-apply bundle` already lists uncommitted files. |
| `check` results were 4 to 15 kB (3,000 to 4,000 tokens): the passed tests and the gaps with their tests. | None: compact JSON and dropping redundant fields would save at most 30%. |

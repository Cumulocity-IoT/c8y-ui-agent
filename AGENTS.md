# C8Y UI Agent

A GitHub App that works on Cumulocity Web SDK apps and plugins with Claude Code. Product overview and status: `README.md`; development and releases: `CONTRIBUTING.md`.

## Read first

- [docs/decisions.md](docs/decisions.md): decisions taken and why. Add a decision when you take one.
- [docs/prove-regression.md](docs/prove-regression.md): the rules of `prove_regression`.

Keep knowledge in the repository, not in a private agent memory.

## Layout

```
packages/workbench/   @cumulocity-iot/c8y-ui-workbench: MCP server on the Cumulocity UI SDK
  src/target.ts       the repository and its apps (angular.json, detectConfig of the SDK)
  src/preview.ts      preview_up: startDev of the SDK, one dev server and emulator per preview
  src/tests.ts        one e2e run: runE2e of the SDK, per-test results from reporter/index.cjs
  src/regression.ts   prove_regression: base worktree, three runs
  src/evaluate.ts     prove_regression's rules (docs/prove-regression.md)
  src/server.ts       the MCP tools; src/cli.ts the bin
```

Planned tools: `screenshot`, `check`.

## Workbench rules

- Nothing may write to stdout in MCP mode: pass an output callback to every SDK call and child process.
- `prove_regression` rules live in `src/evaluate.ts` as a pure function with unit tests; change `docs/prove-regression.md` with them.
- The reporter (`reporter/index.cjs`) runs inside Cypress: CommonJS, no dependencies. Its unit test mirrors the event shape of Cypress 15; check it against a real Cypress run after a Cypress major.

## Rules

- This repository is public. Never commit secrets, tenant URLs, tenant IDs, credentials, or customer data.
- The workbench uses the Cumulocity UI SDK (`@cumulocity-iot/ui-sdk`) through its public API and CLI only. Fix emulator gaps in the SDK, not here.
- Branch per change; pull request titles are conventional commits (`CONTRIBUTING.md`).
- Do not weaken the repository settings or workflow permissions described in `CONTRIBUTING.md` → Repository setup.
- Run `pnpm build && pnpm typecheck && pnpm test` before you open a pull request.

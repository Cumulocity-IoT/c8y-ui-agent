# C8Y UI Agent

A GitHub App that works on Cumulocity Web SDK apps and plugins with Claude Code. Product overview and status: `README.md`; development and releases: `CONTRIBUTING.md`.

## Read first

- [docs/decisions.md](docs/decisions.md): decisions taken and why. Add a decision when you take one.

Keep knowledge in the repository, not in a private agent memory.

## Layout

```
packages/workbench/   @cumulocity-iot/c8y-ui-workbench: MCP server on the Cumulocity UI SDK (preview_up, prove_regression, screenshot, check)
```

## Rules

- This repository is public. Never commit secrets, tenant URLs, tenant IDs, credentials, or customer data.
- The workbench uses the Cumulocity UI SDK (`@cumulocity-iot/ui-sdk`) through its public API and CLI only. Fix emulator gaps in the SDK, not here.
- Branch per change; pull request titles are conventional commits (`CONTRIBUTING.md`).
- Run `pnpm build && pnpm typecheck && pnpm test` before you open a pull request.

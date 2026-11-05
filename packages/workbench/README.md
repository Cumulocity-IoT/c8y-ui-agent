# @cumulocity-iot/c8y-ui-workbench

Model Context Protocol (MCP) server for the C8Y UI Agent. It serves a Cumulocity Web SDK app on the emulated tenant of the Cumulocity UI SDK (`@cumulocity-iot/ui-sdk`), takes screenshots of it, and proves changes with e2e (Cypress) runs. `prove_regression` runs in git worktrees outside the checkout; a preview runs the dev server in the checkout, which writes build output (`dist/`, `.angular/`) as the repository's own serve script does.

Requires Node 22.13 or later, a repository with its dependencies installed (pnpm or npm), and for screenshots Google Chrome or Playwright's Chromium (`npx playwright-core install chromium-headless-shell`). Install from GitHub Packages (`@cumulocity-iot:registry=https://npm.pkg.github.com`), with a token that has `read:packages`. The package is private: ask a maintainer of this repository for Read access for your team.

## Tools

| Tool | Input | Result |
|---|---|---|
| `list_apps` | none | The apps: Angular projects with a serve target, by folder name, or the repository itself |
| `preview_up` | `app` | `id` and `url`: the shell with the app's dev build (`ng serve`) on the emulated tenant, no login needed. 1 to 3 minutes. |
| `preview_log` | `id`, `lines` | The dev server's last output lines, e.g. build errors after a change |
| `preview_down` | `id` (optional) | Stops one preview, or all |
| `screenshot` | `id`, `path`, `waitFor`, `selector`, `fullPage`, `width`, `height`, `language`, `name` (all but `id` optional) | A PNG of a preview's page in headless Chromium (default 1440×900, language `en`), its file, and what went wrong while it loaded: console errors, failed requests, and unexpected emulator gaps. `path` is the route (`#/device/1`); `selector` captures one element. Waits until no request is in flight and the page has not changed for 1 s (`settled`), at most 15 s. 3 to 5 seconds. |
| `prove_regression` | `app`, `base`, `specs`, `tests` (all but `app` optional) | One at a time. Verdict `regression`, `observed`, `not-proven` or `inconclusive`, with reasons, per-test outcomes of the base run and two change runs, and the emulator gaps. 3 to 10 minutes. Rules: [docs/prove-regression.md](https://github.com/Cumulocity-IoT/c8y-ui-agent/blob/main/docs/prove-regression.md). |

## Configuration

The server takes the repository's settings as options. Discovery will fill them in later versions.

| Option | Meaning |
|---|---|
| `--repo <dir>` | The repository (default: the working directory) |
| `--world <file>` | World file the emulator serves, relative to the repository or absolute; required |
| `--e2e-root <dir>` | Cypress project directory, relative to the repository. Files under it are tests; everything else is the product change. |
| `--e2e-config <file>` | Cypress config file, relative to the e2e root; `{app}` is replaced by the app name |
| `--e2e-auth <mode>` | Emulator login mode in e2e runs: `open` (default) or `login` |
| `--e2e-env <K=V>` | More Cypress environment, repeatable; `{devUrl}` and `{mockUrl}` are replaced with the run's URLs |
| `--screenshots <dir>` | Directory for screenshots (default: `c8y-ui-workbench-screenshots` in the temp directory). Keep it out of the working tree or ignore it in git: `prove_regression` counts untracked files as part of the change. |

The world file must exist before a preview or a proof starts. `c8y-ui create` and `c8y-ui init` of the UI SDK add `mock/world.json`. Otherwise create one with `c8y-ui world pull` (part of a real tenant, through the active go-c8y-cli session) or `c8y-ui world export` (a running mock's state), or copy the SDK's template world (`node_modules/@cumulocity-iot/ui-sdk/templates/app/mock/world.json`). A repository that does not commit its world file pulls it first, e.g. with a package script.

Claude Code, for an app set up with `c8y-ui create` or `c8y-ui init` (world in `mock/`, Cypress at the repository root):

```sh
claude mcp add c8y-ui-workbench -- npx -y @cumulocity-iot/c8y-ui-workbench --world mock/world.json
```

For an Angular workspace with several plugins, its Cypress project in `test/` and one Cypress config per plugin, which logs in and reads the app's URL from `C8Y_CYPRESS_URL`:

```sh
claude mcp add c8y-ui-workbench -- npx -y @cumulocity-iot/c8y-ui-workbench \
  --world mock/world.json --e2e-root test --e2e-config 'config/{app}.config.ts' \
  --e2e-auth login --e2e-env 'C8Y_CYPRESS_URL={devUrl}'
```

## From a shell

The same operations, with the same options:

```sh
c8y-ui-workbench apps
c8y-ui-workbench preview <app>                        # until Ctrl+C
c8y-ui-workbench screenshot <app> [--path <route>] [--wait-for <css>] [--selector <css>] [--full-page] [--out <file>]
c8y-ui-workbench prove-regression <app> [--base <commit>] [--spec <file>]… [--test <name>]…
```

`screenshot` starts a preview, takes one screenshot, stops the preview, and prints the result as JSON. `prove-regression` prints the result as JSON and exits with 0 only for the verdict `regression`.

The workbench runs the repository's code (installs, dev server, Cypress) with its own environment: run it only where that code may run.

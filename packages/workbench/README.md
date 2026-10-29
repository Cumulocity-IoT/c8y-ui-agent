# @cumulocity-iot/c8y-ui-workbench

Model Context Protocol (MCP) server for the C8Y UI Agent. It serves a Cumulocity Web SDK app on the emulated tenant of the Cumulocity UI SDK (`@cumulocity-iot/ui-sdk`) and proves changes with e2e (Cypress) runs. `prove_regression` runs in git worktrees outside the checkout; a preview runs the dev server in the checkout, which writes build output (`dist/`, `.angular/`) as the repository's own serve script does.

Requires Node 22.13 or later, and a repository with its dependencies installed (pnpm or npm). Install from GitHub Packages (`@cumulocity-iot:registry=https://npm.pkg.github.com`).

## Tools

| Tool | Input | Result |
|---|---|---|
| `list_apps` | none | The apps: Angular projects with a serve target, by folder name, or the repository itself |
| `preview_up` | `app` | `id` and `url`: the shell with the app's dev build (`ng serve`) on the emulated tenant, no login needed. 1 to 3 minutes. |
| `preview_log` | `id`, `lines` | The dev server's last output lines, e.g. build errors after a change |
| `preview_down` | `id` (optional) | Stops one preview, or all |
| `prove_regression` | `app`, `base`, `specs`, `tests` (all but `app` optional) | One at a time. Verdict `regression`, `observed`, `not-proven` or `inconclusive`, with reasons, per-test outcomes of the base run and two change runs, and the emulator gaps. 3 to 10 minutes. Rules: [docs/prove-regression.md](https://github.com/Cumulocity-IoT/c8y-ui-agent/blob/main/docs/prove-regression.md). |

## Configuration

The server takes the repository's settings as options. Discovery will fill them in later versions.

| Option | Meaning |
|---|---|
| `--repo <dir>` | The repository (default: the working directory) |
| `--world <file>` | World file the emulator serves, relative to the repository; required |
| `--e2e-root <dir>` | Cypress project directory, relative to the repository. Files under it are tests; everything else is the product change. |
| `--e2e-config <file>` | Cypress config file, relative to the e2e root; `{app}` is replaced by the app name |
| `--e2e-auth <mode>` | Emulator login mode in e2e runs: `open` (default) or `login` |
| `--e2e-env <K=V>` | More Cypress environment, repeatable; `{devUrl}` and `{mockUrl}` are replaced with the run's URLs |

Claude Code, for `cumulocity-ui-toolkit`:

```sh
claude mcp add c8y-ui-workbench -- npx -y @cumulocity-iot/c8y-ui-workbench \
  --world test/mock/windy-dev.json --e2e-root test --e2e-config 'config/{app}.config.ts' \
  --e2e-auth login --e2e-env 'C8Y_CYPRESS_URL={devUrl}'
```

## From a shell

The same operations, with the same options:

```sh
c8y-ui-workbench apps
c8y-ui-workbench preview <app>                        # until Ctrl+C
c8y-ui-workbench prove-regression <app> [--base <commit>] [--spec <file>]… [--test <name>]…
```

`prove-regression` prints the result as JSON and exits with 0 only for the verdict `regression`.

The workbench runs the repository's code (installs, dev server, Cypress) with its own environment: run it only where that code may run.

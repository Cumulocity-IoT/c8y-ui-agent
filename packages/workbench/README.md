# @cumulocity-iot/c8y-ui-workbench

Model Context Protocol (MCP) server for the C8Y UI Agent. It serves a Cumulocity Web SDK app on the emulated tenant of the Cumulocity UI SDK (`@cumulocity-iot/ui-sdk`), takes screenshots of it, runs its e2e (Cypress) tests, and proves changes with them. `prove_regression` runs in git worktrees outside the checkout; a preview and `check` run the dev server in the checkout, which writes build output (`dist/`, `.angular/`) as the repository's own serve script does.

Requires Node 22.13 or later, a repository with its dependencies installed (pnpm or npm), and for screenshots Google Chrome or Playwright's Chromium (`npx playwright-core@<version> install chromium-headless-shell`, with the workbench's `playwright-core` version, which the error without a browser names). Install from GitHub Packages (`@cumulocity-iot:registry=https://npm.pkg.github.com`), with a token that has `read:packages`. The package is private: ask a maintainer of this repository for Read access for your team.

## Tools

| Tool | Input | Result |
|---|---|---|
| `list_apps` | none | The apps: Angular projects with a serve target, by folder name, or the repository itself |
| `profile` | none | The repository profile from discovery: package manager, Node, Web SDK and Angular versions, each app's package scripts, the repository's lint and test commands, the e2e setup, the world file, instruction files and skills, and what discovery could not settle; with the settings `preview_up`, `check` and `prove_regression` use ([docs/discovery.md](https://github.com/Cumulocity-IoT/c8y-ui-agent/blob/main/docs/discovery.md)) |
| `preview_up` | `app` | `id` and `url`: the shell with the app's dev build (`ng serve`) on the emulated tenant, no login needed. 1 to 3 minutes. |
| `preview_log` | `id`, `lines` | The dev server's last output lines, e.g. build errors after a change |
| `preview_down` | `id` (optional) | Stops one preview, or all |
| `screenshot` | `id`, `path`, `waitFor`, `selector`, `fullPage`, `width`, `height`, `language`, `name` (all but `id` optional) | A PNG of a preview's page in headless Chromium (default 1440×900, language `en`), its file, and what went wrong while it loaded: console errors, failed requests, and unexpected emulator gaps. `path` is the route (`#/device/1`); `selector` captures one element. Waits until no request is in flight and the DOM has not changed for 1 s, and finishes animations that end (`settled`), at most 15 s: live widgets that keep changing the page give `settled: false` after 15 s. Failed requests leave out the 404 and 405 responses a fresh tenant gives too and requests the page canceled. Images over 8000 px a side or 3.75 MB (long `fullPage` captures) come back as a file path only. 3 to 5 seconds. |
| `check` | `app`, `specs` (optional) | One e2e run on the working tree as it is, on a fresh emulated tenant: status `passed`, `failed`, `build-failed` or `error`, test counts, failures with where and why, tests that passed only on a retry, and unexpected emulator gaps. Default: every spec of the app's Cypress config. A named spec that reports no tests fails the check; when every test is pending, the status is `error`. The quick check between edits; `prove_regression` is the proof. 10 seconds to a few minutes. |
| `prove_regression` | `app`, `base`, `specs`, `tests` (all but `app` optional) | One at a time, and not while a `check` runs. Verdict `regression`, `observed`, `not-proven` or `inconclusive`, with reasons, per-test outcomes of the base run and two change runs, and the emulator gaps. 3 to 10 minutes. Rules: [docs/prove-regression.md](https://github.com/Cumulocity-IoT/c8y-ui-agent/blob/main/docs/prove-regression.md). |

## Configuration

Discovery reads the settings from the repository: the Cypress project, its per-app config files, and the UI SDK project file `c8y-ui.json` with the login mode and the world ([docs/discovery.md](https://github.com/Cumulocity-IoT/c8y-ui-agent/blob/main/docs/discovery.md)). `.c8y-agent/config.yml` corrects them, and these options win over both:

| Option | Meaning |
|---|---|
| `--repo <dir>` | The repository (default: the working directory) |
| `--world <file>` | World file the emulator serves, relative to the repository or absolute. Previews, checks and proofs need one. |
| `--e2e-root <dir>` | Cypress project directory, relative to the repository. Files under it are tests; everything else is the product change. |
| `--e2e-config <file>` | Cypress config file, relative to the e2e root; `{app}` is replaced by the app name. Applies to every app; a detected pattern applies only to the apps whose file exists. |
| `--e2e-auth <mode>` | Emulator login mode in e2e runs: `open` (default without a `c8y-ui.json`) or `login` |
| `--e2e-env <K=V>` | More Cypress environment, repeatable, added to `e2e.env` of `config.yml`; `{devUrl}` and `{mockUrl}` are replaced with the run's URLs |
| `--screenshots <dir>` | Directory for screenshots (default: a new private directory in the temp directory per run). Keep it out of the working tree or ignore it in git: `prove_regression` counts untracked files as part of the change. |

The world file must exist before a preview or a proof starts. `c8y-ui create` and `c8y-ui init` of the UI SDK add `mock/world.json`. Otherwise create one with `c8y-ui world pull` (part of a real tenant, through the active go-c8y-cli session) or `c8y-ui world export` (a running mock's state), or copy the SDK's template world (`node_modules/@cumulocity-iot/ui-sdk/templates/app/mock/world.json`). A repository that does not commit its world file pulls it first, e.g. with a package script.

Claude Code, in a repository that discovery reads completely (check with `c8y-ui-workbench profile`):

```sh
claude mcp add c8y-ui-workbench -- npx -y @cumulocity-iot/c8y-ui-workbench
```

An Angular workspace with several plugins, its Cypress project in `test/` with one config per plugin, and a Cypress config that reads the app's URL from `C8Y_CYPRESS_URL` needs only that variable in `.c8y-agent/config.yml`:

```yaml
e2e:
  env:
    C8Y_CYPRESS_URL: "{devUrl}"
```

## From a shell

The same operations, with the same options:

```sh
c8y-ui-workbench profile
c8y-ui-workbench apps
c8y-ui-workbench preview <app>                        # until Ctrl+C
c8y-ui-workbench screenshot <app> [--path <route>] [--wait-for <css>] [--selector <css>] [--full-page] [--out <file>]
c8y-ui-workbench check <app> [--spec <file>]…
c8y-ui-workbench prove-regression <app> [--base <commit>] [--spec <file>]… [--test <name>]…
```

`screenshot` starts a preview, takes one screenshot, stops the preview, and prints the result as JSON. `check` and `prove-regression` print the result as JSON and exit with 0 only for the status `passed` or the verdict `regression`.

The workbench runs the repository's code (installs, dev server, Cypress) with its own environment: run it only where that code may run.

# Discovery

Discovery reads a repository and writes its profile: plain code over the repository's files, no model. The profile depends on the commit and on what is installed (`versions`); an app without `angular.json` takes its name from the checkout folder. The workbench takes its settings from the profile, and the agent reads it (`c8y-ui-workbench profile`, the MCP tool `profile`). `.c8y-agent/config.yml` corrects what discovery gets wrong; explicit command-line options win over both (D17).

## The profile

| Field | Detected from |
|---|---|
| `packageManager` | `packageManager` in `package.json`; otherwise the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `bun.lock`, `bun.lockb`) |
| `node` | `.nvmrc`, `.node-version`, then `engines.node` in `package.json`, with the file it came from |
| `versions.webSdk`, `versions.angular` | The installed `@c8y/ngx-components` and `@angular/core`, resolved from the repository and the app folders as Node resolves them. Without an install: unknown. |
| `apps` | The workbench's apps: Angular projects with a serve target, by folder name, or the repository itself. Each with its context path (`cumulocity.config.ts`, through the UI SDK's `detectConfig`), its package scripts, and its Cypress config file. |
| `apps[].commands` | Scripts named `<verb>:<name>`, where the name is the app's folder name or Angular project: `test:kpi-widget` gives `test`, `e2e:run:kpi-widget` gives `e2e:run`. Scripts whose verb contains `watch`, `open`, `dev`, `start`, or `serve` are left out: they do not end, and `preview_up` serves an app. |
| `commands` | The repository's own `lint`, `test`, `build`, and `typecheck` scripts |
| `e2e.root` | The repository or a directory one level below it with a `cypress.config.{ts,mts,cts,js,mjs,cjs}`. Two or more: unknown. |
| `e2e.config` | A per-app Cypress config pattern: a `*.config.*` file in the e2e root or one level below it with an app's name as one of its dot-separated parts (`config/kpi.config.ts` gives `config/{app}.config.ts`), found for at least two apps, or for the only app. Without one, Cypress uses the root's default config. |
| `e2e.auth` | `auth` of the UI SDK project file `c8y-ui.json` in the e2e root, or else at the repository root |
| `world` | `world` of that `c8y-ui.json`, relative to the repository, and whether the file exists. A repository that pulls its world at run time reports `exists: false`. |
| `instructions` | `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `CONTRIBUTING.md` at the root |
| `skills` | Directories with a `SKILL.md` under `.claude/skills/` and `.c8y-agent/skills/` |
| `configured` | The fields `config.yml` set |
| `unknown` | The fields discovery could not settle, each with the reason in parentheses when reading failed. A field that fails does not stop discovery. |

Discovery does not guess Cypress environment variables: a Cypress config that reads the app's URL from its own variable (the toolkit's `C8Y_CYPRESS_URL`) needs `e2e.env` in `config.yml`.

## config.yml

The workbench reads these keys of `.c8y-agent/config.yml` and leaves the others (`protect`, `playbooks`, `limits`, …) to the components that use them. An invalid file is an error, not ignored.

```yaml
world:
  file: test/mock/windy-dev.json     # relative to the repository
e2e:
  root: test                         # Cypress project directory
  config: config/{app}.config.ts     # relative to the root; {app} is the app name
  auth: login                        # open | login
  env:                               # added to Cypress's environment; {devUrl} and {mockUrl} are the run's URLs
    C8Y_CYPRESS_URL: "{devUrl}"
commands:
  lint: pnpm run lint:ci             # replaces a detected repository command
projects:
  kpi-widget:
    commands:
      test: pnpm run test:kpi-widget:ci
```

Order: an explicit option (`--world`, `--e2e-*`) wins, then `config.yml`, then detection. `e2e.env` from `config.yml` and `--e2e-env` add up; an option replaces a variable of the same name. `--e2e-root` also moves where discovery looks for the per-app config pattern and `c8y-ui.json`.

A detected `e2e.config` pattern applies only to the apps whose file exists; the others use the root's default config. A pattern from `config.yml` or `--e2e-config` applies to every app, whether its file exists or not.

An invalid `config.yml` (bad YAML, a wrong type, an unknown key under `world`, `e2e`, or a project) stops every workbench command with the file's errors. The MCP tool `profile` returns the profile and `settings`: what `preview_up`, `check`, and `prove_regression` use, as of the server's start.

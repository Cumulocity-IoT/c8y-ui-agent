# Contributing

## Development

Requires Node 22.13 or later and pnpm 11. Packages under `@cumulocity-iot` come from GitHub Packages; add a token with `read:packages` to `~/.npmrc`:

```ini
//npm.pkg.github.com/:_authToken=<your token>
```

```sh
pnpm install
pnpm build
pnpm typecheck && pnpm test
```

## Commits and pull requests

Work on a branch per change, never on `main`: `feat/<topic>`, `fix/<topic>` (or `docs/`, `chore/`, `refactor/`, `test/`, `ci/`).

Pull requests are squash-merged, and the pull request title becomes the commit on `main`. It must be a [conventional commit](https://www.conventionalcommits.org/) (checked by the *PR title* workflow), because it decides the next release:

| Title | Release |
|---|---|
| `fix: …`, `perf: …` | patch |
| `feat: …` | minor |
| `feat!: …` or a `BREAKING CHANGE:` footer | major (from 0.x that is 1.0.0, so only when you mean it) |
| `docs: …`, `chore: …`, `ci: …`, `test: …`, `refactor: …`, `build: …` | none |

Scopes: `workbench`, later `pack` and `workflow`. While the version is 0.x, breaking changes can go out as `feat`; say so in the pull request description.

## Releases

[`release.config.mjs`](release.config.mjs) and [`.github/workflows/release.yml`](.github/workflows/release.yml): every push to `main` or `next` runs CI, then semantic-release.

- `main` publishes `@cumulocity-iot/c8y-ui-workbench` to GitHub Packages under the `latest` dist-tag. `next` publishes prereleases under `next`.
- semantic-release sets the version in `packages/workbench/package.json` only inside the CI run (the repository keeps `0.0.0-development`), then runs `pnpm publish`. It tags `v<version>` and creates a GitHub release whose notes are the changelog. Nothing is committed back.
- The reusable workflow and the agent pack are versioned by the same tag. Before 1.0.0, a release workflow step will move the major tag (`v1`) that callers reference.
- Preview locally: `pnpm release:dry-run` (needs the GitHub remote and a `GITHUB_TOKEN` in the environment).

## One-time repository setup

1. The version line starts from the tag `v0.0.0` on the initial commit, so the first `feat` releases 0.1.0 instead of 1.0.0.
2. Settings → General → Pull Requests: allow squash merging only, with the default commit message set to the pull request title.
3. A ruleset on `main` requires pull requests and the status check *Build, typecheck, test*.
4. After the first release, open the package (repository → Packages → c8y-ui-workbench) → Package settings: set the visibility to internal (D7; a package published from a public repository can inherit public visibility), and under Manage Actions access add the repositories whose CI installs it.

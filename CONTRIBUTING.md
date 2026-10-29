# Contributing

## Development

Requires Node 22.18 or later (24 recommended) and pnpm 11. Packages under `@cumulocity-iot` come from GitHub Packages; add a token with `read:packages` to `~/.npmrc`:

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

Pull requests are squash-merged. The pull request title becomes the commit on `main`, with an empty body, so the description never affects a release. The title must be a [conventional commit](https://www.conventionalcommits.org/) (checked by the *PR title* workflow), because it decides the next release:

| Title | Release |
|---|---|
| `fix: …`, `perf: …`, `revert: …` | patch |
| `feat: …` | minor |
| `feat!: …` (any type with `!`) | major (from 0.x that is 1.0.0, so only when you mean it) |
| `docs: …`, `chore: …`, `ci: …`, `test: …`, `refactor: …`, `build: …`, `style: …` | none |

Scopes: `workbench`, later `pack` and `workflow`. While the version is 0.x, breaking changes can go out as `feat`. The release notes list only commit titles, so name the break in the title: `feat(workbench): rename preview_up to preview (breaking)`.

## Releases

[`release.config.mjs`](release.config.mjs) and [`.github/workflows/release.yml`](.github/workflows/release.yml): every push to `main` or `next` runs CI, then semantic-release.

- `main` publishes `@cumulocity-iot/c8y-ui-workbench` to GitHub Packages under the `latest` dist-tag. `next` publishes prereleases under `next`.
- semantic-release sets the version in `packages/workbench/package.json` only inside the CI run (the repository keeps `0.0.0-development`), then runs `pnpm publish`. It tags `v<version>` and creates a GitHub release whose notes are the changelog. Nothing is committed back.
- The reusable workflow and the agent pack are versioned by the same tag. With the reusable workflow (phase 3), a release step moves the major tag (`v1`, …) to each new release, and callers reference it (`run.yml@v1`). While the version is 0.x, callers pin an exact tag (`run.yml@v0.4.2`).
- Preview locally: `pnpm release:dry-run` (needs the GitHub remote and a `GITHUB_TOKEN` in the environment).

## Repository setup

Done on 2026-10-29. Recheck after changes to the organization's defaults.

- **Versions:** the tag `v0.0.0` on the initial commit starts the version line, so the first `feat` releases 0.1.0 instead of 1.0.0.
- **Merging:** squash merging only; commit title from the pull request title, empty commit body; branches are deleted after merge.
- **Ruleset "Protect main":** pull requests required (0 approvals, review threads resolved), squash only, linear history, no force push or deletion. Required checks, on an up-to-date branch: *Build, typecheck, test* (`ci.yml`) and *conventional-commit* (`pr-title.yml`). Renaming either job blocks every pull request until the ruleset is updated.
- **Ruleset "Protect release tags":** tags `v*` cannot be moved or deleted. Creating them stays open for semantic-release. The step that moves the major tag (phase 3) needs a bypass.
- **Actions:** the default `GITHUB_TOKEN` is read-only, and Actions cannot approve pull requests; each workflow declares its permissions. Runs for pull requests from any external contributor need a maintainer's approval: review changes to `.github/` before approving, because the run can read internal packages (D7).
- **Security:** secret scanning with push protection, and private vulnerability reporting.

After the first release, open the package (repository → Packages → c8y-ui-workbench) → Package settings:

1. Change the visibility from private to internal. The first publish is private: an npm package inherits the repository's access permissions, not its visibility. Never set it to public; a public package cannot be made private again.
2. Under Manage Actions access, add the repositories whose CI installs the package.

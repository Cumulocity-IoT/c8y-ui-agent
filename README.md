# C8Y UI Agent

A GitHub App that works on Cumulocity Web SDK apps and plugins in their repositories: it triages issues, fixes bugs, implements features, and reviews pull requests. Each run executes in the target repository's GitHub Actions with Claude Code and proves its result on an emulated Cumulocity tenant from the Cumulocity UI SDK (`@cumulocity-iot/ui-sdk`).

The App installs only in the `Cumulocity-IoT` organization. Its packages are internal.

## Status

Phase 1 of 6: the workbench. Nothing here is ready for use yet.

| Phase | Content |
|---|---|
| 1 | Workbench: `preview_up` and `prove_regression`, then `screenshot` and `check`, piloted in `cumulocity-ui-toolkit` |
| 2 | Result file, git bundle, separate apply job, App tokens |
| 3 | Agent pack and reusable workflow (`triage`, `fix`) |
| 4 | Second pilot repository |
| 5 | Remaining playbooks: `feature`, `propose`, `review`, `migrate`, `setup` |
| 6 | Evaluation set and metrics |

## Layout

```
packages/workbench/   @cumulocity-iot/c8y-ui-workbench: MCP server that previews an app on the emulated tenant and proves regressions with e2e runs
docs/decisions.md     decisions taken and why
```

Later phases add `pack/` (playbooks, skills, roles, hooks) and `.github/workflows/run.yml` (the reusable workflow that repositories call).

## Versions

One version line for everything in this repository, released by semantic-release from conventional commits:

- The workbench is published to GitHub Packages as `@cumulocity-iot/c8y-ui-workbench`.
- The tag `v<version>` versions the reusable workflow and the agent pack. From 1.0.0, a moving major tag (`v1`) lets repositories call `run.yml@v1`.

Development and release steps: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)

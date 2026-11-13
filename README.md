# C8Y UI Agent

A GitHub App that works on Cumulocity Web SDK apps and plugins in their repositories: it triages issues, fixes bugs, implements features, and reviews pull requests. Each run executes in the target repository's GitHub Actions with Claude Code and proves its result on an emulated Cumulocity tenant from the Cumulocity UI SDK (`@cumulocity-iot/ui-sdk`).

The App installs only in the `Cumulocity-IoT` organization. Its packages are not public: they are private, with Read access granted per team.

## Status

Phase 1 of 6, the workbench, is done: `preview_up`, `screenshot`, `check` and `prove_regression` work on the `cumulocity-ui-toolkit` pilot. The toolkit's issue loop stays as it is until phase 3 replaces it ([D13](docs/decisions.md#d13-phase-1-ends-without-switching-the-toolkits-issue-loop)). Phase 2: `@cumulocity-iot/c8y-ui-apply` checks an agent run's `result.json` and git bundle and writes them to GitHub ([docs/result.md](docs/result.md)); the GitHub App is not registered yet ([docs/github-app.md](docs/github-app.md)). Nothing here is ready for production use yet.

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
packages/apply/       @cumulocity-iot/c8y-ui-apply: result.json, the agent's git bundle, the apply job's check and writes, and playbook resolution
pack/                 the agent pack: run prompt, playbooks triage and fix, roles, guardrail hooks (a Claude Code plugin, not published)
docs/decisions.md     decisions taken and why
docs/prove-regression.md  the rules of prove_regression
docs/result.md        result.json and the apply job
docs/discovery.md     the repository profile and its corrections in .c8y-agent/config.yml
docs/pack.md          the agent pack: playbooks, roles, hooks, and how a run starts
docs/github-app.md    registering the GitHub App
docs/pilot-sessions.md  agent sessions on real issues, and what they changed
```

Next: `.github/workflows/run.yml`, the reusable workflow that repositories call.

## Versions

One version line for everything in this repository, released by semantic-release from conventional commits:

- The packages are published to GitHub Packages: `@cumulocity-iot/c8y-ui-workbench` and `@cumulocity-iot/c8y-ui-apply`.
- The tag `v<version>` versions the reusable workflow and the agent pack. With the reusable workflow (phase 3), a moving major tag lets repositories call `run.yml@v1`; while the version is 0.x, they pin an exact tag.

Development and release steps: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)

# @cumulocity-iot/c8y-ui-apply

The C8Y UI Agent's result handling. The agent job writes `result.json` and packs its commits into a git bundle; the apply job, on a fresh runner, checks both and only then writes to GitHub: the `agent/<number>-<playbook>` branch, the pull request, `agent:*` labels, and one status comment. Format, rules, and the job definition: [docs/result.md](https://github.com/Cumulocity-IoT/c8y-ui-agent/blob/main/docs/result.md).

Requires Node 22.13 or later and git. No runtime dependencies. Install from GitHub Packages (`@cumulocity-iot:registry=https://npm.pkg.github.com`) with a token that has `read:packages`, and with `--ignore-scripts`.

## Commands

| Command | Job | Does |
|---|---|---|
| `c8y-ui-apply validate <result.json>` | Agent | Reports every error of `result.json`; exit 1 if any |
| `c8y-ui-apply bundle --base <sha> --out <file>` | Agent | The commits since the base as a git bundle; none without commits |
| `c8y-ui-apply playbooks --pack <dir> [--dir <checkout>]` | Filter, context | The playbooks the repository can run, and the errors of its playbook files ([docs/pack.md](https://github.com/Cumulocity-IoT/c8y-ui-agent/blob/main/docs/pack.md)) |
| `c8y-ui-apply playbook <name> --pack <dir> [--prompt <file>]` | Context, agent | One playbook; step outputs `evidence` and `result`; `--prompt` writes the run's system prompt |
| `c8y-ui-apply check …` | Apply, no token | Checks result and bundle in a fresh checkout; step output `ok` |
| `c8y-ui-apply apply … --bot-login <login>` | Apply, App token in `GH_TOKEN` | Checks again, then pushes, opens or updates the pull request, labels, and edits the status comment; or reports the rejection |

`c8y-ui-apply --help` lists the options. The same functions are exported for scripts: `parseResult`, `bundle`, `check`, `apply`, `checkPaths`, `listPlaybooks`, `resolvePlaybook`, `runPrompt`.

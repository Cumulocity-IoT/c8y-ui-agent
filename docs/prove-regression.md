# prove_regression

`prove_regression` decides whether e2e (Cypress) tests prove a change. It is the evidence level `regression` of the design: a repository test that fails on the base commit and passes with the change. Implementation: [`packages/workbench/src/regression.ts`](../packages/workbench/src/regression.ts) (runs) and [`evaluate.ts`](../packages/workbench/src/evaluate.ts) (rules).

## Runs

1. **Base and change.** The base is the commit without the change: the `base` argument, by default the merge base of `HEAD` and `origin/HEAD` (then `origin/main`, `origin/master`). The change is the working tree: `HEAD` plus uncommitted and untracked files.
2. **Test files and product files.** Every file that differs between the base and the working tree is a test file if it is under the e2e root (`--e2e-root`), otherwise a product file. With the e2e root at the repository root, test files are `cypress/` folders, `*.cy.*` specs, `cypress.config.*`, `cypress.env.json`, and the configured Cypress config file (`--e2e-config`). Untracked files under `dist/` or `.angular/` are build output (a preview writes them) and count as neither.
3. **No product change, no proof.** If every changed file is a test file, both sides would run the same code: the verdict is `not-proven` without a run.
4. **Two checkouts, built the same way.** Two git worktrees of the base commit outside the repository (git hooks off): the base with the change's test files copied in, the change with all changed files. Each gets a fresh install (`pnpm install --frozen-lockfile --prefer-offline`, or `npm ci`). Files that git ignores (`cypress.env.json`, `.env`, local fixtures) reach neither side, so they cannot make a test fail on one side only. The repository's checkout is not modified.
5. **Specs.** The `specs` argument, by default the changed spec files. Cypress runs only specs that match the `specPattern` of the Cypress config, so a new spec may need a config change, which is a test file too.
6. **Three runs** on the emulated tenant of the Cumulocity UI SDK (`runE2e`, `ng serve`), each with its own ports: the base and the first change run at the same time, then a second change run. The second change run is skipped when the first round decides: a run did not complete, or no test failed on the base in its own body.
7. **Results.** A Cypress reporter (`reporter/index.cjs`, set with `CYPRESS_REPORTER`, which overrides the reporter of the repository's Cypress config file) records each test: passed, failed in its body, failed in a hook, pending, or skipped, and the attempts. The emulator's gap report lists the requests it could not answer as a tenant would, with the tests that sent them.

One proof runs at a time per workbench. Cancelling it (MCP cancellation, SIGINT, SIGTERM, or the client disconnecting) stops the dev servers and Cypress, deregisters both worktrees at once (rename, `git worktree prune`) and deletes their files in a detached process, so that cleanup survives a client that kills the server seconds after disconnecting. Each proof writes its process id into its temp directory; a later proof removes the worktrees of proofs whose process is gone.

## Verdict

| Verdict | Meaning |
|---|---|
| `regression` | The tests fail on the base in their own body, pass in both change runs on the first attempt, and no unexpected emulator gap concerns a tested spec. |
| `observed` | The same outcomes, but an unexpected emulator gap concerns a tested spec, so the gap may explain them. The change is observed, not proven. |
| `not-proven` | The tests do not show the change: see `reasons`. |
| `inconclusive` | A run did not complete: a side does not build, installation failed, or Cypress reported no tests. |

Rules, each with a reason in the result:

- A test proves the change only if it **fails on the base in its own body** and **passes in every change run on the first attempt**. A failure in any hook, including the test's own `beforeEach` and `afterEach` (Cypress reports them as hook failures), proves nothing, nor does a test that a failed hook skipped.
- A test that **passes on the base** proves nothing.
- **Every test of the specs must pass in every change run.** A test that fails in one change run and passes in the other, or passes only on a retry, is flaky.
- **Every spec must report tests in every change run**, and Cypress' exit code (its count of failures) must not exceed the failed tests: a spec that does not load reports no tests but counts as a failure.
- With `tests`, **every named test** must prove the change; without, at least one test of the specs must.
- A **gap concerns a tested spec** when the gap report attributes it to any test or hook of the spec (`<spec> › …`), or to no test at all. The attribution needs the Cypress support hooks of `@cumulocity-iot/ui-sdk/cypress` from SDK 2.3; repositories on older versions get `observed` whenever the emulator misses a request.
- **Expected gaps** (`expected: true`: requests a fresh tenant answers with 404 too) are ignored.

## Test names

Tests are named `<spec> › <suite> › … › <test>`, with the spec relative to the e2e root, as the gap report names them: `cypress/e2e/favorites-manager-plugin.cy.ts › Favorites Manager › shows the empty state`.

## Limits

- Build failures are recognized from the dev server's output (`Failed to compile`, `Application bundle generation failed`, `✘ [ERROR]`, `ERROR in`) until the app is served. An unrecognized failure ends after the SDK's 5-minute wait for the app.
- The lockfile at the repository root is a product file. A change to the e2e root's dependencies (`test/package.json`) therefore fails the base's frozen install: `inconclusive`.
- A repository whose `setupNodeEvents` sets its own reporter overrides `CYPRESS_REPORTER`: Cypress reports no tests to the workbench, and the verdict is `inconclusive`.
- Both sides use the same world file and the change's context path. A change to either is not part of the comparison.
- Files that git ignores are missing on both sides, for the build too: a test that needs a local `cypress.env.json` fails on both sides, and an app that needs an ignored generated file does not build (`inconclusive`).
- "No product change" means no changed file outside the tests. A change that only touches files the build does not use (a README, untracked junk that is not ignored) runs the same code on both sides; such a proof only passes if a test fails on the base by chance, which the second change run makes unlikely but does not rule out.
- Submodules are not supported: a changed submodule gives `inconclusive`.

## Security

The workbench runs the repository's code: installs (with their lifecycle scripts), the dev server, and Cypress. Child processes inherit the workbench's environment. Run it only where that code may run, as the agent's own shell commands do: in the agent job, which holds no write credentials (D2).

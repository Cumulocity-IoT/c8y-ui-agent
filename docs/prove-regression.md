# prove_regression

`prove_regression` decides whether e2e (Cypress) tests prove a change. It is the evidence level `regression` of the design: a repository test that fails on the base commit and passes with the change. Implementation: [`packages/workbench/src/regression.ts`](../packages/workbench/src/regression.ts) (runs) and [`evaluate.ts`](../packages/workbench/src/evaluate.ts) (rules).

## Runs

1. **Base and change.** The base is the commit without the change: the `base` argument, by default the merge base of `HEAD` and `origin/HEAD` (then `origin/main`, `origin/master`). The change is the working tree: `HEAD` plus uncommitted and untracked files.
2. **Test files and product files.** Every file that differs between the base and the working tree is a test file if it is under the e2e root (`--e2e-root`), otherwise a product file. With the e2e root at the repository root, test files are `cypress/` folders and `*.cy.*` specs.
3. **Base checkout.** A git worktree of the base commit outside the repository, with the change's test files copied in (deleted ones removed), and its dependencies installed (`pnpm install --frozen-lockfile --prefer-offline`, or `npm ci`). The repository's checkout is not modified.
4. **Specs.** The `specs` argument, by default the changed spec files. Cypress runs only specs that match the `specPattern` of the Cypress config, so a new spec may need a config change, which is a test file too.
5. **Three runs** on the emulated tenant of the Cumulocity UI SDK (`runE2e`, `ng serve`), each with its own ports: the base and the first change run at the same time, then a second change run. The second change run is skipped when the first round decides: a run did not complete, or no test failed on the base in its own body.
6. **Results.** A Cypress reporter (`reporter/index.cjs`, set with `CYPRESS_REPORTER`, which overrides the repository's reporter) records each test: passed, failed in its body, failed in a hook, pending, or skipped, and the attempts. The emulator's gap report lists the requests it could not answer as a tenant would, with the tests that sent them.

## Verdict

| Verdict | Meaning |
|---|---|
| `regression` | The tests fail on the base in their own body, pass in both change runs on the first attempt, and no unexpected emulator gap touches the proving tests. |
| `observed` | The same outcomes, but an unexpected emulator gap touches a proving test, so the gap may explain them. The change is observed, not proven. |
| `not-proven` | The tests do not show the change: see `reasons`. |
| `inconclusive` | A run did not complete: the base or the change does not build, installation failed, or Cypress reported no tests. |

Rules, each with a reason in the result:

- A test proves the change only if it **fails on the base in its own body** (with its `beforeEach` and `afterEach` hooks, as the gap report counts them) and **passes in every change run on the first attempt**. A failure in a `before all` hook, or a test skipped after one, proves nothing.
- A test that **passes on the base** proves nothing.
- **Every test of the specs must pass in every change run.** A test that fails in one change run and passes in the other, or passes only on a retry, is flaky.
- With `tests`, **every named test** must prove the change; without, at least one test of the specs must.
- A **gap touches a test** when the gap report attributes it to the test, to what follows the test (`<test> › after`), or to its spec's `before all` hooks. A gap without attribution touches every test. The attribution needs the Cypress support hooks of `@cumulocity-iot/ui-sdk/cypress` from SDK 2.3; repositories on older versions get `observed` whenever the emulator misses a request.
- **Expected gaps** (`expected: true`: requests a fresh tenant answers with 404 too) are ignored.

## Test names

Tests are named `<spec> › <suite> › … › <test>`, with the spec relative to the e2e root, as the gap report names them: `cypress/e2e/favorites-manager-plugin.cy.ts › Favorites Manager › shows the empty state`.

## Limits

- Build failures are recognized from the dev server's output (`Failed to compile`, `Application bundle generation failed`, `✘ [ERROR]`, `ERROR in`). An unrecognized failure ends after the SDK's 5-minute wait for the app.
- A change to the e2e root's dependencies (`test/package.json`) without a lockfile change at the repository root fails the base installation: `inconclusive`.
- The base uses the change's world file: data changes are not part of the comparison.

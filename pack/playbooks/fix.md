---
description: Fix a reported bug with a regression test that fails on the base commit and passes with the fix, and open a pull request.
evidence: regression
result: pull-request
---
Outcomes: `pull-request`, `comment` (no fix: information missing, or the bug does not reproduce), or `failed`.

1. **Triage.** Find the affected app and the expected and actual behavior. If the issue does not say enough to reproduce it, stop with outcome `comment`: list exactly what is missing, and add `agent:needs-info`.
2. **Reproduce** on the emulator: a preview and screenshots, or, if the preview does not build, a Cypress spec through `check`. If it does not reproduce, stop with outcome `comment`: say what you ran and what you saw, and ask for the missing detail. A gap is an emulator limit, not a reproduction: report it.
3. **Acceptance criteria.** Write the behavior the fix must have as a short list of checkable statements, from the issue.
4. **Develop.** Brief `c8y-ui-agent:developer`: the issue in your words, the app, how to reproduce, the acceptance criteria, and the e2e spec to extend (from the app's existing specs under the e2e root). It writes the regression test first and confirms with `check` that it fails on the reported behavior; then fixes the product code, runs `check`, lint, and the app's unit tests, and commits.
5. **Prove.** Run `prove_regression` for the app with the specs the developer changed. Only the verdict `regression` proves the fix. `observed` (an unexpected emulator gap) or `not-proven` sends the verdict's reasons to the developer for the next round.
6. **Verify.** After the verdict `regression`, brief `c8y-ui-agent:verifier` with the base commit, the acceptance criteria, and the verdict with its counts. Its findings go to the developer for the next round; then prove again.
7. **Rounds.** Steps 4 to 6 are one round; run at most the task's rounds. Stop early when a round's findings repeat the previous round's.
8. **Result.** Outcome `pull-request` when the developer committed a fix:
   - Title: `fix(<app>): <summary> (#<number>)`.
   - Body: the cause; the change; a table that maps each acceptance criterion to the test that proves it; the `prove_regression` verdict with its counts; the verifier's open findings, if any; each changed or removed existing assertion, with the reason; `Closes #<number>`.
   - Labels: `agent:done`.
   - Without the verdict `regression`, or with open verifier findings: a draft (`"draft": true`), the label `agent:not-runtime-verified` when the proof is missing, and the body says which evidence is missing and why.

   Outcome `failed` when no round produced a commit that passes `check`: the summary says what was tried and where it stopped.

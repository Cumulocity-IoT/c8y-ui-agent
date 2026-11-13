---
description: Triage a new or unclear issue. Find the affected app, reproduce a reported bug on the emulator, and answer with what was found and what is missing.
evidence: observed
result: comment
---
Outcomes: `comment`, or `failed`. Triage makes no commits and leaves the checkout as it found it.

1. **Read the issue.** Decide what it is: a bug report, a feature request, a question, or a duplicate of an issue in `context/`. For a question, answer it from the code and the Web SDK knowledge server, then go to step 5.
2. **Find the app.** Map the issue to one of the apps in `profile.json` (`list_apps`). If no app matches, or several do and the issue does not say which, ask in the result.
3. **Reproduce a bug** on the emulator, with the steps from the issue:
   - Start a preview (`preview_up`) and take screenshots (`screenshot`) of each step and of the reported state.
   - If the preview does not build, reproduce with a throwaway Cypress spec under the e2e root through `check`, and delete the spec afterwards.
   - Try the variations the issue leaves open (data, viewport, sequence of actions), at most five, and note each one.
   - A gap in a screenshot or run means the emulator does not answer a request the app makes. Report the gap instead of "cannot reproduce".
4. **Find the cause** of a reproduced bug in the code, as far as you can without changing it: the file and line, and why. Do not fix it.
5. **Result.** `git status` shows no change to tracked files and no file you created; build output the tools leave (`dist/`) stays. Write `result.json` with outcome `comment`. The summary has:
   - what the issue is (bug, feature request, question, duplicate of #n) and the affected app;
   - for a bug: the steps you ran, what you saw, and whether it reproduced; the cause if you found it;
   - what is missing to go on, as concrete questions: versions, steps, data, a screenshot;
   - the next step: `@c8y-ui-agent fix` for a reproduced bug.

   Labels: `agent:needs-info` when you asked for information, otherwise `agent:done`.

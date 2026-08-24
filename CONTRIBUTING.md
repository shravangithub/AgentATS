# Contributing to AgentATS

Thanks for wanting to help — recruiters and engineers alike are welcome here.

## Ways to contribute

- **Report bugs** — open an issue with what you did, what you expected, and what happened. Screenshots of the Executions log help a lot.
- **Suggest features** — real recruiting pain points are the best input. Describe the workflow, not just the button.
- **Improve the rubric** — better role archetypes, company modifiers, or category weights in `TalentRubric.gs` benefit everyone.
- **Docs & translations** — clearer setup steps or non-English guides are hugely valuable to this community.
- **Code** — fork, branch, and open a pull request. Keep changes focused; explain the "why" in the PR description.

## Ground rules

1. **Never commit secrets or personal data.** No API keys, webhook secrets, spreadsheet/folder IDs, deployment URLs, or real candidate information — in code, examples, screenshots, or tests. Property *names* only.
2. Keep the core Google-only: no new required external services. Optional integrations are fine as clearly separated, opt-in modules.
3. Match the existing style: plain Apps Script (V8), server-side authorization on every entry point, sanitize everything written to the sheet.
4. Test with a fresh `firstRun()` install before submitting — a change that breaks first-time setup breaks everyone.

## Getting help

Open a GitHub issue — there are no bad questions, especially from non-developers. This project exists for the HR/TA community; if the docs confused you, that's a bug too.

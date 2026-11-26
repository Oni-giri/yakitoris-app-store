# Evaluating this skill

`evals.json` holds scenarios built from real failures in this store. Each one lists the behaviours a correct run must show.

## How to run an evaluation

1. Start a **fresh** agent session in a scratch clone of the store repository. Use a clone so the agent's edits never touch `master`.
2. Load the skill and give the session the scenario's `query`, word for word.
3. Grade the transcript and the resulting diff against `expected_behavior`. Score each item as met or not met.
4. Run the same query **without** the skill to get a baseline. The skill earns its place only where it beats the baseline.

## Using the results

- Run each scenario on every model that will use the skill. A smaller model may need more explicit steps, and a larger model may find some steps redundant.
- When an item fails, decide where the guidance belongs:
  - A short rule goes in SKILL.md.
  - Detail goes in the relevant `reference/` file.
  - Anything that can be checked mechanically goes in `scripts/check-app.mjs`.
- When a new incident happens in the store, add a scenario for it, and add a line to `reference/pitfalls.md`.

## Testing the checker itself

`scripts/check-app.mjs` has no unit tests. Before changing it, run `scripts/check.sh --all`, save the output, and compare it with a run after your change. Every new or removed finding should be one you intended.

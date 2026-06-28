# Test integrity

Applies to every test under this directory.

- **Assert requirements, not implementation.** Expected values come from the business rule or user-visible behavior, not from re-deriving production logic inside the test.
- **Never modify a failing test just to make it pass.** Read the requirement, inspect the code and recent history, then decide whether the test or the implementation is wrong. Explain the decision.
- **Use realistic domain data.** Prefer real-shaped ids, names, and values over `"x"` or `"a@b.c"`.
- **Each test runs in isolation.** No shared mutable state across tests unless it's a documented fixture with safe setup/teardown.
- **Do not paper over failures.** No new skip, xfail, broad try/except, empty assertions, or widened matchers to quiet a red test.

## Tidy-first

Before a behavior-affecting change to code with no useful existing tests, add characterization coverage first when practical:

1. Pin the behavior you will **not** change.
2. Then make the behavior change and add tests for the new behavior.
3. If the split is risky or large, suggest separate PRs.

Skip the split for comment / rename / format-only changes, deletion of clearly dead code, or work explicitly marked throwaway.

## This repo

Tests exercise the pure core (`../src/graph.ts`) through plain `NoteLike` data — no Obsidian runtime. Build fixtures with `mk()` from `fixtures.ts`. TDD the core: write the test, watch it fail, then implement.

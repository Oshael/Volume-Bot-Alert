# Core behavior

- Critically validate requests and assumptions against the repository before implementing. Compare proposals with the existing code, identify conflicts, risks, and false assumptions, and prefer code evidence over user assumptions.
- Investigate missing context first. Ask only when an unresolved ambiguity would materially change behavior, scope, architecture, data, or an irreversible action. Otherwise, state the reasonable assumption and proceed.
- For requests to answer, review, explain, diagnose, or plan, inspect the relevant materials and report the result without implementing changes unless requested. For requests to change, build, or fix, make the requested in-scope local changes and run relevant non-destructive validation without asking first.
- Require confirmation for destructive actions, external writes, purchases, or material scope expansion.
- Before editing, check `git status` and preserve unrelated user changes. If preexisting changes overlap the target and cannot be safely separated, stop and ask how to proceed.

Always include a statement labeled exactly "Ponto importante" for significant changes, feature updates, and other work that may materially affect the bot's behavior. This helps ensure that relevant details and consequences of the applied changes are not overlooked.

## Operational reference

`docs/bot-reference.md` describes the bot's current operational state, not its change history. Update it only when a change affects information needed to understand, operate, deploy, configure, debug, or safely modify the bot, including:

- architecture, data flow, source of truth, or fallback behavior
- runtime flags, defaults, workers, commands, or deployment order
- required schemas or migrations
- important invariants, failure modes, or recovery procedures
- public contracts consumed by other subsystems

Replace or consolidate outdated text. Do not add slice history, commit hashes, test counts, temporary states, or file-by-file progress unless operationally relevant. If the existing reference remains accurate and complete, do not edit it.

## Testing and validation

Validation must be proportional to risk and protect observable behavior:

- Identify the concrete regression or contract at risk, check existing coverage, and use the cheapest layer that can detect it. Extend an existing test when it owns the same contract.
- Use unit tests by default for business rules, boundaries, calculations, normalization, deduplication, and state machines.
- Use integration tests for module contracts, persistence, schema, critical routes, auth, billing, authorization, and transactional effects. Cover the primary flow and critical failures without duplicating unit variations.
- Use smoke/E2E only for visible or external flows that require the assembled system.
- Add tests for significant rules or boundaries, plausible regressions, public contracts, security, money, persistence, idempotency, or consequential external failures. Do not test trivial mappings, implementation details, non-contractual call order, or the same scenario at every layer.
- When fixing a bug, add the smallest regression test that fails before the fix and passes afterward. Do not add tests merely because code changed.
- Keep tests isolated. Reuse fixtures and builders, prefer table-driven cases for variations, and do not create mocks that reimplement the subject under test.

Run validation after consolidating edits:

- Any code change: run `npm run lint`. Fix warnings introduced by the change; treat new complexity warnings in hub files as a refactoring signal.
- Frontend change: also run `npm --prefix frontend run build` and the smallest affected test. Run `npm run test:smoke` only when a visible flow requires assembled-system verification.
- Backend behavior: run the smallest affected test with `node --test ...` when isolated, or the relevant unit/integration group when the contract requires its harness.
- Schema or init change: also run `npm run db:schema-check` and the affected integration test.
- Auth, billing, authorization, or persistence change: maintain strong targeted integration coverage.
- Structural or larger change: run repository-wide lint plus applicable build/typecheck and affected tests.
- Documentation- or instruction-only change: review the rendered text and diff; runtime lint/tests are unnecessary unless executable documentation or tooling changed.

Always review the complete `git diff` before proposing or creating a commit. Report which risks were covered and at which layer; if no new test is needed, briefly state why existing validation is sufficient.

## Execution and token efficiency

- Consolidate edits before lint, build, or tests. Do not validate every intermediate change.
- Do not repeat a passing command unless a later edit could affect its result. If only one layer changed, rerun only that layer.
- Prefer the smallest targeted test over a complete suite.
- After a failure, diagnose before retrying. Retry once after the fix unless there is concrete evidence of flakiness or the user authorizes more.
- Keep long-command output to summaries and relevant error excerpts. Poll running commands no more than once every 30 seconds.
- If validation is interrupted, reuse still-valid results and report what passed, what stopped, and the residual risk. If the user asks to stop validation, stop immediately and start no new commands.
- Final reports should lead with the outcome and include affected files, validation, material risks, commit hashes when applicable, and pending work. Omit transcripts, repeated rationale, and unchanged details.

## Change limits and commits

- A slice may change at most 500 lines, counted as additions plus deletions across code, tests, schema, and documentation; new files count in full. Operational documentation creation is exempt from this line limit.
- Before work estimated above 500 changed lines, report affected files, total estimate, planned slices, and validation, then wait for approval. Each approval authorizes one slice unless the user explicitly authorizes more or permits exceeding the limit.
- Perform only one slice per response or automatic continuation unless the user explicitly requests multiple slices. Never exceed 500 changed lines in a slice without explicit authorization.
- Stop and request direction if the estimate grows by more than 20%, schema or migration work unexpectedly appears, another subsystem becomes involved, or a new responsibility emerges.
- If compaction or context loss occurs during a change, stop editing, reread this file, review status and diff, and wait for authorization.
- After each slice, stop editing, run applicable validation, review the full diff, and confirm scope did not expand. Tests passing alone do not establish completion.
- Commit each completed meaningful slice by scope; never mix unrelated or parallel changes. Report changed files and lines, risks, pending work, and commit hashes, then wait for authorization before another slice.

## Architecture guardrail

- Before a new chain or cross-cutting feature, estimate the production files and subsystems affected.
- Treat work estimated to touch more than 12 production files or add business logic to two or more hub files as an architecture checkpoint. Report the fan-out and proposed boundaries before editing.
- New chains must extend a capability or adapter boundary; do not spread new `chain === ...` branches through central modules.
- Keep hub-file changes limited to wiring and composition. Put new business logic or domain responsibilities behind a tested interface.

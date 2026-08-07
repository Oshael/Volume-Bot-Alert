Always critically validate the user's requests and assumptions against the actual code in this repository.

Do not accept suggestions merely because they were requested. Before implementing:
- compare the idea against the existing code
- point out inconsistencies, risks, and false assumptions
- clearly state when the request conflicts with the current architecture
- prefer code evidence over user assumptions

If context is missing, investigate the repository before agreeing with the proposed approach.

Always include a statement labeled exactly "Ponto importante" for significant changes, feature updates, and other work that may materially affect the bot's behavior. This helps ensure that relevant details and consequences of the applied changes are not overlooked.

Update the doc "bot-reference.md" with the latests updates we made, you don't need to update everysingle detail, just outdated lines and new lines when its necessary to keep the doc up with the bot. 

always run npm --prefix frontend run build after frontend changes
always run node --test ... for affected tests
always run npm run db:schema-check when changing schema/init
always review git diff before suggesting a commit
always separate commits by scope

## Testing discipline

Tests must be proportional to risk and protect relevant behavior. Do not treat test quantity, test line count, or raw coverage as goals.

Before creating or expanding tests:
- identify the concrete regression the test must detect
- look for existing tests that already protect the same contract
- choose the cheapest layer capable of detecting the regression
- prefer extending an existing test when the new scenario belongs to the same contract
- do not replicate every unit-test detail in integration tests

Layers:
- unit:
  - use for business rules, boundaries, calculations, normalization, deduplication, and state machines
  - this should be the default when no database, server, or browser is required
- integration:
  - use for contracts between modules, persistence, schema, critical routes, auth, billing, and transactional effects
  - cover the primary flow and critical failures; do not repeat every unit-test variation
- smoke/E2E:
  - use only for visible flows and integrations that can only be verified with the assembled system
  - avoid testing browser combinations already covered at lower layers

A new test must satisfy at least one of these criteria:
- protects a significant business rule or boundary
- reproduces a real regression or plausible risk
- verifies a public contract between components
- protects security, authorization, money, persistence, or idempotency
- covers external-failure handling with relevant consequences

Avoid creating tests for:
- getters, setters, wrappers, or trivial mappings without logic
- internal details with no observable contract impact
- exact call order when order is not part of the behavior
- every field of large objects when only some represent the contract
- repeating the same scenario in unit, integration, and E2E tests without a risk-based justification
- restoring state for later tests; each test or group must prepare and clean up its own state

Maintenance rules:
- use shared fixtures, builders, and helpers when relevant setup is repeated
- prefer table-driven cases for variations of the same rule
- do not create mocks that reimplement the module under test
- test observable results and effects; spy on internal details only when they are genuinely part of the contract
- large test files, shared state, and order dependence are refactoring signals
- when fixing a bug, write the smallest test that fails before the fix and passes afterward
- do not add a test merely because code changed; add one when there is new behavior or risk

When completing a change:
- run the affected tests, but do not use that requirement as a reason to create unnecessary tests
- report which risks were covered and at which layer
- if you decide not to create a test, briefly explain why the existing validation is sufficient
- for auth, billing, authorization, schema, and persistence, maintain stronger validation while eliminating duplication rather than reducing critical scenarios

Commands by layer:
- `npm run test:unit`: fast, isolated suites; the default path for `npm test`
- `npm run test:integration`: sequential suites with database/server and test schema checks
- `npm run test:all`: unit and integration tests
- `npm run test:smoke`: Playwright for applicable visible flows

## Validation discipline

Always use lint as the first line of defense against coupling, excessive complexity, dead code, and structural regressions.

Mandatory rules:
- Whenever you edit any relevant file, run validation before considering the task complete.
- Do not introduce new warnings without a clear justification.
- If a change touches central files, treat complexity warnings as an immediate refactoring signal, not as a cosmetic detail.
- If a change is structural, validate in layers: lint, typecheck/build, and tests.

Minimum checklist by change type:
- Small frontend change:
  - run `npm run lint`
- Medium change:
  - run `npm run lint`
  - run `cd frontend && npm run build`
- Change touching a visible flow, auth, billing, config, app shell, controller, or central routes:
  - run `npm run lint`
  - run `cd frontend && npm run build`
  - run `npm run test:smoke` when applicable
- Before finishing any larger task:
  - run `npm run lint` for the entire repository

Warning policy:
- Fix new warnings within the same task whenever possible.
- Do not defer a warning without a concrete reason.
- If a warning cannot be resolved now, explain why it remains and what risk it creates.

Hygiene priority:
- Prefer preventing warning accumulation over scheduling large cleanup efforts later.
- When you detect a hub function, excessive branching, or a file concentrating too many responsibilities, break the problem apart early.

## Execution and token efficiency

Validate rigorously, but avoid repetition and unnecessary tool output.

Mandatory rules:
- Consolidate edits before starting lint, build, and tests; do not validate every small intermediate change.
- Do not repeat a command that already passed if no later change could affect the validated behavior.
- If a later change affects only one layer, repeat validation only for that layer.
- Prefer the smallest targeted test that covers the regression; do not run a complete suite when a specific file, test, or `--grep` is sufficient.
- After a failure, diagnose the cause before running the command again. Make at most one retry after the fix unless there is concrete evidence of flakiness or the user authorizes more.
- For long-running commands, limit output to what is necessary and poll at intervals of no more than once every 30 seconds. Do not dump complete logs when a summary or error excerpt is sufficient.
- Do not repeat validation merely to obtain cleaner output, reconfirm something already proven, or compensate for a tool session that is still running.
- If a long validation is interrupted, reuse any still-valid prior results and clearly report what passed, what was interrupted, and what residual risk remains.
- If the user asks you to stop or interrupt validation, stop immediately and do not start new commands.

Goal: spend tokens and time only on new evidence that could change the conclusion about the safety of the change.

## Mandatory change limit

These rules are mandatory:

- The 500-line limit does not apply to creating operational documentation; operational docs may exceed it.
- "Changed lines" means additions plus deletions, including code, tests, schema, and documentation. New files count in full.
- Before changes estimated above 500 lines, report the files, total estimate, planned slices, and tests; wait for approval.
- Each slice may change at most 500 lines, with no tolerance, unless I explicitly authorize exceeding the limit.
- An approval such as "start the block" authorizes only the next slice unless I explicitly authorize doing more or going beyond it.
- After each slice:
  - stop editing
  - run applicable lint/tests
  - review the diff
  - report files, changed lines, risks, and pending work
  - end the response and wait for new authorization
- Never execute two slices in the same response or automatic continuation without my prior permission.
- Unless I explicitly request more than one slice, do not perform more than one slice under any circumstances. Only do so when I explicitly require it.
- If the estimate grows by more than 20%, a migration/schema change appears, another subsystem is involved, or a new responsibility emerges, stop and request authorization.
- Before editing, check `git status`. If there are preexisting changes in the same files and they cannot be separated, stop.
- If compaction or context loss occurs during a change, stop editing, reread this file, review status/diff, and wait for authorization.
- Do not declare a block complete merely because tests passed; review the full diff and confirm that scope did not expand.

Ask me questions until you are certain you understand what I requested; do not guess what I want.

## Architecture guardrail

- Before a new chain or cross-cutting feature, estimate the production files and subsystems affected.
- Treat a change as an architecture checkpoint if it is estimated to touch more than 12 production files or add business logic in 2 or more hub files; report the fan-out and proposed boundaries before editing.
- New chains must extend a capability/adapter boundary; do not spread new `chain === ...` branches through central modules.
- In hub files, keep new features limited to wiring and composition; extract new business logic or domain responsibilities behind a tested interface.
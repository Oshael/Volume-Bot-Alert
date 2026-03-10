# V68 Validation Tracker

## Purpose
Track what is already validated for the integrated `volume-alert-botV68.html` migration and what still needs manual regression testing.

Status legend:
- `validated` = behavior already confirmed in real use
- `code-reviewed` = behavior appears preserved in code, but still needs browser validation
- `pending-manual` = no reliable validation yet
- `open` = known issue still being worked

## Current Status

### Integration / account sync
- Login and authenticated session flow: `validated`
- Config persistence per account: `validated`
- Manual token persistence per account: `validated`
- Bootstrap baseline persists across reload after cold-start import: `validated`
- Same-account reload stability for configs/manual tokens: `validated`
- `logout-all` revoking all sessions: `validated`
- Vercel/Railway API resolution model: `validated`
- Cold-start bootstrap seed via backend: `validated`

### PumpFun
- Backend socket connection for PumpFun stream: `validated`
- PumpFun live rows rendering in V68 integrated flow: `validated`
- PumpFun volume accumulation resilient to late SOL/USD initialization: `code-reviewed`
- PumpFun GC unsubscribe path in server-stream mode: `code-reviewed`
- PumpFun migration toast / migration event path: `validated`
- First migration calibration logic: `validated`

### Token routing / bar exclusivity
- Manual tokens excluded from old-token bars: `validated`
- Old Tokens and Old Week bars mutually exclusive: `validated`
- `enforceBarExclusion()` cleanup pass present: `validated`
- Recent/old-token exclusivity as intended by V68 UX: `validated`
- Recent -> Old Week auto-migration at 7 days: `validated`
- Dismissed old-token items do not re-enter incorrectly: `validated`
- Dismissed old-week items do not re-enter incorrectly: `validated`

### Monitoring and filters
- `_userManual` protects against `min-mcap-remove`: `code-reviewed`
- `tok.manual` is not used as MCAP-remove protection: `code-reviewed`
- Zero-MCAP does not trigger false old-bar removals: `code-reviewed`
- Immediate old-token MCAP filter apply: `code-reviewed`
- Immediate old-week MCAP filter apply: `code-reviewed`

### Alerts
- Old-token surge one-shot behavior via `oldAlertFired`: `code-reviewed`
- HVNC and Pump HVNC flags remain separated: `code-reviewed`
- Shared cooldown between standard `VOL` and `MCAP` alerts: `validated`
- Pump alert one-shot semantics per session: `code-reviewed`
- Rule that blocks alert when MCAP behavior invalidates the volume signal: `validated`
- Alert identity/actions preserved on rendered cards: `pending-manual`

- Trading terminal dropdown edge-aware direction: `validated`
- Padre terminal link priority (`pairAddress -> mintAddress -> addr`): `validated`

### Persistence semantics still needing explicit check in V68 integrated flow
- Starred tokens: `validated`
- Dismissed sets after account reload: `validated`
- Removal logs after account reload: `validated`
- Sound persistence and per-account expectations: `validated` (local-only by design for audio files)
- Axiom terminal link priority (`pairAddress -> mintAddress -> addr`): `validated`
- Padre terminal link priority (`pairAddress -> mintAddress -> addr`): `validated`

## Evidence From Code Review

The following behavior hooks are present in `volume-alert-botV68.html`:
- old/old-week mutual exclusion in `addOldToken()` and `addOldWeekToken()`
- manual-token exclusion from age bars via `_userManual`
- global cleanup via `enforceBarExclusion()`
- dismissed sets for both old bars
- old-token alert gating via `oldAlertFired`
- migration rolling calibration via `pumpState.migrationCount` and `pumpState.recentMigrationMcaps`
- user-scoped reload path via `reloadUserScopedClientState()`
- backend sync via `syncConfigsToServer()` and `syncManualTokensToServer()`

## Next Manual Regression Batch

1. Verify age-bar exclusivity under live data.
2. Verify dismissed tokens do not re-enter old bars incorrectly.
3. Verify the alert rule where volume rises but MCAP falls does not beep incorrectly.
4. Verify first migration of the session calibrates bond target as intended.
5. Sweep remaining fine-grained behavior from CLAUDE_HTML_PURO_.md that has not been exercised manually yet.
6. Start the backend-first token catalog/history phase.

## Working Rule

Whenever a new V68 behavior is confirmed or disproved during testing, update this tracker and, if needed, the behavior contract in:
- [v68-behavior-contract.md](/C:/Users/ezequ/Downloads/Volume-Alert-Server/docs/v68-behavior-contract.md)

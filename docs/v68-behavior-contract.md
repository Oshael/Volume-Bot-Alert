# V68 Behavior Contract

## Goal
Define the behavior rules that the `volume-alert-botV68.html` migration must preserve.

This document is not about wiring/auth/deploy only. It is the behavior contract for the bot itself.

Use this together with:
- [v68-migration-checklist.md](/C:/Users/ezequ/Downloads/Volume-Alert-Server/docs/v68-migration-checklist.md)
- [CLAUDE_HTML_PURO_.md](/C:/Users/ezequ/Downloads/Volume-Alert-Server/CLAUDE_HTML_PURO_.md)
- [CLAUDE.md](/C:/Users/ezequ/Downloads/Volume-Alert-Server/CLAUDE.md)

## Contract Scope

This contract covers:
- token routing between bars/panels
- alert firing rules
- PumpFun behavior
- removal/retention rules
- migration calibration rules
- persistence semantics
- visual ordering rules that affect logic

This contract does not define:
- backend deployment topology
- auth API implementation details
- future backendization of all bot logic

## Core Principle

The V68 migration is only acceptable if the new frontend preserves both:
- production integration fixes already validated in the current integrated frontend
- V68 bot behavior rules that were added over time in the pure HTML version

If a feature appears visually correct but violates one of the rules below, the migration is not done.

## 1. Token Routing And Bar Exclusivity

### 1.1 Manual tokens
- Tokens manually added by CA must appear in `Manual Tokens`.
- Manual tokens must keep `_userManual = true`.
- Manual tokens must remain protected from the `min-mcap-remove` sweep.
- Removing a token from `Manual Tokens` clears manual protection but does not automatically remove it from `Monitored`.

### 1.2 Recent / old-token bars
- A token must not appear in multiple age/category bars at the same time when the intended routing says it belongs to only one.
- In particular, tokens shown in the newer `Recent Tokens` logic must not simultaneously duplicate into `Old Tokens` if the V68 routing treats those buckets as mutually exclusive.
- Recent tokens that age past 7 days must leave `Recent Tokens` and move into `Old Tokens 1 Week+`, respecting the destination MCAP range.
- Manual tokens must not be silently reclassified into old-token bars just because they also satisfy age/MCAP conditions.
- Old-token dismissed sets must continue to prevent automatic re-entry into their bar.

### 1.3 PumpFun isolation
- Removing a token from the PumpFun panel with `X` removes it from the panel only.
- That action must not globally block the token.
- The token may reappear if new trades arrive.

### 1.4 Blocklist behavior
- `Block` removes the token from:
  - `Monitored`
  - `PumpFun`
  - alerts
- Blocklist state must stay consistent with the current integrated backend sync model.

## 2. Monitoring And Removal Rules

### 2.1 Monitored tokens
- Polling-based monitored tokens must compare current `vol5m` against the previous cycle.
- Tokens with no volume for the configured dead-cycle count may be removed, except when protected by the correct manual rule.
- `tok.manual` and `tok._userManual` must remain semantically distinct.

### 2.2 MCAP removal filter
- `min-mcap-remove` removes tokens below the configured MCAP floor.
- Only `_userManual` protects against this filter.
- `tok.manual` alone must never protect against this filter.

### 2.3 Zero-MCAP safety
- A token must not be auto-removed from old-token bars just because MCAP is temporarily `0` or missing for that cycle.
- Removal should only happen when MCAP is confirmed and actually outside the configured range.

## 3. Alert Rules

### 3.1 Volume alert safety
- A volume increase alone is not sufficient when other protection rules say the token should not alert.
- If the rule set says a token should not alert because market cap fell while volume rose, that protection must be preserved.
- Migration is not complete until this exact condition is verified in the V68-integrated frontend.

### 3.2 Old-token surge alerts
- Old-token surge alerts must keep using price change rules, not volume-only logic.
- The same token should alert only once per session for the old-surge condition.

### 3.3 PumpFun alerts
- PumpFun alert thresholds must use the Pump panel configuration.
- Per-token session throttling or one-shot semantics must remain intact.
- HVNC and Pump alerts must not double-fire due to shared or mixed flags.

### 3.4 Alert identity
- Alert cards must keep token identity/actions intact:
  - Dex link
  - Copy CA
  - Block
- Alert rendering must not lose behavior-specific badges or classification.

## 4. PumpFun Contract

### 4.1 Connection behavior
- `Connect` in V68 must attach to the backend socket stream, not depend on a direct PumpFun browser websocket in production mode.
- The panel must receive:
  - `pump:newToken`
  - `pump:trade`
  - `pump:migrate`

### 4.2 Entry gating
- PumpFun rows must only become visible once the token satisfies the configured entry threshold.
- Entry threshold behavior must match V68 expectations.

### 4.3 Trade accumulation
- `vol5m` must be accumulated on a sliding 5-minute window.
- Race conditions around SOL/USD initialization must not permanently zero out early trades.
- Total volume and visible `vol5m` must remain logically consistent.

### 4.4 Migration detection
- The migration flow must preserve the V68 logic around the first real migration and the rolling calibration behavior.
- The first confirmed migration in a session is special and must continue to seed the bond target calibration logic correctly.
- Migration toasts must not double-fire for the same token.

### 4.5 Garbage collection
- Inactive PumpFun tokens must still be removable by the configured inactivity/low-MCAP rules.
- GC removal must also unsubscribe the token from server-side trade tracking.

## 5. Old/Recent Token Bar Rules

### 5.1 Ordering
- Bar ordering rules are part of behavior, not just cosmetics.
- If V68 sorts a bar by 24H volume descending, that ordering must remain.
- Pagination limits are part of behavior when they affect what is visible at once.

### 5.2 Filters
- MCAP min/max filters for old/recent bars must apply immediately when changed.
- Filtering existing bar items in-place is part of expected behavior.

### 5.3 Dismissal persistence
- Manually dismissed tokens must not silently come back into the same bar in the same semantic category.
- Dismissed state must survive according to the current persistence model.

## 6. Persistence Contract

### 6.1 Per-account persistence
- Configs must persist per authenticated account.
- Manual tokens must persist per authenticated account.
- Different accounts using the same browser must not inherit each other's synced state.

### 6.2 Browser-local feature persistence
- Any feature intentionally still local at this phase must remain scoped correctly.
- Current examples that require explicit validation during migration:
  - starred tokens
  - dismissed sets
  - removal logs
  - sound selections

### 6.3 Reload stability
- `F5` must not randomly drop manual tokens.
- `F5` must not revert valid saved config changes.
- Reload must restore the same logical view for the same account, modulo live market changes.

## 7. UI-State Rules That Affect Logic

These are not mere visuals. They encode user expectations and workflow:

- Status labels must reflect actual bot state.
- Pump status must not claim a working live stream while the panel is logically dead.
- Count badges must reflect actual row/card state.
- Search/sort/filter controls must continue to act on the same underlying token sets they acted on in V68.
- Axiom links in trading terminal menus must use `pairAddress -> mintAddress -> addr` priority; other terminals continue to use the normal token address flow.

## 8. Migration-Specific Regression Gates

The migration to integrated V68 is not complete until the following are explicitly validated:

- Same account loads the same config in another browser.
- Same account loads the same manual tokens in another browser.
- Manual token add/remove survives `F5`.
- PumpFun panel connects and renders live rows.
- PumpFun live rows react to the configured entry threshold.
- First migration calibration behavior still matches V68 intent.
- Recent/old-token exclusivity rules still hold.
- Tokens dismissed from age bars do not reappear incorrectly.
- Volume alerts respect the rule that protects against alerting when MCAP behavior invalidates the signal.
- `logout-all` still revokes all active sessions.

## 9. Rules That Must Be Checked Before Backendizing More Logic

When logic starts moving to the backend in later phases, preserve these semantics exactly:

- token category routing
- alert gating logic
- migration calibration rules
- PumpFun GC and unsubscribe behavior
- dismissed-set semantics
- manual token protection semantics

If backend behavior ever diverges from these rules, the backend becomes the regression source instead of the fix.

## 10. Working Rule For Future Changes

Any future V68-plus change should be documented in one of two places:
- [v68-migration-checklist.md](/C:/Users/ezequ/Downloads/Volume-Alert-Server/docs/v68-migration-checklist.md) for integration/deploy/schema work
- this file for bot behavior rules

If a new tweak changes how tokens are routed, alerted, filtered, persisted, or removed, it belongs in this behavior contract.

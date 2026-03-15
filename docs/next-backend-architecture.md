# Next Backend Architecture

## Current Progress
- Phase 1 started.
- Database init script created: `src/utils/db-init-stage5.js`.
- Base model created: `src/models/token-catalog.js`.
- Phase 1.5 started: operational catalog fields + first eligibility worker scaffold added.
- Phase 2 started: `token_market_snapshots` schema + first market snapshot worker scaffold added.

## Goal
Move the bot from frontend-heavy monitoring to backend-owned token memory and historical market data.

## Phase Objective
After V68 is stable, the backend becomes the long-term source of truth for:
- known tokens
- monitoring eligibility
- MCAP/price history
- Meteora pool history

The frontend remains the UI, filters, and interaction layer.

## Core Components

### 1. Permanent token catalog
A backend table of all tokens known by the product.

Suggested fields:
- `address`
- `symbol`
- `name`
- `chain`
- `first_seen_at`
- `last_seen_at`
- `last_mcap`
- `last_price`
- `last_pair_address`
- `last_pair_url`
- `last_image_url`
- `last_twitter_url`
- `source` (`bootstrap`, `manual`, `trending`, `pumpfun`, `meteora`, etc.)
- `is_active_monitor_candidate`

Purpose:
- token can leave visible bars without being forgotten
- token can become eligible again when rules fit
- bootstrap seed and discovered tokens converge into one catalog

### 2. Monitoring eligibility layer
Separate logic from visibility.

Concept:
- token may be out of visible UI range
- backend still keeps last known state
- backend periodically reevaluates whether the token should re-enter active monitoring

Suggested derived states:
- `visible_now`
- `eligible_for_recent`
- `eligible_for_old_week`
- `suppressed_by_dismiss`
- `suppressed_by_blocklist`
- `inactive_but_known`

### 3. MCAP/price history store
Persist snapshots over time for real historical comparisons.

Suggested table:
- `token_market_snapshots`
  - `token_address`
  - `ts`
  - `mcap`
  - `price`
  - `vol_5m`
  - `vol_1h`
  - `vol_6h`
  - `vol_24h`

Use cases:
- stable 5m delta without frontend baseline jumps
- future sparkline mini-chart
- server-side alert logic based on true history

Recommended retention strategy:
- dense retention for recent windows
- optional rollups later for older data

### 4. Meteora pool history store
Persist TVL over time instead of keeping it only in frontend memory.

Suggested table:
- `token_meteora_snapshots`
  - `token_address`
  - `ts`
  - `tvl`
  - `pool_count`
  - `pool_address` (optional representative/latest)

Use cases:
- real 1H / 6H / 24H Meteora movement
- backend-driven tooltip values
- historical pool analytics later

### 5. Bootstrap seed becomes catalog input, not monitor spam
The current seed should evolve into catalog seeding, not frontend active polling of all 85 tokens.

Better future behavior:
- backend imports seed tokens into permanent catalog
- backend decides which subset is actively monitored right now
- frontend receives only the relevant visible/eligible subset

### 6. Frontend API shape after backendization
Suggested endpoints:
- `GET /api/catalog/visible`
- `GET /api/catalog/history/:address`
- `GET /api/catalog/sparkline/:address`
- `GET /api/catalog/meteora/:address/history`

Or a consolidated shape:
- `GET /api/dashboard/bootstrap`
  - visible monitored tokens
  - visible recent/old-week tokens
  - sparkline summaries
  - latest Meteora deltas

## Processing Model

### Ingestion
Backend workers ingest from:
- DexScreener
- PumpFun
- Meteora
- bootstrap seed
- manual user additions

### Evaluation
Backend periodically evaluates:
- token eligibility for monitoring
- token eligibility for Recent / Old Week bars
- alert conditions
- re-entry conditions when MCAP range becomes valid again

### Delivery
Frontend receives prepared state instead of raw heavy polling burden.

## Why This Solves Current Pain
- fewer frontend API bursts
- fewer CORS/proxy/rate-limit issues in browser
- stable historical deltas
- real sparkline data on page load
- token memory that survives visibility changes
- cleaner path to make the frontend non-copy-critical

## Recommended Build Order
1. Permanent token catalog table + seed importer.
2. Operational catalog fields and first eligibility worker.
3. Snapshot tables for MCAP/price and Meteora TVL.
4. Background polling workers in backend.
5. Eligibility engine for re-entry into monitoring.
6. Read APIs for frontend visible state.
7. Sparkline endpoint/UI.
8. Gradual removal of equivalent heavy polling from frontend.
## Next Session
1. Add history read endpoints on top of `token_market_snapshots`.
2. Then wire frontend-originated `Recent Tokens`, `Old Tokens 1 Week+`, and alert-triggered tokens into backend catalog persistence so bar visibility and alerts also promote tokens into permanent backend memory.

## Agreed Follow-Ups

These notes capture product/architecture decisions discussed after the first catalog phases so the next sessions do not depend on chat history.

### 1. Global catalog should drive new-account discovery
- New accounts should not depend on the static seed file as their main source of monitored tokens.
- The long-term source for new-account baseline should be the live backend catalog on Railway.
- The relevant shared subset for all accounts is the set of tokens that are currently considered globally eligible for monitoring.
- This means new accounts should receive the current eligible catalog view, not an outdated per-user bootstrap snapshot derived from `data/initial-monitored-tokens.txt`.

### 2. Manual tokens have dual meaning
- A manual token is both:
  - a per-user preference ("I always want to track this token"), and
  - a catalog-ingestion path when the token does not already exist in the backend catalog.
- If a user adds a manual token that is already in `token_catalog`, it should remain only a user-level manual association for that account.
- If a user adds a manual token that is not yet in `token_catalog`, the backend should upsert it into the permanent catalog and also keep it as a manual token for that user.
- Different accounts may have different manual overlays even when they share the same global eligible catalog view.

### 3. Shared visible set vs per-user overlay
- The intended frontend model is:
  - shared/global tokens = backend catalog tokens that are currently eligible,
  - per-user overlay = manual tokens,
  - per-user filtering = blocklist, starred state, dismiss state, UI preferences, sound/config preferences.
- In other words, the meaningful difference between normal user accounts should not be the global monitored baseline; it should be the personal overlay and user-specific filters/preferences.

### 4. Bootstrap tokens should lose their central role
- `user_bootstrap_tokens` may still exist temporarily for compatibility or migration purposes.
- However, they should not remain the primary source of truth for what a new account sees.
- If kept, they should be treated as legacy/bootstrap scaffolding rather than the long-term monitored baseline.

### 5. Rediscovery / re-entry behavior must be global
- If an old token falls out of relevance and later becomes relevant again, all accounts should be able to see it once the backend marks it eligible again.
- A new account created shortly before that re-entry should still receive the token once it becomes globally eligible.
- Therefore, account onboarding cannot rely only on a one-time bootstrap snapshot; the live backend eligibility layer must remain authoritative.

### 6. Current ingestion assumptions confirmed
- Manual tokens already act as one catalog-ingestion source.
- PumpFun migrations already act as another catalog-ingestion source.
- Dex discovery currently appears to depend on an active product flow (for example a user session causing Dex fetch/subscription activity), rather than a fully autonomous global discovery crawler.
- That current behavior is acceptable for now and matches the intended product mental model: the bot grows its catalog through active usage plus migrations/manual additions.

### 7. Need to formalize one official backend eligibility rule
- Current code paths use more than one threshold/meaning for "eligible":
  - catalog worker currently treats `marketCap > 0` as eligible,
  - explicit catalog promotion uses `marketCap >= 30000`,
  - frontend monitored visibility also effectively treats `>= 30000` as the practical floor for non-manual tokens.
- This mismatch must be resolved in a future step so the backend becomes the single source of truth for eligibility semantics.

### 8. Global junk suppression is preferable to hard delete
- Some migrated tokens are effectively garbage and should not remain visible forever.
- The preferred long-term direction is not physical deletion from the permanent catalog as a first response.
- Instead, add a global suppression/junk state in the catalog so these tokens:
  - stay auditable in backend memory,
  - can be excluded from eligibility and new-account views,
  - can later be restored if needed,
  - do not pollute the monitored baseline for all users.
- Automatic garbage detection still needs a careful heuristic and should be conservative.

### 9. Monitoring priority policy to implement later
- Global eligibility and monitoring priority are not the same concept.
- A token may remain in the permanent catalog while being checked less often depending on its current state.
- Status: first implementation now exists in backend worker logic and local DB schema.
- The agreed current backend priority policy is:

#### Dormant
- Applies to tokens with no useful pair / no meaningful signs / effectively dead state.
- Planned recheck interval: `8 minutes`.

#### Low Priority
- Applies when `marketCap < 30k`.
- Planned recheck interval: `3 minutes`.

#### Normal Priority
- Applies when `30k <= marketCap < 100k`.
- Planned base recheck interval: `1 minute`.

#### Normal Priority Boosts
- For tokens in the `30k <= marketCap < 100k` band, boosts are based on Dex-delivered `PCHANGE`.
- If `PCHANGE 1H >= 150%`, planned recheck interval becomes `20s`.
- If `PCHANGE 6H >= 200%`, planned recheck interval becomes `40s`.
- If both boost conditions are true, use the smaller interval (`20s`).

#### High Priority
- Applies when `marketCap >= 100k`.
- Planned base recheck interval: `10s`.
- Internal ordering should be by volume only.
- Within the due queue, tokens with higher total volume should be evaluated first.

#### Persistence rule during evaluation
- Every successful Dex evaluation should persist the latest market data into backend-owned state.
- At minimum this includes:
  - `mcap`
  - `price`
  - `vol_5m`
  - `vol_1h`
  - `vol_6h`
  - `vol_24h`
  - pair/metadata fields already tracked in the catalog
- `PCHANGE` should be used as a live evaluation signal for priority.
- `PCHANGE` is not currently required in historical snapshot persistence.

## Additional Session Notes

### Frontend/backend behavior validated
- Shared monitored baseline now comes from backend eligible catalog instead of per-user bootstrap tokens.
- New-account flow was validated with backend running: freshly created accounts receive the global eligible set.
- Frontend only displays shared/global monitored entries at `mcap >= 30k`; manual tokens remain user-specific exceptions.

### Bootstrap tokens status
- `bootstrapTokens` has been removed from the active frontend/backend config flow.
- Legacy data may still exist in older code/database paths, but it is no longer the active source of monitored state.

### Local development operational note
- Development rate limiting was disabled in local backend middleware because repeated frontend/session testing was triggering `429 Too Many Requests` on `/api/auth/me`.
- This change is intended for `NODE_ENV=development` only and should not affect production behavior.

### Confirmed future work not yet implemented
- Priority engine may still need tuning after real production usage, especially thresholds and scaling behavior.
- Historical Dex snapshots should continue to be the source of comparison for MCAP/volume changes.
- `PCHANGE` is intentionally not required in snapshot persistence right now; the team currently only needs it as a live evaluation signal.

### Implemented follow-up state
- Frontend stop/start monitoring now gates realtime token updates as intended.
- Meteora is now backendized for the active frontend flow:
  - backend stores `token_meteora_snapshots`
  - backend exposes batch/history routes
  - frontend consumes backend Meteora batch data and shows deltas in hover tooltip
- The first version of the backend priority engine now:
  - classifies tokens into `dormant`, `low`, `normal`, `high`
  - computes `next_evaluation_at` using the agreed timing policy
  - boosts normal-band tokens using Dex `PCHANGE`
  - orders due evaluation by volume
  - persists successful Dex evaluations into `token_market_snapshots`
- The previous dedicated `marketSnapshotWorker` no longer drives the active snapshot flow; snapshot persistence is now coupled to the catalog evaluation pass.

### 10. BirdEye adoption direction
- Future priority/monitoring work is expected to use BirdEye as an additional market-data source for richer token information and price/value data.
- The remaining design question is timing: the best interval strategy still needs practical tuning after BirdEye is integrated.
- The team currently prefers using Dex-delivered `PCHANGE` values as the boost signal instead of backend-computed percentage growth of volume.
- Status: discussed and recorded only; no BirdEye integration or priority-engine implementation has been added yet.

# Current Bot State

## Purpose
This is the canonical documentation for the current integrated bot state in this repository.

It is based on the active backend/frontend code, with older migration notes used only as secondary context.

For the full technical/behavior reference, see:
- `docs/bot-complete-reference.md`

Last reviewed against code on `2026-03-17` after rate-limit split, Dex discovery restoration, monitored alert fixes, Old Surge session-baseline rules, top-menu alert controls, instant starred sync polish, and validated backend-backed manual-token restore across devices.

## Current Runtime Shape

### Frontend
- Active frontend lives in `frontend/`
- Stack:
  - `Vite`
  - `TypeScript`
  - `socket.io-client`
- Main state/orchestration files:
  - `frontend/src/state/app-controller.ts`
  - `frontend/src/state/app-state.ts`
  - `frontend/src/ui/sections/`

### Backend
- Active backend lives in `src/`
- Stack:
  - `Express`
  - `Socket.io`
  - `PostgreSQL`
- Main routes/services:
  - `src/routes/config.js`
  - `src/routes/catalog.js`
  - `src/routes/dashboard.js`
  - `src/services/catalog-worker.js`
  - `src/services/dex-discovery-worker.js`
  - `src/services/meteora-snapshot-worker.js`
  - `src/services/socket-hub.js`

## Source Of Truth By Area

### Auth and account state
- Source of truth: backend
- Main endpoints:
  - `POST /api/auth/login`
  - `GET /api/auth/me`
  - `POST /api/auth/logout`
  - `POST /api/auth/logout-all`

### User config and user overlays
- Source of truth: backend
- Main endpoint:
  - `GET /api/config`
- Returned user-scoped data:
  - `configs`
  - `tokens`
  - `blocklist`
  - `starredTokens`

### Global monitored baseline
- Source of truth: backend catalog/dashboard state
- Active endpoint for monitored hydration:
  - `GET /api/dashboard/monitored`
- This is the endpoint the frontend currently uses for the shared monitored set.

### Recent / Old Week bars
- Source of truth: frontend-derived from tracked token state
- Why still frontend-owned:
  - MCAP windows are per-user
  - dismiss state is per-user
  - removal logs are local/account-scoped

### PumpFun live stream
- Source of truth: backend socket stream for live events
- Frontend consumes:
  - `pump:status`
  - `pump:newToken`
  - `pump:trade`
  - `pump:migrate`
  - `sol:price`

### Meteora
- Source of truth: backend-persisted snapshots
- Collection is done by backend worker
- Frontend reads persisted summaries from `GET /api/dashboard/monitored`
- The legacy batch route still exists on backend, but the active frontend no longer polls `POST /api/catalog/meteora/batch`

## Active Data Flows

### 1. Session bootstrap
1. Frontend restores token from storage.
2. Frontend validates session with `GET /api/auth/me`.
3. Frontend loads canonical account state with:
   - `GET /api/config`
   - `GET /api/dashboard/monitored`
4. Frontend rebuilds tracked state from:
   - global monitored payload
   - manual user tokens
   - user blocklist
   - user starred tokens

Important:
- The bot does not auto-start monitoring on login/session restore.
- Start/stop is manual in the current UI.

### 2. Monitored Tokens
- Frontend refresh interval: `10s`
- Current flow:
  - frontend calls `GET /api/dashboard/monitored`
  - backend serves prepared monitored rows from `token_catalog`
  - backend enriches rows with:
    - latest market values persisted in catalog
    - MCAP baseline from `token_market_snapshots`
    - latest Meteora summary from `token_meteora_snapshots`
- Current intended effect:
  - frontend no longer depends on `dex:subscribe` as the main monitored refresh mechanism
  - frontend refresh should read backend-prepared state instead of causing Dex fetches itself

Current caution:
- this `10s` polling cadence is still aggressive relative to the backend-wide rate limiter
- in production, `429` can still happen when dashboard polling combines with other frontend API traffic

### 3. Manual Tokens
- Current source of truth:
  - backend per-user manual-token list from `GET /api/config`
- Dedicated user endpoints:
  - `POST /api/config/tokens`
  - `DELETE /api/config/tokens/:address`
- Backend ingestion endpoint:
  - `POST /api/catalog/manual-track`
- Current add flow:
  1. frontend adds the token optimistically to local state
  2. frontend persists the manual token to the authenticated user via `POST /api/config/tokens`
  3. frontend asks backend to track the token in catalog
  4. backend upserts it into `token_catalog`
  5. backend schedules immediate catalog evaluation
  6. frontend reloads canonical state with:
     - `GET /api/config`
     - `GET /api/dashboard/monitored`

- Intended semantics:
  - manual token list is a backend-persisted per-user overlay
  - manual token also acts as a catalog-ingestion path
  - `_userManual` is the protection flag for `min-mcap-remove`
  - restoring manual tokens must not depend on dashboard success; `GET /api/config` alone is enough to restore the list across browsers/devices
  - tracked-state rebuild now consumes `payload.tokens` from `GET /api/config` directly, which fixed the previous reload/device-sync bug

### 4. Catalog worker
- Worker: `src/services/catalog-worker.js`
- Poll loop: every `5s`
- Current priority bands:
  - `high`: `>= 100k`
  - `normal`: `30k-100k`
  - `low`: `< 30k`
  - `dormant`: missing/no useful Dex state
- Priority timing:
  - `high`: `10s`
  - `normal`: `60s`
  - `normal` boosted by `PCHANGE`
  - `low`: `3m`
  - `dormant`: `8m`
- Important hardening already present:
  - `dex-unavailable` preserves existing eligibility/priority instead of collapsing directly into `dex-missing`
  - newly added manual tokens get `5s` retry cadence until first classification

### 4b. Dex discovery worker
- Worker: `src/services/dex-discovery-worker.js`
- Poll loop: every `60s`
- Current discovery feeds:
  - `GET /token-profiles/latest/v1`
  - `GET /token-boosts/top/v1`
  - `GET /token-boosts/latest/v1`
- Current behavior:
  - collects Solana token addresses from those feeds
  - deduplicates them
  - upserts them into `token_catalog` with source `dexscreener-discovery`
  - schedules immediate evaluation in the normal catalog worker
- This restored the old `loadTrending()`-style discovery behavior that had been missing from the backendized bot

### 5. Meteora flow
- Snapshot worker: `src/services/meteora-snapshot-worker.js`
- Worker polls eligible catalog tokens every `30s`
- Read routes:
  - `GET /api/catalog/meteora/:address/history`
- Active frontend read path:
  - embedded `meteora` payload inside `GET /api/dashboard/monitored`
- Current read path is DB-backed, not upstream-fetch-backed

### 6. PumpFun metadata enrichment
- Frontend still resolves some PumpFun token images/metadata through:
  - `GET /api/catalog/pumpfun/:mint/meta`
- This happens when incoming PumpFun tokens are missing image/meta in local state
- These are individual per-mint requests, not socket messages
- This route is one of the current contributors to frontend-triggered `429` alongside dashboard polling

## Current UI/Behavior Contract

### Manual tokens
- Must remain visible in `Manual Tokens`
- Use `_userManual = true`
- Are protected from `min-mcap-remove`
- Removing from `Manual Tokens` clears manual pinning but does not imply global block

### Recent / Old Week routing
- Current routed bars:
  - `Recent Tokens`
  - `Old Tokens 1 Week+`
- Routing is frontend-derived from tracked token age and MCAP windows
- `_userManual` tokens are excluded from routed discovery bars
- Dismissed sets are stored locally and are account-scoped in browser storage
- Removal-log hover is now click-sticky as well as hover-driven, so the panel can stay open while the user reads it

### PumpFun
- `X` removes a row from the panel only
- Token may reappear on new trades
- Pump live updates are ignored while the bot is stopped

### Alerts
- Standard monitored `VOL` and `MCAP` alerts share cooldown
- HVNC remains separate
- Old-surge remains separate
- Alerts are still frontend-owned behavior
- Monitored alert evaluation now runs both on:
  - live patch merges
  - `GET /api/dashboard/monitored` rebuilds

## Persistence Model

### Backend-persisted per account
- auth/session state
- user configs
- manual tokens
- blocklist
- starred tokens

### Browser-local but account-scoped
- dismissed Recent set
- dismissed Old Week set
- Recent removal log
- Old Week removal log
- sound UI preferences

## Important Current Implementation Notes

### `D` column / MCAP delta
- `GET /api/dashboard/monitored` currently exposes:
  - `prevMcap`
  - `mcapDelta`
- Backend implementation today:
  - route requests a larger recent snapshot window per token
  - it filters to snapshots with valid `mcap`
  - it uses the newest valid snapshot as current
  - it then looks for a valid baseline around `~5 minutes` back
  - if no near-5m point exists, it falls back to the oldest valid snapshot still inside the fetched window

Current limitation:
- if there is no pair of valid snapshots in the fetched window, `mcapDelta` still remains `null`
- this is acceptable fallback behavior for now

### Routed/manual table sorting
- `Manual Tokens`, `Recent Tokens`, and `Old Tokens 1 Week+` all support:
  - `VOL`
  - `MCAP`
  - `PCHANGE`
  - `AGE`
- `AGE` currently supports two directions in the UI:
  - `NEWEST`
  - `OLDEST`
- `Manual Tokens` now has the same `#` ranking column as Recent/Old
- The duplicate footer-level `Per Page` control was removed from Recent/Old; the active `Per Page` control is the header one

### Rate limiting reality
- Backend rate limiting is now split by route behavior through `src/middleware/rate-limit.js`
- Active limiter buckets:
  - `authLimiter`
  - `defaultApiLimiter`
  - `dashboardLimiter`
  - `pumpfunMetaLimiter`
  - `catalogWriteLimiter`
  - `catalogReadLimiter`
- Current defaults:
  - `authLimiter`: `10 / 15min / IP`
  - `defaultApiLimiter`: `180 / 15min / user+IP`
  - `dashboardLimiter`: `360 / 15min / user+IP`
  - `pumpfunMetaLimiter`: `220 / 15min / user+IP`
  - `catalogWriteLimiter`: `60 / 15min / user+IP`
  - `catalogReadLimiter`: `120 / 15min / user+IP`
- Current conclusion:
  - the active frontend is no longer wasting requests on `meteora/batch`
  - rate limiting is no longer one global bucket for the whole API
  - remaining pressure points are still mainly dashboard polling plus per-token PumpFun metadata fetches

### Monitored alert trigger model
- `VOL` and `MCAP` monitored alerts are computed on the frontend from monitored state deltas
- Current monitored alert evaluation runs during dashboard-driven rebuilds, not only socket patch merges
- This matters because the monitored table is now backend-driven and no longer relies on Dex socket updates as the primary refresh path
- `VOL` and `MCAP` now only repeat if:
  - they drop back below threshold and cross again
  - or they advance at least `+40` percentage points beyond the last alert of that same type
- The old behavior where near-identical monitored alerts could re-fire after cooldown is no longer intended
- Tokens now also have a cross-alert block:
  - if a token fires one alert type, other alert types for that same token are blocked for `2m`
  - `Surge` is evaluated before local `VOL/MCAP`, so it wins when both would qualify in the same cycle

### Old Token Surge rule
- Old Surge no longer fires immediately on bot start just because a token is already hot
- The current rule is session-based:
  - if `PCHANGE 1H` or `PCHANGE 6H` crosses its threshold during the session, it alerts
  - if the token already started above threshold, it only alerts after rising an additional `+50` percentage points above the session baseline
- This prevents noisy “instant boot alerts” while still allowing genuinely stronger continuation moves to alert later in the same session
- Surge is now additionally age-gated:
  - tokens younger than `2d` do not qualify for Surge at all
  - tokens from `2d` to `7d` can show as `Recent Token Surge`
  - tokens older than `7d` show as `Old Token Surge`
- Current visual contract:
  - `Recent Token Surge` is green
  - `Old Token Surge` is orange
  - standard `50%-100%` monitored alerts are blue

### Top config controls
- The top config area now exposes:
  - `Surge Threshold`
    - editable `1H` and `6H` surge thresholds
  - `Alert Toggles`
    - `VOL`
    - `MCAP`
    - `High Volume New Coin`
    - `Surge`
    - `PumpFun VOL`
    - `PumpFun HVNC`
  - `Sound By Alert Type`
    - the same per-type families above, but for sound playback only
- These toggles are backend-persisted user configs
- `Sound Alert` remains the master on/off switch, while `Sound By Alert Type` is the per-kind gate

### Starred-token sync
- Toggling a star now updates immediately across every visible surface rendering that same address
- This includes:
  - `Monitored`
  - `Recent`
  - `Old Tokens 1 Week+`
  - `Manual Tokens`
  - `Alerts`

### Padre terminal quick fix
- The Padre terminal link now uses:
  - `https://trade.padre.gg/trade/solana/{address}`
- Link resolution order is:
  - `pairAddress`
  - `mintAddress`
  - fallback `address`
- Important nuance:
  - the bot always opens the same computed Padre URL for a given token
  - the Padre app itself may later rewrite/canonicalize the visible URL after page load
  - that post-load rewrite is Padre behavior, not bot-side link switching

### Manual token reload stability
- manual tokens are expected to survive `F5`
- manual tokens are also expected to restore across different browsers/devices for the same authenticated account
- backend catalog tracking remains separate from the user manual-token list itself
- this behavior has now been validated after fixing the rebuild path that previously ignored backend `payload.tokens` during reload

## Known Open Issues / Review Targets
- Consider deduplicating/caching PumpFun metadata fetches more aggressively if `429` persists.
- Keep watching `dex_unavailable` behavior until Birdeye or another stronger market-data source is introduced.

## Documentation Policy Going Forward
- This file is the primary state-of-the-world document.
- Keep older docs only when they still serve one of these purposes:
  - production runbook
  - historical behavior contract
  - deployment checklist
- Do not use progress-log docs as the main source of truth once their content has been consolidated here.

## Docs Still Worth Keeping
- `docs/current-bot-state.md`
  - canonical current-state doc
- `docs/v68-behavior-contract.md`
  - behavior rules that still matter during parity/regression review
- `docs/phase6-runbook.md`
  - production/ops runbook
- `docs/phase6-checklist.md`
  - deployment validation checklist
- `docs/phase6-railway.md`
  - Railway-specific deployment notes

## Docs Retired By This Consolidation
- `docs/frontend-vite-progress.md`
- `docs/next-backend-architecture.md`

Those two were useful as session logs, but they had accumulated contradictory state and should no longer be treated as authoritative.

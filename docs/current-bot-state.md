# Current Bot State

## Purpose
This is the canonical documentation for the current integrated bot state in this repository.

It is based on the active backend/frontend code, with older migration notes used only as secondary context.

Last reviewed against code on `2026-03-17`.

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
- Current frontend source of truth:
  - account-scoped browser storage
- Backend ingestion endpoint:
  - `POST /api/catalog/manual-track`
- Current add flow:
  1. frontend adds the token optimistically to local state
  2. frontend persists the manual list locally per authenticated account
  3. frontend asks backend to track the token in catalog
  4. backend upserts it into `token_catalog`
  5. backend schedules immediate catalog evaluation
  6. frontend reloads canonical state with:
     - `GET /api/config`
     - `GET /api/dashboard/monitored`

- Intended semantics:
  - manual token is a per-user overlay
  - manual token also acts as a catalog-ingestion path
  - `_userManual` is the protection flag for `min-mcap-remove`

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

## Persistence Model

### Backend-persisted per account
- auth/session state
- user configs
- blocklist
- starred tokens

### Browser-local but account-scoped
- manual tokens
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
- Backend still applies a general API limiter by IP through `src/middleware/rate-limit.js`
- The current limiter is safe for auth abuse protection, but it is tight relative to the production frontend polling pattern
- Recent observed `429` sources are:
  - `GET /api/dashboard/monitored`
  - `GET /api/catalog/pumpfun/:mint/meta`
- Current conclusion:
  - the active frontend is no longer wasting requests on `meteora/batch`
  - remaining `429` pressure comes mainly from dashboard polling plus per-token PumpFun metadata fetches

### Manual token reload stability
- manual tokens are now expected to survive `F5` from local per-account frontend storage
- backend tracking is no longer required for the manual bar itself

## Known Open Issues / Review Targets
- Revisit general API rate limiting versus real production polling.
- Consider deduplicating/caching PumpFun metadata fetches more aggressively if `429` persists.

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

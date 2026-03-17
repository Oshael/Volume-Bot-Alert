# Bot Complete Reference

## Purpose
This document is the full reference for the current bot implementation.

It is meant to play the role that the old `CLAUDE_HTML_PURO_.md` used to play, but for the current backend + frontend architecture.

Use this document for:
- behavior review
- onboarding
- architecture recall
- rule verification
- debugging which file owns which feature

Use `docs/current-bot-state.md` as the shorter canonical snapshot.

Last reviewed against code on `2026-03-17`.

## High-Level Product Shape

The bot is a Solana monitoring app with:
- authenticated multi-user frontend
- Express backend
- PostgreSQL persistence
- backend workers for discovery, catalog evaluation, market snapshots, and Meteora snapshots
- realtime PumpFun socket feed

The UI is centered around:
- `Monitored Tokens`
- `Manual Tokens`
- `Recent Tokens`
- `Old Tokens 1 Week+`
- `PumpFun`
- `Alerts`

## Main Directories

### Frontend
- `frontend/src/state/app-controller.ts`
  - main orchestration logic
- `frontend/src/state/app-state.ts`
  - state shape and UI state
- `frontend/src/ui/app-shell.ts`
  - shell render + hover/sort menu wiring
- `frontend/src/ui/sections/`
  - all UI sections
- `frontend/src/services/api/`
  - HTTP client wrappers
- `frontend/src/services/socket/`
  - realtime socket client
- `frontend/src/services/alerts/sound.ts`
  - alert sounds
- `frontend/src/utils/`
  - browser storage helpers

### Backend
- `src/server.js`
  - app wiring, routes, workers, socket hub
- `src/routes/`
  - API routes
- `src/models/`
  - DB access layer
- `src/services/`
  - workers and upstream integrations
- `src/middleware/`
  - auth and rate limiting

## Runtime Components

### Frontend controller
File:
- `frontend/src/state/app-controller.ts`

Responsibilities:
- session restore
- config load
- monitored dashboard polling
- local token-state merge
- alert decisions
- routed-bar derivation
- PumpFun UI state
- manual token local persistence

### Backend server
File:
- `src/server.js`

Responsibilities:
- Express app setup
- CORS/helmet/cookies/json
- route registration
- worker startup
- Socket.io hub startup
- admin worker status endpoint

### Backend workers

#### Catalog worker
File:
- `src/services/catalog-worker.js`

Role:
- reevaluates tokens already in `token_catalog`
- updates eligibility, priority, latest market stats
- inserts market snapshots

Cadence:
- scheduler loop every `5s`

Priority bands:
- `high`: `>= 100k`
- `normal`: `30k-100k`
- `low`: `< 30k`
- `dormant`: no useful Dex state / no MCAP

Priority recheck timings:
- `high`: `10s`
- `normal`: `60s`
- `normal` boosted by price change:
  - `6h >= 200` can reduce to `40s`
  - `1h >= 150` can reduce to `20s`
- `low`: `3m`
- `dormant`: `8m`

Special handling:
- `dex-unavailable` preserves the current eligibility/priority instead of immediately downgrading the token to `dex-missing`
- new manual tokens retry quickly until first real classification

#### Dex discovery worker
File:
- `src/services/dex-discovery-worker.js`

Role:
- restores the old `loadTrending()` behavior on the backend
- discovers new tokens from DexScreener feeds
- inserts them into `token_catalog`
- schedules immediate evaluation

Cadence:
- every `60s`

Discovery feeds:
- `/token-profiles/latest/v1`
- `/token-boosts/top/v1`
- `/token-boosts/latest/v1`

Current source used in catalog:
- `dexscreener-discovery`

#### Market snapshot worker
File:
- `src/services/market-snapshot-worker.js`

Role:
- inserts market snapshots for eligible tokens

Cadence:
- every `60s`

#### Meteora snapshot worker
File:
- `src/services/meteora-snapshot-worker.js`

Role:
- fetches and stores TVL snapshots for eligible tokens

Cadence:
- every `30s`

## Data Sources

### DexScreener
File:
- `src/services/dexscreener.js`

Used for:
- token pair lookup by address
- discovery feeds for latest profiles and boosts

Important current note:
- reevaluation failures from Dex are expected to happen sometimes
- current hardening tolerates this

### PumpFun WebSocket
File:
- `src/services/pumpfun-ws.js`

Used for:
- `newToken`
- `trade`
- `migrate`
- connection status

### Meteora
Files:
- `src/services/meteora.js`
- `src/services/meteora-snapshot-worker.js`

Used for:
- pool TVL summary/history

## Source Of Truth By Area

### Auth/session
- backend

Endpoints:
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/logout-all`

### User configs
- backend

Endpoint:
- `GET /api/config`

User-scoped persisted data:
- configs
- manual tokens
- blocklist
- starred tokens

### Manual tokens
- backend user data, scoped by authenticated account

Important:
- backend is the source of truth for which manual tokens a user sees
- frontend still applies optimistic UI updates
- backend also ingests the token for global catalog tracking through a separate catalog path

### Monitored tokens baseline
- backend

Endpoint:
- `GET /api/dashboard/monitored`

### Recent / Old Week bars
- frontend-derived from monitored token state

Reasons:
- per-user MCAP windows
- per-user dismissed state
- per-user removal logs

### Alerts
- frontend-owned behavior

### PumpFun live state
- backend socket feed + frontend session state

## Session Boot Flow

1. frontend restores auth token from storage
2. frontend calls `GET /api/auth/me`
3. frontend loads:
   - `GET /api/config`
   - `GET /api/dashboard/monitored`
4. frontend rebuilds tracked state from:
   - backend monitored payload
   - backend manual tokens for that account
   - blocklist
   - starred tokens

Important:
- the session restoring does not auto-start monitoring
- the user still needs to click `START MONITORING`

## Monitored Tokens

Files:
- `frontend/src/ui/sections/monitored-section.ts`
- `frontend/src/state/app-controller.ts`
- `src/routes/dashboard.js`

Main behavior:
- frontend polls `GET /api/dashboard/monitored` every `10s`
- backend returns prepared catalog rows
- frontend rebuilds monitored token state from that payload

Current sorting:
- `VOL`
  - hover dropdown:
    - `5M`
    - `1H`
    - `6H`
    - `24H`
- `MCAP`
- `AGE`
  - hover dropdown:
    - `NEWEST`
    - `OLDEST`

Important:
- this panel is now backend-driven
- it is no longer primarily driven by direct Dex patches

## Manual Tokens

Files:
- `frontend/src/ui/sections/manual-section.ts`
- `frontend/src/utils/manual-storage.ts`
- `src/routes/catalog.js`

Behavior:
- user adds token by address
- frontend stores the manual list locally per account
- frontend calls `POST /api/catalog/manual-track`
- backend upserts the token into `token_catalog`
- backend schedules immediate evaluation

Rules:
- `_userManual = true`
- manual token survives `F5`
- manual token is protected from `min-mcap-remove`
- removing a manual token removes the user pin, not the global catalog entry

Table features:
- rank column `#`
- sort by `VOL`, `MCAP`, `PCHANGE`, `AGE`
- `AGE` supports `NEWEST` and `OLDEST`

## Recent Tokens

File:
- `frontend/src/ui/sections/routed-sections.ts`

Definition:
- age between `1d` and `7d`
- inside the Recent MCAP window configured by user

Rules:
- derived from tracked token state
- excludes `_userManual` tokens from routed discovery bars
- supports local dismiss
- has local removal log

Sorting:
- `VOL`
- `MCAP`
- `PCHANGE`
- `AGE`

Age sort options:
- `NEWEST`
- `OLDEST`

## Old Tokens 1 Week+

File:
- `frontend/src/ui/sections/routed-sections.ts`

Definition:
- age `>= 7d`
- inside the Old Week MCAP window configured by user

Rules:
- derived from tracked token state
- supports local dismiss
- has local removal log

Sorting:
- `VOL`
- `MCAP`
- `PCHANGE`
- `AGE`

Age sort options:
- `NEWEST`
- `OLDEST`

## Routed Bar Removal Logs

Files:
- `frontend/src/ui/sections/shared.ts`
- `frontend/src/ui/app-shell.ts`

Behavior:
- Recent and Old Week each have a removal log badge
- hover still works
- click now locks the panel open
- clicking outside closes it

This prevents the old issue where the hover panel disappeared before the user could move the cursor into it.

## Starred Tokens

Files:
- `frontend/src/ui/sections/shared.ts`
- `frontend/src/styles/app.css`

Behavior:
- starred tokens are persisted in backend user data
- starring applies across all sections for the same address
- UI sync is now immediate across all visible instances of the same address when the star is clicked

Current visual treatment:
- stronger gold glow
- row/card highlight
- left accent in tables
- symbol/avatar emphasis

Current sections using the stronger starred state:
- Manual table
- Recent table
- Old Week table
- Monitored cards
- Alert cards

## PumpFun Panel

Files:
- `frontend/src/ui/sections/pumpfun-section.ts`
- `frontend/src/state/app-controller.ts`
- `src/services/pumpfun-ws.js`
- `src/services/socket-hub.js`

Behavior:
- backend maintains one server-side PumpFun websocket
- frontend receives:
  - `pump:newToken`
  - `pump:trade`
  - `pump:migrate`
  - `pump:status`
  - `sol:price`

Panel rules:
- sorted/live-updated in frontend
- `X` removes only from the panel
- removed token can return on new trades
- stopped bot ignores PumpFun live updates

Pump GC rules:
- inactive for `10m` can be removed
- low MCAP for too long can be removed

Migration behavior:
- migrated token is removed from PumpFun panel
- migration is reported into the catalog/backend flow
- migration toast is shown in frontend

## Alerts

Files:
- `frontend/src/state/app-controller.ts`
- `frontend/src/ui/sections/alerts-section.ts`
- `frontend/src/services/alerts/sound.ts`

Main alert types:
- `monitored-vol`
- `monitored-mcap`
- `hvnc`
- `old-surge`
- `pumpfun-vol`
- `pumpfun-hvnc`

### Monitored VOL alert
Rules:
- computed from `prevVolume5m` vs current `volume5m`
- respects `threshold`
- respects `min-vol`
- respects `min-mcap`
- respects `max-mcap`
- suppressed if MCAP is declining during the same comparison
- shares standard cooldown with monitored MCAP alerts
- repeat rule:
  - does not re-fire just because cooldown expired
  - re-fires only if it drops back below threshold and crosses again
  - or if it advances another `+40` percentage points beyond the previous VOL alert
- cross-alert rule:
  - if the same token has already fired another alert type in the last `2m`, this alert is suppressed

### Monitored MCAP alert
Rules:
- computed from `prevMcap` vs current `mcap`
- respects `mcap-threshold`
- also passes the general alert filters
- shares standard cooldown with monitored VOL alerts
- repeat rule:
  - does not re-fire just because cooldown expired
  - re-fires only if it drops back below threshold and crosses again
  - or if it advances another `+40` percentage points beyond the previous MCAP alert
- cross-alert rule:
  - if the same token has already fired another alert type in the last `2m`, this alert is suppressed

### HVNC
Meaning:
- High Volume New Coin

Rules:
- token age under `30m`
- `volume24h >= hvnc-min-vol`
- single-fire per token/session state

### Old Token Surge
Rules:
- only evaluated for routed Recent / Old Week tokens
- only evaluated for tokens aged at least `2d`
- thresholds:
  - `1H >= user-configured threshold` default `100%`
  - `6H >= user-configured threshold` default `150%`

Current session-baseline logic:
- does not fire immediately on boot just because the token already started hot
- if token starts below threshold, it alerts when it crosses threshold during the session
- if token already starts above threshold, it only alerts after gaining another `+50` percentage points above the session baseline

Badge label in alert card:
- no Surge alert for tokens younger than `2d`
- `RECENT TOKEN SURGE` when token age is from `2d` up to `7d`
- `OLD TOKEN SURGE` when older than `7d`

Priority / conflict rule:
- `Surge` is evaluated before local `VOL/MCAP`
- if `Surge` fires, local monitored alerts for that token are blocked by the shared `2m` cross-alert window

### PumpFun alerts
Rules:
- separate from monitored-token alerts
- use PumpFun volume accumulation logic

### Alert evaluation timing
Important current behavior:
- monitored alert evaluation runs on:
  - live patch merges
  - dashboard refresh rebuilds

This matters because the monitored panel is backend-driven now.

## Sounds

Files:
- `frontend/src/services/alerts/sound.ts`
- `frontend/src/utils/sound-storage.ts`

Behavior:
- custom sounds can be saved per account scope
- fallback synthesized patterns still exist
- sound respects enable/disable and volume UI settings
- sound now also respects per-alert-type toggles stored in user config

## Alert Color Semantics

Files:
- `frontend/src/ui/sections/alerts-section.ts`
- `frontend/src/styles/app.css`

Current visual mapping:
- standard monitored alerts in the `50%-100%` range use blue
- `critical` alerts at `100%-200%` use yellow
- `mega` alerts above `200%` use orange
- `Recent Token Surge` uses green
- `Old Token Surge` uses orange

## Top Config Menu

Files:
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/styles/app.css`
- `src/models/user-config.js`

Current top-row controls include:
- global monitored thresholds
- `Sound Alert`
- `Surge Threshold`
- `Alert Toggles`
- `Sound By Alert Type`

Current per-type toggle families:
- `VOL`
- `MCAP`
- `High Volume New Coin`
- `Surge`
- `PumpFun VOL`
- `PumpFun HVNC`

Persistence:
- these are backend-persisted user config values
- `Sound Alert` is the master sound gate
- `Sound By Alert Type` is the per-kind sound gate

## `D` Column / MCAP Delta

Backend file:
- `src/routes/dashboard.js`

Related model:
- `src/models/token-market-snapshot.js`

Current behavior:
- backend reads a wider snapshot window
- filters to valid MCAP rows
- uses newest valid row as current
- looks for a valid baseline around `~5m` back
- if none is available, uses the oldest valid row in the fetched window

If no valid pair exists:
- `mcapDelta` remains `null`

## Persistence Model

### Backend persisted
- users
- sessions
- configs
- manual tokens
- blocklist
- starred tokens
- token catalog
- market snapshots
- Meteora snapshots

### Browser-local and account-scoped
- dismissed Recent set
- dismissed Old Week set
- Recent removal log
- Old Week removal log
- sound preferences/assets

## Catalog Entry Paths

A token can enter `token_catalog` from:
- manual track
- Dex discovery worker
- `dex:subscribe` socket path
- PumpFun migrate path
- config-related upserts for some user overlays

Important distinction:
- reevaluation is not discovery
- the catalog worker only works on tokens already inside the catalog

Manual-token distinction:
- the per-user manual-token list lives in config/token endpoints
- the global tracked/catalog version of that token lives in `token_catalog`
- these are intentionally separate layers

## Current Rate Limiting

Files:
- `src/middleware/rate-limit.js`
- `config/index.js`

Limiter buckets:
- `authLimiter`
- `defaultApiLimiter`
- `dashboardLimiter`
- `pumpfunMetaLimiter`
- `catalogWriteLimiter`
- `catalogReadLimiter`

Current defaults:
- `authLimiter`: `10 / 15min / IP`
- `defaultApiLimiter`: `180 / 15min / user+IP`
- `dashboardLimiter`: `360 / 15min / user+IP`
- `pumpfunMetaLimiter`: `220 / 15min / user+IP`
- `catalogWriteLimiter`: `60 / 15min / user+IP`
- `catalogReadLimiter`: `120 / 15min / user+IP`

Reason for this split:
- auth brute force protection should stay tight
- dashboard polling needs more headroom
- PumpFun metadata fetches can burst independently
- one single global limiter was punishing normal usage

## Important API Endpoints

### Auth
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/logout-all`

### Config
- `GET /api/config`
- `PUT /api/config`
- `PATCH /api/config`
- `POST /api/config/tokens`
- `DELETE /api/config/tokens/:address`

### Catalog
- `POST /api/catalog/manual-track`
- `GET /api/catalog/eligible`
- `GET /api/catalog/history/:address`
- `GET /api/catalog/meteora/:address/history`
- `GET /api/catalog/pumpfun/:mint/meta`
- `POST /api/catalog/promote`
- `POST /api/catalog/migrated`

### Dashboard
- `GET /api/dashboard/monitored`

### Admin status
- `GET /api/admin/ws-status`

## Worker Status Visibility

Admin status endpoint currently exposes:
- socket hub status
- catalog worker status
- market snapshot worker status
- Meteora snapshot worker status
- Dex discovery worker status

## Current Known Weak Spots

- Dex reevaluation can still produce many `dex_unavailable` results
- PumpFun metadata route can still pressure rate limiting in bursts
- discovery is restored through Dex feeds again, but underlying Dex availability remains a dependency

## Practical Review Checklist

When verifying the bot, these are the best quick checks:

1. `GET /api/admin/ws-status`
- confirm workers are running

2. `SELECT ... FROM token_catalog ORDER BY first_seen_at DESC`
- confirm new discovery is entering

3. `SELECT ... FROM token_catalog ORDER BY last_seen_at DESC`
- confirm reevaluation is still active

4. login + `START MONITORING`
- confirm alerts and UI refresh still work

5. add manual token + `F5`
- confirm local manual persistence survives reload

6. watch `Monitored`
- confirm `D` and alert behavior remain stable across refreshes

## Relationship To Other Docs

Use this file for deep reference.

Use:
- `docs/current-bot-state.md`
for the shorter state snapshot

Keep:
- `docs/v68-behavior-contract.md`
- `docs/phase6-runbook.md`
- `docs/phase6-checklist.md`
- `docs/phase6-railway.md`
for behavior parity and deployment operations.

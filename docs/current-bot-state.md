# Current Bot State

## Purpose
This is the canonical documentation for the current integrated bot state in this repository.

It is based on the active backend/frontend code, with older migration notes used only as secondary context.

For the full technical/behavior reference, see:
- `docs/bot-complete-reference.md`

Last reviewed against code on `2026-03-29` after the dedicated `/access` pre-access purchase flow, inactive-by-default new accounts, special-invite timed access, and the post-verify auto-login into pre-access were integrated.

## Test Database Safety

This repository now treats automated tests as a destructive operation against the selected database.

Current code facts:
- the test files force `NODE_ENV=test` internally:
  - `tests/catalog.test.js`
  - `tests/admin.test.js`
  - `tests/auth.test.js`
- test setup deletes and recreates data in the target DB
- config loading now prefers `.env.test` in test mode and supports explicit test-only DB variables in `config/index.js`:
  - `DATABASE_URL_TEST`
  - `POSTGRES_URL_TEST`
  - `DB_HOST_TEST`
  - `DB_PORT_TEST`
  - `DB_NAME_TEST`
  - `DB_USER_TEST`
  - `DB_PASSWORD_TEST`

Mandatory operational rules:
- never run `npm test` against the normal `.env` database
- never point tests at Railway, production, or a local production snapshot DB
- `.env` and `.env.test` must coexist; `.env.test` must not replace `.env`
- `.env.test` should use only `*_TEST` DB variables for the database target
- the test DB must be local and clearly named as a test DB, for example:
  - `volume_alert_test`
  - `my_feature_test`
- names such as `volume_alert_railway_snapshot` are intentionally treated as unsafe for tests

Current guard rail behavior in `config/index.js`:
- in `NODE_ENV=test`, the app aborts if the selected DB does not look local and clearly test-only
- it also aborts if test mode falls back to `.env` without explicit `*_TEST` database variables
- the only bypass is `ALLOW_UNSAFE_TEST_DATABASE=true`, which should be used only for deliberate one-off recovery/debug work

Recommended verification before any test run:
```bash
node -e "process.env.NODE_ENV='test'; const config=require('./config'); console.log(config.db)"
```

Safe workflow:
1. keep normal runtime config in `.env`
2. keep automated test config in `.env.test`
3. point `.env.test` to a local DB cloned specifically for tests
4. run `npm test` only after confirming the resolved DB is the intended test DB

Important:
- the fact that the backend starts on `localhost` does not prove the DB is local
- app port and DB target are independent concerns
- the DB target is determined only by the resolved environment variables/config

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
- Current authenticated UI shape:
  - `/alerts`
    - `Monitored Tokens`
    - `Manual Tokens`
    - `PumpFun`
    - `Alerts`
  - `/monitor`
    - `Recent Tokens`
    - `Old Tokens 1 Week+`
    - `Lateralization Coins`
    - `Bid Zone Coins`

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
  - `src/services/catalog-cleanup-worker.js`
  - `src/services/catalog-worker.js`
  - `src/services/dex-discovery-worker.js`
  - `src/services/lateralization-worker.js`
  - `src/services/meteora-snapshot-worker.js`
  - `src/services/socket-hub.js`
- Important deployment caveat:
  - one Railway backend service normally means one instance
  - if the backend is ever scaled to multiple replicas, or a second process points to the same production DB, every process will start its own workers
  - that would duplicate `catalog`, `cleanup`, `discovery`, `meteora`, and `lateralization` work against the same DB/upstreams
  - horizontal scale of the full backend is therefore not recommended without worker coordination, leader election, or process separation

## Source Of Truth By Area

### Auth and account state
- Source of truth: backend
- Main endpoints:
  - `POST /api/auth/login`
  - `POST /api/auth/login-otp/verify`
  - `POST /api/auth/login-otp/resend`
  - `GET /api/auth/me`
  - `POST /api/auth/logout`
  - `POST /api/auth/logout-all`
  - `POST /api/auth/change-password`
  - `POST /api/auth/verify-email/request`
  - `POST /api/auth/verify-email/confirm`
  - `POST /api/auth/password-reset/request`
  - `POST /api/auth/password-reset/confirm`
  - `GET /api/pre-access/me`
  - `GET /api/pre-access/plans`
  - `GET /api/pre-access/orders`
  - `POST /api/pre-access/orders`
  - `POST /api/pre-access/complete`
  - `POST /api/pre-access/logout`
- Current session transport:
  - backend-issued `HttpOnly` cookie
  - frontend requests use `credentials: include`
  - frontend no longer depends on browser-readable auth token storage
  - session-cookie expiry now defaults to a persistent window (`AUTH_SESSION_EXPIRES_IN || JWT_EXPIRES_IN || 30d`), so browser restarts do not log the user out unless the session is revoked or expires
- Current access/session model:
  - normal bot session and pre-access session are now separate auth states
  - new non-admin accounts default to `inactive`
  - `is_active = false` and `access_status = revoked` are hard blocks
  - `access_status = inactive` and expired access route the user into `/access`
  - successful email verification now creates the pre-access session directly instead of forcing OTP immediately after verify
  - manual login after logout still uses email/password + email OTP

### User config and user overlays
- Source of truth: backend
- Main endpoint:
  - `GET /api/config`
- Returned user-scoped data:
  - `configs`
  - `uiPrefs`
  - `tokens`
  - `blocklist`
  - `starredTokens`
- Important current config behavior:
  - `chain` is now admin-only in the UI and protected on the backend
  - normal users no longer see or mutate `chain`
  - current default values for newly created accounts now include:
    - `min-vol = 5000`
    - `min-mcap = 30000`
    - `old-mcap-max = 100000000`
    - `old-week-mcap-max = 100000000`
    - `old-alert-1h-threshold = 50`
    - `old-alert-6h-threshold = 150`
    - `meteora-alert-1h-threshold = 50`

### Global monitored baseline
- Source of truth: backend catalog/dashboard state
- Active endpoint for monitored hydration:
  - `GET /api/dashboard/monitored`
- This is the endpoint the frontend currently uses for the shared monitored set.
- Current frontend state contract:
  - canonical token store is `trackedTokensByAddress`
  - `Monitored` now keeps `monitoredTokenAddresses`
  - `Manual`, `Recent`, and `Old Week` also resolve from the same tracked store instead of keeping independent full-token copies
- Admin-only global suppression now also exists outside the per-user blocklist:
  - `POST /api/catalog/admin-blocklist`
  - `DELETE /api/catalog/admin-blocklist/:address`
- This admin block is global/backend-owned rather than account-scoped.

### Lateralization Coins
- Source of truth: backend-precomputed lateralization runs
- Persisted tables:
  - `lateralization_runs`
  - `lateralization_results`
- Main endpoint:
  - `GET /api/catalog/lateralized`
- Main worker:
  - `src/services/lateralization-worker.js`
- Current behavior:
  - frontend reads the latest completed persisted run instead of triggering the finder on every request
  - the panel is now mounted in the `/monitor` workspace alongside `Recent Tokens` and `Old Tokens 1 Week+`
  - current row info is intentionally compact:
    - `#rank`
    - symbol/name
    - `MCAP`
    - `AGE`
    - `VOL 1H`
    - `VOL 24H`

### Bid Zone Coins
- Source of truth: backend-computed on demand from `token_market_buckets_1m`
- Main endpoint:
  - `GET /api/catalog/bid-zone`
- Current behavior:
  - frontend reads a separate ranking in `/monitor`
  - this ranking is intentionally not merged into `Lateralization Coins`
  - it is designed to catch support-defended accumulation / bid-area setups that the more conservative lateralization model can reject
- Current model shape:
  - robust support / resistance bands are derived from close-based quantiles
  - score emphasizes:
    - distance to support
    - support-touch clusters
    - recent compression
    - close drift
    - coverage
    - liquidity

### Working currently
- The current architecture separates:
  - discovery of new tokens
  - catalog reevaluation of known tokens
  - cleanup of stale/low-value catalog entries
- Important current conclusion:
  - Dex batch reads remain the main refresh path for monitored state
  - the remaining production risk was upstream `429` storms and synchronized recovery
  - current code now uses a staged Dex throttle/recovery model instead of returning directly from outage to full traffic
  - frontend render cost remains materially lower after the render-pipeline refactor that stopped rebuilding the entire app shell on each update

### Recent / Old Week bars
- Source of truth: frontend-derived from tracked token state
- Why still frontend-owned:
  - MCAP windows are per-user
  - dismiss state is per-user
  - removal logs are local/account-scoped
- Current routed/elegibility behavior:
  - token-level routed eligibility (`_isRecentRouted`, `_isOldWeekRouted`) is maintained in the tracked-token pipeline even when the bars are collapsed
  - `Recent` / `Old Week` list derivation is now paused while the corresponding bar is collapsed
  - reopening either bar rebuilds its visible list immediately from the current tracked token state
- This is why `old-surge` still works while those bars are minimized:
  - alert eligibility no longer depends on the rendered routed lists
- Current workspace placement:
  - `Recent Tokens` and `Old Tokens 1 Week+` now live in `/monitor`, not the main `/alerts` workspace

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
- The active frontend no longer uses the old batch-style Meteora read path

### Market history / MCAP baselines
- Source of truth:
  - backend-persisted `token_market_buckets_1m` for the primary MCAP baseline path
  - backend-persisted `token_market_snapshots` for the canonical visual `VOL 5M` baseline used by `Monitored`
- Primary model:
  - `src/models/token-market-bucket-1m.js`
- Important current note:
  - `token_market_buckets_1m` remains the main pre-aggregated market-history path
  - the catalog worker now also writes fresh `token_market_snapshots` again
  - that snapshot table is currently used to provide a canonical `VOL 5M` visual baseline to the `Monitored` cards
  - this snapshot path does not change the monitored alert engine

## Active Data Flows

### 1. Session bootstrap
1. Frontend attempts cookie-backed session restore with `GET /api/auth/me`.
2. Backend validates the active session.
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
- legacy frontend token storage was removed from the live auth flow

Current login rule:
- login is now two-step for verified accounts:
  - password check
  - email OTP verify
- authenticated session/cookie is only created after OTP success

### 2. Monitored Tokens
- Frontend refresh interval: `3s`
- Current flow:
  - frontend calls `GET /api/dashboard/monitored`
  - backend serves prepared monitored rows from `token_catalog`
  - backend enriches rows with:
    - latest market values persisted in catalog
    - MCAP baseline primarily from `token_market_buckets_1m`
    - legacy fallback baseline from `token_market_snapshots` only when the bucket baseline is missing
    - latest Meteora summary from `token_meteora_snapshots`
- Current intended effect:
  - frontend no longer depends on per-token Dex socket fetches as the main monitored refresh mechanism
  - frontend refresh should read backend-prepared state instead of causing Dex fetches itself
- Current frontend state model:
  - `trackedTokensByAddress` is the source of truth for token objects
  - `Monitored`, `Manual`, `Recent`, `Old Week`, and `Starred` resolve those tokens by address
  - repeated refresh rows are not replaced when the effective token data is unchanged
- Current monitored field-refresh model:
  - hot fields refresh every dashboard poll:
    - `mcap`
    - `priceUsd`
    - `volume5m/1h/6h/24h`
    - `priceChange1h/6h/24h`
    - `prevMcap`
    - `prevVolume5mCanonical`
    - `prevVolume5m`
    - `mcapDelta`
  - cold fields are only reapplied when missing/critical or on the slower recheck window:
    - `symbol`
    - `name`
    - `imageUrl`
    - `pairAddress`
    - `pairUrl`
    - `twitterUrl`
    - `createdAt`
  - current cold-field recheck window is `10m`

Current monitored UI behavior:
- this panel now lives in the `/alerts` workspace
- backend payload now includes `generatedAt`
- frontend shows freshness text in the panel header using that timestamp
- `Monitored Tokens` now paginates the rendered cards
- `Monitored Tokens` now supports compact local search by:
  - symbol
  - name
  - contract/address
- the monitored `TOKENS` pill reflects the filtered result count
- pagination does not change alert logic:
  - the full monitored address set still stays in frontend state
  - only the visible page is rendered
  - hidden pages still receive fresh data through the monitored payload
- the monitored header now behaves as two tuned rows:
  - title isolated on the left
  - sort controls + token count on the top row
  - per-page/page/jump + compact search on the bottom row
  - opening the compact search only pushes the bottom row, not the title/top-row controls
- current compact-search behavior:
  - `Monitored` uses the stabilized dedicated behavior added earlier
  - `Manual`, `Recent`, `Old Week`, and `Alerts` now use click-to-open compact search that stays open while focused
  - those compact searches no longer depend purely on transient hover/focus timing
  - compact searches now support `Enter/Return` to blur/commit the current query without clicking outside the input
- current card-link behavior:
  - the white token symbol itself now opens Dex Screener
  - the action row now contains:
    - `X` search
    - a social/community X button when Dex provided a social URL
  - the `X` search button searches `contract OR $ticker`
  - the social/community button uses URL shape only:
    - `👥` for `x.com/i/communities/...`
    - `👤` otherwise
- current `VOL 5M` card-delta behavior:
  - the main `VOL 5M` number is still the live `5m` volume from catalog/Dex
  - the small delta below it now uses backend-provided `prevVolume5mCanonical`
  - this is visual-only and separate from the monitored alert baseline

### 2a. Lateralization Coins
- Frontend refresh interval: `60s`
- Current flow:
  - frontend calls `GET /api/catalog/lateralized`
  - backend returns rows from the latest completed `lateralization_runs` / `lateralization_results` pair
  - normal panel reads no longer execute the full finder inline
- Current intended effect:
  - lateralization ranking cost is shifted to the backend worker cadence
  - panel reads stay stable and cheap relative to the previous on-demand route shape
- Current UI behavior:
  - the panel now sits in the `/monitor` workspace as the larger analysis card beside the routed-history surfaces
  - header shows freshness text from backend `generatedAt`
  - rows are intentionally thin and ranked, not large cards

### 2b. Bid Zone Coins
- Frontend refresh interval: `60s`
- Current flow:
  - frontend calls `GET /api/catalog/bid-zone`
  - backend computes the list on demand from `token_market_buckets_1m`
  - backend payload includes `generatedAt`
- Current intended effect:
  - catch “support-bid / accumulation-zone” setups separately from the central-range lateralization model
  - use more robust closes/quantiles instead of raw wick extremes as the main support reference
- Current UI behavior:
  - the panel sits beside `Lateralization Coins` inside `/monitor`
  - rows reuse the same ranked compact visual language, but the rail metrics are support-oriented instead of lateralization-oriented

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
- Current UI additions:
  - `Manual Tokens` now supports compact local search by symbol, name, and contract/address
  - `Manual Tokens`, `Recent`, and `Old Week` now also support a compact starred-only toggle
  - these routed/manual table rows can expose an admin-only permanent backend block action when the logged-in user is admin

### 4. Catalog worker
- Worker: `src/services/catalog-worker.js`
- Poll loop: every `2s`
- Dex strategy:
  - uses `/tokens/v1/{chainId}/{tokenAddresses}`
  - fetches up to `30` token addresses per request
  - is budgeted around Dex's documented `300 req/min` token endpoint limit
- Current priority bands:
  - `high`: `>= 100k`
  - `normal`: `30k-100k`
  - `low`: `< 30k`
  - `dormant`: missing/no useful Dex state
- Priority timing:
  - `high-hot`: `2s`
  - `high-warm`: `3s`
  - `high-cold`: `5s`
  - `normal`: `4s`
  - `normal` boosted by `PCHANGE`: `3s`
  - `low-near`: `15s`
  - `low-dust`: `10m`
  - `dormant`: `30m`
- Important hardening already present:
  - `dex-unavailable` preserves existing eligibility/priority instead of collapsing directly into `dex-missing`
  - newly added manual tokens get `5s` retry cadence until first classification in normal mode
  - `pumpfun-migrated` tokens now persist `migration_grace_until`
  - during the first `10m` after migration, they cannot fall into the `low-dust` cadence even if Dex sees them below `15k`
  - while inside that grace, `<15k` migrated tokens still use at least the `low-near` cadence floor (`15s`), while `30k+` and `100k+` continue following the normal higher-priority buckets
- Current write order inside token evaluation:
  - `token_catalog` is updated first
  - `token_market_buckets_1m` is upserted immediately after in the same evaluation
  - fresh raw `token_market_snapshots` are no longer written by the worker
  - this keeps current monitored values fresh while using minute-bucket history instead of near-real-time raw snapshot persistence
- Current Dex throttle behavior:
  - global cooldown only activates on the `10th` consecutive Dex `429`
  - cooldown keeps batch size at `30` but raises batch delay to `400ms`
  - cooldown processes only `high` and `user-manual`
  - staged recovery then runs:
    - `5` cycles: `high` + `manual`, delay `500ms`
    - `5` cycles: add `normal`, delay `350ms`
    - `5` cycles: add `low-near`, delay `200ms`
    - `5` cycles: add `low-dust`, delay `150ms`
    - then return to normal `100ms`
- Current Dex-unavailable retry timings during throttle:
  - `high`: `15s`
  - `normal`: `2m`
  - `low-near`: `3m`
  - `low-dust`: `2m`
  - manual bootstrap: `15s`
- Current runtime instrumentation:
  - worker status now exposes:
    - `lastRunDurationMs`
    - `lastLoopOverrunMs`
    - `lastScheduledDelayMs`
    - `lastTotalDueCount`
    - `lastBacklogCount`
    - `lastDueByPriority`
    - `lastBacklogByPriority`
    - `lastMaxOverdueMs`
    - `lastMaxOverdueMsByPriority`
    - `lastDexBatchCount`
    - `lastProcessBatchCount`
    - `lastRateLimitActive`
    - `lastRateLimitBackoffRemainingMs`
    - `lastRateLimitFilteredCount`
    - `lastThrottleMode`
    - `lastRecoveryPhase`
    - `lastThrottleBatchDelayMs`
  - these are available through `GET /api/admin/ws-status`
  - scheduler now compensates for drift without overlap:
    - if the cycle finishes under `2s`, the next wait is reduced
    - if the cycle overruns `2s`, the next cycle is scheduled immediately
  - low-priority reevaluation is now jittered to reduce synchronized cohorts:
    - `low-near`: up to `+3s`
    - `low-dust`: up to `+60s`
    - `dormant`: up to `+120s`
    - `high` and `normal` still remain unjittered

### 4a. Catalog cleanup worker
- Worker: `src/services/catalog-cleanup-worker.js`
- Poll loops:
  - `quarantine`: every `15m`
  - `soft archive`: every `48h`
  - the soft-archive timer anchor is persisted in DB under `catalog_cleanup_soft_archive_last_run_at`, so restarts do not reset the `48h` wait
- Purpose:
  - quarantine weak discovery tokens
  - soft archive stale/low-value tokens
  - keep low-signal catalog entries from competing with hot monitored tokens
- Current rule shape:
  - protected user-linked tokens are excluded
  - `dexscreener-discovery` weak tokens go to `quarantine`
  - tokens already marked `cleanup_quarantine` do not go to `soft archive` in the same pass
  - soft archive now applies to low-dust tokens from all sources, including `dexscreener-discovery` and `pumpfun-migrated`
  - `quarantine` stays frequent and independent from archive cadence
  - soft archive runs every `2d`
  - each soft-archive run archives at most `400` addresses
  - archive order is oldest captured first using `first_seen_at ASC`, then `last_seen_at ASC`
  - `soft archive` now also deletes persisted `token_market_buckets_1m` rows and Meteora snapshots for the archived addresses
  - legacy market snapshots may still exist in older environments, but fresh runtime market history is now the `1m` bucket store
  - legacy `token_market_snapshots` are also deleted for archived addresses
  - `quarantine` still does not delete history

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
  - inserts new addresses into `token_catalog` with source `dexscreener-discovery`
  - schedules initial evaluation for new tokens only
- Important current rule:
  - discovery no longer refreshes known catalog rows
  - existing catalog addresses are skipped rather than re-upserted/re-scheduled
  - exception: rows in `cleanup_soft_archive` are reactivated if they reappear in Dex discovery
  - reactivated rows return as `dexscreener-discovery`, clear the archive suppression, and are scheduled for immediate reevaluation
  - discovery is paused while Dex throttle mode is active, including staged recovery

### 5. Meteora flow
- Snapshot worker: `src/services/meteora-snapshot-worker.js`
- Worker polls eligible catalog tokens every `30s`
- Read routes:
  - `GET /api/catalog/meteora/:address/history`
- Active frontend read path:
  - embedded `meteora` payload inside `GET /api/dashboard/monitored`
- Current read path is DB-backed, not upstream-fetch-backed
- Current alert behavior on top of Meteora data:
  - a dedicated `meteora-surge` alert now exists in frontend alert generation
  - it uses the persisted `change1h` Meteora summary from the dashboard payload
  - it is independently toggleable from normal surge alerts
  - it is independently muteable in `Sound by alert type`
  - it currently reuses the `old1h` sound slot/effect while keeping its own sound-enable key
- Current anti-noise rule for Meteora alerting:
  - requires `TVL current >= 10k`
  - requires inferred `TVL baseline 1h >= 10k`
  - requires `change1h >= meteora-alert-1h-threshold`
  - default threshold is `50%`

### 6. PumpFun metadata enrichment
- Frontend still resolves some PumpFun token images/metadata through:
  - `GET /api/catalog/pumpfun/:mint/meta`
- This happens when incoming PumpFun tokens are missing image/meta in local state
- These are individual per-mint requests, not socket messages
- This route remains an auxiliary traffic source, but the main Dex overload issue was addressed in the catalog worker rather than here
- Current metadata/image behavior:
  - PumpFun image resolution is more tolerant for this route than the broader hardened URL path
  - if PumpFun returns no usable image, the backend now continues to metadata/fallback sources instead of aborting early
  - this restored missing PumpFun token images without undoing the broader SSRF protections
- Current operational note:
  - this route is separately rate-limited and can still produce frontend-visible `429` if a screen resolves too many PumpFun images in a short burst
  - this is distinct from DexScreener rate pressure and should not be confused with the catalog worker's Dex usage

## Current Market History / Finder Contract

### `GET /api/catalog/history/:address`
- This route now reads from `token_market_buckets_1m`, not fresh raw `token_market_snapshots`
- Response shape still returns `snapshots` for compatibility, but each item is a `1m` bucket row:
  - `ts`
  - `mcap` / `price` as the bucket close
  - `open/high/low/close` fields
  - `sampleCount`
  - `source`

### `GET /api/catalog/lateralized`
- Current state: precomputed read route
- The route now reads the latest completed persisted run for the requested parameter set
- Precompute is done by `src/services/lateralization-worker.js`
- Worker behavior:
  - one run on backend boot
  - periodic recompute every `20m`
- If no completed run exists yet for that parameter set, the route returns `404`
- Current route contract:
  - returns `generatedAt`, `runId`, `requestedHours`, `count`, and `candidates`
  - also returns run metadata:
    - `candidateCount`
    - `resultCount`
    - `minMcap`
    - `minVol24h`
  - each candidate includes:
    - `mcap`, `catalogMcap`, `windowMcap`
    - `volume1h/6h/24h`
    - `rangePct`, `driftPct`, `coverageRatio`
    - `windowHoursUsed`, `minimumWindowHours`
    - liquidity/ranking diagnostics such as `liquidityPenalty`

### Current lateralization-finder rule shape
- Windowing:
  - `< 1M`: minimum `16h`
  - `>= 1M`: minimum `32h`
- Current range / drift bands:
  - `90k - <1M`: `range <= 50%`, `drift <= 20%`
  - `1M - <4M`: `range <= 50%`, `drift <= 16%`
  - `4M+`: `range <= 25%`, `drift <= 14%`
- Current position rule:
  - token must sit between `15%` and `85%` of its window range
- Current liquidity rules:
  - `vol24h` remains a hard filter
  - recent-liquidity dead-zone filter removes only tokens with:
    - `vol1h < 100`
    - and `vol6h < 1.5k`
  - low `vol1h` otherwise acts through ranking penalties rather than automatic exclusion
  - strong recent liquidity (`vol1h >= 1k` and `vol6h >= 20k`) gets a positive score bonus
- Current age / bid-zone bias:
  - newer `90k-180k` tokens get a modest ranking bonus
  - stale low caps (`>= 30d` old and `< 150k`) get a strong penalty
- Current candidate-pool guardrail:
  - sub-`1M`, `1M-4M`, and `4M+` use separate pre-pool limits before bucket expansion
  - this is now mainly a compute/persistence guardrail for the worker output, not a request-time latency guardrail

## Current UI/Behavior Contract

### Admin-only global token block
- Current intent:
  - give the admin account a one-click permanent backend block for trash tokens
  - make cleanup/global suppression faster than relying on per-user blocklist
- Current behavior:
  - admin-only buttons are exposed in the relevant token UIs
  - blocked token is inserted into backend `admin_blocked_tokens`
  - frontend removes it immediately from active lists after the request succeeds
  - blocked token should not be revived by later catalog upserts
  - manual-track now rejects admin-blocked addresses
- This is distinct from the normal per-user blocklist:
  - normal blocklist remains account-scoped
  - admin block is global for all users

### Login and account surface
- The frontend login is no longer just a raw credential form.
- It now reflects the current backend-owned auth model and includes:
  - explicit auth-state feedback
  - client-side login validation
  - password show/hide
  - caps-lock hint
  - focus recovery after failed submit
  - `Create Account`
  - `Forgot Password`
  - `Access Help`
  - email-verification flow
  - password-reset flow
  - email-OTP verification modal
  - dedicated pre-access `/access` flow
  - authenticated `Change Password`
- Current login/bootstrap paths:
  1. registration + verify path:
     - user registers with invite
     - user confirms email from the verification link
     - backend creates a pre-access session
     - frontend routes directly to `/access`
  2. manual login path:
     - `POST /api/auth/login`
     - backend verifies email/password
     - backend sends email OTP
     - `POST /api/auth/login-otp/verify`
     - backend branches by access state:
       - valid access -> normal bot session
       - `inactive` / expired -> pre-access session
       - `revoked` / deactivated -> blocked
  3. normal session restore path:
     - `GET /api/auth/me`
     - normal config/dashboard hydration path
  4. pre-access restore path:
     - `GET /api/pre-access/me`
     - billing/pre-access hydration path only

Current login/account implementation status:
- login, registration, email verification, pre-access purchase flow, password reset, and change password are implemented
- session restore after hard refresh, browser close, and normal browser restart is working in the integrated frontend while the cookie session remains valid
- the live auth flow is cookie-backed and no longer depends on browser-readable token storage
- auth UX is materially more complete than the older "raw login shell" state
- current MoonPay sandbox/dev validation path uses the frontend dev server as the public origin:
  - Vite now proxies `/api` and `/socket.io` to the backend in development
  - a single public tunnel on the frontend origin can therefore serve both provider redirect and backend webhook paths during local sandbox testing

Current login/account follow-up:
- keep refining support/recovery wording and auth-state messaging
- keep validating that frontend UX changes do not drift from the backend-owned session model
- avoid reintroducing frontend-readable session state as part of convenience UX work

### Auth and security hardening checkpoint
- Session auth is now cookie-backed with `HttpOnly` cookies instead of browser-readable auth token storage.
- Frontend debug/token exposure that could leak session state in the console was removed.
- Cookie-authenticated mutating requests now require trusted `Origin` / `Referer` on the backend.
- Frontend render surfaces that interpolate token metadata, account copy, auth messages, links, and config values now broadly use:
  - `escapeHtml(...)`
  - `sanitizeHttpUrl(...)`
  - `sanitizeOptionalHttpUrl(...)`
- Selector interpolation that could be destabilized by unescaped dynamic values is also being reduced, including `CSS.escape(...)` for dynamic selectors in UI state wiring.
- A pragmatic CSP is now active:
  - frontend `meta http-equiv="Content-Security-Policy"` in `frontend/index.html`
  - backend `helmet({ contentSecurityPolicy: ... })` in `src/server.js`
- CSP currently allows only the sources required for the app to function:
  - self-hosted scripts
  - Google Fonts / Fontshare styles
  - HTTPS images
  - local/dev and production API + websocket connections
  - `data:` / `blob:` where needed for custom audio and browser-managed assets

Current honest security assessment:
- Auth/session security is materially stronger than before.
- The frontend is significantly harder to exploit via straightforward XSS than it was before the hardening pass.
- Recent backend hardening completed:
  - each login now gets a unique session identity
  - socket revocation is tracked per session instead of only per user
  - periodic cleanup now includes login OTP challenges, email verification tokens, and password reset tokens
  - backend auth routes now reject malformed OTP challenge tokens, verification tokens, and reset tokens earlier instead of carrying obviously invalid input deeper into auth flows
  - websocket auth now follows the documented cookie-first session model in live environments instead of keeping a general-purpose token handshake path
- Recent frontend render-surface hardening completed:
  - auth/account UI text for session identity and email-verification / login-OTP hints was moved off direct HTML-string interpolation and into DOM text hydration
  - blocklist chips are now built as DOM nodes instead of interpolated HTML strings
  - manual, monitored, recent, and old-week search inputs now restore the typed query through DOM input values instead of HTML attribute interpolation
  - primary config-grid values now hydrate through DOM input/select state instead of being embedded directly into HTML `value` / `selected` attributes
  - alerts search, PumpFun controls, starred address-only cards, PumpFun toasts, and star toggles all reduced reliance on inline HTML mutation / interpolation further
  - live rows in `ALERTS`, `MONITORED TOKENS`, and `PUMPFUN - LIVE` now build their external-data-heavy card content through DOM nodes instead of row-level HTML-string interpolation
  - the PumpFun migration strip now hydrates through DOM chips instead of string-joined HTML
- Recent backend validation hardening completed:
  - `GET /api/admin/logs` now validates `limit` explicitly as a positive integer and rejects malformed `success` query values instead of relying on implicit coercion
  - admin user-target routes now use the same positive-ID parsing contract already used elsewhere in the admin surface
- Risk is reduced, but not eliminated:
  - remaining risk is now mostly deeper structural / architectural, not the previously most-exposed auth/account/config/list surfaces
  - the next line of defense after the current hardening is targeted defense-in-depth on lower-traffic render helpers, operational limits, and observability

Current security priority order:
1. Defense-in-depth render follow-up
   - the highest-risk auth/account/config/list surfaces have already received the main hardening pass
   - remaining work is selective cleanup of lower-traffic HTML-string helpers where the safety win justifies the churn
   - preserve the current CSP and cookie-auth posture while keeping `escapeHtml(...)`, URL sanitization, and `CSS.escape(...)` as the baseline floor

2. Auth regression coverage recovery
   - test entrypoint and live cookie + OTP coverage are back in place
   - keep extending coverage for:
     - login OTP verify/resend edge cases
     - cookie-backed session restore
     - password reset / password change revocation behavior
     - admin session revocation paths
     - malformed auth token / challenge inputs at backend boundaries

3. Stronger secondary verification follow-up
   - current secondary verification is email OTP
   - if stronger account protection is needed later, the next upgrade path is TOTP + backup codes
   - keep this as a later hardening step, not the immediate next priority

#### Next active path
1. Defense-in-depth hardening
   - review lower-traffic render helpers and backend edges that still rely on older patterns
   - prioritize changes that improve safety without changing alerting, catalog, routing, or operator workflow
   - keep operational visibility, rate/retention controls, and abuse resistance as the main next levers

2. Performance investigation and latency reduction
   - measure real response time for:
     - `GET /api/dashboard/monitored`
     - `GET /api/config`
     - `PATCH /api/config`
   - determine whether the main remaining bottleneck is:
     - SQL / snapshot read volume
     - payload size
     - frontend bootstrap sequencing
   - if needed, reduce bootstrap payload cost before adding more features
   - likely next target is trimming or staging `dashboard/monitored` hydration further if production still feels slow

3. Stronger secondary verification follow-up
   - if the account-risk model grows, evaluate TOTP + backup codes after the render-surface pass
   - keep email OTP as the current secondary gate until then

#### Email infrastructure checkpoint
- Chosen provider for the first real email rollout: `Resend`
- Email sending should remain behind a backend service layer instead of being wired directly inside auth routes
- Current prepared config/env surface:
  - `EMAIL_ENABLED`
  - `EMAIL_PROVIDER`
  - `EMAIL_FROM`
  - `EMAIL_REPLY_TO`
  - `APP_BASE_URL`
  - `RESEND_API_KEY`
- Current prepared backend service direction:
  - generic email send service
  - auth-specific email helpers for:
    - email verification
    - password reset
- Current backend auth/email status:
  - registration now attempts to send an email-verification link when email delivery is enabled
  - unverified accounts cannot log in
  - authenticated users can request verification-email resend
  - verification confirm route is in place and consumes single-use tokens
  - password-reset request + confirm routes are in place
  - password reset now revokes all active sessions after success
  - login now sends an email OTP before session creation
  - login OTP resend + verify routes are in place

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
- PumpFun runtime is now restricted to `/alerts`; `/monitor` does not mount or keep the PumpFun live workspace active

### Trade terminal links
- `Axiom` now prefers `pairAddress` for monitored/routed/manual token rows when available
- `PUMPLIVE` still preserves its custom Axion/Axiom-address override path instead of using the generic monitored fallback order

### Alerts
- Standard monitored `VOL` and `MCAP` alerts share cooldown
- HVNC remains separate
- Old-surge remains separate
- Alerts are still frontend-owned behavior
- Monitored alert evaluation now runs both on:
  - live patch merges
  - `GET /api/dashboard/monitored` rebuilds
- the `Alerts` panel now supports local text search by:
  - symbol
  - name
  - contract/address
- the alerts search now uses the same compact-search interaction model as the other lupas, including `Enter/Return` to commit by blurring the input
- alerts are now restored from browser-local storage per account scope
- alerts history is currently capped at the most recent `100` entries in runtime state and browser-local storage
- users can clear:
  - all alerts at once via `Clean All`
  - a single alert card via the card-level `×` button
- current workspace/runtime rule:
  - alerts are evaluated only inside `/alerts`
  - `/monitor` still receives live dashboard data but does not run frontend alert evaluation
- current alert-link behavior:
  - `X Buscar CA /` opens X search using `contract OR $ticker`
  - the separate social link now renders only the emoji:
    - `👥` for X community URLs
    - `👤` for normal X profile URLs

## Persistence Model

### Backend-persisted per account
- auth/session state
- user configs
- user UI prefs
- manual tokens
- blocklist
- starred tokens

### Browser-local but account-scoped
- dismissed Recent set
- dismissed Old Week set
- Recent removal log
- Old Week removal log
- alert cards
- custom sound assets

## Workspace Split And Multi-Tab Behavior

### `/alerts`
- owns the high-churn live runtime:
  - `Monitored Tokens`
  - `Manual Tokens`
  - `PumpFun`
  - `Alerts`
- keeps the frontend-owned alert pipeline active
- does not mount `Recent`, `Old Week`, or `Lateralization`

### `/monitor`
- is the lighter dashboard-analysis workspace
- mounts:
  - `Recent Tokens`
  - `Old Tokens 1 Week+`
  - `Lateralization Coins`
  - `Bid Zone Coins`
- still consumes `GET /api/dashboard/monitored` so routed/history surfaces stay current
- does not run:
  - frontend alerts
  - PumpFun runtime
  - PumpFun GC

### Multi-tab coordination
- monitor tabs now use `BroadcastChannel` leader election
- only one active `/monitor` tab keeps the continuous polling loop for:
  - `GET /api/dashboard/monitored`
  - `GET /api/catalog/lateralized`
  - `GET /api/catalog/bid-zone`
- follower `/monitor` tabs receive monitored/lateralized/bid-zone snapshots from the leader instead of duplicating that polling
- this coordination currently applies only to `/monitor`
- `/alerts` still runs independently per tab because alerts are still frontend-owned behavior

## Important Current Implementation Notes

### `D` column / MCAP delta
- `GET /api/dashboard/monitored` currently exposes:
  - `prevMcap`
  - `mcapDelta`
  - `prevVolume5mCanonical`
- Backend implementation today:
  - route requests a larger recent snapshot window per token
  - it filters to snapshots with valid `mcap`
  - it uses the newest valid snapshot as current
  - it then looks for a valid baseline around `~5 minutes` back
  - if no near-5m point exists, it falls back to the oldest valid snapshot still inside the fetched window

Current limitation:
- if there is no pair of valid snapshots in the fetched window, `mcapDelta` still remains `null`
- this is acceptable fallback behavior for now
- for `Monitored` `VOL 5M`, the route now also exposes `prevVolume5mCanonical`
- if the backend does not yet have enough market snapshots for that token, the visual delta still shows `-`

### Routed/manual table sorting
- `Manual Tokens`, `Recent Tokens`, and `Old Tokens 1 Week+` all support:
  - `VOL`
  - `MCAP`
  - `PCHANGE`
  - `AGE`
- `Manual Tokens`, `Recent Tokens`, and `Old Tokens 1 Week+` now also support compact local search by:
  - symbol
  - name
  - contract/address
- search inputs preserve typing/focus through rerenders so the user can continue typing while live state refreshes
- `AGE` currently supports two directions in the UI:
  - `NEWEST`
  - `OLDEST`
- `Manual Tokens` now has the same `#` ranking column as Recent/Old
- The duplicate footer-level `Per Page` control was removed from Recent/Old; the active `Per Page` control is the header one
- `Recent Tokens` now shows a green live indicator with a slower “breathing” pulse while the bot is active
- current persistence split:
  - `MCAP` min/max filters remain backend-persisted user configs
  - collapse state, sort state, starred-only toggles, and per-page controls are backend-persisted in `user_ui_prefs`
  - free-text search inputs remain browser-local UI state only

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
  - the active frontend is no longer wasting requests on the old batch-style Meteora path
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
  - if a token fires one alert type, other alert types for that same token are blocked for `5m`
  - `Surge` is evaluated before local `VOL/MCAP`, so it wins when both would qualify in the same cycle
- semantic note:
  - the alert engine still uses `prevVolume5m` as the session-local previous observed `volume5m`
  - the newer `prevVolume5mCanonical` field is visual-only for the `Monitored` cards
  - the visual cleanup of the monitored `VOL 5M` delta therefore did not change alert behavior

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
- The same `old-surge` engine covers both routed buckets:
  - `Recent Token Surge`
  - `Old Token Surge`
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
- current sound persistence split:
  - sound enable/disable and volume are backend-persisted user configs
  - custom uploaded sound files remain browser-local and account-scoped

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
- No confirmed high-priority regression is open at this moment.
- Current active watchpoint:
  - monitor catalog-worker backlog/overrun metrics in production-like runtime
  - if `high` or `normal` backlog appears persistently, treat that as the next performance/debug target for monitored freshness

## VPS Migration Reminder
- When migrating from Railway to a private VPS, treat public exposure hardening as a high-priority deployment task, not an optional cleanup item.
- At minimum, the VPS migration should explicitly verify:
  - only intended public ports are exposed
  - backend is preferably bound behind a reverse proxy instead of being left broadly reachable on arbitrary ports
  - HTTPS is enforced
  - firewall / security-group rules are intentionally set, not left permissive by default
  - admin access is protected beyond "normal login" when possible, such as IP allowlisting, VPN, or Tailscale
  - production cookies, CORS/origin rules, and rate limiting are reviewed specifically for the new public-facing topology
- Railway reduces some infra footguns by default; a raw VPS does not. Re-check public exposure assumptions before considering a VPS migration production-safe.

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

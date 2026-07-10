# Bot Reference

## Purpose
This document is the technical reference for the current bot implementation.

It is meant to hold the deeper implementation details that are too large for the root `README.md`.

Use this document for:
- behavior review
- architecture recall
- rule verification
- debugging which file owns which feature
- detailed review of workers, alerts, persistence, endpoints, and feature contracts

Use `README.md` as the primary operational entry point.

Last reviewed against code and the launch deployment model on `2026-07-10` after reconciling the web/worker runtime split, distributed worker leases, Live leader-tab polling, performance metrics, emergency switches, QuickNode/Jupiter lab status, `gmgnClaimSignalWorker`, `solUsdPrice`, and the operations runbook.

## Current Deployment Topology

Current production-like topology:
- frontend:
  - deployed separately from the backend
  - currently served from Vercel
  - public host: `https://www.trendscope.pro`
- backend:
  - runs on a private VPS
  - managed by split `systemd` units:
    - `volume-bot-alert-web.service`
    - `volume-bot-alert-worker.service`
  - reverse-proxied by `nginx`
  - public host: `https://api.trendscope.pro`
  - intended launch runtime:
    - web: `RUN_SOCKET_HUB=true`, `RUN_BACKGROUND_JOBS=false`
    - worker: `RUN_SOCKET_HUB=false`, `RUN_BACKGROUND_JOBS=true`
- database:
  - PostgreSQL runs on the same VPS as the backend
  - intended to stay private/local rather than publicly exposed
- repository note:
  - `railway.json` remains in the repo, but it is now legacy deployment residue / historical context rather than the primary production deployment contract
  - current frontend runtime defaults and CSP allowlists now point at `https://api.trendscope.pro` rather than Railway

Operational runbook:
- `docs/ops-runbook.md`

Lab/probe status:
- QuickNode/Jupiter/onchain scripts and docs are not launch-critical production paths unless explicitly promoted later.
- Reference probe commands:
  - `npm run quicknode:smoke`
  - `npm run quicknode:probe`
  - `npm run quicknode:dry-run`
  - `npm run quicknode:continuous-dry-run`
  - `npm run quicknode:logs-dry-run`
  - `npm run jupiter:probe`

## Test Environment And Database Safety

This project has an important operational trap that is now explicitly documented because integration tests are destructive against the selected database.

Code-backed behavior:
- `npm test` now runs the isolated unit group and does not intentionally use the real database
- `npm run test:integration` runs sequentially:
  - `npm run db:schema-check:test`
  - `tests/admin.test.js`
  - `tests/auth.test.js`
  - `tests/billing.test.js`
  - `tests/catalog.test.js`
  - `tests/config.test.js`
  - `tests/dashboard.test.js`
  - `tests/mock-trading-routes.test.js`
- `npm run test:all` runs unit and integration groups
- multiple test entrypoints force `NODE_ENV=test` themselves, including:
  - `tests/catalog.test.js`
  - `tests/admin.test.js`
  - `tests/auth.test.js`
  - `tests/config.test.js`
  - `tests/billing.test.js`
- test setup resets data in the target database rather than using a read-only strategy
- `config/index.js` now contains a guard rail for test DB selection

Current config resolution rules in `config/index.js`:
- test mode prefers `.env.test` when present
- test mode prefers explicit test-only DB variables over normal runtime DB variables:
  - `DATABASE_URL_TEST`
  - `POSTGRES_URL_TEST`
  - `DB_HOST_TEST`
  - `DB_PORT_TEST`
  - `DB_NAME_TEST`
  - `DB_USER_TEST`
  - `DB_PASSWORD_TEST`
- test mode records whether explicit test config was used via `db.explicitTestConfig`

Guard rail behavior:
- abort if `NODE_ENV=test` resolves to a DB host that does not look local
- abort if the selected DB name does not clearly look like a test DB
- abort if test mode is still using `.env` without explicit `*_TEST` database variables
- allow bypass only with `ALLOW_UNSAFE_TEST_DATABASE=true`

Operational rules that must be followed:
- never use the normal `.env` DB for automated tests
- never point automated tests at Railway or any production/shared database
- never point automated tests at a local snapshot/import that is not clearly isolated as a test DB
- keep `.env` for normal runtime and `.env.test` for automated tests; do not replace one with the other
- in `.env.test`, do not mix normal DB variables with test DB variables
- use a clearly isolated local DB name such as `volume_alert_test`
- treat names like `volume_alert_railway_snapshot` as unsafe for tests even if they are local

Recommended verification command before integration tests:
```bash
node -e "process.env.NODE_ENV='test'; const config=require('./config'); console.log(config.db)"
```

What this avoids:
- starting the backend locally while still targeting a remote DB
- assuming `localhost` app ports imply a local DB target
- accidentally deleting production or snapshot data because the wrong env source won precedence

## High-Level Product Shape

The bot is a Solana monitoring app with:
- authenticated multi-user frontend
- Express backend
- PostgreSQL persistence
- backend workers for discovery, GMGN ingestion, catalog cleanup, catalog evaluation, minute-bucket market history, Meteora snapshots, token-risk enrichment/review sync, optional bid-zone snapshots, and mock-trading take-profit execution
- backend-only PumpFun migration and optional pre-migration bucket capture

The UI is now centered around two authenticated workspaces:
- `/alerts`
  - `Monitored Tokens`
  - `Manual Tokens`
  - `Alerts`
- `/monitor`
  - visible workspace label: `RADAR`
  - `Recent Tokens`
  - `Old Tokens 1 Week+`
  - `Bid Zone Coins`

The auth/account surface now also includes:
- `/`
  - public product landing
  - public pricing preview
- `/login`
  - local login
  - `Create Account`
  - `Forgot Password`
  - linked-only Google/Discord sign-in
- `/access`
  - authenticated pre-access purchase flow
- `/account-security`
  - limited recovery/settings surface for linked identities and billing history

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
- UI-pref load / sync
- workspace routing / URL sync
- monitored dashboard polling
- monitored freshness label updates from backend payload timestamps
- local token-state merge
- alert decisions
- routed-bar derivation
- monitor-tab `BroadcastChannel` coordination
- manual token local persistence
- auth modal state
- auth form validation and focus recovery
- cookie-session bootstrap / revocation handling
- frontend-side auth hardening for render surfaces

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
- cookie-backed auth/session transport
- trusted-origin checks for mutating cookie-authenticated requests
- backend CSP via `helmet`

Deployment model:
- the launch production model uses split runtime roles through:
  - `RUN_SOCKET_HUB`
  - `RUN_BACKGROUND_JOBS`
  - `BACKGROUND_WORKER_GROUPS`
- current runtime roles are:
  - `combined`
  - `web`
  - `background`
  - `idle`
- current default remains `combined`
- `combined` is local development / emergency rollback shape
- public web process should run with:
  - `RUN_SOCKET_HUB=true`
  - `RUN_BACKGROUND_JOBS=false`
- background worker process should run with:
  - `RUN_SOCKET_HUB=false`
  - `RUN_BACKGROUND_JOBS=true`
- the code now uses distributed worker leases in Postgres for the worker set, but operators should still avoid starting arbitrary extra background processes without checking `workerLeases`
- rate limit state is process-local memory, so multiple web instances need shared-store work or deliberate rate-limit tuning before they become the normal production shape

Admin worker status endpoint:
- `GET /api/admin/ws-status`
- requires authenticated admin session
- also returns:
  - `runtime.role`
  - `runtime.socketEnabled`
  - `runtime.backgroundJobsEnabled`
  - `runtime.workerGroupsRequested`
  - `runtime.workerGroupsActive`
  - `runtime.workerGroupsSkipped`
- returns socket hub status plus:
  - `catalogWorker`
  - `catalogCleanupWorker`
  - `meteoraSnapshotWorker`
  - `dexDiscoveryWorker`
  - `bidZoneWorker`
  - `tokenRiskEnrichmentWorker`
  - `tokenRiskReviewSyncWorker`
  - `mockTradingTakeProfitWorker`
  - `gmgnDiscoveryWorker`
  - `gmgnClaimSignalWorker`
  - `solUsdPrice`
  - `workerLeases`
  - `gmgn`
  - `dexscreener`

### Backend workers

#### Catalog worker
File:
- `src/services/catalog-worker.js`

Role:
- reevaluates tokens already in `token_catalog`
- updates eligibility, priority, latest market stats
- inserts `1m` market-bucket snapshots
- evaluates backend-owned high-cap dump detections from those `1m` buckets
- persists dump events / rule state when the backend-owned rule fires
- consumes DexScreener in batch mode instead of one token per request

Cadence:
- scheduler loop every `2s`
- non-overlapping scheduler uses drift compensation:
  - if a cycle finishes early, the next wait is shortened to preserve the target cadence
  - if a cycle overruns, the next cycle is scheduled immediately

Dex throughput model:
- target budget is `300 requests/minute`
- each Dex batch request carries up to `30` token addresses
- the worker uses the per-cycle token budget implied by that request budget instead of the old fixed small batch model
- due rows are ordered with finer queue priority:
  - `high-hot`
  - `high-warm`
  - `high-cold`
  - `normal`
  - `low-near`
  - `low-dust`
  - `dormant`

Priority bands:
- `high`: `>= 100k`
- `normal`: `30k-100k`
- `low`: `< 30k`
- `dormant`: no useful Dex state / no MCAP

Priority recheck timings:
- `high-hot`:
  - `mcap >= 100k`
  - `6h volume >= 30k`
  - `2s`
- `high-warm`:
  - `mcap >= 100k`
  - `15k <= 6h volume < 30k`
  - `3s`
- `high-cold`:
  - `mcap >= 100k`
  - `6h volume < 15k`
  - `5s`
- `normal`: `4s`
- `normal` boosted by price change:
  - `6h >= 200` can reduce to `3s`
  - `1h >= 150` can reduce to `3s`
- `low-near` (`15k-30k`): `15s`
- `low-dust` (`< 15k`): `10m`
- `dormant`: `30m`

Low-activity override:
- independent from the pure MCAP bands, automatic tokens with `volume24h < 5k` are now treated as low-activity
- those rows are forced onto at least a `3m` recheck floor
- for tokens younger than `24h`, missing/zero `volume24h` is filled from positive shorter windows before this decision when available
- `user-manual` tokens are exempt from that low-activity suppression path

Young-token volume-window fill:
- applies during Dex catalog reevaluation and GMGN ingestion
- for tokens `< 6h`, missing/zero `vol6h` is filled from the largest positive shorter window (`vol1m`, `vol5m`, `vol1h`)
- for tokens `< 24h`, missing/zero `vol24h` is filled from the largest positive shorter/filled window (`vol1m`, `vol5m`, `vol1h`, `vol6h`)
- positive native `6h`/`24h` values from the upstream are preserved
- this keeps active very young tokens from showing stale `0` long-window volume while shorter-window volume is already accumulating

Migrated-token grace:
- `pumpfun-migrated` catalog rows now persist `migration_grace_until`
- migration grace is assigned even when the PumpPortal migration payload does not include a usable initial market cap
- unevaluated migrated rows are prioritized ahead of normal/low/dormant backlog so they get an initial Dex evaluation promptly
- for the first `10m` after migration, the worker does not let those tokens fall into the `low-dust` cadence
- if Dex sees a freshly migrated token below `15k` during that window, it still uses the `low-near` floor (`15s`)
- if it moves into `30k+` or `100k+`, it follows the normal `normal` / `high-*` cadence immediately
- after the grace expires, normal `<15k` / `15k-30k` / `30k+` rules apply again

Throttle / outage handling:
- Dex batch size remains `30`
- normal batch delay is `100ms`
- a global Dex throttle only activates after `10` consecutive upstream `429` responses
- cooldown phase:
  - only `high` + `user-manual`
  - batch delay `400ms`
- staged recovery after cooldown:
  - phase `high-manual`: `5` cycles, delay `500ms`
  - phase `normal`: `5` cycles, delay `350ms`
  - phase `low-near`: `5` cycles, delay `200ms`
  - phase `low-dust`: `5` cycles, delay `150ms`
  - then returns to normal scheduling

Dex-unavailable retry timings during throttle:
- `high`: `15s`
- `normal`: `2m`
- `low-near`: `3m`
- `low-dust`: `2m`
- new manual bootstrap: `15s`

Special handling:
- `dex-unavailable` preserves the current eligibility/priority instead of immediately downgrading the token to `dex-missing`
- persistent automatic GMGN rows that keep returning `dex_unavailable`, have `VOL 5M = 0`, and have already accumulated at least `300` consecutive evaluation errors trigger a fresh GMGN token-info liquidity lookup; if fresh liquidity is below `$1,000`, the token is admin-blocked as `gmgn-liquidity:under-1k-spam:*`, otherwise it is demoted to `gmgn-dex-unavailable-zombie` / `gmgn_dex_unavailable_zombie` with dormant priority
- new manual tokens retry quickly until first real classification
- manual launchpad tokens request fresh GMGN token-info before Dex evaluation only while pending, already in a `gmgn-*` state, or missing/unavailable on Dex; Dex-confirmed manual rows use GMGN token-info as fallback instead of spawning it before every Dex evaluation
- stale `token_catalog.source = user-manual` rows are verified against the live `user_tokens` table before manual GMGN token-info lookup; rows no longer pinned by any user are demoted to `dexscreener-discovery` and GMGN is skipped
- manual GMGN token-info lookups are single-flighted per address and capped at `3` concurrent lookups, while low-mcap `user-manual` Dex rows use the `15s` low-near floor instead of the automatic `10m` low-dust cadence
- market reevaluation writes `token_market_buckets_1m`
- fresh raw `token_market_snapshots` are no longer written by the catalog worker

#### Catalog cleanup worker
File:
- `src/services/catalog-cleanup-worker.js`

Role:
- automatically reduces low-value catalog pressure before it turns into evaluation backlog
- quarantines weak discovery tokens
- soft archives stale or repeated low-signal low-dust tokens across catalog sources

Cadence:
- `quarantine`: every `15m`
- `soft archive`: every `48h`
- the soft-archive schedule anchor is persisted in DB under `catalog_cleanup_soft_archive_last_run_at`, so process restarts do not restart the `48h` countdown
- blocked-token artifact cleanup:
  - every `15m` while artifact backlog remains
  - every `60m` after a run finds no blocked artifacts
  - processes `1` blocked address per run by default
  - deletes in bounded chunks of `250` rows per table by default, with a `2000ms` statement timeout per chunk
  - runs table cleanup sequentially instead of in parallel, so cleanup cannot fan out into multiple long-running bucket deletes
  - tuning env vars: `CATALOG_CLEANUP_BLOCKED_ARTIFACT_ADDRESS_LIMIT`, `CATALOG_CLEANUP_BLOCKED_ARTIFACT_CHUNK_LIMIT`, `CATALOG_CLEANUP_BLOCKED_ARTIFACT_STATEMENT_TIMEOUT_MS`, `CATALOG_CLEANUP_BLOCKED_ARTIFACT_INTERVAL_MS`, `CATALOG_CLEANUP_BLOCKED_ARTIFACT_IDLE_INTERVAL_MS`

Cleanup policy:
- protected tokens are excluded:
  - rows present in `user_tokens`
  - rows present in `user_starred_tokens`
  - rows present in `user_blocklist`
  - any `token_catalog` row with `source = 'user-manual'`
- `dexscreener-discovery` tokens below `15k` with no useful current eligibility and low/null `24h` volume go to `quarantine`
- tokens already in `cleanup_quarantine` are not soft-archived in the same pass
- soft archive now applies to low-dust tokens from all sources, including `dexscreener-discovery` and `pumpfun-migrated`
- `quarantine` remains frequent and independent from archive cadence
- soft archive runs every `2d`
- each soft-archive pass archives at most `400` addresses
- archive candidates are ordered by `first_seen_at ASC`, then `last_seen_at ASC`

Operational effect:
- `quarantine`
  - keeps the record
  - disables active monitoring behavior
  - pushes reevaluation far into the future
- `soft archive`
  - keeps the record
  - sets `is_active_monitor_candidate = FALSE`
  - removes the token from the normal evaluation queue
  - deletes persisted `token_market_buckets_1m`
  - deletes legacy `token_market_snapshots`
  - deletes `token_meteora_snapshots` for archived addresses
- blocked-token artifact cleanup removes market buckets, volume buckets, aggregate market buckets, and Meteora snapshots for old admin-blocked addresses on a bounded incremental maintenance cadence

#### Dex discovery worker
File:
- `src/services/dex-discovery-worker.js`

Role:
- discovers new tokens from DexScreener feeds
- inserts them into `token_catalog`
- schedules initial evaluation for new addresses only

Cadence:
- every `60s`

Discovery feeds:
- `/token-profiles/latest/v1`
- `/token-boosts/top/v1`
- `/token-boosts/latest/v1`

Current source used in catalog:
- `dexscreener-discovery`

Important current rule:
- discovery is no longer a refresh path for known tokens
- if the address already exists in `token_catalog`, the worker skips it entirely
- exception: addresses currently marked `cleanup_soft_archive` are reactivated if they reappear in Dex discovery
- reactivation changes the row back to source `dexscreener-discovery`, clears the archive suppression, and schedules immediate reevaluation
- freshness for existing catalog rows now comes from the catalog worker, not from repeated discovery re-entry
- discovery is paused while DexScreener throttle mode is active, including staged recovery

#### GMGN discovery worker
Files:
- `src/services/gmgn-discovery-worker.js`
- `src/services/gmgn-discovery-scheduler.js`
- `src/services/gmgn-catalog-ingestion.js`
- `src/services/gmgn-client.js`
- `src/models/token-gmgn-panel-state.js`
- `src/services/gmgn-panel-state-manager.js`

Role:
- reads GMGN Agent API through `gmgn-cli`
- uses GMGN trending as an auxiliary discovery and volume-alert source
- stores GMGN volume in the same 1m bucket family used by Dex volume history
- performs early risk gates for obvious GMGN-origin junk before alerts can fire
- tracks GMGN panel membership and hands stale/panel-exit tokens back to DexScreener evaluation

Default state:
- disabled unless `GMGN_DISCOVERY_ENABLED=true`
- requires `GMGN_API_KEY`

Request shape:
- default request budget is `2` trending requests per `2s` window
- intervals:
  - `1m`
  - `5m`
- default per-request limit is `30`
- `GMGN_TRENDING_LIMIT` applies per request/interval, so `20` can return up to `20` `1m` rows plus up to `20` `5m` rows before address dedupe
- `GMGN_DISCOVERY_INTERVAL_MS` controls how often a full discovery cycle starts; values near `5000ms` still spawn frequent `gmgn-cli market trending` subprocesses and can be CPU-heavy on small VPS hosts
- safer CPU profile for an enabled GMGN worker:
  - `GMGN_DISCOVERY_INTERVAL_MS=30000`
  - `GMGN_REQUEST_WINDOW_MS=10000`
  - `GMGN_REQUESTS_PER_WINDOW=2`
  - `GMGN_TRENDING_LIMIT=20`
- when host CPU appears saturated, check Linux CPU `st`/steal time and active `gmgn-cli market trending` processes before attributing load to Postgres cleanup
- GMGN `1m` discovery is intentionally not trusted as a brand-new-token source

Catalog/alert behavior:
- GMGN trending rows are normalized into catalog snapshots
- brand-new tokens that appear only in GMGN `1m` trending are skipped
- existing catalog tokens can still be refreshed by GMGN `1m`
- GMGN volume writes go into `token_market_volume_buckets_1m`
- GMGN snapshots use the same young-token `6h`/`24h` volume-window fill as Dex before catalog, bucket, alert, and panel-state writes
- when a token already has Dex confirmation, GMGN refreshes preserve the existing Dex-derived `vol5m` instead of overwriting it with raw GMGN interval volume
- GMGN `5m` volume jumps use the normal backend `monitored-vol` alert path
- `gmgn-vol-1m` remains behind `GMGN_VOL_1M_ALERT_ENABLED`; default is disabled because the 1m feed was too noisy
- automatic GMGN-origin tokens are now blocked from alert evaluation until one of these is true:
  - the token already has DexScreener confirmation from the catalog flow (`dex-low`, `dex-normal`, `dex-high`, or a DexScreener pair URL)
  - the token completed the GMGN preliminary review path (`token security`, `token info`, and `market kline`) without being auto-blocked
  - the token is a user/manual row
- this safeguard does not stop catalog or volume-bucket writes; it only prevents the user-alert matcher from emitting while the token is still only a raw GMGN discovery
- GMGN panel state tracks seen/stale tokens and schedules Dex reevaluation after a token leaves the GMGN panel
- GMGN refreshes that resolve to `admin-blocked` are excluded from the accepted panel-token set
  - this prevents already-blocked tokens from being marked `active` again in `token_gmgn_panel_state`

GMGN risk gates before catalog/upsert alert flow:
- high-confidence GMGN junk from the existing classifier is auto-blocked through `admin_blocked_tokens`
- GMGN, catalog-worker, and risk-review auto-block paths also write ban-time evidence into `admin_block_evidence`; this is separate from operational blocklist reads so the block table stays lightweight
- medium-confidence junk from a brand-new GMGN token is skipped without permanent block
- `user-manual` rows and addresses present in the backend `user_tokens` manual-token table are protected from GMGN auto-blocking, even if a GMGN ingestion cycle sees the catalog row before its source has been rewritten to `user-manual`
- young low-mcap/extreme-volume GMGN tokens are auto-blocked before security/info/kline lookups:
  - age `< 24h`
  - mcap `<= 100k`
  - vol5m `>= 500k`
  - vol5m/mcap `>= 4`
  - block label shape:
    - `gmgn-volume:low-mcap-extreme-vol5m:{mcap}:{vol5m}`
- new automatic GMGN non-pump launch tokens are auto-blocked before catalog upsert, bucket writes, security/info/kline lookups, and alerts:
  - token is not manual and not Dex-confirmed
  - CA does not end with `pump`, `bags`, or `brrr`
  - age `< 2h`
  - mcap `>= 50k` and `<= 100k`
  - vol5m `>= 200k`
  - vol5m/mcap `>= 4`
  - GMGN `5m` volume must pass sanity checks:
    - `vol5m > 0`
    - `vol1m < 90%` of `vol5m`
    - `vol5m <= vol1h`
  - this prevents raw GMGN launches from being auto-blocked when the upstream mirrors nearly the same volume into `1m`, `5m`, and longer windows before Dex confirms the pair, and avoids hard-banning moderate low-mcap launch traction such as ~25k mcap / ~45k vol5m
  - block label shape:
    - `gmgn-origin:new-non-pump-high-launch-mcap:{mcap}:{vol5m}`
- new automatic GMGN discoveries that do not end with `pump`, `bags`, or `brrr` are suppressed from monitored/alerts for the first `15m` after token creation:
  - applies only when age is known and still below `15m`
  - does not apply to manual, admin-blocked, or Dex-confirmed rows
  - writes `eligibility_state = gmgn-non-launch-grace`
  - writes `suppressed_reason = gmgn_non_launch_grace_period`
  - schedules `next_evaluation_at` for the end of the 15-minute grace window
- young GMGN candidates under `6h` can trigger GMGN risk-data lookup when any of these are true:
  - vol1h/mcap `>= 10`
  - vol24h/mcap `>= 20`
  - vol1h/mcap `>= 3`
  - mcap `>= 100k`
  - vol5m `>= 50k`
- successful GMGN risk-data lookups are cached process-wide before another `gmgn-cli` process is spawned:
  - cached surfaces: `token security`, `token info`, and `market kline`
  - default TTL: `60s`
  - `GMGN_RISK_LOOKUP_CACHE_TTL_MS=0` disables this cache
  - `GMGN_RISK_LOOKUP_CACHE_MAX_ENTRIES` controls the process-local cap
- GMGN discovery ingestion queues the full preliminary risk lookup bundle outside the 2s trending loop:
  - default queue interval: `10s`
  - default queue budget: `5` tokens per queue run
  - overrides: `GMGN_RISK_REVIEW_QUEUE_INTERVAL_MS`, `GMGN_RISK_REVIEW_QUEUE_TOKEN_LIMIT`
  - legacy budget alias: `GMGN_RISK_LOOKUP_TOKEN_LIMIT_PER_CYCLE`
  - `GMGN_RISK_REVIEW_QUEUE_TOKEN_LIMIT=0` pauses deep risk review processing
  - queue budget exhaustion does not block catalog/visual bucket persistence by itself
  - automatic GMGN-only alert emission still requires Dex confirmation or completed preliminary review
  - successful queued preliminary reviews create a process-local fresh-pass marker controlled by `GMGN_PRELIMINARY_REVIEW_TTL_MS`
  - GMGN refreshes preserve an already-earlier Dex recheck for GMGN-only rows, so repeated trending updates do not indefinitely postpone pair confirmation by `catalog-worker`
- GMGN ingestion writes mcap/price snapshots to `token_market_buckets_1m` when mcap is available, in addition to volume snapshots in `token_market_volume_buckets_1m`; this lets GMGN/manual refreshes feed the same sparkline source used by Dex-driven catalog refreshes without bypassing the GMGN-only alert safeguard
- Sparkline history uses `token_market_buckets_1m` as the base source and `token_market_buckets_agg` as the fast read source for `5m`, `15m`, `30m`, `1h`, `4h`, and `24h` granularities.
- `token_market_buckets_agg` can be populated historically with `npm run market-buckets-agg:backfill -- --days 14 --batchSize <n>`.
- Incremental aggregate writes happen only when a new `1m` bucket is created; repeated writes inside the same minute do not recompute aggregate windows. The inline path computes `5m`, `15m`, and `30m` from `1m`, then computes `1h`, `4h`, and `24h` from the refreshed `5m` buckets.
- `MARKET_BUCKET_AGGREGATE_ON_WRITE_ENABLED=false` disables both inline aggregate recompute steps after `1m` bucket writes. This is a pressure relief switch for small VPS incidents; aggregate sparklines can lag until a backfill/rebuild catches up.
- Expanded charts subscribe to authenticated Socket.io `market:bucket` updates for the open token. Bucket writes emit only after persistence/cache invalidation, and the frontend merges the live `1m` bucket into the currently visible candle granularity instead of forcing a Dex refresh per user.
- GMGN bad-liquidity-status mcap-band auto-blocks automatic GMGN tokens before catalog/bucket/security work when:
  - the token is not manual, not already admin-blocked, and not Dex-confirmed; manual protection checks both `token_catalog.source = user-manual` and the persisted `user_tokens` table
  - the CA does not end with `pump`, `bags`, `brrr`, or `bonk`
  - token age is known and below `2h`
  - GMGN mcap is between `$20,000` and `$150,000`
  - at least `2` of the `5` GMGN liquidity-protection fields are bad: `lock_percent = 0`, `burn_ratio = 0`, `burn_status = none`, `creator_close = true`, `creator_token_status = creator_close`
  - matching rows are auto-blocked as `gmgn-liquidity:bad-status-mcap-band:{mcap}:{badCount}bad:{signals...}`
- GMGN `token security` auto-blocks when top-10 holder rate is `>= 70%`
- GMGN `token info` auto-blocks low-mcap/high-holder anomalies:
  - mcap `<= 150k`
  - holders `>= 1500`
- GMGN `market kline` auto-blocks staircase pumps on 1m candles:
  - at least `12` candles
  - runup `>= 150%`
  - green candle ratio `>= 85%`
  - up-step ratio `>= 85%`
  - at most `2` red candles
  - max step ratio `<= 20%`

Young extreme GMGN quarantine:
- separate from immediate GMGN security/info/kline blocks
- applies when:
  - age `< 2h`
  - vol1h/mcap `>= 10` or vol24h/mcap `>= 20`
- persisted behavior:
  - token/catalog snapshot is saved
  - GMGN volume bucket is saved
  - `eligible_for_monitoring = false`
  - `suppressed_reason = gmgn_needs_risk_enrichment`
  - alert matcher is skipped while suppressed
- after Helius enrichment:
  - concentrated structure is auto-blocked as `auto-junk-probable`
  - healthy enriched structure is released back to GMGN monitoring

Operational checkpoint:
- local backfill on `2026-05-04` scanned `97` GMGN candidates
- `33` were blocked:
  - `29` by GMGN security top-10 holder rate
  - `4` by GMGN info low-mcap/high-holder anomaly
  - `0` by kline pattern in that backfill batch
- this was a one-off local cleanup/backfill, not a recurring worker by itself

#### Market snapshots
Primary file:
- `src/services/catalog-worker.js`

Role:
- inserts `token_market_buckets_1m` snapshots during normal catalog reevaluation

#### Meteora snapshot worker
File:
- `src/services/meteora-snapshot-worker.js`

Role:
- fetches and stores Meteora current state plus TVL history for eligible tokens
- scheduler is backend-owned and tiered rather than a flat queue

Cadence:
- targets `20s`
- compensates for run duration to keep wall-clock cadence close to `20s`
- global budget cap: `800 tokens/min`

Eligibility:
- `is_active_monitor_candidate = true`
- and (`has_pool = true` or trusted-source `last_mcap >= 100k`)
- raw `gmgn` catalog rows are not Meteora-eligible by mcap alone unless they have Dex-confirmed eligibility (`dex-low`, `dex-normal`, `dex-high`)

Priority tiers:
- `high`: `vol24h >= 100k`
- `normal`: `15k <= vol24h < 100k`
- `low`: `vol24h < 15k`

Tier SLAs:
- `high`: `30s`
- `normal`: `60s`
- `low`: `5m`

#### Token risk enrichment worker
File:
- `src/services/token-risk-enrichment-worker.js`

Role:
- fetches structural/on-chain token signals through Helius/RPC
- persists those signals into `token_risk_enrichment`
- keeps structural analysis out of the main catalog worker critical path

Important behavior:
- the worker loop runs frequently, but per-token enrichment is cache-gated
- a token is not re-enriched on every worker loop
- the default “fresh structural cache” TTL is now `1h`
- the Helius candidate selector can skip a token when:
  - structural enrichment is still fresh
  - the token is under enrichment error backoff
  - the token has a persisted `manual` `valid` review
  - the token has a persisted `manual` `junk_permanent` review
- being present in `Monitored Tokens` does not guarantee immediate Helius enrichment
  - monitored status makes the token eligible for consideration
  - Helius still uses its own selector and TTL logic

Persisted structural outputs:
- holder count
- top-holder concentration
- mint authority state
- freeze authority state
- structural reason codes

#### Token risk review sync worker
File:
- `src/services/token-risk-review-sync-worker.js`

Role:
- periodically computes the current runtime token-risk assessment for monitored tokens
- persists that assessment into `token_risk_reviews`
- creates an operational label cache that other runtime systems can reuse
- automatically blocklists tokens that remain automatic `junk_probable`

Important behavior:
- automatic persisted labels use the existing review labels only:
  - `valid`
  - `valid_but_weak`
  - `junk_probable`
- automatic `junk_permanent` is intentionally not persisted as `junk_permanent`
  - it is softened to persisted `junk_probable`
  - the softened `junk_probable` can now enter the automatic backend blocklist path
- automatic `valid` is only persisted as `valid` after structural coverage exists
  - without structural coverage, automatic `valid` is softened to persisted `valid_but_weak`
  - this avoids skipping Helius too early
- automatic `junk_probable` now triggers backend blocklisting:
  - inserts the token into `admin_blocked_tokens`
  - writes a best-effort audit row into `admin_block_evidence`
    - captures the auto-ban pipeline, ban label, catalog snapshot, market snapshot, risk/enrichment snapshot, Meteora snapshot, GMGN snapshot when present, assessment payload, and rule match metadata
  - writes `created_by = NULL`, which surfaces as `blocked_auto`
  - applies an `admin-blocked` catalog evaluation state
  - disables active monitoring and pushes the next evaluation far into the future
  - removes the automatic `token_risk_reviews` row after blocklisting
- automatic blocklisting does not run for:
  - existing manual review rows
  - `valid`
  - `valid_but_weak`
- GMGN quarantine resolution:
  - rows suppressed as `gmgn_needs_risk_enrichment` can be assessed by the sync worker after Helius structural coverage arrives
  - top-20 concentration `>= 95%`, top-10 concentration `>= 90%`, or active authority plus top-10 `>= 80%` auto-blocks the token
  - healthy enriched GMGN quarantine rows are released back to monitoring with normal GMGN priority/state
- Dex-to-GMGN holder anomaly check:
  - suspicious young Dex-discovered tokens can request GMGN `token info` before falling back to the normal junk metric
  - source must not be GMGN or `user-manual`
  - age must be `< 24h`
  - mcap must be `<= 500k`
  - Helius holder count must be at least `1000`
  - at least one suspicion trigger must exist:
    - vol24h/mcap `>= 5`
    - buy/sell imbalance `>= 3`
    - absolute 24h price change `>= 200%`
  - if GMGN reports holders `>= 10k` and mcap/holder `<= $50`, the token is auto-blocked with:
    - `auto-junk-probable:gmgn_holder_count_mcap_anomaly`
- Source-agnostic young low-mcap/extreme-volume gate:
  - runs before the Dex-to-GMGN holder anomaly check and before the normal junk metric fallback
  - age `< 24h`
  - mcap `<= 100k`
  - vol5m `>= 500k`
  - vol5m/mcap `>= 4`
  - matching rows are auto-blocked with:
    - `auto-junk-probable:new_low_mcap_extreme_vol5m_churn`
- GMGN low-liquidity spam gate:
  - runs in GMGN ingestion before catalog upsert, bucket writes, security/info/kline lookups, and alert matcher
  - automatic GMGN discovery only
  - token must not be manual, already admin-blocked, or Dex-confirmed; manual protection checks both `token_catalog.source = user-manual` and the persisted `user_tokens` table
  - CA must not end with `pump`, `bags`, or `brrr`
  - age must be known and below `2h`
  - GMGN current liquidity must be known and below `$1,000`
  - market cap must be missing or below `$150,000`
  - matching rows are auto-blocked with:
    - `gmgn-liquidity:under-1k-spam:{liquidityUsd}:{mcap}`
  - this replaces the removed token-risk review GMGN liquidity hard-bans:
    - `auto-junk-probable:gmgn_confirmed_micro_liquidity`
    - `auto-junk-probable:gmgn_low_mcap_thin_support`
    - `auto-junk-probable:gmgn_low_mcap_extreme_24h_churn_thin_liquidity`
    - `auto-junk-probable:gmgn_young_low_cap_high_churn_thin_liquidity`

Manual vs automatic precedence:
- `token_risk_reviews` now has `source`:
  - `manual`
  - `auto`
- manual review remains authoritative
- automatic sync never overwrites an existing manual review row
- the dashboard can expose both:
  - `riskReview`
  - `junkAssessment`
  - `blockStatus`
  - `effectiveRiskLabel`

Practical distinction:
- `junkAssessment`
  - computed live from current data
  - not authoritative by itself
- `riskReview`
  - persisted review state
  - can be reused by selectors and operators
- blocklist action is now automatic for auto `junk_probable`, but still separate for manual labels
  - blocked tokens can surface as `blocked_manual` or `blocked_auto` in effective reads
  - admin blocklisting removes automatic review rows so blocked tokens no longer linger in the automatic `junk_probable` pool

Current junk metric guardrail:
- `junk_probable` can be softened to `valid_but_weak` when enough positive profile signals offset weak suspicion
- the active threshold is `3` positive profile signals
- stronger bundles still bypass that softening, including:
  - extreme buy/sell imbalance
  - no-pool suspicious bundles
  - microcap collapse
  - terminal microcap collapse
  - high-cap thin-support bundles
- this guardrail exists because automatic backend blocklisting now consumes the `junk_probable` output

Execution notes:
- worker computes per-tier demand and effective budget under the `800/min` cap
- batch composition is now tiered instead of one flat `LIMIT`
- each tier applies its own due cutoff before selecting addresses
- unused slots from an underfilled higher tier can spill into lower tiers
- current state is persisted in `token_meteora_state`
- positive checks also append history into `token_meteora_snapshots`
- worker writes `last_snapshot_at` and `1h`/`6h`/`24h` baseline TVLs into `token_meteora_state`, so summary reads no longer hit `token_meteora_snapshots`

## Data Sources

### DexScreener
File:
- `src/services/dexscreener.js`

Used for:
- batched token pair lookup by address set
- discovery feeds for latest profiles and boosts

Important current note:
- the main catalog refresh path now uses `/tokens/v1/{chainId}/{tokenAddresses}`
- each request can carry up to `30` addresses
- per-token cache TTL follows worker priority hints:
  - `high-hot`: `2s`
  - `high-warm`: `3s`
  - `high-cold`: `5s`
  - `normal`: `4s`
- `low-near`: `15s`
- `low-dust`: `10m`
- `dormant`: `30m`
- error cooldown is `60s`
- discovery still uses the `latest/top` feeds, not the batch token endpoint
- consecutive `429` responses are tracked globally inside the Dex integration
- the global cooldown only activates on the `10th` consecutive `429`
- once activated, batch delay rises to `400ms` and the catalog worker enters staged recovery instead of returning immediately to full traffic
- worker/admin status now exposes the Dex throttle state, remaining cooldown, recovery phase, and effective batch delay

### PumpFun WebSocket
File:
- `src/services/pumpfun-ws.js`

Used for:
- backend migration capture from PumpPortal
- `txType: "migrate"` events only
- connection status for backend observability

### PumpFun dry-run experiments
Status:
- removed from runtime code
- removed experiment families:
  - `pumpfun-fast-5x`
  - `pumpfun-post-migration-blast`
  - `pumpfun-combo-confirmation`
- removed surfaces:
  - runtime workers
  - admin diagnostic routes
  - config/env parsing
  - runtime schema guards and init stages
  - persistence models
  - service modules
  - dedicated tests/docs
- existing database tables are not recreated or checked by runtime schema anymore
- existing database tables are not dropped automatically by this code removal

### Meteora
Files:
- `src/services/meteora.js`
- `src/services/meteora-snapshot-worker.js`

Used for:
- pool TVL summary/history

Current API shape:
- client uses the current DLMM Datapi pools endpoint, not the legacy `pair/all_by_groups` route
- worker queries `token_x` and `token_y` sides separately per token and merges the results
- summary endpoints read only `token_meteora_state`; historical TVL baselines are persisted there by the worker
- current `meteora-surge` alerting layer on top of this data now includes:
  - hot-token priming instead of always alerting immediately on session start
  - `10m` repeat cooldown
  - fingerprint bucketing by `change1h` and TVL instead of drifting `mcap` / `volume24h`

## Source Of Truth By Area

### Auth/session
- backend

Endpoints:
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/logout-all`
- `POST /api/auth/change-password`
- `POST /api/auth/register`

Current transport:
- backend-issued `HttpOnly` cookie
- frontend uses `credentials: include`
- frontend no longer depends on browser-readable token storage for the live auth flow
- each successful login now gets a unique backend session identity
- server-side session revocation and live socket revocation are aligned around the same per-session semantics

### User configs
- backend

Endpoint:
- `GET /api/config`

User-scoped persisted data:
- configs
- uiPrefs
- manual tokens
- blocklist
- starred tokens

Current persisted config/ui-pref notes:
- `card-effects-mode` is now a persisted user config:
  - `on`
  - `off`
- current config defaults for new accounts include:
  - `min-vol = 10000`
  - `min-mcap = 30000`
- `uiPrefs.enabledTradeTerminals` is persisted per account and defaults to:
  - `axiom`
  - `photon`
  - `bullx`
  - `gmgn`
  - `padre`
- `uiPrefs.livePanelLayout` is now persisted per account for `/alerts`:
  - `order = ['monitored', 'pumpfun', 'alerts']`
  - default spans: `monitored = 2`, `pumpfun = 1`, `alerts = 1`
  - `spans.monitored = 1 | 2 | 3`
  - `spans.pumpfun = 1`
  - `spans.alerts = 1 | 2 | 3`
- current default UI-pref sorts for new accounts are:
  - `monitoredSorts = [{ mode: 'vol', window: '5m' }]`
  - `recentSorts = [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }]`
  - `oldWeekSorts = [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }]`

### Manual tokens
- backend user data, scoped by authenticated account

Important:
- backend is the source of truth for which manual tokens a user sees
- frontend still applies optimistic UI updates
- backend also ingests the token for global catalog tracking through a separate catalog path
- the reload path now rebuilds manual-token UI state directly from `GET /api/config` payload tokens, which is what makes same-account cross-device restore work correctly
- workspace placement:
  - mounted only in `/alerts`
  - not mounted in `/monitor`
- current table behavior:
  - supports compact search by symbol, name, and contract/address
  - supports starred-only filtering
  - supports client-side manual sort modes
  - now includes a `Chart` column
- current manual chart behavior:
  - charts are loaded only for the visible manual table rows after manual search/filter/sort resolution
  - current manual chart cap is `30` rows
  - source endpoint is `POST /api/catalog/sparklines`
  - backend reads `token_market_buckets_1m` for `1m` and `token_market_buckets_agg` for `5m`, `15m`, and `30m`
  - backend falls back to `token_market_buckets_1m` when aggregate coverage is empty or too short
  - backend keeps a short in-memory sparkline cache with default TTL `30s`, invalidated by token writes/removals
  - refresh cadence is `1m`
  - requested span is `14d`
  - requested point budget is `336`
  - the chart tooltip now labels the visual as `Mini chart`
  - compact mini charts render a translucent filled area under the line
  - hover inspection shows approximate market cap plus approximate bucket time for the selected point
  - clicking a manual mini chart opens a compact expanded hologram popup and loads a separate full-available-history sparkline for that token
  - the expanded popup stays as a compressed sparkline, not candles
  - expanded sparkline reads are cached briefly by the backend and reused briefly by the frontend to reduce repeated open/query churn
  - the expanded popup keeps the chart-focused layout and does not render projection/feixe lines
  - the visual span is `14d` max, but tokens younger than `14d` render only their real available lifespan
  - current age-adaptive granularity:
    - `< 24h`: `1m`
    - `24h` to `< 72h`: `5m`
    - `72h` to `< 11d`: `15m`
    - `11d+`: `30m`
  - manual search changes, starred-only toggles, and manual sort changes now force a sparkline refresh in the live workspace
- current manual add validation:
  - the frontend now rejects obvious non-address input before optimistic add
  - accepted optimistic input formats are currently:
    - Solana-style base58 addresses with `32-44` chars
    - EVM-style `0x` addresses with `40` hex chars
  - if backend persistence fails, the optimistic row is rolled back instead of being left behind locally
- current table-age formatting:
  - `< 30d`: `d` / `h` / `m` / `s`
  - `30d+`: `1mo`, `2mo`, ...
  - `12mo+`: `1y`, `2y`, ...

### Monitored tokens baseline
- backend

Endpoint:
- `GET /api/dashboard/monitored`
- route supports paged hydration with:
  - `page`
  - `perPage`
  - `sorts`
- `/monitor` routed/history bootstrap uses:
  - `POST /api/dashboard/history-bootstrap`
  - backend-side `recent` and `oldWeek` slices with page/perPage, search, starred-only, dismissed-address filtering, sort criteria, MCAP windows, and age windows
  - the payload reuses monitored-style token rows plus Meteora summaries and MCAP/VOL baselines

Workspace placement:
- consumed by both `/alerts` and `/monitor`
- `/alerts` uses it for monitored/manual/live-alert behavior
- `/monitor` uses it for routed/history surfaces only

Bootstrap behavior:
- authenticated frontend bootstrap now loads monitored page `0` first using the current `monitoredPerPage` and persisted monitored sorts
- remaining pages continue hydrating in background and merge into the shared tracked-token store without blocking the first paint of the monitored panel

### Recent / Old Week bars
- frontend-derived from monitored token state

Reasons:
- per-user MCAP windows
- per-user dismissed state
- per-user removal logs
- current routed table behavior:
  - mounted only in `/monitor`
  - both routed tables now include a `Chart` column
  - the header text is `Chart`, while the tooltip labels the visual as `Mini chart`
- current routed chart behavior:
  - source endpoint: `POST /api/catalog/sparklines`
  - source data: `token_market_buckets_1m` for `1m`; `token_market_buckets_agg` for `5m`, `15m`, and `30m`
  - backend falls back to `token_market_buckets_1m` when aggregate coverage is empty or too short
  - backend sparkline metrics include `source`, `cacheHit`, `aggregateRows`, `fallbackRows`, and `fallbackAddresses`
  - only visible routed rows are fetched
  - current routed chart cap is `100` total rows across `Recent Tokens` + `Old Tokens 1 Week+`
  - the routed selector is neutral/interleaved rather than permanently prioritizing recent or old-week
  - refresh cadence is `1m`
  - requested span is `14d`
  - requested point budget is `336`
  - compact mini charts render a translucent filled area under the line
  - hover inspection shows approximate market cap plus approximate bucket time for the selected point
  - clicking a routed mini chart opens the same compact expanded hologram popup used in `Manual Tokens` and loads a separate full-available-history sparkline for that token
  - the expanded popup stays as a compressed sparkline, not candles
  - visual span is `14d` max, with younger-token compression to the real available lifespan
  - current age-adaptive granularity:
    - `< 24h`: `1m`
    - `24h` to `< 72h`: `5m`
    - `72h` to `< 11d`: `15m`
    - `11d+`: `30m`
  - routed compact search surfaces a visible searching/loading state while the table resolves the query
  - routed-list interaction locks now clear stale DOM zones after refreshes and allow overlay-only renders through the lock, so chart popups and buy/sell overlays do not get stuck after several live update cycles
  - shared token action, copy, and sparkline-hover handlers are marked as bound per element to prevent listener accumulation during incremental Recent/Old row patching

### Admin mock trading
- Admin-only backend route prefix:
  - `/api/admin/mock-trading`
- Route protection:
  - authenticated session
  - `requireAdmin`
  - trusted-origin check for mutating requests
- Current endpoints:
  - `GET /wallets`
  - `POST /wallets`
  - `PATCH /wallets/:walletId`
  - `POST /wallets/:walletId/default`
  - `POST /wallets/:walletId/archive`
  - `GET /summary`
  - `GET /positions`
  - `GET /trades`
  - `POST /buy`
  - `POST /sell`
  - `POST /take-profit-orders`
  - `POST /take-profit-orders/:id/cancel`
  - `POST /add-cash`
  - `POST /reset`
  - `GET /sol-price`
- Current tables:
  - `mock_trading_wallets`
  - `mock_trading_accounts`
  - `mock_trading_positions`
  - `mock_trading_trades`
  - `mock_trading_take_profit_orders`
- Wallet model:
  - mock trading state is scoped to user-created mock wallets
  - legacy or existing mock trading rows are backfilled into a default wallet named `Main`
  - backend calls without `walletId` resolve to the user's default active wallet for compatibility
  - one wallet owns one account row through `mock_trading_accounts.wallet_id`
  - open positions are keyed by `wallet_id + token_address`, so the same token can be held separately in multiple wallets
  - trades and take-profit orders store `wallet_id`, and list/summary/trade endpoints filter by the selected wallet
  - order cancellation resolves the active/default wallet and rejects orders outside that wallet
  - archiving a non-default wallet hides it from the active wallet list and cancels its open take-profit orders
  - the current UI blocks archiving the default wallet and the last visible wallet
- Background execution:
  - `src/services/mock-trading-take-profit-worker.js`
  - starts with the background worker set
  - enabled by default through `MOCK_TRADING_TAKE_PROFIT_ENABLED=true`
  - default interval is `3s`
  - default batch limit is `25` open triggered candidates
  - exposed as `mockTradingTakeProfitWorker` in `GET /api/admin/ws-status`
  - triggered candidates join open orders to open positions by `wallet_id + token_address`
  - archived wallets are excluded from triggered candidate discovery
- Execution behavior:
  - buys and sells execute against `token_catalog.last_price` as `priceUsd`
  - execution snapshots `token_catalog.last_mcap` as market-cap reference
  - manual sells can use a stale catalog price only when `last_mcap < 30k`; buys and take-profit orders still require fresh catalog price
  - mock trading uses a backend CoinMarketCap SOL/USD quote service for SOL display and SOL-denominated buy/deposit conversion:
    - CoinMarketCap asset id: `5426` (Solana)
    - default poll interval: `264500ms`, about `9,800` requests per 30-day window
    - stale window: `300000ms`
    - browser code receives read-only quote status and never receives the CMC API key
    - a `1 SOL` buy sends `notionalSol = 1` to the backend, and the backend converts to internal USD with the latest non-stale CMC quote
    - backend/API/DB field names still use `*_usd` / `notionalUsd` for compatibility
  - each executed buy/sell/take-profit trade snapshots the active CMC-backed `mockSolUsdcRate` into `mock_trading_trades.metadata`, so finalized trade rows, closed-play realized PnL, and chart markers keep the SOL reading from execution time even if SOL/USD moves later
  - older trades without a rate snapshot fall back to the original default `88`
  - the auto-created default mock wallet still uses the existing internal account default (`1000`), displayed as `1000 / live SOL/USD` SOL; newly created non-default wallets start with `0` cash until the admin deposits mock SOL
  - open-position value, PnL, and return percentage are calculated from token quantity and `priceUsd`
  - market cap is display/reference context, not the PnL calculation source
- Frontend behavior:
  - admin sessions load the wallet list, active-wallet summary, active-wallet open positions, and active-wallet recent trades
  - the mock trading header includes an active wallet selector
  - compact header controls support create, rename, set default, and archive for mock wallets
  - wallet create/rename/archive currently use native browser `prompt`/`confirm` flows
  - switching wallet closes wallet-specific overlays and refreshes summary/positions/trades for the selected wallet
  - the selected mock wallet is persisted per browser/user in local storage, so hard reloads restore the last selected wallet when it still exists
  - token rows expose admin-only mock buy/sell controls
  - buy uses a ticket modal with fixed SOL presets and a custom SOL amount
  - sell uses a ticket modal with percent presets and a custom percent
  - sell tickets preview estimated SOL receive, realized PnL, and remaining position for both immediate sells and target-MCAP sell orders
  - the PnL resume modal exposes direct sell buttons for 25%, 50%, and 100%
  - admin can manually add mock SOL to the active wallet without clearing positions/trades; this still increases both `cash_usd` and `starting_cash_usd` internally so deposits do not inflate total PnL
  - buy/sell ticket modals scroll when their content exceeds the viewport
  - header cash pill shows the active wallet selector, current mock SOL, read-only SOL/USD quote status, add, a `Plays` button, and reset; each active-wallet open position still gets a separate image/ticker/PnL pill
  - buy/sell ticket, `Plays`, and PnL modals show the active wallet name
  - `Plays` opens an active-wallet closed-play summary based on sell executions, realized PnL, win/loss counts, and win rate
  - reset clears only the active wallet's mock portfolio
- Floating Quick Buy:
  - admin-only floating widget rendered through its own overlay slot, separate from routed tabs and panels
  - hidden on the account-security route and unavailable to non-admin sessions
  - can be reopened from the admin user menu with the `Quick Buy` item after being closed
  - draggable by its header; the close `X` only hides the widget and does not cancel/reset an armed order
  - accepts a token contract/address and fixed notional `0.3 SOL`
  - submitting works from the `0.3 SOL` button or `Enter` / `NumpadEnter` inside the address field
  - adds the address into `Manual Tokens`, persists/tracks it through the normal manual catalog flow, and hydrates manual dashboard fields
  - waits for the GMGN/catalog market-cap snapshot to appear in tracked token state before buying
  - executes a mock buy against the active mock trading wallet with `notionalSol = 0.3`
  - rejects execution if the active wallet already has an open position for that token or if normal mock-buy validation fails
  - displays only status/log text in the floating window; price and MCAP details stay in the normal token tables
  - on successful buy, the status resets back to idle after about `1.8s`; the token remains trackable in `Manual Tokens`
- Chart-marker behavior:
  - Manual, Recent, and Old Week compact sparklines receive active-wallet buy/sell markers
  - the expanded sparkline modal receives the same markers
  - marker X position is based on trade `executedAt` within the sparkline time window
  - marker Y position uses trade MCAP when available, otherwise it falls back to the closest sparkline point
  - markers are passed as render options and are not merged into the global sparkline cache

### Alerts
- backend-owned for active alert generation
- only active in `/alerts` as a rendered panel
- current split:
  - backend-owned user alerts:
    - `monitored-vol`
    - `monitored-mcap`
    - `hvnc`
    - `recent-surge-1h`
    - `recent-surge-6h`
    - `old-week-surge-1h`
    - `old-week-surge-6h`
    - `meteora-surge`
- the panel now also supports per-user animated card FX behind `card-effects-mode`
- current implementation detail:
  - the visible row shell stays stable in the list
  - most arrival FX run in a separate ghost overlay layer
  - row-level shake is intentionally limited to higher tiers to reduce flicker risk
- current alert mini-chart behavior:
  - alert cards now render a static mini chart on the right side of the card
  - alert mini charts render a translucent filled area under the line
  - alert-card sparkline snapshots are keyed by `alert.id`
  - each alert row freezes its own mini chart snapshot after the fetch completes
  - the cache is browser-local and account-scoped
  - a newer alert for the same token no longer mutates older alert-card mini charts
  - the cache is pruned when old alert rows leave the capped local alert history or are removed/cleared
  - hover inspection shows approximate market cap plus approximate bucket time for the selected point
  - clicking an alert mini chart opens the shared compact expanded sparkline popup on demand
  - the popup is seeded from the clicked alert's frozen mini-chart snapshot before the full available history request completes
  - repeated opens reuse a short frontend/backend expanded-chart cache instead of refetching immediately
  - the current request profile still uses the same `14d` / `336`-point sparkline window with age-adaptive granularity
  - alert mini charts use the same backend sparkline endpoint and can benefit from the aggregate `5m`/`15m`/`30m` source plus `1m` fallback

### PumpFun migration state
- backend-only PumpPortal migration stream
- frontend no longer mounts the PumpFun live panel or keeps PumpFun session state active
- migrated tokens enter the catalog as `pumpfun-migrated` active monitor candidates and then follow the normal catalog-worker eligibility, migration grace, minimum market-cap, and archive rules

## Session Boot Flow

1. frontend attempts cookie-backed restore with `GET /api/auth/me`
2. frontend loads:
   - `GET /api/config`
   - `GET /api/dashboard/monitored`
3. frontend rebuilds tracked state from:
   - backend monitored payload
   - backend manual tokens for that account
   - blocklist
   - starred tokens

Important:
- monitoring now auto-starts when an authenticated session is restored
- the old `START MONITORING` button is no longer the primary workspace-header control
- if `/alerts` is hidden for less than `20m`, the live workspace now enters a lighter hidden mode instead of behaving exactly like the visible workspace:
  - live polling is paused
  - PumpFun frontend runtime is no longer mounted
  - backend alert events can still be accepted into alert state
  - backend alert sounds are attempted while hidden, but the stronger guarantee is that returning to the tab should not replay a burst of catch-up alert sounds
  - repeated hidden user-scoped backend alerts now coalesce per `user + rule + token` instead of endlessly accumulating duplicate backend rows during the same hidden period
  - returning to the tab schedules a monitored refresh with unseen alert-feed catch-up
- if the tab stays hidden/unfocused for `20m`, the frontend stops the runtime and forces a reload when the user returns
- manual-token restore is intentionally independent of dashboard success; `GET /api/config` alone is sufficient to recover the per-user manual list
- legacy frontend auth token storage was removed from the live session path
- cookie-session expiry now defaults to `AUTH_SESSION_EXPIRES_IN || JWT_EXPIRES_IN || 30d`, so normal browser restarts preserve login until the session is revoked or expires
- non-auth routes now canonicalize into the authenticated workspace URLs:
  - `/alerts`
  - `/monitor`

## Workspace Split And Tab Coordination

Files:
- `frontend/src/state/app-controller.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/ui/app-shell.ts`
- `frontend/src/ui/sections/layout-sections.ts`

High-level behavior:
- `live` is still the internal state name for the `/alerts` workspace
- `history` is still the internal state name for the `/monitor` workspace
- the header exposes those workspaces as:
  - `ALERTS`
  - `RADAR`
- only the visible label changed from `MONITOR` to `RADAR`; the route remains `/monitor` to preserve existing links, routing, and internal state assumptions

`/alerts` responsibilities:
- mounts:
  - monitored
  - manual
  - alerts
- manual token charts are loaded in this workspace
- replays unseen backend-owned alert feeds from the dashboard alert-events feed
- no longer runs PumpFun-local frontend alert generation
- does not mount `Recent`, `Old Week`, or `Bid Zone`
- does not mount `Bid Zone`
- live workspace layout is now user-customizable and persisted:
  - panels can be reordered by drag handle
  - `Monitored` and `Alerts` can resize between `1/3`, `2/3`, and `3/3`
  - the header includes a dedicated reset action for the default live layout

`/monitor` responsibilities:
- mounts:
  - `Recent Tokens`
  - `Old Tokens 1 Week+`
  - `Bid Zone Coins`
- routed token charts are loaded in this workspace
- still consumes live monitored dashboard state
- does not run:
  - frontend alerts
  - PumpFun frontend runtime

Multi-tab coordination:
- `/monitor` and `/alerts` tabs coordinate with `BroadcastChannel`
- one active tab per coordinated workspace becomes leader
- only the `/monitor` leader continues the repeating polling loop for:
  - `GET /api/dashboard/monitored`
  - `POST /api/dashboard/history-bootstrap`
  - `GET /api/catalog/bid-zone`
- leader also owns routed-chart refresh for:
  - `POST /api/catalog/sparklines`
- follower monitor tabs receive monitored/bid-zone/sparkline snapshots from the leader
- the `/alerts` workspace now uses a conservative leader-tab model for expensive shared polling/visual data:
  - monitored dashboard snapshots
  - monitored sparklines
  - top performers snapshots
- hidden `/alerts` tabs are not leader candidates
- socket connection, live presence, alert acceptance, sound/browser-notification state, and direct user actions remain per tab

Workspace header status:
- the header now exposes runtime health through a compact status indicator:
  - `Connected`
  - `Unstable`
  - `Disconnected`
- current rule shape:
  - `Disconnected` if session is not authenticated or runtime mode is `stopped`
  - `Unstable` if runtime mode is `syncing`
  - `Unstable` if monitored freshness is older than `15s`
  - otherwise `Connected`
- the `/alerts` path now invalidates/rerenders the header after successful monitored refreshes, so a fresh monitored payload updates the status immediately instead of waiting for a later header-only cycle

## Login / Account Surface

Files:
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/ui/app-shell.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/ui/sections/auth-feedback.ts`
- `frontend/src/ui/sections/login-form-utils.ts`
- `frontend/src/ui/sections/auth-extensions.ts`

Current login behavior:
- login is the entry point into the backend-owned session model
- current successful paths:
  - verification-link path:
    - user confirms email via `POST /api/auth/verify-email/confirm`
    - backend creates the dedicated pre-access session when access is not yet valid
    - frontend routes directly into `/access`
  - manual login path:
    - `POST /api/auth/login`
    - backend verifies email/password
    - backend sends login OTP to the verified account email
    - `POST /api/auth/login-otp/verify`
    - backend branches by access state:
      - valid access -> `GET /api/auth/me` + normal bot hydration
      - `inactive` / expired -> pre-access session + `/access`
      - `revoked` / deactivated -> blocked
  - social login path:
    - login panel exposes `Continue with Google` and `Continue with Discord`
    - `GET /api/auth/social/:provider/login/start`
    - provider redirects to `GET /api/auth/social/:provider/login/callback`
    - backend exchanges OAuth code and resolves the provider identity
    - Google can create a new verified account automatically when its verified email is not already registered
    - the generated username comes from the email local-part, sanitized to the account username rules, with a numeric suffix on collision
    - Discord remains linked-account-only
    - backend branches by access state:
      - linked + valid access -> normal bot session without OTP
      - linked + `inactive` / expired -> pre-access session + `/access`
      - linked + `revoked` / deactivated -> blocked
      - unlinked Google + new verified email -> create inactive account + pre-access session + `/access`
      - unlinked Google + existing email -> block automatic merge and require authenticated linking from the original account
      - unlinked Discord -> return to login with explicit social-login error
- restore path:
  - normal session:
    - `GET /api/auth/me`
    - same config/bootstrap hydration path
  - pre-access session:
    - `GET /api/pre-access/me`
    - `GET /api/pre-access/billing/state`

Login access rules:
- unverified accounts cannot sign in
- login session/cookie is created only after OTP verification succeeds
- login OTP is email-based and currently uses a `6`-digit code
- login OTP supports resend
- successful sessions are now long-lived by default rather than browser-session-only, while still remaining backend-revocable
- new non-admin accounts now default to `inactive`
- `access_status = inactive` and expired access route the user into `/access`
- `access_status = revoked` and `is_active = false` are hard blocks
- invite-based registration can immediately grant timed access when the consumed invite has `grant_access_days > 0`
- that invite grant affects access state only; it does not make the new account an admin
- successful verify-email now skips the immediate OTP step and opens pre-access directly
- Google login can provision a new account; Discord login is allowed only for previously linked identities
- social login does not use OTP
- local `email + password` login still uses OTP
- social login never performs email-based merge
- Google-only accounts may keep using OAuth without adding a password
- unlinking a social identity requires a usable local password; Google-only users can create one through the password-reset email flow

Current login UX features:
- `TrendScope` branding with `Volume Bot Tracker`
- specific auth-state messaging instead of generic loading
- preserved form values across rerenders
- Enter/Return submit handling
- double-submit guard
- password `Show / Hide`
- caret preservation on password visibility toggle
- caps-lock hint
- validation/focus recovery on the correct field after failed submit
- old-password warning after local password-change history match
- email OTP modal to finish sign-in
- dedicated pre-access landing and billing flow at `/access`
- dedicated public landing at `/` with dynamic plan preview
- dedicated login surface at `/login`
- auth modals now use focus trapping so `Tab` stays inside the active modal
- separated support actions:
  - `Create Account`
  - `Forgot Password`
  - `Access Help`
- login panel now includes:
  - `Continue with Google`
  - `Continue with Discord`
  - explicit copy that these buttons are for linked accounts only

Current login/help layout rules:
- `Create Account` and `Forgot Password` live under the password field
- `Access Help` stays in the support block
- auth modals are centered overlays with backdrop blur

## Create Account

Files:
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/ui/app-shell.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/state/auth-flow-utils.ts`
- `frontend/src/services/api/auth.ts`
- `frontend/src/services/api/invites.ts`

Behavior:
- account creation is invite-gated
- modal flow collects:
  - `username`
  - `email`
  - `password`
  - `confirm password`
  - `invite code`
- invite can be validated before submit
- submit path:
  - `POST /api/auth/register`
  - account is created as `is_email_verified = false`
  - backend attempts to send verification email
  - frontend opens the post-register verification notice modal

Current auth rule:
- registration does not auto-login the user
- account access stays blocked until email verification succeeds
- after successful verify-email, users without product access are auto-signed into the dedicated pre-access flow instead of being forced through immediate OTP

UX rules:
- register-specific errors stay inside the register modal
- register errors do not leak into the base login flash
- field focus returns to the relevant field on failure
- values stay preserved on failed submit
- password requires confirmation before submit

Backend rule added in this session:
- invite usage is consumed only on successful registration
- duplicate `username` / duplicate `email` failures do not burn the invite

## Change Password

Files:
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/ui/app-shell.ts`
- `frontend/src/state/app-controller.ts`
- `src/routes/auth.js`

Behavior:
- available from the authenticated user menu
- opens as a centered modal
- requires:
  - current password
  - new password
  - confirm new password
- submit path:
  - `POST /api/auth/change-password`
- on success:
  - backend revokes all sessions for the account
  - frontend clears current session
  - user is returned to login
  - frontend shows a password-changed success modal
  - backend sends a password-changed notification email

UX rules:
- change-password errors are isolated to the modal
- dashboard/global bot flash does not show change-password errors
- wrong current password shows inline feedback in the modal
- focus returns to `Current password` on incorrect current password
- `Show / Hide` uses the minimal text-only style preferred in the current UI
- `Tab` is trapped inside the modal
- config inputs behind the modal no longer react to modal field blur/change events

Security behavior:
- changing password revokes other sessions too
- login with the old password fails after the change

## Forgot Password

Files:
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/services/api/auth.ts`
- `src/routes/auth.js`
- `src/services/auth-email.js`
- `src/models/password-reset-token.js`

Current status:
- real self-serve password reset is implemented

Behavior:
- request path:
  - `POST /api/auth/password-reset/request`
  - generic response to avoid leaking whether the account exists
- confirm path:
  - link lands on frontend reset modal via query params
  - user sets:
    - new password
    - confirm new password
  - `POST /api/auth/password-reset/confirm`
- success path:
  - backend revokes all sessions for the account
  - frontend clears the current session state
  - user returns to login with success messaging
  - backend sends a password-changed notification email

Current rules:
- reset email is only useful for active verified accounts
- reset token is single-use
- reset token expires
- reset modal keeps focus trapped while open

## Email Verification

Files:
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/services/api/auth.ts`
- `src/routes/auth.js`
- `src/services/auth-email.js`
- `src/models/email-verification-token.js`

Behavior:
- verification email is sent after successful registration when email delivery is enabled
- unverified accounts cannot log in
- confirm path:
  - verification link lands on frontend via query params
  - frontend calls `POST /api/auth/verify-email/confirm`
  - success creates the pre-access session when the account still lacks product access
  - frontend routes to `/access`
- resend path exists via:
  - `POST /api/auth/verify-email/request`

UI rules:
- post-register flow shows an informational `Check Your Email` modal
- that post-register modal is not the same as the manual resend form
- closing the informational modal ends the flow instead of falling through to the resend form

## Pre-Access Purchase Flow

Files:
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/services/api/pre-access.ts`
- `src/routes/pre-access.js`
- `src/services/pre-access-session.js`
- `src/routes/billing.js`
- `src/services/billing-service.js`

Behavior:
- dedicated route family starts at `/access`
- flow is isolated from the normal bot shell
- available to:
  - newly verified accounts without product access
  - manually logged-in accounts whose access is `inactive` or expired
- not available to:
  - `revoked` accounts
  - `is_active = false` accounts
- user can:
  - choose a plan
  - create a billing order
  - leave for MoonPay or local mock checkout
  - return and wait for backend confirmation
  - upgrade into the normal bot session after confirmed payment

Current implementation notes:
- `/access` is now intentionally narrow:
  - topbar actions
  - transient payment state notices
  - pricing cards
  - no giant account-target hero
- local mock checkout is already integrated for development validation, but it is now intentionally narrow:
  - available only in `development` / `test`
  - available only on loopback hosts
  - requires authenticated access
  - only operates on the authenticated user's own order
- webhook-confirmed access remains the backend source of truth
- successful non-mock webhook processing is now stricter than the earlier version:
  - the webhook bearer token alone is not enough to grant access
  - `billingOrderId`, optional `billingPlanKey`, and optional `appUserId` from `additionalJSON` are validated against the saved order
  - the backend now looks up the saved charge via the provider before granting access
  - charge reconciliation currently checks:
    - provider charge id
    - paylink id
    - requested amount
    - currency
    - provider transaction id
    - transaction signature when present
    - successful provider transaction status
  - if a provider lookup fails transiently after the event row is created, the same delivery can be retried and processed later instead of being treated as permanently duplicated
- successful payment upgrades access and then upgrades the session into the normal bot session
- `User Settings` billing still exists, but it is no longer the primary journey for no-access users
- the pricing cards in `/access` now reuse the same visual/card hierarchy as the public landing instead of maintaining a separate older billing-card template
- `/access` now hydrates plan selection from the public billing-plan payload so pricing cards do not wait on order-history loading
- pre-access checkout opens in a new tab
- while the checkout link is being generated, the selected pricing card shows an explicit in-card loading banner
- MoonPay dynamic paylinks are supported per billing plan with `providerPaylinkDynamic: true`
  - dynamic plans reuse `providerPaylinkId` for full and discounted checkout
  - the backend sends `requestAmount` to MoonPay/Helio from the final order price
  - `amountMinor: 1500` remains `USDC 15.00` in the app, while the provider `requestAmount` is sent as decimal `15`
  - fixed paylink plans still require `discountProviderPaylinkId` for discounted checkout
- current sandbox/dev validation uses a single public tunnel on the frontend origin:
  - `frontend/vite.config.ts` proxies `/api` and `/socket.io` to `localhost:3000`
  - this allows provider redirect and MoonPay webhook calls to share the same public host during local testing

## Limited Account Settings Surface

Files:
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/services/api/account.ts`
- `src/routes/account-security.js`

Behavior:
- visible UI label is `Account Settings`
- internal route remains `/account-security`
- available to:
  - normal authenticated sessions
  - `pre_access` sessions
- not available to:
  - `revoked` accounts
  - `is_active = false` accounts
- user can:
  - review linked Google/Discord identities
  - unlink provider identities with `currentPassword`
  - review billing history
  - open internal receipt pages for paid orders
  - resume unfinished checkout sessions from billing history

Important rule:
- `link` remains available only inside the normal authenticated bot session
- this limited route is intentionally for recovery/settings tasks, not product access

## Social Identity Linking

Files:
- `src/routes/social-auth.js`
- `src/services/social-oauth.js`
- `src/services/social-link-session.js`
- `src/models/user-social-identity.js`
- `src/services/social-auth.js`
- `src/routes/account.js`
- `frontend/src/state/app-controller.ts`
- `frontend/src/services/api/account.ts`
- `frontend/src/ui/sections/layout-sections.ts`

Behavior:
- only available from an already authenticated normal app session
- exposed in `User Settings` under `Connected Identities`
- supported providers:
  - `Google`
  - `Discord`
- flow:
  - `GET /api/auth/social/:provider/start`
  - provider OAuth consent
  - `GET /api/auth/social/:provider/callback`
  - identity is attached to the current local account when validation succeeds

Current linking rules:
- linking must not start from pre-access
- linking requires the same authenticated session that started the flow
- provider identity conflict blocks linking
- provider email conflict with another local account blocks linking
- automatic merge by email is intentionally blocked
- one provider slot per account is enforced in the current data model

Current callback model:
- `APP_BASE_URL` is the frontend/public app base
- `SOCIAL_AUTH_CALLBACK_BASE_URL` is the backend/public callback base when frontend and backend live on different hosts
- local testing currently works best when the full flow starts and ends on the same public host, typically the single frontend `ngrok` URL

## Social Login

Files:
- `src/routes/social-auth.js`
- `src/services/social-oauth.js`
- `src/services/social-link-session.js`
- `src/models/user-social-identity.js`
- `frontend/src/state/app-controller.ts`
- `frontend/src/ui/sections/layout-sections.ts`

Behavior:
- linked Google/Discord identities can sign in directly
- Google can also provision a new inactive account from a verified provider email
- start routes:
  - `GET /api/auth/social/:provider/login/start`
- callback routes:
  - `GET /api/auth/social/:provider/login/callback`

Current login rules:
- linked `Google` / `Discord` identities can sign in without OTP
- local `email + password` login still requires OTP
- Google creates a new account only when the provider email is verified and does not belong to an existing account
- Discord never creates a new account
- social login never merges by email
- linked + active access -> normal bot session
- linked + `inactive` / expired -> pre-access session + `/access`
- linked + `revoked` / deactivated -> blocked
- not linked -> return to login with explicit social-login error

## Solana Wallet Selection

Files:
- `frontend/src/services/wallets/solana-wallets.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/ui/sections/layout-sections.ts`

Behavior:
- wallet login and account linking discover compatible providers through Wallet Standard
- supported installed wallets include Phantom, Solflare, Backpack, and other providers exposing `standard:connect` plus `solana:signMessage`
- the user explicitly chooses the wallet before challenge creation
- the backend remains provider-agnostic and verifies the Solana public key plus Ed25519 signature
- MetaMask is not registered through the MetaMask Solana SDK; it appears only if the user's environment exposes MetaMask as a compatible Wallet Standard Solana provider
- `VITE_SOLANA_NETWORK` and `VITE_SOLANA_RPC_URL` must match the token-gate environment
- message-signing login does not submit an on-chain transaction; network approval or switching is wallet-dependent

Important implementation note:
- linking and social login now use different callback URIs for each provider
- both callback URIs must be registered with Google and Discord
- local/production misconfiguration of only one callback URI is enough to make half of the social-auth surface fail while the other half still works

## Access Help

Files:
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/ui/app-shell.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/services/api/invites.ts`

Behavior:
- support modal focused on invite/account-access guidance
- current functional action is invite validation
- email field was removed because it was not functionally used

Current content:
- invite checker
- admin/support guidance
- strong anti-scam warning

Typography:
- login/auth surface now uses `Saira` as the current auth UI font direction

## Logout / Logout All

Files:
- `src/routes/auth.js`
- `src/models/session.js`
- `frontend/src/state/app-controller.ts`

Behavior:
- `Logout` revokes current session only
- `Logout All` revokes all sessions for the authenticated account only
- `Logout All` does not affect other users on the server
- live socket disconnect behavior now matches those HTTP semantics:
  - `Logout` drops only the current session socket
  - `Logout All`, password change, password reset, and admin revoke/deactivate drop all live sockets for that account

Important operational note:
- session counts can be higher than expected because server-side sessions can accumulate from prior logins, tabs, browsers, and devices

## Monitored Tokens

Files:
- `frontend/src/ui/sections/monitored-section.ts`
- `frontend/src/state/app-controller.ts`
- `src/routes/dashboard.js`

Main behavior:
- frontend polls `GET /api/dashboard/monitored` every `3s`
- backend returns prepared catalog rows
- frontend rebuilds monitored token state from that payload
- backend payload includes `generatedAt`
- frontend shows a freshness label in the panel header based on that backend timestamp
- the panel supports compact local search by:
  - symbol
  - name
  - contract/address
- the shared compact-search interaction now supports `Enter/Return` to blur/commit the current query
- monitored search also listens for input/change/search/cut updates so clearing a query cannot leave the panel stuck on the previous ticker
- the `TOKENS` pill reflects the filtered monitored count
- only the visible page of cards is rendered, but the full monitored set still stays in memory for alert logic and routed-bar derivation
- this panel is mounted only in `/alerts`

Current sorting:
- `VOL`
  - hover dropdown:
    - `5M`
    - `1H`
    - `6H`
    - `24H`
- `MCAP`
  - hover dropdown:
    - `HIGHEST`
    - `LOWEST`
- `AGE`
  - hover dropdown:
    - `NEWEST`
    - `OLDEST`

Sorting rules:
- multiple sort criteria can stay active at the same time
- the most recently toggled criterion has highest priority
- `MCAP` is exclusive within its own group:
  - `HIGHEST` or `LOWEST`
- `AGE` is exclusive within its own group:
  - `NEWEST` or `OLDEST`

Important:
- this panel is now backend-driven
- it is no longer primarily driven by direct Dex patches
- practical freshness is now determined mainly by:
  - catalog worker reevaluation cadence
  - dashboard poll cadence
  - backend `generatedAt` payload timing
- the monitored header is intentionally split into two independently positioned rows:
  - top row for sorting + filtered token count
  - bottom row for compact search + page controls
- opening the monitored compact search only pushes the bottom row
- this panel can now also be collapsed
  - collapse currently affects the UI/render surface only
  - monitored refresh and alert logic continue while collapsed
- current card-link behavior:
  - the white token symbol itself is now the Dex Screener link
  - the action row contains the X-search button and, when present, the Dex-provided social/community X URL
  - the X-search button searches `contract OR $ticker`
  - the social/community button changes only by URL pattern:
    - `👥` for `x.com/i/communities/...`
    - `👤` otherwise
- current `VOL 5M` card-delta behavior:
  - the large `VOL 5M` number remains the live catalog `volume5m`
  - the small delta below it now uses backend-provided `prevVolume5mCanonical`
  - this is visual-only and does not change the monitored alert engine

## Bid Zone Coins

Files:
- `frontend/src/ui/sections/bid-zone-section.ts`
- `frontend/src/state/app-controller.ts`
- `src/routes/catalog.js`
- `src/models/token-market-bucket-1m.js`
- `src/services/bid-zone-worker.js`

Main behavior:
- frontend polls `GET /api/catalog/bid-zone` every `60s`
- backend returns rows from the latest completed persisted bid-zone snapshot
- backend payload includes `generatedAt`
- scheduled worker is disabled by default; enable with `BID_ZONE_WORKER_ENABLED=true`
- boot run is disabled by default unless `BID_ZONE_WORKER_RUN_ON_START=true`
- heavy candidate SQL uses `BID_ZONE_STATEMENT_TIMEOUT_MS` and `BID_ZONE_CANDIDATE_SCAN_LIMIT`
- frontend shows a freshness label in the panel header based on that timestamp
- the panel is rendered in `/monitor`

Current model intent:
- this is the only heavy history-analysis coin panel currently mounted
- the ranking is meant for support-defended accumulation / bid-area setups
- support and resistance are based on close-derived quantile bands rather than raw min/max wick extremes
- the score currently emphasizes:
  - support distance
  - support-touch clusters
  - recent compression
  - close drift
  - coverage
  - liquidity

Current row surface:
- `#rank`
- symbol + name
- actions aligned with the monitored/bid-zone visual language
- `MCAP`
- `AGE`
- `VOL 1H`
- `VOL 24H`
- rail metrics:
  - `SCORE`
  - `SUPPORT`
  - `RANGE`
  - `TOUCH`

Important:
- it is the active support-zone analysis surface in `/monitor`
- in `/monitor`, bid-zone is also part of the `BroadcastChannel`-shared polling path between tabs

## Manual Tokens

Files:
- `frontend/src/ui/sections/manual-section.ts`
- `frontend/src/state/app-controller.ts`
- `src/routes/config.js`
- `src/routes/catalog.js`

Behavior:
- user adds token by address
- frontend calls backend config/catalog flows
- backend persists the manual list per account
- backend upserts the token into `token_catalog`
- backend schedules immediate evaluation
- `POST /api/catalog/manual-track` now also attempts an eager Dex evaluation immediately instead of waiting only for the catalog worker loop
- if that eager evaluation fails, the token still falls back to the normal scheduled worker evaluation path
- launchpad-style manual tokens can continue receiving GMGN token-info snapshots while pending/pre-migration or while Dex has not produced a usable pair yet; once a manual token is Dex-confirmed, GMGN token-info becomes fallback instead of a required pre-Dex lookup
- removing a manual token demotes the global catalog row from `user-manual` back to `dexscreener-discovery` when no user still has that address pinned

Rules:
- `_userManual = true`
- manual token survives `F5`
- manual token is protected from `min-mcap-remove`
- removing a manual token removes the user pin, not the global catalog entry

Table features:
- rank column `#`
- sort by `VOL`, `MCAP`, `PCHANGE`, `AGE`
- supports multiple active sort criteria at once
- `AGE` supports `NEWEST` and `OLDEST`
- `MCAP` supports `HIGHEST` and `LOWEST`
- compact local search by symbol, name, or contract/address
- the compact-search input supports `Enter/Return` to blur/commit the current query
- supports a compact `starred only` toggle using the same small-square visual language as the search control
- panel can be collapsed
  - collapse currently affects the UI/render surface only

## Recent Tokens

File:
- `frontend/src/ui/sections/routed-sections.ts`

Definition:
- age inside a user-configurable window from `0m` to `7d`
- inside the Recent MCAP window configured by user
- mounted in `/monitor`

Rules:
- derived from tracked token state
- excludes `_userManual` tokens from routed discovery bars
- supports local dismiss
- supports compact local search by symbol, name, or contract/address
- supports per-user persisted age filters through:
  - `AGE MIN`
  - `AGE MAX`
- the age inputs accept shorthand values like `30m`, `2h`, and `1d`
- `AGE MAX` is normalized so it cannot be lower than `AGE MIN`
- the compact-search input supports `Enter/Return` to blur/commit the current query
- supports a compact `starred only` toggle
- the workspace header now uses a compact runtime status indicator instead of the old manual start/stop button
- routed eligibility is now maintained on the token itself via:
  - `_isRecentRouted`
  - `_isOldWeekRouted`
- this means:
  - collapse can pause visible Recent-list derivation
  - `old-surge` still remains correct while the bar is collapsed
- when `Recent Tokens` is collapsed:
  - body/render is removed
  - list derivation is paused
  - reopening forces an immediate rebuild from the current tracked token state

Sorting:
- `VOL`
- `MCAP`
- `PCHANGE`
- `AGE`

Age sort options:
- `NEWEST`
- `OLDEST`

MCAP sort options:
- `HIGHEST`
- `LOWEST`

Sorting rules:
- multiple criteria can be active at the same time
- `AGE` remains exclusive inside its own group
- `MCAP` remains exclusive inside its own group

## Old Tokens 1 Week+

File:
- `frontend/src/ui/sections/routed-sections.ts`

Definition:
- age inside a user-configurable window with a hard floor of `7d`
- inside the Old Week MCAP window configured by user
- mounted in `/monitor`

Rules:
- derived from tracked token state
- supports local dismiss
- supports compact local search by symbol, name, or contract/address
- supports per-user persisted age filters through:
  - `AGE MIN`
  - `AGE MAX`
- `AGE MIN` is clamped to `7d` or higher
- `AGE MAX` is optional; a blank value means no maximum age limit
- the compact-search input supports `Enter/Return` to blur/commit the current query
- supports a compact `starred only` toggle
- when `Old Tokens 1 Week+` is collapsed:
  - body/render is removed
  - list derivation is paused
  - reopening forces an immediate rebuild from the current tracked token state

Sorting:
- `VOL`
- `MCAP`
- `PCHANGE`
- `AGE`

Age sort options:
- `NEWEST`
- `OLDEST`

MCAP sort options:
- `HIGHEST`
- `LOWEST`

Sorting rules:
- multiple criteria can be active at the same time
- `AGE` remains exclusive inside its own group
- `MCAP` remains exclusive inside its own group

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

## Terminal Links

Files:
- `frontend/src/ui/sections/shared.ts`

Current link behavior:
- terminal availability is user-configurable through persisted `uiPrefs.enabledTradeTerminals`
- if multiple terminals are enabled, token actions open the selector menu
- if exactly one terminal is enabled, the token action opens that terminal directly
- Axiom:
  - default path uses `tokenAddress`
  - migrated PumpFun tokens use the generic token action path after they enter monitored/catalog state
- Photon:
  - uses `tokenAddress`
- BullX:
  - uses `tokenAddress`
- GMGN:
  - uses `tokenAddress`
- Padre:
  - uses `https://trade.padre.gg/trade/solana/{address}`
  - current address selection order:
    - `pairAddress`
    - `mintAddress`
    - fallback `address`

Important Padre note:
- the bot only computes and opens the initial Padre URL
- Padre may rewrite the visible URL after load
- that later rewrite is Padre-side behavior, not a second-stage link transform in the bot

## PumpFun Backend Migration Flow

Files:
- `src/services/pumpfun-ws.js`
- `src/services/pumpfun-pre-migration-capture.js`
- `src/services/socket-hub.js`
- `src/models/token-catalog.js`
- `src/services/catalog-worker.js`

Behavior:
- backend maintains one server-side PumpPortal websocket for migration capture
- backend websocket subscribes with:
  - `subscribeMigration`
- backend no longer subscribes to new-token or per-token trade streams for the frontend
- Socket.io no longer exposes PumpFun live fanout or PumpFun client subscription events
- frontend no longer mounts the PumpFun live panel, local PumpFun toasts, or local PumpFun alert generation

Optional pre-migration capture:
- controlled by `PUMPFUN_PRE_MIGRATION_CAPTURE_ENABLED`
- default state is disabled
- when enabled, create/trade observations are tracked in process memory for up to `PUMPFUN_PRE_MIGRATION_MAX_TRACKED` mints
- default track TTL is `2h`
- pre-migration observations can write MCAP/price buckets into `token_market_buckets_1m`
- pre-migration trade volume windows can write into `token_market_volume_buckets_1m`
- migration events remove the tracked pre-migration state for that mint
- status is visible as `pumpfunPreMigrationCapture` inside `GET /api/admin/ws-status`

Migration behavior:
- current expected backend path:
  - PumpPortal websocket emits `txType: "migrate"`
  - backend logs/handles `pump_migrate_received`
  - backend upserts the token as `pumpfun-migrated`
  - token gets `migration_grace_until`
  - catalog worker performs the first Dex evaluation immediately
  - dashboard/monitored visibility still depends on the existing catalog-worker filters and Dex data availability
- important nuance:
  - Dex paid metadata is not a requirement for normal Dex market reads (`mcap`, `price`, `volume`, pair selection)
  - this backend-only path does not bypass minimum market-cap, migration grace, low-dust archive, or other monitored eligibility rules

## Alerts

Files:
- `frontend/src/state/app-controller.ts`
- `frontend/src/ui/sections/alerts-section.ts`
- `frontend/src/services/alerts/sound.ts`
- `frontend/src/services/alerts/browser-notifications.ts`
- `src/services/backend-alert-feed.js`

Main alert types:
- `monitored-vol`
- `monitored-mcap`
- `hvnc`
- `recent-surge-1h`
- `recent-surge-6h`
- `old-week-surge-1h`
- `old-week-surge-6h`
- `meteora-surge`
- backend ownership today:
  - user-scoped backend matcher rules:
    - `monitored-vol`
    - `monitored-mcap`
    - `hvnc`
    - `recent-surge-1h`
    - `recent-surge-6h`
    - `old-week-surge-1h`
    - `old-week-surge-6h`
    - `meteora-surge`
- the panel also supports local text search by symbol, name, or contract/address
- the alerts search now uses the same compact-search behavior as the other lupa inputs and supports `Enter/Return` to blur/commit
- alerts are restored from browser-local storage per account scope
- runtime state and browser-local persistence now keep the most recent `120` alert cards
- the panel paginates alert cards at `40` alerts per page
- pagination controls live in the `Alerts` header so page navigation remains visible while the alert list scrolls
- backend-owned alerts are accepted into `/alerts` from backend feed/socket paths
- card effects can be disabled per user through `card-effects-mode = off`
- current FX architecture:
  - list rows remain stable
  - overlay FX are played through `.alert-fx-ghost-*` elements outside the row
  - real-card shake is limited to higher tiers rather than the whole panel
- alerts can be removed:
  - all at once via `Clean All`
  - individually via the card-level `×`
- current links-row behavior:
  - `X Buscar CA /` opens X search using `contract OR $ticker`
  - the social link now renders only the emoji:
    - `👥` for X community URLs
    - `👤` otherwise
- current ticker-peer badge behavior:
  - backend alert snapshots include same-ticker peer metadata from `src/services/alert-ticker-peers.js`
  - the frontend renders a compact peer marker beside the alert token line
  - exact ticker peers define the source role:
    - `OG` when the alerted token is both the oldest known exact ticker match and the highest-market-cap exact ticker match
    - `#1` when the alerted token is the highest-market-cap exact ticker match but not the oldest
    - `!` for the normal duplicate ticker/subticker warning state
  - `OG` is blue and `#1` is green
  - both role marks inherit the same size/weight as the warning marker
  - exact peer role promotion requires complete exact-peer mcap data
  - subticker matching now starts at `3` normalized characters
  - subticker matches are context-filtered against source symbol/name words so unrelated ticker extensions are excluded from peer counts
  - the peer popover shows peer avatar, symbol/address, mcap, and age at alert time

### Monitored VOL alert
Rules:
- backend matcher candidate built from backend signal inputs
- respects:
  - `threshold`
  - `min-vol`
  - `min-mcap`
  - `max-mcap`
- suppressed if MCAP is declining during the same comparison
- shares standard cooldown family with monitored MCAP
- repeat semantics are anchored to the last alerted value:
  - repeat alert payload uses the last alerted `prevVolume5m`
  - the token must show fresh progression relative to that last alerted value
  - this prevents the old “wait 1 minute and reapita igual” behavior
- semantic split:
  - backend matching does not use the card’s visual `prevVolume5mCanonical`
  - `prevVolume5mCanonical` remains visual-only for the monitored card delta

### Monitored MCAP alert
Rules:
- backend matcher candidate built from backend signal inputs
- respects `mcap-threshold` plus the general alert filters
- tokens younger than `1h` do not qualify
- shares standard cooldown family with monitored VOL
- repeat semantics are anchored to the last alerted MCAP value rather than forever reusing the first baseline

### HVNC
Meaning:
- High Volume New Coin

Rules:
- normal token age up to `5m`
- for `pumpfun-migrated` tokens, age is counted up to `5m` from migration capture, not from pre-migration token creation
- `volume24h >= hvnc-min-vol`
- backend matcher emits it as a user-token event
- still single-fire style unless a new backend lifecycle transition requalifies it

### Old Token Surge
Rules:
- backend matcher still emits surge cards as `kind = old-surge`, but the actual rule keys are split:
  - `recent-surge-1h`
  - `recent-surge-6h`
  - `old-week-surge-1h`
  - `old-week-surge-6h`
- age gates are backend-enforced:
  - no `1H` surge for tokens younger than `1d`
  - no `6H` surge for tokens younger than `2d`
  - `1d <= age < 7d` qualifies only for `recent-surge-1h`
  - `2d <= age < 7d` qualifies for `recent-surge-6h`
  - `age >= 7d` qualifies only for old-week-surge
- thresholds are now split by age bucket/window:
  - recent `1H`
  - recent `6H`
  - old-week `1H`
  - old-week `6H`
- backend anti-spam behavior:
  - if a token is already hot when the current matcher session begins, the rule can be primed instead of alerting immediately
  - `1H` same-session primed-hot release requires `+10pp` PCHANGE advance
  - `6H` same-session primed-hot release requires `+10pp` PCHANGE advance
  - `1H` same-session repeat now requires `+50%` relative PCHANGE growth after the first emitted alert
  - `6H` repeat is now stricter after the first emitted alert:
    - `20m` cooldown
    - `+50%` relative PCHANGE growth
    - and at least `+15%` MCAP growth versus the last alerted MCAP
  - `1H` and `6H` surge variants in the same age bucket cross-block each other for `1h`
  - surge requires `mcap >= 45k` for `1H` and `mcap >= 40k` for `6H`

Badge label in alert card:
- `RECENT TOKEN SURGE` for recent surge age buckets
- `OLD TOKEN SURGE` for `age >= 7d`

Current visual contract:
- `Recent Token Surge` is green
- `Old Token Surge` is orange
- standard monitored `VOL/MCAP` alerts remain blue/yellow/orange by percentage banding

### PumpFun alerts
- frontend-local PumpFun alerts are disabled.
- migrated PumpFun tokens can still trigger normal backend monitored alerts after they pass catalog-worker eligibility.

Persistence and delivery:
- per-user per-rule seen/replay progress lives in `alert_delivery_cursors`
- per-user emitted alert events live in `user_alert_events`
- `user_alert_events` requires `dedupe_key` and enforces `UNIQUE (user_id, dedupe_key)` so the matcher can stay idempotent per user without relying on browser-local ambiguity
  - during hidden user-scoped alert delivery, matcher dedupe now intentionally coalesces repeated emits per `user + rule + token`
- backend feed endpoint:
  - `GET /api/dashboard/alert-events`
- multi-feed catch-up endpoint:
  - `GET /api/dashboard/alert-feeds`
  - this is the current frontend catch-up path for loading multiple backend-owned alert rules together
- cursor update endpoint:
  - `POST /api/dashboard/alert-events/cursor`
- realtime delivery also uses authenticated socket event `alert:event`
  - if an already-known backend event id is republished with fresher payload, the frontend now updates the existing alert card instead of dropping the refresh

Current user-config scope:
- monitored `VOL/MCAP`, `HVNC`, split surge variants, and `Meteora` all expose backend-persisted user enable/threshold config

### Alert evaluation timing
Important current behavior:
- backend alert matching does not depend on the `/alerts` DOM being mounted
- `/alerts` consumes backend event feeds and realtime socket pushes
- PumpFun-local frontend alerts are disabled; migrated PumpFun tokens now flow through the backend catalog/monitored path.

## Browser Notifications

Files:
- `frontend/src/services/alerts/browser-notifications.ts`
- `frontend/src/main.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/ui/app-shell.ts`

Scope:
- Native browser notifications are implemented only for the existing authenticated web app session.
- The app must be open in at least one browser tab.
- This is not closed-tab push notification support.
- Out of scope for the current implementation:
  - Service Worker push
  - Push API subscriptions
  - VAPID keys
  - backend push delivery
  - subscription schema/storage

Settings and permission:
- Bot Settings includes a compact `Browser Notifications` control near sound/card effect settings.
- Permission is requested only from a direct user gesture.
- The UI can show:
  - `Enabled`
  - `Off`
  - `Blocked`
  - `Not supported`
- If the browser permission is denied/blocked, the app cannot reopen the permission prompt by itself; the user must change site/browser permissions.
- Settings are browser-local and account-scoped rather than backend `user_configs`.
- Current storage key shape:
  - `trendscope_browser_notifications_v1:<user-scope>`
- Stored settings currently include:
  - `enabled`
  - `notifyWhenVisible`

Notification eligibility:
- user is authenticated
- runtime mode is `active`
- browser notification setting is enabled
- browser permission is `granted`
- existing alert kind config still allows the alert
- alert id has not already been handled in the page session
- document is hidden/backgrounded by default

Catch-up and duplicate behavior:
- Existing alerts are marked as handled when the user authenticates.
- Existing alerts are marked as handled when runtime first becomes active.
- Existing alerts are marked as handled when browser notifications are enabled.
- This avoids native notifications for historical REST/feed catch-up rows.
- The notification service also keeps an in-memory notified id set and uses `tag = alert:<alert.id>`.

Notification content:
- title is generated from alert family and symbol:
  - `VOL alert: SYMBOL`
  - `MCAP alert: SYMBOL`
  - `HVNC: SYMBOL`
  - `RECENT 1H surge: SYMBOL`
  - `OLD 6H surge: SYMBOL`
  - `METEORA 1H: SYMBOL`
- body includes:
  - percent
  - MCAP transition when `prevMcap`/baseline exists
  - volume transition/window label when available
  - address fragment
- Volume labels are explicit:
  - `VOL 1M` for GMGN 1m volume alerts
  - `VOL 5M` for standard monitored volume context
  - `VOL 1H` / `VOL 6H` for surge alerts
- Token `imageUrl` is used as the native notification icon when it is a safe `http/https` URL; otherwise the app favicon is used.
- The implementation does not send mini chart/sparkline images to native notifications.

Browser/OS limitations:
- Text color, notification duration, origin label, and rendered icon size are controlled by the browser/operating system.
- The origin label appears as `localhost:<port>` during local Vite development and as the production site origin in production.
- macOS/Chrome system notification settings and Focus/Do Not Disturb can prevent display even when the site permission says notifications are allowed.

## Sounds

Files:
- `frontend/src/services/alerts/sound.ts`
- `frontend/src/utils/sound-storage.ts`

Behavior:
- custom sounds can be saved per account scope
- fallback synthesized patterns still exist
- sound respects enable/disable and volume UI settings
- sound now also respects per-alert-type toggles stored in user config
- persistence split:
  - sound enable/disable and volume are backend-persisted user config
  - uploaded custom sound assets remain browser-local and account-scoped

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
- `Recent Surge 1H`
- `Recent Surge 6H`
- `Old Token Surge 1H`
- `Old Token Surge 6H`
- `Meteora 1H`

Persistence:
- these are backend-persisted user config values
- mock trading SOL/USD conversion is no longer edited through user config; current buy/deposit conversion and portfolio display use the backend CoinMarketCap SOL/USD quote service
- legacy `mock-sol-usdc-rate` can remain in persistence for older data/fallback compatibility
- `Sound Alert` is the master sound gate
- `Sound By Alert Type` is the per-kind sound gate

## `D` Column / MCAP Delta

Backend file:
- `src/routes/dashboard.js`

Related models:
- `src/models/token-market-bucket-1m.js`
- legacy fallback: `src/models/token-market-snapshot.js`

Current behavior:
- backend reads the primary baseline from `token_market_buckets_1m`
- it uses the newest valid bucket row as current
- it looks for a valid baseline around `~5m` back
- if the bucket baseline is missing, it can still fall back to legacy `token_market_snapshots`

If no valid pair exists:
- `mcapDelta` remains `null`

## Persistence Model

### Backend persisted
- users
- sessions
- configs
- user UI prefs
- manual tokens
- blocklist
- starred tokens
- token catalog
- market bucket history
- legacy market snapshots
- Meteora snapshots

### Browser-local and account-scoped
- dismissed Recent set
- dismissed Old Week set
- alerts
- alert mini-chart snapshot cache keyed by `alert.id`
- custom sound assets

### User UI prefs

Backend file:
- `src/models/user-ui-pref.js`

Table:
- `user_ui_prefs`

Route surface:
- `GET /api/config`
  - now returns `uiPrefs` alongside `configs`, `tokens`, `blocklist`, and `starredTokens`
- `PATCH /api/config/ui-prefs`

Current cross-browser-synced UI state:
- collapsed sections:
  - `manual`
  - `recent`
  - `oldWeek`
  - `monitored`
  - `pumpfun`
- enabled trade terminals:
  - `axiom`
  - `photon`
  - `bullx`
  - `gmgn`
  - `padre`
- `starred only` toggles:
  - manual
  - recent
  - old week
- per-page controls:
  - monitored
  - recent
  - old week
- sort state:
  - manual
  - recent
  - old week
  - monitored

Intentionally not included there:
- free-text search inputs
- alert cards

## Catalog Entry Paths

A token can enter `token_catalog` from:
- manual track
- Dex discovery worker
- GMGN discovery ingestion
- PumpFun migrate path
- config-related upserts for some user overlays
- admin/manual catalog promote/migrated routes used for operational backfill or migration validation

Important distinction:
- reevaluation is not discovery
- the catalog worker only works on tokens already inside the catalog

Manual-token distinction:
- the per-user manual-token list lives in config/token endpoints
- the global tracked/catalog version of that token lives in `token_catalog`
- these are intentionally separate layers
- the previous bug was not in backend persistence itself, but in frontend rebuild logic using stale local manual state instead of backend `payload.tokens`

## Current Rate Limiting

Files:
- `src/middleware/rate-limit.js`
- `config/index.js`

Limiter buckets:
- `authLimiter`
- `authEmailLimiter`
- `authOtpLimiter`
- `defaultApiLimiter`
- `healthLimiter`
- `dashboardLimiter`
- `pumpfunMetaLimiter`
- `catalogWriteLimiter`
- `catalogReadLimiter`

Current defaults:
- `authLimiter`: `10 / 15min / IP`
- `authEmailLimiter`: `6 / 60min / IP+email/token/session`
- `authOtpLimiter`: `12 / 15min / IP+challenge`
- `healthLimiter`: `30 / 1min / IP`
- `defaultApiLimiter`: `180 / 15min / user+IP`
- `dashboardLimiter`: `360 / 15min / user+IP`
- `pumpfunMetaLimiter`: `300 / 15min / user+IP`
- `catalogWriteLimiter`: `60 / 15min / user+IP`
- `catalogReadLimiter`: `120 / 15min / user+IP`

Reason for this split:
- auth brute force protection should stay tight
- dashboard polling needs more headroom
- PumpFun metadata fetches can burst independently
- one single global limiter was punishing normal usage

## Important API Endpoints

### Auth
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/login-otp/resend`
- `POST /api/auth/login-otp/verify`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/logout-all`
- `POST /api/auth/change-password`
- `POST /api/auth/verify-email/request`
- `POST /api/auth/verify-email/confirm`
- `POST /api/auth/password-reset/request`
- `POST /api/auth/password-reset/confirm`

### Billing / Access
- `GET /api/billing/plans`
- `GET /api/billing/state`
- `GET /api/billing/orders`
- `POST /api/billing/orders`
- `POST /api/billing/webhooks/moonpay`
- `GET /api/pre-access/me`
- `GET /api/pre-access/billing/state`
- `POST /api/pre-access/billing/orders`
- `POST /api/pre-access/complete`
- `POST /api/pre-access/logout`

### Config
- `GET /api/config`
- `PUT /api/config`
- `PATCH /api/config`
- `POST /api/config/tokens`
- `DELETE /api/config/tokens/:address`

### Catalog
- `POST /api/catalog/manual-track`
- `GET /api/catalog/eligible`
- `POST /api/catalog/monitored-metadata-batch`
- `POST /api/catalog/sparklines`
- `POST /api/catalog/admin-blocklist`
- `DELETE /api/catalog/admin-blocklist/:address`
- `GET /api/catalog/history/:address`
- `GET /api/catalog/bid-zone`
- `POST /api/catalog/bid-zone/refresh`
- `POST /api/catalog/meteora/batch`
- `GET /api/catalog/meteora/:address/history`
- `GET /api/catalog/pumpfun/:mint/meta`
- `POST /api/catalog/promote`
- `POST /api/catalog/migrated`

### Temporary migration trace flags
- `PUMP_MIGRATE_TRACE_ENABLED`
  - enables structured Pump migration trace logs in backend stdout/journal
- `PUMP_MIGRATE_TRACE_DISCOVERY`
  - when enabled, also traces `dexscreener-discovery` entry cases for comparison
- `PUMP_MIGRATE_TRACE_ADDRESSES`
  - optional comma-separated mint filter for narrowing trace output
- these flags are intended for investigation and can be turned off after migration-path validation is complete

### Dashboard
- `GET /api/dashboard/monitored`
- `POST /api/dashboard/history-bootstrap`
- `GET /api/dashboard/alert-events`
- `GET /api/dashboard/alert-feeds`
- `POST /api/dashboard/alert-events/cursor`

### Mock Trading
- `GET /api/admin/mock-trading/wallets`
- `POST /api/admin/mock-trading/wallets`
- `PATCH /api/admin/mock-trading/wallets/:walletId`
- `POST /api/admin/mock-trading/wallets/:walletId/default`
- `POST /api/admin/mock-trading/wallets/:walletId/archive`
- `GET /api/admin/mock-trading/summary`
- `GET /api/admin/mock-trading/positions`
- `GET /api/admin/mock-trading/trades`
- `POST /api/admin/mock-trading/buy`
- `POST /api/admin/mock-trading/sell`
- `POST /api/admin/mock-trading/take-profit-orders`
- `POST /api/admin/mock-trading/take-profit-orders/:id/cancel`
- `POST /api/admin/mock-trading/add-cash`
- `POST /api/admin/mock-trading/reset`
- `GET /api/admin/mock-trading/sol-price`

### Admin status
- `GET /api/admin/ws-status`

## Worker Status Visibility

Admin status endpoint currently exposes:
- socket hub status
- catalog worker status
- catalog cleanup worker status
- Meteora snapshot worker status
- Dex discovery worker status
- bid-zone worker status
- token-risk enrichment worker status
- token-risk review sync worker status
- mock-trading take-profit worker status
- mock-trading SOL/USD quote status
- GMGN discovery worker status
- GMGN client/risk-cache status
- DexScreener cache/throttle status

Socket hub nested status includes:
- authenticated client/session/IP counts
- live alert presence cache status
- PumpFun websocket status
- optional PumpFun pre-migration capture status
- SOL price status

Current mock-trading take-profit worker status includes:
- running/in-flight/enabled state
- last run/completion timestamps
- configured batch limit and scheduled delay
- candidate/triggered/skipped/cancelled counts
- cumulative triggered/skipped/cancelled/error counts
- last error

Current GMGN worker status includes:
- enabled/running/in-flight state
- API-key configured flag
- last request count and raw/unique token counts
- rate-limit/backoff state
- catalog updates and volume bucket writes
- mcap bucket writes from GMGN ingestion
- skipped new `1m`-only discovery count
- GMGN junk assessments, skipped junk suspects, and GMGN auto-block count
- GMGN risk-enrichment suppression count
- GMGN risk lookup budget usage/skips
- queued/deduped/fresh-passed GMGN risk review handoffs
- GMGN security/info/kline check counts, error counts, and auto-block counts
- GMGN bad-liquidity-status mcap-band auto-block counts (`lastGmgnBadLiquidityStatusAutoBlocked`, `totalGmgnBadLiquidityStatusAutoBlocked`)
- GMGN low-mcap extreme-volume auto-block counts
- GMGN new non-pump high-launch auto-block counts (`lastGmgnNewNonPumpHighLaunchMcapAutoBlocked`, `totalGmgnNewNonPumpHighLaunchMcapAutoBlocked`)
- alert matcher evaluations and emitted alert counts
- alert matcher debounce/suppression skip counts
- GMGN alert-safeguard skip counts (`lastMatcherSkippedGmgnSafeguard`, `totalMatcherSkippedGmgnSafeguard`)
- emitted `gmgn-vol-1m` count
- GMGN panel seen/stale/handoff counts
- nested `riskReviewQueue` status with queue depth, fresh passed-review count, processing limit, last/total processed, last/total passed, last/total auto-blocked, and last/total errors
- top-level `gmgn.riskLookupCache` status with enabled flag, TTL, max entries, current entries, hits, misses, writes, evictions, expired entries, and clears

Current Meteora worker status now includes:
- total eligible Meteora universe
- last dynamic batch limit
- universe by tier
- target checks/min by tier
- effective checks/min by tier
- target checks/cycle by tier
- selected count by tier
- degrade flag and degraded tiers

## Current Known Weak Spots

- Dex reevaluation can still produce many `dex_unavailable` results
- PumpFun metadata route can still pressure rate limiting in bursts
- discovery is restored through Dex feeds again, but underlying Dex availability remains a dependency
- the highest-risk auth/account/config/list render surfaces have been hardened, but lower-traffic UI helpers still use HTML-string-heavy patterns in places
- the current CSP is pragmatic and intentionally compatible with:
  - self-hosted fonts
  - external HTTPS token images
  - local websocket/API development
  This means it is stronger than before, but not maximalist
- the frontend no longer depends on third-party font requests:
  - currently used font families are self-hosted from `frontend/public/fonts`
  - `frontend/src/styles/local-fonts.css` provides the local `@font-face` mapping

## Current VPS Deployment Notes

The active production-like deployment is now a private VPS rather than Railway.

Current intended exposure model:
- `nginx` is the public entrypoint on `80/443`
- backend traffic is routed through `https://api.trendscope.pro`
- the public frontend remains separate at `https://www.trendscope.pro`
- PostgreSQL stays local/private on the VPS and should not be publicly exposed
- web traffic should only reach `volume-bot-alert-web.service`
- background workers should run in `volume-bot-alert-worker.service`
- the old combined runtime is an emergency rollback shape

Operational review points that now matter continuously:
- only intended public ports exposed
- backend kept behind a reverse proxy instead of being left broadly reachable on arbitrary ports
- HTTPS enforced at the proxy layer
- intentional firewall / security-group rules
- production cookie/origin/rate-limit settings revalidated for the actual public topology
- backend kept behind local/private proxy hops because the app now resolves trusted client IPs through proxy-aware private/loopback trust instead of raw `X-Forwarded-For`
- explicit `CORS_ORIGINS` maintained for every frontend host that should be allowed; implicit preview trust is no longer part of the code contract
- runtime split commands:
  - `npm run start:web`
  - `npm run start:worker`
  - `npm run dev:web`
  - `npm run dev:worker`
- health/runtime visibility now exists through:
  - `GET /api/health`
    - `runtime.role`
    - `runtime.socketEnabled`
    - `runtime.backgroundJobsEnabled`
  - `GET /api/admin/ws-status`
    - same runtime block for admin inspection
- admin status also exposes `workerLeases`, `gmgnClaimSignalWorker`, and `solUsdPrice`
- operational rollback and emergency switches are documented in `docs/ops-runbook.md`

Railway-specific deployment assumptions are now legacy context only.

## Security Hardening State

Files:
- `frontend/src/ui/sections/html-safety.ts`
- `frontend/src/services/api/base.ts`
- `frontend/src/state/auth-flow-utils.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/ui/sections/shared.ts`
- `frontend/src/ui/sections/monitored-section.ts`
- `frontend/src/ui/sections/alerts-section.ts`
- `frontend/src/ui/sections/starred-section.ts`
- `frontend/src/ui/sections/blocklist-section.ts`
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/ui/app-shell.ts`
- `src/middleware/auth.js`
- `src/models/session.js`
- `src/models/login-email-otp-challenge.js`
- `src/models/token-catalog.js`
- `src/server.js`
- `src/routes/auth.js`
- `src/routes/admin.js`
- `src/routes/catalog.js`
- `src/routes/config.js`
- `src/routes/dashboard.js`
- `src/routes/invites.js`
- `src/utils/url-safety.js`
- `frontend/index.html`

What was hardened:
- broad `escapeHtml(...)` coverage for text inserted into HTML strings
- URL sanitization via:
  - `sanitizeHttpUrl(...)`
  - `sanitizeOptionalHttpUrl(...)`
- backend-side URL / asset sanitization via `src/utils/url-safety.js`
- safer handling of external image/profile/dex links
- safer selector interpolation using `CSS.escape(...)` in dynamic selector paths
- trusted-origin requirement for mutating cookie-authenticated requests
- CSP added in both frontend and backend layers
- the frontend CSP is now delivered by response headers in `frontend/vercel.json` instead of only by `meta http-equiv`
- frontend auth-flow token normalization for verify/reset/OTP challenge inputs
- stricter `?api=` override rules so auth/config flows do not point at arbitrary backends by query string
- backend auth routes reject malformed OTP challenge, verify-email, and password-reset tokens early
- login OTP generation now uses cryptographically secure randomness
- cleanup scheduler now removes expired OTP challenges, email verification tokens, and password reset tokens
- production frontend API fallback now defaults to `https://api.trendscope.pro`
- implicit Vercel preview-origin trust was removed; origin allowlisting now depends on explicit `CORS_ORIGINS`
- Railway hosts were removed from backend/frontend CSP `connect-src` allowlists
- request IP and socket IP resolution now use proxy-aware private/loopback trust instead of preferring raw `X-Forwarded-For`
- `GET /api/health` now returns a sanitized public DB-failure payload instead of exposing raw DB error text
- mock checkout is now limited to authenticated loopback requests in `development` / `test`
- MoonPay webhook granting now requires local order validation plus provider charge reconciliation before access is extended
- repeated webhook deliveries are only treated as terminal duplicates once a prior delivery has left the initial `received` state

Frontend delivery note:
- the public frontend currently relies on `frontend/vercel.json` for:
  - SPA rewrites to `index.html`
  - frontend security headers such as CSP / frame protection
- if the frontend host changes, those rules must be recreated on the new host or the current security posture and route behavior will drift
- session JWTs now carry unique per-login identity and session revocation is tracked per login
- socket auth is cookie-first in live environments instead of keeping a general-purpose token handshake path
- PumpFun metadata lookups reject private/local asset URIs
- admin/logs now validates `limit` and `success` explicitly instead of relying on implicit coercion

Current honest assessment:
- auth/session security is materially stronger than the pre-cookie implementation
- frontend XSS risk has been reduced from obvious/high-risk territory into a much more controlled state
- remaining XSS risk is now mostly structural and concentrated in lower-traffic helpers rather than the previously most-exposed auth/account/config/list surfaces
- the most sensitive remaining billing risk is now more about provider contract drift or operational misconfiguration than about obviously forgeable webhook payloads

## Password Reset / Real Email State

The backend auth/email foundation is now implemented.

Current status:
- provider selected for the first rollout: `Resend`
- provider-specific send logic lives behind a backend service layer so auth routes stay provider-agnostic
- registration attempts to send an email-verification link when email delivery is enabled
- `POST /api/auth/verify-email/request` exists for authenticated resend
- `POST /api/auth/verify-email/confirm` exists and consumes single-use verification tokens
- `POST /api/auth/password-reset/request` exists with a generic anti-enumeration response
- `POST /api/auth/password-reset/confirm` exists and revokes all sessions after a successful reset
- real email verification is implemented
- real password reset is implemented
- secondary verification is implemented as email OTP on login
- the backend resend path exists, but the manual resend email-verification entry is not currently a primary visible login action in the frontend

Still pending / follow-up:
- lower-priority auth polish in the frontend
- clearer account-state / support messaging where useful
- later stronger secondary verification if needed:
  - TOTP
  - backup codes

## Practical Review Checklist

When verifying the bot, these are the best quick checks:

1. `GET /api/admin/ws-status`
- confirm workers are running

2. `SELECT ... FROM token_catalog ORDER BY first_seen_at DESC`
- confirm new discovery is entering

3. `SELECT ... FROM token_catalog ORDER BY last_seen_at DESC`
- confirm reevaluation is still active

4. login and open `/alerts`
- confirm auto-started monitoring, backend alert feed catch-up, and UI refresh still work

5. add manual token + `F5`
- confirm local manual persistence survives reload

6. watch `Monitored`
- confirm `D` and alert behavior remain stable across refreshes

## Relationship To Other Docs

Use this file for deep technical reference.

Keep:
- `README.md`
for the primary project entry point, local workflow, validation policy, and high-level architecture
- `docs/phase6-runbook.md`
- `docs/phase6-checklist.md`
- `docs/phase6-railway.md`
for behavior parity and deployment operations, with `docs/phase6-railway.md` treated as legacy Railway-specific reference rather than the current production path.

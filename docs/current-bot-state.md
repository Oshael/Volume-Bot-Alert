# Current Bot State

## Purpose
This is the canonical documentation for the current integrated bot state in this repository.

It is based on the active backend/frontend code, with older migration notes used only as secondary context.

For the full technical/behavior reference, see:
- `docs/bot-complete-reference.md`

Last reviewed against code and the live deployment model on `2026-05-05` after adding GMGN-assisted junk gates, the GMGN new non-pump high-launch auto-block gate, GMGN alert safeguards, GMGN risk backfill, ticker-peer role badges, young-token volume-window fill, and the `/monitor` visible rename to `RADAR`.

## Current Deployment Topology

Current production-like deployment shape:
- public frontend:
  - hosted separately from the backend
  - currently served from Vercel
  - public host: `https://www.trendscope.pro`
- backend/API:
  - runs as a single Node process on a private VPS
  - managed by `systemd`
  - reverse-proxied by `nginx`
  - public host: `https://api.trendscope.pro`
- database:
  - PostgreSQL runs locally on the same VPS as the backend
  - it is not intended to be exposed publicly on `5432`
- current production assumption:
  - one backend process
  - one local production PostgreSQL instance
- repository note:
  - `railway.json` still exists, but it should now be treated as legacy deployment residue / historical context rather than the primary production deployment contract
  - current frontend runtime defaults and CSP allowlists now point at `https://api.trendscope.pro` rather than Railway

## Test Database Safety

This repository now treats automated tests as a destructive operation against the selected database.

Current code facts:
- the core automated test path now runs:
  - `npm run db:schema-check:test`
  - `tests/admin.test.js`
  - `tests/auth.test.js`
  - `tests/catalog.test.js`
  - `tests/config.test.js`
  - `tests/billing.test.js`
- multiple test entrypoints force `NODE_ENV=test` internally, including:
  - `tests/catalog.test.js`
  - `tests/admin.test.js`
  - `tests/auth.test.js`
  - `tests/config.test.js`
  - `tests/billing.test.js`
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
    - `Alerts`
  - `/monitor`
    - visible workspace label: `RADAR`
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
  - `src/services/token-risk-enrichment-worker.js`
  - `src/services/token-risk-review-sync-worker.js`
  - `src/services/socket-hub.js`
- Important deployment caveat:
  - the current production model still assumes one backend process
  - however, the code now has explicit runtime-role controls:
    - `RUN_SOCKET_HUB`
    - `RUN_BACKGROUND_JOBS`
  - current runtime roles are:
    - `combined`
    - `web`
    - `background`
    - `idle`
  - current default remains `combined`
  - if the backend is ever scaled to multiple replicas, or a second process points to the same production DB, every process will still start its own workers unless runtime roles are deliberately split
  - that would duplicate `catalog`, `cleanup`, `discovery`, `meteora`, and `lateralization` work against the same DB/upstreams
  - it would also duplicate Helius enrichment and automatic token-risk review sync
  - horizontal scale of the full backend is therefore still not recommended unless the split is intentionally deployed as separate web/background roles

## Token Risk Runtime

### Classification layers
- The runtime now has two distinct token-risk layers:
  - `junkAssessment`
    - computed on demand from current catalog + Meteora + structural enrichment data
    - not authoritative by itself
    - can return:
      - `valid`
      - `valid_but_weak`
      - `junk_probable`
      - `junk_permanent`
  - `riskReview`
    - persisted in `token_risk_reviews`
    - now includes `source`:
      - `manual`
      - `auto`
- Important distinction:
  - `junkAssessment.label = valid` does not automatically mean a human reviewed the token
  - `riskReview` is the persisted operational label used by other runtime decisions

### Manual vs auto precedence
- `manual` review labels remain authoritative
- automatic review sync never overwrites an existing `manual` row
- automatic persistence can create/update only `auto` rows
- `junk_permanent` is never auto-persisted as `junk_permanent`
  - automatic `junk_permanent` assessments are downgraded to persisted `junk_probable`
  - the downgraded `junk_probable` path can now trigger automatic backend blocklisting

### Automatic persisted labels
- Background runtime now includes a dedicated sync worker:
  - `src/services/token-risk-review-sync-worker.js`
- It periodically scans monitored catalog rows and persists the current risk label into `token_risk_reviews`
- Current persisted automatic labels are still limited to the existing label set:
  - `valid`
  - `valid_but_weak`
  - `junk_probable`
  - `junk_permanent` is reserved for manual/explicit review semantics and is not auto-written by the worker
- Safety rule:
  - a token assessed as `valid` is only persisted as automatic `valid` after structural coverage exists
  - without structural coverage, automatic `valid` is softened to persisted `valid_but_weak`
  - this prevents the Helius selector from skipping a token too early
- Automatic blocklist behavior:
  - after an automatic `junk_probable` review is saved, the sync worker inserts the token into `admin_blocked_tokens`
  - the row is written with `created_by = NULL`, so operational reads expose it as `blocked_auto`
  - the catalog row is suppressed as `admin_blocked`, with monitoring disabled and reevaluation pushed far into the future
  - the automatic review row is removed after blocklisting so blocked tokens do not remain counted as active auto `junk_probable` reviews
  - existing `manual` review rows are still protected and are not auto-blocked by the sync path
  - `valid_but_weak` and `valid` never trigger this automatic blocklist path
- Current junk metric guardrail:
  - `junk_probable` can be softened to `valid_but_weak` when the token has enough positive profile signals
  - the current threshold is `3` positive signals, with explicit exceptions for stronger collapse/thin-support bundles
  - this guardrail was tightened before enabling automatic blocklisting to reduce false positives from weak suspicion bundles

### GMGN-assisted junk gates
- GMGN is now used as a risk source, not only as a discovery source.
- Young-token volume windows are normalized before catalog/bucket writes:
  - when a token is `< 6h` old and the upstream has no positive `6h` volume yet, `vol6h` is filled from the largest positive shorter window (`1m`, `5m`, `1h`)
  - when a token is `< 24h` old and the upstream has no positive `24h` volume yet, `vol24h` is filled from the largest positive shorter/filled window (`1m`, `5m`, `1h`, `6h`)
  - positive native `6h`/`24h` values are not overwritten
  - this applies to both GMGN ingestion and Dex catalog reevaluation, so very young active tokens do not display stale `0` long-window volume while shorter-window volume is already known
- GMGN discovery ingestion can auto-block before catalog upsert when GMGN risk data is decisive:
  - young low-mcap/extreme-volume gate:
    - age `< 24h`
    - mcap `<= 100k`
    - vol5m `>= 500k`
    - vol5m/mcap `>= 4`
  - `token security` top-10 holder rate `>= 70%`
  - `token info` low mcap/high holder anomaly:
    - mcap `<= 150k`
    - holders `>= 1500`
  - `market kline` 1m staircase-pump pattern:
    - at least `12` candles
    - runup `>= 150%`
    - green candle ratio `>= 85%`
    - up-step ratio `>= 85%`
    - at most `2` red candles
    - max per-step move `<= 20%`
- GMGN risk lookup is checked for young GMGN candidates under `6h` when any of these are true:
  - vol1h/mcap `>= 10`
  - vol24h/mcap `>= 20`
  - vol1h/mcap `>= 3`
  - mcap `>= 100k`
  - vol5m `>= 50k`
- Young GMGN extreme churn quarantine still exists separately:
  - age `< 2h`
  - vol1h/mcap `>= 10` or vol24h/mcap `>= 20`
  - token is saved and volume buckets are written, but monitoring/alerts are suppressed with `gmgn_needs_risk_enrichment`
  - after Helius enrichment, concentrated structure is auto-blocked and healthy structure is released back to monitoring
- GMGN-origin new non-pump launch gate:
  - applies before catalog/upsert, bucket writes, security/info/kline lookups, and alert matcher
  - token is automatic GMGN discovery, not manual, and not Dex-confirmed
  - CA does not end with `pump`, `bags`, or `brrr`
  - age `< 2h`
  - mcap `>= 20k` and `<= 100k`
  - vol5m `>= 20k`
  - vol5m/mcap `>= 1`
  - matching rows are auto-blocked as `gmgn-origin:new-non-pump-high-launch-mcap:{mcap}:{vol5m}`
- The token-risk review sync worker can now use GMGN info for suspicious Dex-discovered tokens:
  - source is not GMGN and not `user-manual`
  - age `< 24h`
  - mcap `<= 500k`
  - Helius holder count is at least `1000`
  - suspicious trigger exists: vol24h/mcap `>= 5`, buy/sell imbalance `>= 3`, or abs 24h price change `>= 200%`
  - if GMGN reports holders `>= 10k` and mcap/holder `<= $50`, the token is auto-blocked as `auto-junk-probable:gmgn_holder_count_mcap_anomaly`
- The token-risk review sync worker also has a source-agnostic young low-mcap/extreme-volume gate:
  - age `< 24h`
  - mcap `<= 100k`
  - vol5m `>= 500k`
  - vol5m/mcap `>= 4`
  - matching rows are auto-blocked as `auto-junk-probable:new_low_mcap_extreme_vol5m_churn`
- Local operational checkpoint on `2026-05-04`:
  - GMGN risk backfill scanned `97` local candidates
  - `33` were blocked
  - `29` by GMGN security top-10 holder rate
  - `4` by GMGN info low-mcap/high-holder anomaly
  - `0` by kline pattern in that backfill batch

### Helius structural enrichment
- Helius/RPC enrichment is a separate background pipeline, not part of the main dashboard route path
- Worker:
  - `src/services/token-risk-enrichment-worker.js`
- It fetches structural/on-chain signals such as:
  - holder count
  - top-holder concentration
  - mint authority state
  - freeze authority state
- The cache lives in:
  - `token_risk_enrichment`
- The dashboard and backend alert payloads can expose this through `structuralRisk`

### When Helius runs
- A token becoming `monitored` does not guarantee immediate Helius enrichment
- Helius enrichment uses a candidate selector with rate/cost-aware filtering
- Practical behavior:
  - `monitored` means the token is eligible for consideration
  - Helius runs only if the token passes the selector conditions
- Tokens can be skipped from normal Helius selection when:
  - they already have a fresh structural cache
  - they are under error backoff
  - they were manually marked `valid`
  - they were manually marked `junk_permanent`
- Default freshness behavior:
  - successful structural enrichment is now treated as fresh for `1h` by default
  - after that, the token can re-enter the selector if it is still relevant and not otherwise skipped
- Automatic persisted `valid` labels can also reduce future Helius usage, but only after the token has enough structural coverage to qualify for persisted `valid`

### Operational visibility
- `GET /api/admin/ws-status` now exposes:
  - `tokenRiskEnrichmentWorker`
  - `tokenRiskReviewSyncWorker`
- `GET /api/dashboard/monitored` now exposes both:
  - `riskReview`
  - `junkAssessment`
  - `blockStatus`
  - `effectiveRiskLabel`
- `riskReview.source` can be used to distinguish:
  - human-reviewed state
  - bot-persisted automatic state
- blocked tokens keep their analysis history, but operational reads can now surface:
  - `blocked_manual`
  - `blocked_auto`
- when a token is blocklisted through the backend catalog flow, automatic review rows are removed
  - this prevents blocked tokens from continuing to inflate the automatic `junk_probable` pool

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
  - `GET /api/pre-access/billing/state`
  - `POST /api/pre-access/billing/orders`
  - `POST /api/pre-access/complete`
  - `POST /api/pre-access/logout`
  - `GET /api/account/identities`
  - `GET /api/account-security/identities`
  - `POST /api/account-security/identities/:provider/unlink`
  - `GET /api/account-security/billing/orders/:orderId/receipt`
  - `GET /api/auth/social/:provider/start`
  - `GET /api/auth/social/:provider/callback`
  - `GET /api/auth/social/:provider/login/start`
  - `GET /api/auth/social/:provider/login/callback`
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
  - invite-based registration can immediately grant timed access if the consumed invite has `grant_access_days > 0`
  - this invite grant affects access state only; it does not promote the new account to `admin`
  - successful email verification now creates the pre-access session directly instead of forcing OTP immediately after verify
  - manual login after logout still uses email/password + email OTP
  - Google/Discord identities can now be linked only from an already authenticated normal app session
  - social login is now available only for identities that were previously linked to an existing local account
  - social login never creates accounts and never merges by email
  - social login does not require OTP
  - local `email + password` login still requires OTP
  - linked social login branches by access state:
    - valid access -> normal bot session
    - `inactive` / expired -> pre-access session + `/access`
    - `revoked` / deactivated -> blocked

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
  - `card-effects-mode` is now a persisted per-user config:
    - `on`
    - `off`
  - current default keeps card FX enabled
  - `uiPrefs.enabledTradeTerminals` is now persisted per account
  - supported terminal ids are:
    - `axiom`
    - `photon`
    - `bullx`
    - `gmgn`
    - `padre`
  - current default enables all five
  - if exactly one terminal is enabled, terminal actions open it directly instead of showing the terminal selector menu
  - `uiPrefs.livePanelLayout` is now persisted per account for the `/alerts` workspace:
    - `order`:
      - `monitored`
      - `pumpfun`
      - `alerts`
    - `spans.monitored`: `1 | 2 | 3`
    - `spans.pumpfun`: fixed to `1`
    - `spans.alerts`: `1 | 2 | 3`
  - current default values for newly created accounts now include:
    - `min-vol = 8000`
    - `min-mcap = 30000`
    - `old-mcap-max = 100000000`
    - `old-week-mcap-max = 100000000`
    - `old-alert-1h-threshold = 50`
    - `old-alert-6h-threshold = 150`
    - `meteora-alert-1h-threshold = 50`
    - `alert-high-cap-dump-enabled = on`
    - `sound-high-cap-dump-enabled = on`
  - current default UI-pref values for newly created accounts now include:
    - `monitoredSorts = [{ mode: 'vol', window: '5m' }]`
    - `recentSorts = [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }]`
    - `oldWeekSorts = [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }]`
    - `enabledTradeTerminals = ['axiom', 'photon', 'bullx', 'gmgn', 'padre']`
    - `livePanelLayout.order = ['monitored', 'pumpfun', 'alerts']`
    - `livePanelLayout.spans.monitored = 1`
    - `livePanelLayout.spans.pumpfun = 1`
    - `livePanelLayout.spans.alerts = 1`
  - current surge-config reality:
    - recent surge and old-week surge now have separate backend-persisted threshold keys:
      - `recent-surge-1h-threshold`
      - `recent-surge-6h-threshold`
      - `old-week-surge-1h-threshold`
      - `old-week-surge-6h-threshold`
    - alert toggles are also split per age bucket/window:
      - `alert-recent-surge-1h-enabled`
      - `alert-recent-surge-6h-enabled`
      - `alert-old-week-surge-1h-enabled`
      - `alert-old-week-surge-6h-enabled`
    - legacy `old-alert-*` / `alert-old-surge-*` keys still exist only as compatibility fallback inputs when the newer split keys are absent

### Global monitored baseline
- Source of truth: backend catalog/dashboard state
- Active endpoint for monitored hydration:
  - `GET /api/dashboard/monitored`
- This is the endpoint the frontend currently uses for the shared monitored set.
- Important token-risk caveat:
  - being present in `Monitored` does not imply that the token has already received Helius enrichment
  - monitored membership and Helius structural enrichment are related but separate runtime steps
- Current frontend state contract:
  - canonical token store is `trackedTokensByAddress`
  - `Monitored` now keeps `monitoredTokenAddresses`
  - `Manual`, `Recent`, and `Old Week` also resolve from the same tracked store instead of keeping independent full-token copies
- Admin-only global suppression now also exists outside the per-user blocklist:
  - `POST /api/catalog/admin-blocklist`
  - `DELETE /api/catalog/admin-blocklist/:address`
- This admin block is global/backend-owned rather than account-scoped.

### High Cap Dump alert
- Source of truth: backend
- Rule key:
  - `high-cap-dump-5m`
- Main detection/persistence files:
  - `src/models/token-market-bucket-1m.js`
  - `src/services/high-cap-dump-alert.js`
  - `src/models/token-alert-event.js`
  - `src/models/token-alert-rule-state.js`
- Main delivery endpoints:
  - `GET /api/dashboard/alert-events`
  - `POST /api/dashboard/alert-events/cursor`
- Current delivery shape:
  - event creation is global per token, not per user
  - replay/seen progress is persisted per user and per rule in `alert_delivery_cursors`
  - realtime delivery also uses the authenticated socket event `alert:event`
- Current rule shape:
  - strict baseline anchored `5m` back
  - compares the baseline against the minimum `low_mcap` inside the last `5m`
  - qualifies only if `baseline_mcap >= 2_000_000`
  - default dump threshold remains `50%`
  - pair consistency is now part of the gate:
    - the detector tracks pair/pool identity through the window
    - dumps are suppressed when the window shows pair churn instead of a consistent collapse on the same pair
    - this was added to reduce false dump alerts caused by Dex returning a different pool for the same token
  - dump evaluation now keeps a rule-local pinned pair per token in `token_alert_rule_state.metadata`
  - pin acquisition / pin switch requires `15` consecutive live observations of the same best pair before the detector trusts that new pair
  - while a pair pin is being acquired or switched, dump alerts are intentionally suppressed
  - if the live best pair diverges from the pinned pair while a dump leg is still marked triggered, the old leg is rearmed immediately with reason `pair-switch`
  - rearm happens on recovery to `85%` of the last baseline or after `6h`
- Current user-scope limitation:
  - users can currently only toggle this alert on/off and mute/unmute its sound
  - threshold, minimum market cap, window length, and rearm are still canonical backend rule settings rather than per-user configs

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
- Current routed/elegibility behavior:
  - token-level routed eligibility (`_isRecentRouted`, `_isOldWeekRouted`) is maintained in the tracked-token pipeline even when the bars are collapsed
  - `Recent` / `Old Week` list derivation is now paused while the corresponding bar is collapsed
  - reopening either bar rebuilds its visible list immediately from the current tracked token state
- This is why `old-surge` still works while those bars are minimized:
  - alert eligibility no longer depends on the rendered routed lists
- Current workspace placement:
  - `Recent Tokens` and `Old Tokens 1 Week+` now live in `/monitor`, not the main `/alerts` workspace

### PumpFun backend migration stream
- Source of truth: backend PumpPortal websocket migration stream
- Backend websocket subscription methods:
  - `subscribeMigration`
- Frontend no longer consumes or subscribes to PumpFun live events:
  - no `pump:*` Socket.io fanout
  - no `sol:price` Socket.io fanout for PumpFun UI
  - no frontend `pump:subscribe` / `pump:unsubscribe`
- Current post-migration conclusion:
  - the backend must explicitly subscribe to migration events or migrated tokens can skip the `pumpfun-migrated` catalog path and only appear later via `dexscreener-discovery`
  - the expected path is:
    - `pump_migrate_received`
    - `pumpfun-migrated` catalog upsert
    - immediate Dex evaluation with `migration_grace_until`
  - this does not force Dex to return data and does not bypass market-cap or catalog-worker filters

### PumpFun dry-run experiments
- Current status: removed from runtime code.
- Removed experiment families:
  - `pumpfun-fast-5x`
  - `pumpfun-post-migration-blast`
  - `pumpfun-combo-confirmation`
- Removed surfaces:
  - runtime workers
  - admin diagnostic routes
  - config/env parsing
  - runtime schema guards and init stages
  - persistence models
  - service modules
  - dedicated tests/docs
- Important:
  - existing database tables are not recreated or checked by runtime schema anymore
  - existing database tables are not dropped automatically by this code removal

### Meteora
- Source of truth: backend-persisted current state in `token_meteora_state`
- Collection is done by backend worker
- Historical TVL history remains in `token_meteora_snapshots`
- Frontend reads persisted summaries from:
  - `GET /api/dashboard/monitored`
  - `POST /api/catalog/meteora/batch`
- The active frontend no longer uses the old browser-driven batch-style Meteora read path
- Current Meteora scheduler is backend-owned and tiered:
  - global cap: `800 tokens/min`
  - loop target: `20s`
  - worker compensates for run duration to keep wall-clock cadence closer to `20s`
  - eligible universe:
    - `last_mcap >= 100k`
    - or `has_pool = true`
  - priority tiers:
    - `high`: `vol24h >= 100k`
    - `normal`: `15k <= vol24h < 100k`
    - `low`: `vol24h < 15k`
  - tier SLAs:
    - `high`: `30s`
    - `normal`: `60s`
    - `low`: `5m`
  - selection is now by tier budget plus due cutoff, not one flat queue
  - carryover slots from an underfilled higher tier can spill into lower tiers

### Market history / MCAP baselines
- Source of truth:
  - backend-persisted `token_market_buckets_1m` for the primary MCAP baseline path
  - backend-persisted `token_market_volume_buckets_1m` for the canonical visual `VOL 5M` baseline used by `Monitored`
- Primary model:
  - `src/models/token-market-bucket-1m.js`
- Important current note:
  - `token_market_buckets_1m` remains the main pre-aggregated market-history path
  - fresh raw `token_market_snapshots` are no longer the normal monitored baseline path
  - the dashboard route now builds the canonical visual `VOL 5M` baseline from `token_market_volume_buckets_1m`
  - legacy `token_market_snapshots` still exist mainly for historical/backfill compatibility and cleanup behavior

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
- The bot now auto-starts monitoring on login/session restore once an authenticated session is active.
- The old manual start/stop control is no longer the primary workspace-header interaction.
- If `/alerts` is hidden for less than `20m`, the live workspace now enters a lighter hidden mode instead of behaving exactly like the visible workspace:
  - live polling is paused
  - PumpFun frontend runtime is no longer mounted
  - backend alert events can still be accepted into alert state
  - backend alert sounds are attempted while hidden, but the main guarantee is that returning to the tab should no longer replay a flood of accumulated alert sounds
  - user-scoped backend matcher alerts now coalesce repeated hidden emissions per `user + rule + token` instead of endlessly fanning out backend rows during the same hidden period
  - returning to the tab schedules a monitored refresh with unseen alert-feed catch-up
- If the browser tab stays hidden/unfocused for `20m`, the frontend stops the runtime and reloads when the user returns to the tab.
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
    - canonical `VOL 5M` baseline from `token_market_volume_buckets_1m`
    - latest Meteora summary from `token_meteora_state`
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
- initial authenticated bootstrap now loads monitored page `0` first using the current `monitoredPerPage` and persisted monitored sorts
- remaining monitored pages continue hydrating in background and merge into the shared tracked-token store without blocking the first paint of the panel
- `Monitored Tokens` now supports compact local search by:
  - symbol
  - name
  - contract/address
- the monitored `TOKENS` pill reflects the filtered result count
- pagination does not change alert logic:
  - the full monitored address set still stays in frontend state
  - only the visible page is rendered
  - once all pages hydrate, hidden pages continue receiving refreshed state through the shared monitored payload/store
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
  - monitored search now clears stale typed state on input/change/search/cut flows, so deleting a query does not leave the panel filtered by the old ticker
  - Recent/Old list interaction locks now clear stale DOM zones after refreshes and allow overlay-only renders through the lock, so expanded mini charts and buy/sell overlays keep opening after the page has been live for several refresh cycles
  - shared token action, copy, and sparkline-hover handlers are bound once per element to prevent duplicate listeners during incremental row patching
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
- current low-activity monitored policy in the backend worker:
  - automatic catalog tokens with `volume24h < 5k` are treated as low-activity and are forced onto at least a `3m` recheck floor
  - for tokens younger than `24h`, missing/zero `volume24h` is first filled from positive shorter windows when available, so active new tokens are not suppressed just because Dex/GMGN has not emitted a native `24h` value yet
  - manual tokens are exempt from this low-activity suppression
  - the monitored dashboard route still defaults to `minMcap = 30k`, but worker cadence no longer assumes all low-activity auto tokens should be refreshed aggressively

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
  6. `POST /api/catalog/manual-track` now also attempts an eager Dex evaluation immediately instead of depending only on the background worker loop
  7. if that eager evaluation fails, the token still falls back to the normal scheduled worker evaluation path
  8. frontend reloads canonical state with:
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
  - migration grace is assigned even when the PumpPortal migration payload does not include a usable initial market cap
  - unevaluated migrated rows are prioritized ahead of normal/low/dormant backlog so they get an initial Dex evaluation promptly
  - during the first `10m` after migration, they cannot fall into the `low-dust` cadence even if Dex sees them below `15k`
  - while inside that grace, `<15k` migrated tokens still use at least the `low-near` cadence floor (`15s`), while `30k+` and `100k+` continue following the normal higher-priority buckets
  - the migration bootstrap does not depend on any Dex paid profile/order; tokens can still receive normal Dex market data without paid Dex metadata if Dex already exposes a usable pair
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

### 4c. GMGN discovery worker
- Worker: `src/services/gmgn-discovery-worker.js`
- Default state: disabled unless `GMGN_DISCOVERY_ENABLED=true`
- Request shape:
  - `5` trending requests per `2s` window by default
  - intervals: `1m`, `5m`, `1h`, `6h`, `24h`
  - default per-request limit: `30`
- Current behavior:
  - normalizes GMGN trending rows into catalog snapshots
  - skips brand-new tokens that appeared only in GMGN `1m` trending, because that surface proved too polluted for catalog discovery
  - runs new GMGN snapshots through the existing junk classifier before catalog upsert
  - high-confidence GMGN junk is auto-blocked through `admin_blocked_tokens`
  - medium-confidence junk from a brand-new GMGN token is skipped without permanent block
  - consults GMGN `token security`, `token info`, and `market kline` for young/high-activity GMGN candidates before allowing alerts
  - caches successful GMGN `token security`, `token info`, and `market kline` lookups process-wide for a short TTL to avoid repeatedly spawning `gmgn-cli` for the same risk target
    - default TTL: `60s`
    - override: `GMGN_RISK_LOOKUP_CACHE_TTL_MS`
    - cache cap override: `GMGN_RISK_LOOKUP_CACHE_MAX_ENTRIES`
  - queues GMGN preliminary risk lookup work outside the 2s trending ingestion loop
    - default queue interval: `10s`
    - default token budget: `5` queued tokens per queue run
    - overrides: `GMGN_RISK_REVIEW_QUEUE_INTERVAL_MS`, `GMGN_RISK_REVIEW_QUEUE_TOKEN_LIMIT`
    - legacy alias: `GMGN_RISK_LOOKUP_TOKEN_LIMIT_PER_CYCLE`
    - `GMGN_RISK_REVIEW_QUEUE_TOKEN_LIMIT=0` pauses deep risk review processing without disabling trending ingestion
    - the budget counts tokens that enter the `security`/`info`/`kline` bundle, not each individual CLI call
    - when a token is only queued, catalog and bucket writes can still happen, but GMGN-only alert emission remains blocked by the preliminary-review safeguard
    - after a queued token passes preliminary review, the process keeps a short fresh-pass marker controlled by `GMGN_PRELIMINARY_REVIEW_TTL_MS`
  - blocks young low-mcap/extreme-volume GMGN tokens before spending security/info/kline lookups
  - uses GMGN security/info/kline to block obvious scam profiles before they enter the normal monitored alert flow
  - quarantines young extreme GMGN churn under `gmgn_needs_risk_enrichment` until structural enrichment resolves it
  - `user-manual` rows are protected from GMGN auto-blocking
  - still refreshes existing catalog tokens if they appear in `1m`
  - writes GMGN market volume into `token_market_volume_buckets_1m`
  - fills missing young-token `6h`/`24h` volume windows from shorter GMGN volume before catalog, bucket, alert, and panel-state writes
  - uses normal `monitored-vol` for GMGN `5m` volume jumps
  - keeps separate `gmgn-vol-1m` support behind `GMGN_VOL_1M_ALERT_ENABLED`; default is disabled
  - auto-blocks new automatic GMGN non-pump/non-bags/non-brrr contracts launched from `20k` to `100k` mcap with vol5m/mcap `>= 1` before they write buckets or alert
  - blocks automatic GMGN-origin alert evaluation until the token has DexScreener confirmation or has completed GMGN preliminary review (`token security`, `token info`, and `market kline`) without being auto-blocked
  - the GMGN alert safeguard still allows catalog and GMGN volume-bucket writes; it only stops matcher emission while the token remains raw GMGN-only discovery
  - tracks active/stale GMGN panel membership and schedules DexScreener reevaluation when a token leaves the GMGN panel
  - GMGN refreshes that resolve to `admin-blocked` are excluded from the accepted panel-token set, so blocked addresses are not kept `active` in `token_gmgn_panel_state`
- Admin status:
  - `GET /api/admin/ws-status` exposes `gmgnDiscoveryWorker`
  - `gmgnDiscoveryWorker` status includes request count, raw/unique tokens, rate-limit backoff, catalog writes, bucket writes, matcher evaluations, emitted alerts, matcher debounce/suppression skips, GMGN alert-safeguard skips, GMGN `1m` alerts, risk-enrichment suppression count, risk lookup budget usage/skips, queued/deduped/fresh-passed queue handoffs, security/info/kline checks, security/info/kline errors, security/info/kline auto-block counts, GMGN low-mcap extreme-volume auto-block counts, GMGN new non-pump high-launch auto-block counts, GMGN auto-block counts, Dex handoff counts, and nested `riskReviewQueue`
  - `gmgnDiscoveryWorker.riskReviewQueue` exposes queue running/in-flight state, queued token count, fresh passed-review count, last/total processed, last/total passed, last/total auto-blocked, last/total errors, and queue token limit
  - top-level `gmgn.riskLookupCache` exposes the process-wide GMGN risk lookup cache state: enabled flag, TTL, max entries, current entries, hits, misses, writes, evictions, expired entries, and clears
- Required rollout switches:
  - `GMGN_API_KEY`
  - `GMGN_DISCOVERY_ENABLED=true`
  - stage 17 and stage 36 DB init must be applied before enabling

### 5. Meteora flow
- Snapshot worker: `src/services/meteora-snapshot-worker.js`
- Worker targets a `20s` loop with run-duration compensation
- Scheduler is no longer flat:
  - hard cap: `800 tokens/min`
  - tiered budget:
    - `high`
    - `normal`
    - `low`
  - tier-specific due cutoff:
    - `high`: only addresses not checked in the last `30s`
    - `normal`: only addresses not checked in the last `60s`
    - `low`: only addresses not checked in the last `5m`
  - if a higher tier is underfilled, remaining slots can spill into lower tiers
- Current eligible universe:
  - `is_active_monitor_candidate = true`
  - and (`last_mcap >= 100k` or `has_pool = true`)
- Read routes:
  - `GET /api/catalog/meteora/:address/history`
  - `POST /api/catalog/meteora/batch`
- Active frontend read path:
  - embedded `meteora` payload inside `GET /api/dashboard/monitored`
  - explicit batch hydration for tracked tokens outside the monitored dashboard payload
- Current read path is DB-backed, not upstream-fetch-backed
- Current alert behavior on top of Meteora data:
  - a dedicated `meteora-surge` alert now exists in the backend user-alert matcher
  - it uses the persisted `change1h` Meteora summary from monitored/backend signal inputs
  - it is independently toggleable from normal surge alerts
  - it is independently muteable in `Sound by alert type`
  - it is delivered into the same `/alerts` feed/socket flow as the other backend-owned user alerts
- Current anti-noise rule for Meteora alerting:
  - requires `TVL current >= 10k`
  - requires inferred `TVL baseline 1h >= 10k`
  - requires `change1h >= meteora-alert-1h-threshold`
  - default threshold is `50%`
  - hot tokens can be primed on session start instead of emitting immediately
  - repeat behavior now has a real `10m` cooldown
  - fingerprinting buckets `change1h` / `TVL` and stops depending on drifting `mcap` / `volume24h`

### 6. PumpFun metadata enrichment
- The legacy PumpFun metadata route still exists:
  - `GET /api/catalog/pumpfun/:mint/meta`
- The active frontend PumpFun live panel no longer calls this route because PumpFun is backend-only for migrations.
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
- login, registration, email verification, pre-access purchase flow, password reset, change password, social identity linking, and linked-only social login are implemented
- unlink is now implemented in both normal authenticated `User Settings` and the limited `/account-security` surface
- the public entry surface is now split as:
  - `/`
    - public product landing
    - public billing plan preview
  - `/login`
    - local login
    - register modal path
    - linked-only Google/Discord login
  - `/access`
    - authenticated pre-access purchase flow
    - dynamic billing cards using the same pricing system as the public landing
  - `/account-security`
    - limited recovery/settings surface
    - linked-identity review + unlink
    - billing history + internal receipt view
- session restore after hard refresh, browser close, and normal browser restart is working in the integrated frontend while the cookie session remains valid
- the live auth flow is cookie-backed and no longer depends on browser-readable token storage
- auth UX is materially more complete than the older "raw login shell" state
- current MoonPay sandbox/dev validation path uses the frontend dev server as the public origin:
  - Vite now proxies `/api` and `/socket.io` to the backend in development
  - a single public tunnel on the frontend origin can therefore serve both provider redirect and backend webhook paths during local sandbox testing
- current social auth local validation uses the same public frontend origin approach:
  - `APP_BASE_URL` and `SOCIAL_AUTH_CALLBACK_BASE_URL` can both point at the same public frontend tunnel during local testing
  - social linking and social login now use different callback paths and both must be registered in Google/Discord
  - for local OAuth validation, the flow must start and finish on the same public host; mixing `localhost` and `ngrok` is not a valid test shape
- the social-link popup completion path is now CSP-safe:
  - the callback page no longer depends on inline script
  - a dedicated external bridge script is served from `/api/auth/social/popup-bridge.js`
  - this bridge now closes the popup and syncs the main window correctly in the validated local/ngrok flow
- the authenticated `User Settings` overlay now preserves scroll position during link/unlink rerenders, which prevents the modal from jumping back to the top on every identity interaction
- `/access` now hydrates plan selection from the public billing-plan payload instead of blocking the pricing cards on order-history loading
- pre-access checkout now opens MoonPay in a new tab and shows explicit in-card loading feedback while the secure checkout link is being generated
- the limited `/account-security` label shown to users is now `Account Settings`, but the internal route remains `/account-security`

Current login/account follow-up:
- keep refining support/recovery wording and auth-state messaging
- keep validating that frontend UX changes do not drift from the backend-owned session model
- avoid reintroducing frontend-readable session state as part of convenience UX work
- fresh email-OTP step-up remains an optional future hardening path for unlink, but the current shipped step-up is `currentPassword`
- final validation on the permanent production domain should still be treated as a separate rollout check from the successful local/ngrok pass

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
  - frontend response-header CSP via `frontend/vercel.json`
  - backend `helmet({ contentSecurityPolicy: ... })` in `src/server.js`
- frontend typography no longer depends on Google Fonts / Fontshare requests:
  - the currently used families are self-hosted from `frontend/public/fonts`
  - `frontend/src/styles/local-fonts.css` registers the local `@font-face` entries
- CSP currently allows only the sources required for the app to function:
  - self-hosted scripts
  - self-hosted fonts
  - HTTPS images
  - local/dev and production API + websocket connections
  - `data:` / `blob:` where needed for custom audio and browser-managed assets

Operational frontend-host note:
- The frontend CSP / frame protections now depend on response headers configured in `frontend/vercel.json`.
- If the frontend is moved away from Vercel or served by a different static host, those rewrites and security headers must be ported explicitly or the protections will silently weaken.

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
  - alerts search, starred address-only cards, and star toggles all reduced reliance on inline HTML mutation / interpolation further
  - live rows in `ALERTS` and `MONITORED TOKENS` now build their external-data-heavy card content through DOM nodes instead of row-level HTML-string interpolation
- Recent backend validation hardening completed:
  - `GET /api/admin/logs` now validates `limit` explicitly as a positive integer and rejects malformed `success` query values instead of relying on implicit coercion
  - admin user-target routes now use the same positive-ID parsing contract already used elsewhere in the admin surface
- Recent backend / billing / edge hardening completed:
  - production API fallback in the frontend now defaults to `https://api.trendscope.pro` instead of the old Railway host
  - trusted frontend origins now come only from explicit `CORS_ORIGINS`; implicit Vercel preview trust was removed
  - legacy Railway hosts were removed from backend and frontend CSP `connect-src` allowlists
  - request IP and socket IP resolution now follow proxy-aware private/loopback trust instead of preferring raw `X-Forwarded-For`
  - `GET /api/health` no longer exposes raw database error text publicly
  - mock checkout is now limited to authenticated local loopback requests in `development` / `test`
  - MoonPay webhook processing now validates the local order, reconciles the provider charge before granting access, and allows retry after transient provider-lookup failure instead of treating every repeated delivery as a terminal duplicate
- Risk is reduced, but not eliminated:
  - remaining risk is now mostly deeper structural / architectural, not the previously most-exposed auth/account/config/list surfaces
  - the next line of defense after the current hardening is targeted defense-in-depth on lower-traffic render helpers, operational verification against the real topology, and observability

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
- Current workspace/UI behavior:
  - `Manual Tokens` is mounted only in `/alerts`
  - the table now includes a `Chart` column
  - charts are not rendered in `Monitored Tokens` cards
  - alerts feed rows now render their own static mini charts
- Current sparkline behavior for `Manual Tokens`:
  - source endpoint: `POST /api/catalog/sparklines`
  - source data: aggregated from `token_market_buckets_1m`
  - only the current visible manual table rows are considered
  - current manual cap is `30` charted rows
  - the visible-row selection respects current manual search, starred-only toggle, and manual sort order
  - refresh cadence is `1m`
  - requested span is `14d`
  - requested point budget is `336`
  - chart header label is now `Chart`
  - chart tooltip now identifies the visual as `Mini chart`
  - compact mini charts render a translucent filled area under the line
  - hover shows approximate market cap + approximate bucket time for the inspected point
  - clicking a manual-row mini chart opens a compact expanded hologram popup for the same series
  - the expanded popup is chart-only; it no longer uses projection/feixe lines from the clicked row
  - max chart window is `14d`, but younger tokens use their real available lifespan instead of rendering a long empty left side
  - current age-adaptive chart granularity:
    - `< 24h`: `1m`
    - `24h` to `< 72h`: `5m`
    - `72h` to `< 11d`: `15m`
    - `11d+`: `30m`
- Current add-token validation behavior:
  - the frontend now rejects obvious non-address input before optimistic add
  - accepted optimistic input formats are currently:
    - Solana-style base58 addresses with `32-44` chars
    - EVM-style `0x` addresses with `40` hex chars
  - if backend persistence fails, the optimistic manual row is rolled back instead of being left behind locally
- Current table-age formatting:
  - younger rows still use `d`, `h`, `m`, `s`
  - `30d+` now renders as `1mo`, `2mo`, etc.
  - `12mo+` now renders as `1y`, `2y`, etc.

### Recent / Old Week routing
- Current routed bars:
  - `Recent Tokens`
  - `Old Tokens 1 Week+`
- Routing is frontend-derived from tracked token age and MCAP windows
- `_userManual` tokens are excluded from routed discovery bars
- Dismissed sets are stored locally and are account-scoped in browser storage
- Removal-log hover is now click-sticky as well as hover-driven, so the panel can stay open while the user reads it
- Current routed chart behavior:
  - `/monitor` routed tables now include a `Chart` column
  - source endpoint: `POST /api/catalog/sparklines`
  - source data: aggregated from `token_market_buckets_1m`
  - current routed cap is `50` total charted rows across `Recent` + `Old Tokens 1 Week+`
  - selection is neutral/interleaved rather than permanently prioritizing one side
  - refresh cadence is `1m`
  - requested span is `14d`
  - requested point budget is `336`
  - compact mini charts render a translucent filled area under the line
  - hover shows approximate market cap + approximate bucket time for the inspected point
  - clicking a routed mini chart opens the same compact expanded hologram popup used by manual tokens
  - max chart window is `14d`
  - younger tokens compress to their real lifespan inside that `14d` ceiling
  - current age-adaptive chart granularity:
    - `< 24h`: `1m`
    - `24h` to `< 72h`: `5m`
    - `72h` to `< 11d`: `15m`
    - `11d+`: `30m`
  - routed compact search now exposes a visible searching/loading state while the filtered table is resolving

### PumpFun
- PumpFun is backend-only for migrations.
- The frontend no longer mounts the PumpFun live panel, PumpFun toasts, PumpFun local alerts, or per-mint PumpFun trade subscriptions.
- Migrated tokens enter the backend catalog as `pumpfun-migrated` active monitor candidates and continue through the existing migration grace, minimum market-cap, eligibility, and archive rules.

### Trade terminal links
- `Axiom` now prefers `pairAddress` for monitored/routed/manual token rows when available
- `PUMPLIVE` still preserves its custom Axion/Axiom-address override path instead of using the generic monitored fallback order
- terminal visibility is now user-configurable through persisted `uiPrefs.enabledTradeTerminals`
- if multiple terminals are enabled, the selector menu is shown
- if exactly one terminal is enabled, the button opens that terminal directly

### Admin mock trading
- Mock trading is admin-only at the backend route layer and the frontend render layer.
- Backend route prefix:
  - `/api/admin/mock-trading`
- Current endpoints:
  - `GET /summary`
  - `GET /positions`
  - `GET /trades`
  - `POST /buy`
  - `POST /sell`
  - `POST /take-profit-orders`
  - `POST /take-profit-orders/:id/cancel`
  - `POST /add-cash`
  - `POST /reset`
- Current persistence:
  - `mock_trading_accounts`
  - `mock_trading_positions`
  - `mock_trading_trades`
  - `mock_trading_take_profit_orders`
- Execution price comes from `token_catalog.last_price` as `priceUsd`.
- Trade execution also snapshots `token_catalog.last_mcap` as display/reference MCAP.
- The default starting fake cash is `$1,000` for new mock accounts and resets that do not pass an explicit amount.
- PnL and return percentage are calculated from token quantity and `priceUsd`, not from market cap.
- The frontend loads the authenticated admin portfolio summary, open positions, and recent trades.
- Admin token rows expose mock buy/sell controls:
  - buy opens a ticket with fixed USD presets and a custom USD amount
  - sell opens a ticket with percentage presets and a custom percent
  - add cash deposits manual fake USD into the authenticated admin portfolio without clearing positions or trades
  - reset clears only the authenticated admin user's mock portfolio
- Manual mock cash deposits increase both `cash_usd` and `starting_cash_usd`, so deposits do not inflate the total PnL calculation.
- Buy/sell tickets are scrollable when their content exceeds the viewport.
- The workspace header cash pill shows only current mock cash, a `Plays` button, and reset; each open position still gets a separate image/ticker/PnL pill.
- The `Plays` modal summarizes recent closed sell executions, including realized PnL, win/loss counts, win rate, and each profitable/unprofitable play.
- Manual, Recent, and Old Week mini charts render account-specific buy/sell markers from the admin trade ledger.
- The expanded sparkline modal renders the same markers.
- Marker placement is based on `executedAt` inside the sparkline time window and uses trade MCAP when available.
- Mock trade markers are not stored in or mixed into the global sparkline cache.

### Workspace header status
- The workspace header now exposes runtime state through a compact status indicator instead of a manual start/stop button.
- Current tones are:
  - `Connected`
  - `Unstable`
  - `Disconnected`
- Current rule shape:
  - `Disconnected` if session is not authenticated or runtime mode is `stopped`
  - `Unstable` if runtime mode is `syncing`
  - `Unstable` if monitored freshness is older than `15s`
  - otherwise `Connected`
- The `/alerts` header now rerenders after successful monitored refreshes, so fresh dashboard payloads update the status tone immediately instead of waiting for a later header-only refresh

### Alerts
- Current ownership split is now mostly backend-first:
  - backend-owned user alerts:
    - `monitored-vol`
    - `monitored-mcap`
    - `hvnc`
    - `recent-surge-1h`
    - `recent-surge-6h`
    - `old-week-surge-1h`
    - `old-week-surge-6h`
    - `meteora-surge`
  - backend-owned global-token alert:
    - `high-cap-dump-5m`
- PumpFun frontend-local alert generation is disabled with the live panel/runtime removal.
- backend-owned alerts are delivered on:
  - `GET /api/dashboard/alert-events?mode=unseen`
  - authenticated socket event `alert:event`
- current backend delivery semantics:
  - unseen replay is tracked per user and per rule, not only in browser-local dedupe
  - per-user event idempotency uses mandatory `dedupe_key`
  - the frontend marks backend alert events as seen only after accepting them into the local alert list
  - backend-owned alerts still render inside `/alerts`, but they no longer depend on the local monitored alert engine
  - if a backend-owned alert event is republished with the same event id and fresher payload, the frontend now upserts the existing alert card instead of silently dropping the update
- the `Alerts` panel now supports local text search by:
  - symbol
  - name
  - contract/address
- the alerts search now uses the same compact-search interaction model as the other lupas, including `Enter/Return` to commit by blurring the input
- alerts are now restored from browser-local storage per account scope
- alerts history is currently capped at the most recent `120` entries in runtime state and browser-local storage
- the panel paginates alert cards at `40` alerts per page
- pagination controls live in the `Alerts` header so page navigation remains visible while the alert list scrolls
- the panel now also supports per-user animated card FX behind `card-effects-mode`
- current implementation detail:
  - the visible card shell stays stable in the list
  - most arrival FX run through a separate ghost overlay layer
  - row-level shake is intentionally limited to higher tiers to reduce re-render flicker risk
- current alert mini-chart behavior:
  - alert cards now render a static `Chart` snapshot at the right side of the card
  - alert mini charts reuse the same sparkline source family as routed/manual tables
  - alert mini charts render a translucent filled area under the line
  - hover shows approximate market cap + approximate bucket time for the inspected point
  - alert mini charts are not clickable and do not open the expanded hologram popup
  - snapshots are cached browser-locally per account and keyed by `alert.id`
  - each alert row freezes its own mini chart snapshot after the fetch completes
  - a newer alert for the same token no longer mutates older alert-card mini charts
  - snapshot cache is pruned when old alert rows leave the capped `120`-alert local history or are removed/cleared
- users can clear:
  - all alerts at once via `Clean All`
  - a single alert card via the card-level `×` button
- current workspace/runtime rule:
  - `/alerts` is still the only workspace that renders and actively catches up the alert feed
  - `/monitor` still receives live monitored/history data but does not run PumpFun alert generation or mount the alerts panel
- current alert-link behavior:
  - `X Buscar CA /` opens X search using `contract OR $ticker`
  - the separate social link now renders only the emoji:
    - `👥` for X community URLs
    - `👤` for normal X profile URLs
- current ticker-peer badge behavior:
  - backend alert snapshots include same-ticker peer metadata from `src/services/alert-ticker-peers.js`
  - exact ticker peers determine the source role:
    - `OG` when the alerted token is both the oldest known exact ticker match and the highest-mcap exact ticker match
    - `#1` when the alerted token is the highest-mcap exact ticker match but not the oldest
    - `!` for normal duplicate ticker/subticker warning semantics
  - `OG` renders blue and `#1` renders green, with the same visual scale as the `!` marker
  - subticker matching now starts at `3` normalized characters
  - subticker peers are context-filtered by source symbol/name words so unrelated extensions like a meme/trump suffix do not count as peers for a different semantic ticker

## Persistence Model

### Backend-persisted per account
- auth/session state
- user configs
- user UI prefs
- manual tokens
- blocklist
- starred tokens
- backend alert delivery cursors

### Backend-persisted global alert state
- `token_alert_events`
- `token_alert_rule_state`

### Browser-local but account-scoped
- dismissed Recent set
- dismissed Old Week set
- alert cards
- alert mini-chart snapshot cache keyed by `alert.id`
- custom sound assets

## Workspace Split And Multi-Tab Behavior

### `/alerts`
- owns the high-churn live runtime:
  - `Monitored Tokens`
  - `Manual Tokens`
  - `Alerts`
- replays unseen backend-owned alert feeds from `GET /api/dashboard/alert-events`
- no longer runs PumpFun-local frontend alerting
- does not mount `Recent`, `Old Week`, or `Lateralization`
- the live workspace layout is now user-customizable and persisted:
  - panels can be reordered by drag handle
  - `Monitored` and `Alerts` can resize between `1/3`, `2/3`, and `3/3`
  - the header now includes a dedicated reset action for the default live layout

### `/monitor`
- is the lighter dashboard-analysis workspace
- is labeled `RADAR` in the workspace header while keeping the `/monitor` route and internal `history` workspace state
- mounts:
  - `Recent Tokens`
  - `Old Tokens 1 Week+`
  - `Lateralization Coins`
  - `Bid Zone Coins`
- still consumes `GET /api/dashboard/monitored` so routed/history surfaces stay current
- does not run:
  - frontend alerts
  - PumpFun frontend runtime

### Multi-tab coordination
- monitor tabs now use `BroadcastChannel` leader election
- only one active `/monitor` tab keeps the continuous polling loop for:
  - `GET /api/dashboard/monitored`
  - `GET /api/catalog/lateralized`
  - `GET /api/catalog/bid-zone`
- the leader also owns routed chart refresh for:
  - `POST /api/catalog/sparklines`
- follower `/monitor` tabs receive monitored/lateralized/bid-zone snapshots from the leader instead of duplicating that polling
- follower `/monitor` tabs also receive routed chart snapshots from the leader
- this coordination currently applies only to `/monitor`
- `/alerts` still runs independently per tab because live presence, hidden-light behavior, and backend alert acceptance remain scoped to the active browser tab/session

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
- `Recent Tokens` now also supports per-user persisted age-window filters:
  - `AGE MIN`
  - `AGE MAX`
- the UI accepts shorthand age inputs like `30m`, `2h`, and `1d`
- `Recent Tokens` age range is clamped to `0m` through `7d`
- `AGE MAX` is normalized so it never ends up below `AGE MIN`
- `Old Tokens 1 Week+` now also supports per-user persisted age-window filters:
  - `AGE MIN`
  - `AGE MAX`
- `Old Tokens 1 Week+` keeps a hard floor of `7d` for `AGE MIN`
- `Old Tokens 1 Week+` accepts an empty `AGE MAX`, which means no maximum age limit
- `AGE` currently supports two directions in the UI:
  - `NEWEST`
  - `OLDEST`
- `Manual Tokens` now has the same `#` ranking column as Recent/Old
- The duplicate footer-level `Per Page` control was removed from Recent/Old; the active `Per Page` control is the header one
- `Recent Tokens` now shows a green live indicator with a slower “breathing” pulse while the bot is active
- current persistence split:
  - `MCAP` min/max filters remain backend-persisted user configs
  - `Recent Tokens` age min/max also remain backend-persisted user configs
  - `Old Tokens 1 Week+` age min/max also remain backend-persisted user configs
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
  - `pumpfunMetaLimiter`: `300 / 15min / user+IP`
  - `catalogWriteLimiter`: `60 / 15min / user+IP`
  - `catalogReadLimiter`: `120 / 15min / user+IP`
- Current conclusion:
  - the active frontend is no longer wasting requests on the old batch-style Meteora path
  - rate limiting is no longer one global bucket for the whole API
  - remaining pressure points are still mainly dashboard polling plus per-token PumpFun metadata fetches

### Backend user-alert matcher model
- `VOL`, `MCAP`, `HVNC`, `Surge`, and `Meteora` user alerts are now matched in the backend user-alert matcher, not generated primarily in the frontend panel
- `HVNC` currently requires `volume24h >= hvnc-min-vol`
  - for normal tokens, the age gate is token age under `10m`
  - for `pumpfun-migrated` tokens, the age gate is under `10m` after migration capture, not pre-migration token age
- `monitored-vol` and `monitored-mcap` now use anchored repeat semantics:
  - the first alert uses the current persisted baseline
  - repeat alerts compare against the last alerted value rather than forever reusing the original baseline
  - this is why a token now needs fresh progression to re-alert instead of just waiting out `1m`
- `recent/old-week surge` now use backend rule keys split by age bucket and time window:
  - `recent-surge-1h`
  - `recent-surge-6h`
  - `old-week-surge-1h`
  - `old-week-surge-6h`
- surge age gates are backend-enforced:
  - no surge for tokens younger than `2d`
  - `2d <= age < 7d` qualifies only for recent-surge
  - `age >= 7d` qualifies only for old-week-surge
- surge now also has backend anti-spam guards:
  - first-seen hot tokens are primed instead of always alerting immediately
  - `1H` same-session repeat now requires `+50%` relative PCHANGE growth after the first emitted alert
  - `6H` same-session repeat now also applies a `20m` cooldown and requires:
    - `+50%` relative PCHANGE growth
    - and at least `+15%` MCAP growth versus the last alerted MCAP
  - `1H` and `6H` variants in the same age bucket cross-block each other for `1h`
  - surge requires `mcap >= 60k` for both `1H` and `6H`
- semantic note:
  - `prevVolume5mCanonical` remains visual-only for monitored cards
  - alert matching uses backend signal inputs and persisted rule state, not the visual card delta

### Top config controls
- The top config area now exposes:
  - `Surge Threshold`
    - editable recent `1H` and `6H` surge thresholds
    - editable old-week `1H` and `6H` surge thresholds
  - `Alert Toggles`
    - `VOL`
    - `MCAP`
    - `High Volume New Coin`
    - `Recent Surge 1H`
    - `Recent Surge 6H`
    - `Old Token Surge 1H`
    - `Old Token Surge 6H`
    - `Meteora 1H`
    - `High Cap Dump 5M`
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

## Current VPS Deployment Notes
- The active production-like deployment is now a private VPS, not Railway.
- Current intended exposure model:
  - `nginx` is the public entrypoint on `80/443`
  - the backend process stays behind `nginx`
  - PostgreSQL stays local to the VPS and should not be exposed publicly
- Current code-level runtime split support now exists:
  - `RUN_SOCKET_HUB=true RUN_BACKGROUND_JOBS=false`
    - intended `web` role
  - `RUN_SOCKET_HUB=false RUN_BACKGROUND_JOBS=true`
    - intended `background` role
  - `npm run start:web`
  - `npm run start:worker`
  - `GET /api/health` now exposes:
    - `runtime.role`
    - `runtime.socketEnabled`
    - `runtime.backgroundJobsEnabled`
  - `GET /api/admin/ws-status` now exposes the same runtime role block for admin inspection
- Operational checks that now matter continuously, not just during migration:
  - verify only intended public ports are exposed
  - keep HTTPS enforced at the proxy layer
  - keep firewall rules intentional rather than permissive by default
  - review production cookies, CORS/origin rules, and rate limiting against the actual public topology:
    - frontend at `https://www.trendscope.pro`
    - backend at `https://api.trendscope.pro`
  - keep the backend behind local/private proxy hops only, because proxy-aware IP trust now assumes the public entrypoint is `nginx` rather than arbitrary direct exposure
  - keep `CORS_ORIGINS` explicit; preview/staging frontend hosts no longer inherit access automatically
  - until the VPS deploy is explicitly split into separate roles, keep the backend as a single production process
- Railway-specific deployment behavior should now be treated as legacy context only.

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
- `docs/phase6-runbook.md`
  - production/ops runbook
- `docs/phase6-checklist.md`
  - deployment validation checklist
- `docs/phase6-railway.md`
  - Railway-specific legacy deployment notes, no longer the primary production path

## Docs Retired By This Consolidation
- `docs/frontend-vite-progress.md`
- `docs/next-backend-architecture.md`

Those two were useful as session logs, but they had accumulated contradictory state and should no longer be treated as authoritative.

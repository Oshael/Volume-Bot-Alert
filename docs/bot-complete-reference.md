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

Last reviewed against code and the live deployment model on `2026-04-09` after the token-risk runtime gained Helius structural enrichment, automatic persisted risk labels, and manual-vs-auto review precedence while the public frontend remained on Vercel.

## Current Deployment Topology

Current production-like topology:
- frontend:
  - deployed separately from the backend
  - currently served from Vercel
  - public host: `https://www.trendscope.pro`
- backend:
  - runs as a single Node process on a private VPS
  - managed by `systemd`
  - reverse-proxied by `nginx`
  - public host: `https://api.trendscope.pro`
- database:
  - PostgreSQL runs on the same VPS as the backend
  - intended to stay private/local rather than publicly exposed
- repository note:
  - `railway.json` remains in the repo, but it is now legacy deployment residue / historical context rather than the primary production deployment contract
  - current frontend runtime defaults and CSP allowlists now point at `https://api.trendscope.pro` rather than Railway

## Test Environment And Database Safety

This project has an important operational trap that is now explicitly documented because the tests are destructive against the selected database.

Code-backed behavior:
- the automated test files force `NODE_ENV=test` themselves:
  - `tests/catalog.test.js`
  - `tests/admin.test.js`
  - `tests/auth.test.js`
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

Recommended verification command before `npm test`:
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
- backend workers for discovery, catalog cleanup, catalog evaluation, minute-bucket market history, Meteora snapshots, and lateralization precompute
- realtime PumpFun socket feed

The UI is now centered around two authenticated workspaces:
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
- PumpFun UI state
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

Deployment caveat:
- the current production model still assumes one backend process
- the code now supports explicit runtime-role separation through:
  - `RUN_SOCKET_HUB`
  - `RUN_BACKGROUND_JOBS`
- current runtime roles are:
  - `combined`
  - `web`
  - `background`
  - `idle`
- current default remains `combined`
- if the backend is ever scaled to multiple replicas, or another process uses the same production DB, each process will still start the full worker set unless runtime roles are intentionally split
- that duplicates `catalog`, `cleanup`, `discovery`, `meteora`, and `lateralization` execution against the same DB/upstreams
- it also duplicates Helius enrichment and automatic token-risk review sync
- do not horizontally scale the full backend unless it is explicitly separated into web/background runtime roles or stronger coordination is introduced

Admin worker status endpoint:
- `GET /api/admin/ws-status`
- requires authenticated admin session
- also returns:
  - `runtime.role`
  - `runtime.socketEnabled`
  - `runtime.backgroundJobsEnabled`
- returns socket hub status plus:
  - `catalogWorker`
  - `catalogCleanupWorker`
  - `meteoraSnapshotWorker`
  - `dexDiscoveryWorker`
  - `lateralizationWorker`
  - `tokenRiskEnrichmentWorker`
  - `tokenRiskReviewSyncWorker`

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

Migrated-token grace:
- `pumpfun-migrated` catalog rows now persist `migration_grace_until`
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
- new manual tokens retry quickly until first real classification
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
- and (`last_mcap >= 100k` or `has_pool = true`)

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

Important behavior:
- automatic persisted labels use the existing review labels only:
  - `valid`
  - `valid_but_weak`
  - `junk_probable`
- automatic `junk_permanent` is intentionally not persisted as `junk_permanent`
  - it is softened to persisted `junk_probable`
  - the current runtime still does not auto-ban tokens
- automatic `valid` is only persisted as `valid` after structural coverage exists
  - without structural coverage, automatic `valid` is softened to persisted `valid_but_weak`
  - this avoids skipping Helius too early

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
- blocklist action remains separate from persisted analysis
  - blocked tokens can surface as `blocked_manual` or `blocked_auto` in effective reads
  - admin blocklisting removes automatic review rows so blocked tokens no longer linger in the automatic `junk_probable` pool

Execution notes:
- worker computes per-tier demand and effective budget under the `800/min` cap
- batch composition is now tiered instead of one flat `LIMIT`
- each tier applies its own due cutoff before selecting addresses
- unused slots from an underfilled higher tier can spill into lower tiers
- current state is persisted in `token_meteora_state`
- positive checks also append history into `token_meteora_snapshots`

#### Lateralization worker
File:
- `src/services/lateralization-worker.js`

Role:
- periodically computes and persists ranked lateralization candidates
- stores run metadata in `lateralization_runs`
- stores ranked output rows in `lateralization_results`
- shifts lateralization cost out of request time and into worker cadence

Cadence:
- one run on backend boot
- every `20m` after that

Read path:
- `GET /api/catalog/lateralized` now reads the latest completed persisted run
- normal panel reads do not execute the finder inline anymore

Manual trigger:
- `POST /api/admin/lateralization/runs`

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

Current API shape:
- client uses the current DLMM Datapi pools endpoint, not the legacy `pair/all_by_groups` route
- worker queries `token_x` and `token_y` sides separately per token and merges the results

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
- manual tokens
- blocklist
- starred tokens

### Manual tokens
- backend user data, scoped by authenticated account

Important:
- backend is the source of truth for which manual tokens a user sees
- frontend still applies optimistic UI updates
- backend also ingests the token for global catalog tracking through a separate catalog path
- the reload path now rebuilds manual-token UI state directly from `GET /api/config` payload tokens, which is what makes same-account cross-device restore work correctly

### Monitored tokens baseline
- backend

Endpoint:
- `GET /api/dashboard/monitored`

Workspace placement:
- consumed by both `/alerts` and `/monitor`
- `/alerts` uses it for monitored/manual/live-alert behavior
- `/monitor` uses it for routed/history surfaces only

### Recent / Old Week bars
- frontend-derived from monitored token state

Reasons:
- per-user MCAP windows
- per-user dismissed state
- per-user removal logs

### Alerts
- mixed ownership
- only active in `/alerts` as a rendered panel
- current split:
  - monitored/local alerts remain frontend-owned
  - `high-cap-dump-5m` is backend-owned as a global token event and then delivered per user

### PumpFun live state
- backend socket feed + frontend session state
- only mounted in `/alerts`

### Lateralization panel
- backend-precomputed
- mounted in `/monitor`

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
  - `MONITOR`

`/alerts` responsibilities:
- mounts:
  - monitored
  - manual
  - PumpFun
  - alerts
- keeps frontend alert evaluation active
- replays unseen backend-owned dump alerts from the dashboard alert-events feed
- keeps PumpFun runtime active
- does not mount `Recent`, `Old Week`, or `Lateralization`
- does not mount `Bid Zone`

`/monitor` responsibilities:
- mounts:
  - `Recent Tokens`
  - `Old Tokens 1 Week+`
  - `Lateralization Coins`
  - `Bid Zone Coins`
- still consumes live monitored dashboard state
- does not run:
  - frontend alerts
  - PumpFun runtime
  - PumpFun GC/toast behavior

Multi-tab coordination:
- `/monitor` tabs now coordinate with `BroadcastChannel`
- one active `/monitor` tab becomes leader
- only the leader continues the repeating polling loop for:
  - `GET /api/dashboard/monitored`
  - `GET /api/catalog/lateralized`
  - `GET /api/catalog/bid-zone`
- follower monitor tabs receive monitored/lateralized/bid-zone snapshots from the leader
- this dedupe currently does **not** apply to `/alerts`, because the legacy alert engine there is still frontend-owned and per-tab

Workspace header status:
- the header now exposes runtime health through a compact status indicator:
  - `Connected`
  - `Unstable`
  - `Disconnected`
- current rule shape:
  - `Disconnected` if session is not authenticated or runtime mode is `stopped`
  - `Unstable` if runtime mode is `syncing`
  - `Unstable` if monitored freshness is older than `15s`
  - `Unstable` in `/alerts` if `pumpfun.connected` is false
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
    - backend exchanges OAuth code, resolves linked provider identity, and never creates an account automatically
    - backend branches by access state:
      - linked + valid access -> normal bot session without OTP
      - linked + `inactive` / expired -> pre-access session + `/access`
      - linked + `revoked` / deactivated -> blocked
      - not linked -> return to login with explicit social-login error
- restore path:
  - normal session:
    - `GET /api/auth/me`
    - same config/bootstrap hydration path
  - pre-access session:
    - `GET /api/pre-access/me`
    - `GET /api/pre-access/plans`
    - `GET /api/pre-access/orders`

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
- social login is allowed only for previously linked provider identities
- social login does not use OTP
- local `email + password` login still uses OTP
- social login never performs account creation and never performs email-based merge

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
- social login is now implemented for already-linked identities only
- start routes:
  - `GET /api/auth/social/:provider/login/start`
- callback routes:
  - `GET /api/auth/social/:provider/login/callback`

Current login rules:
- linked `Google` / `Discord` identities can sign in without OTP
- local `email + password` login still requires OTP
- social login never creates a new account
- social login never merges by email
- linked + active access -> normal bot session
- linked + `inactive` / expired -> pre-access session + `/access`
- linked + `revoked` / deactivated -> blocked
- not linked -> return to login with explicit social-login error

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

## Lateralization Coins

Files:
- `frontend/src/ui/sections/lateralized-section.ts`
- `frontend/src/state/app-controller.ts`
- `src/routes/catalog.js`
- `src/services/lateralization-worker.js`
- `src/models/token-market-lateralization-run.js`

Main behavior:
- frontend polls `GET /api/catalog/lateralized` every `60s`
- backend returns rows from the latest completed persisted lateralization run
- backend payload includes `generatedAt`
- frontend shows a freshness label in the panel header based on that timestamp
- the panel is rendered in `/monitor` alongside `Recent Tokens` and `Old Tokens 1 Week+`
- rows are intentionally thin and ranked instead of using large cards

Current row surface:
- `#rank`
- symbol + name
- actions aligned with the monitored visual language
- `MCAP`
- `AGE`
- `VOL 1H`
- `VOL 24H`

Important:
- this panel is read-only from the frontend point of view
- ranking is backend-owned and precomputed
- `BOX` / `DRIFT` still exist in backend results, but they are no longer foreground UI metrics in the panel
- the panel can be collapsed
  - collapse currently affects the UI/render surface only
  - backend polling still continues while collapsed
- in `/monitor`, lateralization is also part of the `BroadcastChannel`-shared polling path between tabs
- the X-search button in this panel also now searches `contract OR $ticker`

## Bid Zone Coins

Files:
- `frontend/src/ui/sections/bid-zone-section.ts`
- `frontend/src/state/app-controller.ts`
- `src/routes/catalog.js`
- `src/models/token-market-bucket-1m.js`

Main behavior:
- frontend polls `GET /api/catalog/bid-zone` every `60s`
- backend computes the ranking on demand from `token_market_buckets_1m`
- backend payload includes `generatedAt`
- frontend shows a freshness label in the panel header based on that timestamp
- the panel is rendered in `/monitor` beside `Lateralization Coins`

Current model intent:
- this is intentionally **not** the same setup as `Lateralization`
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
- actions aligned with the monitored/lateralized visual language
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
- this list is not persisted into `lateralization_runs` / `lateralization_results`
- it is a separate on-demand analysis surface so the two setup philosophies stay distinct
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
- age between `1d` and `7d`
- inside the Recent MCAP window configured by user
- mounted in `/monitor`

Rules:
- derived from tracked token state
- excludes `_userManual` tokens from routed discovery bars
- supports local dismiss
- has local removal log
- supports compact local search by symbol, name, or contract/address
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
- age `>= 7d`
- inside the Old Week MCAP window configured by user
- mounted in `/monitor`

Rules:
- derived from tracked token state
- supports local dismiss
- has local removal log
- supports compact local search by symbol, name, or contract/address
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

## Routed Bar Removal Logs

Files:
- `frontend/src/ui/sections/shared.ts`
- `frontend/src/ui/app-shell.ts`

Behavior:
- Recent and Old Week each have a removal log badge
- opens on click only
- `Close`, outside click, or `Esc` closes it
- the panel now shows up to `20` latest removed tokens with symbol, short address, timestamp, `Copy CA`, and `DEX`

This prevents the old issue where the panel disappeared before the user could inspect which tokens left monitoring.

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
  - PumpFun pre-bond rows override Axiom to prefer:
    - `bondingCurveKey`
    - fallback `pairAddress`
    - fallback `mintAddress`
    - fallback token address
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

## PumpFun Panel

Files:
- `frontend/src/ui/sections/pumpfun-section.ts`
- `frontend/src/state/app-controller.ts`
- `src/services/pumpfun-ws.js`
- `src/services/socket-hub.js`

Behavior:
- backend maintains one server-side PumpFun websocket
- backend websocket subscribes with:
  - `subscribeNewToken`
  - `subscribeMigration`
  - `subscribeTokenTrade`
- frontend receives:
  - `pump:newToken`
  - `pump:trade`
  - `pump:migrate`
  - `pump:status`
  - `sol:price`

Panel rules:
- sorted/live-updated in frontend
- mounted only in `/alerts`
- `X` removes from the live panel for the current session
- removed token is added to a session-level dismissed PumpFun set
- dismissed PumpFun rows do not immediately reappear on new trades during the same session
- stopped bot ignores PumpFun live updates

Pump GC rules:
- inactive for `10m` can be removed
- low MCAP for too long can be removed

Migration behavior:
- migrated token is removed from PumpFun panel
- migration is reported into the catalog/backend flow
- migration toast is shown in frontend
- current expected backend path after the migration subscription fix:
  - PumpPortal websocket emits `txType: "migrate"`
  - backend logs/handles `pump_migrate_received`
  - backend upserts the token as `pumpfun-migrated`
  - token gets `migration_grace_until`
  - catalog worker performs the first Dex evaluation immediately
- important nuance:
  - Dex paid metadata is not a requirement for normal Dex market reads (`mcap`, `price`, `volume`, pair selection)
  - the production issue identified in April 2026 was missing migration capture on the backend, which caused some migrated tokens to enter late via `dexscreener-discovery`

## Alerts

Files:
- `frontend/src/state/app-controller.ts`
- `frontend/src/ui/sections/alerts-section.ts`
- `frontend/src/services/alerts/sound.ts`
- `src/services/high-cap-dump-alert.js`
- `src/services/backend-alert-feed.js`

Main alert types:
- `monitored-vol`
- `monitored-mcap`
- `hvnc`
- `old-surge`
- `meteora-surge`
- `pumpfun-vol`
- `pumpfun-hvnc`
- `high-cap-dump-5m`
- the panel also supports local text search by symbol, name, or contract/address
- the alerts search now uses the same compact-search behavior as the other lupa inputs and supports `Enter/Return` to blur/commit
- alerts are restored from browser-local storage per account scope
- runtime state and browser-local persistence now keep the most recent `100` alert cards
- local monitored alerts are evaluated only in `/alerts`
- backend-owned dump alerts are delivered into `/alerts` from backend feed/socket paths
- alerts can be removed:
  - all at once via `Clean All`
  - individually via the card-level `×`
- current links-row behavior:
  - `X Buscar CA /` opens X search using `contract OR $ticker`
  - the social link now renders only the emoji:
    - `👥` for X community URLs
    - `👤` otherwise

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
  - if the same token has already fired another alert type in the last `5m`, this alert is suppressed
- semantic split:
  - the alert engine still uses `prevVolume5m` as its frontend session-local previous observed `volume5m`
  - the `Monitored` card visual delta no longer uses that field
  - the card now uses backend-provided `prevVolume5mCanonical` instead
  - this was done specifically to improve visual coherence without changing alert behavior

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
  - if the same token has already fired another alert type in the last `5m`, this alert is suppressed

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
  - `1H >= user-configured threshold` default `50%`
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
- if `Surge` fires, local monitored alerts for that token are blocked by the shared `5m` cross-alert window
- the same `old-surge` engine covers both routed buckets:
  - Recent-routed tokens surface as `RECENT TOKEN SURGE`
  - Old-Week-routed tokens surface as `OLD TOKEN SURGE`

### PumpFun alerts
Rules:
- separate from monitored-token alerts
- use PumpFun volume accumulation logic

### High Cap Dump 5M
Ownership:
- backend-owned

Rule source:
- `src/services/backend-alert-rules.js`

Detection model:
- strict baseline anchored `5m` back
- evaluates the minimum `low_mcap` inside the trailing `5m` window
- default gate requires `baseline_mcap >= 2_000_000`
- default threshold is `50%` down from baseline
- wick-style intrawindow dumps qualify; it does not require the token to close the full `5m` window at the low

Rearm / dedupe:
- first qualifying dump creates a persisted event
- the same collapse does not keep generating new events every minute
- rearm requires either:
  - recovery to `85%` of the last baseline
  - or `6h` since the last alert

Persistence and delivery:
- global event history lives in `token_alert_events`
- current rule state lives in `token_alert_rule_state`
- per-user per-rule seen/replay progress lives in `alert_delivery_cursors`
- backend feed endpoint:
  - `GET /api/dashboard/alert-events`
- cursor update endpoint:
  - `POST /api/dashboard/alert-events/cursor`
- realtime delivery also uses authenticated socket event `alert:event`

Current user-config scope:
- users can toggle the alert on/off
- users can toggle its sound on/off
- users cannot currently customize threshold, baseline market-cap gate, window length, or rearm

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
- `💥 Dump Alert!` uses an explicit red dump-alert treatment

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
- `High Cap Dump 5M`

Persistence:
- these are backend-persisted user config values
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
- lateralization runs/results

### Browser-local and account-scoped
- dismissed Recent set
- dismissed Old Week set
- Recent removal log
- Old Week removal log
- alerts
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
  - `lateralized`
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
- PumpFun migrate path
- config-related upserts for some user overlays

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
- `POST /api/auth/change-password`
- `POST /api/auth/register`

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
- `GET /api/dashboard/alert-events`
- `POST /api/dashboard/alert-events/cursor`

### Admin status
- `GET /api/admin/ws-status`

## Worker Status Visibility

Admin status endpoint currently exposes:
- socket hub status
- catalog worker status
- Meteora snapshot worker status
- Dex discovery worker status

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

Operational review points that now matter continuously:
- only intended public ports exposed
- backend kept behind a reverse proxy instead of being left broadly reachable on arbitrary ports
- HTTPS enforced at the proxy layer
- intentional firewall / security-group rules
- production cookie/origin/rate-limit settings revalidated for the actual public topology
- backend kept behind local/private proxy hops because the app now resolves trusted client IPs through proxy-aware private/loopback trust instead of raw `X-Forwarded-For`
- explicit `CORS_ORIGINS` maintained for every frontend host that should be allowed; implicit preview trust is no longer part of the code contract
- code-level runtime split support now exists:
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
- until the VPS deployment is explicitly split into separate web/background processes, the production runtime should still be treated as single-process

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
- `frontend/src/ui/sections/pumpfun-section.ts`
- `frontend/src/ui/sections/pumpfun-toasts.ts`
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
- `docs/phase6-runbook.md`
- `docs/phase6-checklist.md`
- `docs/phase6-railway.md`
for behavior parity and deployment operations, with `docs/phase6-railway.md` treated as legacy Railway-specific reference rather than the current production path.

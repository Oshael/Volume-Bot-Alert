# Current Bot State

## Purpose
This is the canonical documentation for the current integrated bot state in this repository.

It is based on the active backend/frontend code, with older migration notes used only as secondary context.

For the full technical/behavior reference, see:
- `docs/bot-complete-reference.md`

Last reviewed against code on `2026-03-22` after catalog sanitization, Dex batch migration, monitored refresh acceleration, monitored UI pagination/freshness updates, admin backend blocking, and Meteora alert integration.

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
  - `src/services/catalog-cleanup-worker.js`
  - `src/services/catalog-worker.js`
  - `src/services/dex-discovery-worker.js`
  - `src/services/meteora-snapshot-worker.js`
  - `src/services/socket-hub.js`

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
- Current session transport:
  - backend-issued `HttpOnly` cookie
  - frontend requests use `credentials: include`
  - frontend no longer depends on browser-readable auth token storage

### User config and user overlays
- Source of truth: backend
- Main endpoint:
  - `GET /api/config`
- Returned user-scoped data:
  - `configs`
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
- Admin-only global suppression now also exists outside the per-user blocklist:
  - `POST /api/catalog/admin-blocklist`
  - `DELETE /api/catalog/admin-blocklist/:address`
- This admin block is global/backend-owned rather than account-scoped.

### Working currently
- The main recent optimization pass was on catalog/API efficiency rather than auth.
- The largest resolved issue was DexScreener overuse and delayed refresh for hot monitored tokens.
- The current architecture now separates:
  - discovery of new tokens
  - catalog reevaluation of known tokens
  - cleanup of stale/low-value catalog entries
- Important current conclusion:
  - Dex `429` pressure dropped sharply after moving catalog refresh to Dex batch reads
  - frontend render cost also dropped after paginating the `Monitored Tokens` panel
  - current work has shifted from “stop Dex overload” to targeted behavior review and smaller follow-up optimizations

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
- The active frontend no longer uses the old batch-style Meteora read path

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
    - MCAP baseline from `token_market_snapshots`
    - latest Meteora summary from `token_meteora_snapshots`
- Current intended effect:
  - frontend no longer depends on per-token Dex socket fetches as the main monitored refresh mechanism
  - frontend refresh should read backend-prepared state instead of causing Dex fetches itself

Current monitored UI behavior:
- backend payload now includes `generatedAt`
- frontend shows freshness text in the panel header using that timestamp
- `Monitored Tokens` now paginates the rendered cards
- `Monitored Tokens` now supports compact local search by:
  - symbol
  - name
  - contract/address
- the monitored `TOKENS` pill reflects the filtered result count
- pagination does not change alert logic:
  - the full monitored set still stays in frontend state
  - only the visible page is rendered
  - hidden pages still receive fresh data through the monitored payload
- the monitored header now behaves as two tuned rows:
  - title isolated on the left
  - sort controls + token count on the top row
  - per-page/page/jump + compact search on the bottom row
  - opening the compact search only pushes the bottom row, not the title/top-row controls
- current compact-search behavior:
  - `Monitored` uses the stabilized dedicated behavior added earlier
  - `Manual`, `Recent`, and `Old Week` now use click-to-open compact search that stays open while focused
  - those compact searches no longer depend purely on transient hover/focus timing

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
  - newly added manual tokens get `5s` retry cadence until first classification

### 4a. Catalog cleanup worker
- Worker: `src/services/catalog-cleanup-worker.js`
- Poll loop: every `60m`
- Purpose:
  - quarantine weak discovery tokens
  - soft archive stale/low-value tokens
  - keep low-signal catalog entries from competing with hot monitored tokens
- Current rule shape:
  - protected user-linked tokens are excluded
  - `dexscreener-discovery` weak tokens go to `quarantine`
  - stale/repeated-bad-state low-value non-discovery tokens can go to `soft archive`

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
  - authenticated `Change Password`
- Current login/bootstrap path:
  1. `POST /api/auth/login`
  2. backend verifies email/password
  3. backend sends email OTP
  4. `POST /api/auth/login-otp/verify`
  5. backend creates the cookie-backed session
  6. frontend restores session with `GET /api/auth/me`
  7. frontend hydrates account/config/dashboard state

Current login/account implementation status:
- login, registration, email verification, password reset, and change password are implemented
- session restore after hard refresh is working in the integrated frontend
- the live auth flow is cookie-backed and no longer depends on browser-readable token storage
- auth UX is materially more complete than the older "raw login shell" state

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
1. Session policy follow-up
   - unique per-login session identity is now in place
   - HTTP and socket revocation semantics are now aligned for:
     - `Logout` on the current session
     - `Logout All` on the full account
     - admin revoke/deactivate on live sockets
   - remaining follow-up is mainly policy tuning:
     - session expiration
     - cleanup cadence
     - how many historical sessions one account may accumulate

2. Defense-in-depth render follow-up
   - the highest-risk auth/account/config/list surfaces have already received the main hardening pass
   - remaining work is selective cleanup of lower-traffic HTML-string helpers where the safety win justifies the churn
   - preserve the current CSP and cookie-auth posture while keeping `escapeHtml(...)`, URL sanitization, and `CSS.escape(...)` as the baseline floor

3. Auth regression coverage recovery
   - test entrypoint and live cookie + OTP coverage are back in place
   - keep extending coverage for:
     - login OTP verify/resend edge cases
     - cookie-backed session restore
     - password reset / password change revocation behavior
     - admin session revocation paths
     - malformed auth token / challenge inputs at backend boundaries

4. Stronger secondary verification follow-up
   - current secondary verification is email OTP
   - if stronger account protection is needed later, the next upgrade path is TOTP + backup codes
   - keep this as a later hardening step, not the immediate next priority

#### Next active path
1. Session policy and cleanup review
   - verify the current expiration and retention behavior against real usage
   - keep `logout-all` and forced admin revoke as the reference contract for full-account invalidation
   - watch for any operational need to cap concurrent or historical sessions harder

2. Defense-in-depth hardening
   - review lower-traffic render helpers and backend edges that still rely on older patterns
   - prioritize changes that improve safety without changing alerting, catalog, routing, or operator workflow
   - keep operational visibility, rate/retention controls, and abuse resistance as the main next levers

3. Performance investigation and latency reduction
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

4. Stronger secondary verification follow-up
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

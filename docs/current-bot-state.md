# Current Bot State

## Purpose
This is the canonical documentation for the current integrated bot state in this repository.

It is based on the active backend/frontend code, with older migration notes used only as secondary context.

For the full technical/behavior reference, see:
- `docs/bot-complete-reference.md`

Last reviewed against code on `2026-03-19` after auth hardening via `HttpOnly` cookie sessions, removal of frontend token/debug exposure, validated login/create-account flow after the cookie migration, broad frontend XSS hardening, and a pragmatic CSP rollout on both frontend and backend.

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
  - `POST /api/auth/change-password`
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
  - frontend no longer depends on per-token Dex socket fetches as the main monitored refresh mechanism
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
  - `high`:
    - default: `10s`
    - if `6h volume < 30k`: `40s`
    - if `6h volume < 15k`: `60s`
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

### Login screen roadmap
- Current frontend login is still a minimal "raw login" shell:
  - product title + subtitle
  - flash/error area
  - email field
  - password field
  - submit button
- This is functionally enough to call `POST /api/auth/login`, but it does not yet represent the full auth/session architecture already present in the backend and controller.
- For this bot, login is not just credential submit:
  - it starts the session bootstrap
  - it leads into `GET /api/auth/me`
  - it then hydrates account config from `GET /api/config`
  - it then hydrates monitored state from `GET /api/dashboard/monitored`

Current UX gaps in login:
- generic error handling still collapses too many cases into broad messages such as fetch/login failure
- login shell does not clearly communicate session restore, active validation, or next-step bootstrap behavior
- missing important form UX states such as password visibility toggle, stronger loading states, and clearer field-level guidance
- insufficient recovery/help affordances for auth problems
- visual hierarchy is still very close to a raw form instead of a deliberate product entry screen

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
- Risk is reduced, but not eliminated:
  - remaining risk is mostly structural due to the UI architecture still relying on HTML-string rendering in many places
  - the next line of defense after the current hardening is continued render-surface review and future reduction of `innerHTML`-heavy patterns where practical

Current security priority order:
1. Finish practical XSS hardening and keep CSP stable.
2. Only then move into real email-backed password reset.
3. After password reset, revisit 2FA / secondary verification.

What a good login screen for this bot must communicate:
- this is the authenticated entry point to the Solana monitoring workspace
- session is backend-owned and validated by `/api/auth/me`
- login success leads to config/account/bootstrap loading
- session restore on returning users is expected behavior
- logout and logout-all are part of the same backend session model

Planned login requirements:

#### 1. Status clarity
- clearly show the auth phase:
  - restoring session
  - logging in
  - login success
  - session revoked
  - login required
- avoid generic loading language when the app knows the exact phase

#### 2. Useful error handling
- distinguish these cases in UI copy:
  - invalid email/password
  - deactivated account
  - auth rate-limit / temporary lockout
  - backend unavailable
  - network failure / fetch failure
- if backend returns retry timing for lockout, the UI should expose that clearly

#### 3. Better form usability
- preserve the email value after failed submit
- support Enter submit cleanly
- disable form controls while request is in flight
- add password show/hide toggle
- improve focus/error/disabled states on fields
- keep labels explicit and accessible

#### 4. Product context and trust
- keep strong branding:
  - product name
  - short monitor-specific subtitle
- add a short description of what happens after login
- reinforce that the user is entering the monitoring dashboard/workspace, not a generic admin panel

#### 5. Session awareness
- communicate that session can be restored on return
- communicate server-side revocation more clearly when it happens
- align login messaging with the real backend session model already used by socket auth and logout-all

#### 6. Recovery path
- reserve space for future recovery/support actions:
  - forgot password
  - access problem/help text
  - invite/account assistance if needed
- even if those flows are not implemented yet, the layout should leave room for them

#### 7. Visible security without clutter
- keep auth messaging calm and product-grade
- avoid exposing sensitive details
- keep neutral invalid-credential responses
- prepare the screen structure so future additions like password change / invite / 2FA do not require a redesign from zero

#### 8. Visual hierarchy and consistency
- preserve the current visual language of the bot
- strengthen hierarchy between:
  - brand header
  - explanatory copy
  - status/error feedback
  - form fields
  - primary CTA
- the goal is not only "prettier login", but a login that explains the app state clearly

Implementation strategy for this login work:
- deliver in parts to avoid losing track
- prefer incremental changes over a full rewrite at once
- keep `docs/current-bot-state.md` as the running checkpoint for login UX scope
- validate each step against the existing backend auth/session flow before moving to the next

Current login implementation progress:

#### Completed in current phase
- branding was updated in the login shell to the current product naming:
  - `TrendScope`
  - `Volume Bot Tracker`
- top-of-screen redundancy was reduced:
  - duplicated status chip in the top-right was removed
  - duplicate explanatory copy block above the form was removed
- form usability was improved:
  - email value persists across rerenders and failed login attempts
  - password field supports show/hide
  - password show/hide now preserves caret/selection position
  - submit/loading state is clearer
  - repeated invalid-credential attempts trigger a subtle flash pulse
  - invalid-credential responses also visually mark the email/password fields
  - password field shows a `Caps Lock is on` hint
  - login ignores duplicate submits while auth is already in flight
  - keyboard submit via Enter/Return now triggers the same login flow as mouse click
  - email input trims surrounding spaces on blur
  - error feedback clears automatically when the user starts editing again
  - login now focuses the most useful field automatically:
    - email on first open / email-format problems / generic credential failure
    - password on password-required errors
- auth error handling is more specific in the frontend controller:
  - invalid credentials
  - deactivated account
  - temporarily locked login
  - revoked/expired/invalid session
  - network/server auth failure
- lockout messaging was refined:
  - retry timing is displayed in minutes instead of raw seconds
  - the lockout flash no longer uses the `WAIT` badge
- flash feedback now has clearer semantic states:
  - `login required`
  - `session`
  - `credentials`
  - `lockout`
  - `network`
  - `success`
- login accessibility/semantics were improved without adding UI clutter:
  - flash uses `role="alert"` or `role="status"`
  - fields use `aria-invalid`
  - fields reference the current auth feedback with `aria-describedby`
  - email field uses `inputmode="email"`, `autocapitalize="none"`, and `spellcheck="false"`
  - password-toggle control uses `aria-controls`
- auth feedback/state classification was centralized in frontend helpers instead of being spread as raw string checks across multiple render points
- login shell structure was modularized into explicit slots:
  - header
  - feedback
  - form
  - support
- lightweight client-side login validation now blocks obvious invalid submits before backend roundtrip:
  - empty email
  - malformed email
  - empty password
- auth extension groundwork is no longer only hidden structure:
  - the frontend now has real auth-panel state for modal flows
  - auth helper/state/controller wiring is in place for registration, password change, and invite validation
- `Change Password` is now a real authenticated frontend flow:
  - opened from the user menu
  - rendered as a centered modal with backdrop blur
  - uses `POST /api/auth/change-password`
  - preserves field drafts across rerenders
  - preserves caret/selection during password show/hide
  - logs the user out after success so the new password must be used on the next sign-in
- local old-password detection was added for the current browser/device:
  - after a successful password change, the previous password is remembered locally as a hash
  - if the same email later tries to log in with that old password, the login flash explains that it is an old password and includes the changed date in `MM/DD/YYYY`
- invite-based registration is now a real frontend flow instead of only a reserved slot:
  - `Create account with invite` opens a centered registration modal
  - registration uses the existing backend `POST /api/auth/register`
  - fields are:
    - username
    - email
    - password
    - invite code
  - frontend validation now mirrors backend constraints more closely:
    - username must be `3-32` chars
    - username may only use letters, numbers, and underscores
    - password must be `8-128` chars
  - invite codes are validated on blur through the existing public endpoint before submit
  - registration errors stay inside the registration modal instead of dropping the user back to the base login shell
  - registration preserves already-entered values on rerender/error
  - registration now focuses/selects the most relevant field automatically on error:
    - username for username conflicts/validation
    - email for email conflicts/validation
    - password for password validation
    - invite code for invite issues
- invite/account assistance is now a visible support flow instead of only helper copy:
  - `Access help` opens a dedicated modal from the login support area
  - the modal gives guidance for:
    - expired invite
    - revoked invite
    - invite max-uses reached
    - account blocked / deactivated scenarios
  - the modal now acts as an invite-code checker only
  - the support warning inside that modal was rewritten as a stronger anti-scam / anti-DM message
  - the help modal has its own typography treatment and compact layout separate from the main login shell
- a first explicit `Forgot Password` path now exists in the login UI:
  - it does not fake a reset flow that the backend does not support yet
  - it opens a dedicated modal that explains the official support-only recovery path
  - it reinforces the anti-DM / official-ticket guidance instead of pretending self-serve reset exists
- login support/action hierarchy was reorganized:
  - `Create Account` and `Forgot Password` were moved directly under the password field
  - `Access Help` remains in the support block as the dedicated support affordance
  - `Create Account` label was simplified from `Create account with invite` to `Create Account`
- auth feedback isolation was refined so each surface only shows relevant messages:
  - registration modal no longer inherits generic login notices such as `No saved session`
  - base login flash no longer inherits registration-only errors such as invite-validation failures
- auth/session transport was hardened:
  - auth no longer exposes a readable session token through frontend debug globals
  - unnecessary auth/config debug logs were removed from the browser console
  - live auth now relies on backend-issued `HttpOnly` cookies instead of frontend-managed JWT storage
  - socket auth was aligned to the same cookie-backed session model
- login typography and visual language were revised:
  - `Saira` is now the intended default type direction for the login/auth interface
  - login screen, support block, and auth modals were aligned around that direction
  - auth titles were moved toward stronger white/bold treatment while body/support copy remains lighter
  - the login password `Show` control was reduced to plain clickable text to match the auth modal style
  - the inline `Create Account | Forgot Password` row was centered under the password field
  - spacing between login labels and fields was tightened and then selectively rebalanced for `Password`
- backend invite consumption for registration was corrected:
  - invite codes are no longer burned before the user record is successfully created
  - `/api/auth/register` now uses a DB transaction
  - the invite row is locked first
  - user creation, session creation, last-login update, and invite-use increment happen in one transaction
  - if registration fails, the transaction rolls back and the invite remains usable until success, revocation, or expiry

#### Explicitly reverted during iteration
- temporary inline recovery action buttons inside the form were tested and then removed because they added too much visual weight for the current layout
- softer alternate field-error color for local validation was tested and then removed; the current UI keeps one consistent error color
- dismissing feedback with `Esc` was tested and then removed because it felt unnecessary for this screen
- the `Access Help` modal originally included an email field, but it was removed because it did not have a real functional role yet and made the checker more cluttered
- the `Change Password` modal originally used boxed `Show/Hide` toggles, but those were replaced with plain clickable text because the lighter treatment fit the modal better
- several auth-modal font experiments were tested (`Inter`, `Satoshi`, `Saira`) before settling on `Saira` as the default direction for the login/auth surfaces

#### Still pending in the login roadmap
- decide whether the recovery path / support affordance is now complete enough in its current modal form or still needs another product pass
- evaluate whether the current field-error styling is the final direction or still too visually strong
- future auth work still not implemented:
  - password reset / forgot-password flow
  - 2FA or secondary verification
- decide whether login notices/flash states should gain small iconography or remain text+badge only
- session restore after hard refresh (`F5`) was re-tested and is now considered resolved in the integrated frontend
- continue validating that each login UX refinement preserves the current backend-owned auth/session model and does not imply unsupported frontend-only behavior
- latest manual validation after the cookie migration:
  - login works again once the local test-account password matches the DB state
  - a quick create-account flow was manually validated as working
  - the temporary local login confusion came from a password changed during auth-test runs, not from the cookie migration itself
- current auth/security implementation strategy from this point:
  1. security hardening first
     - audit and reduce XSS exposure from frontend HTML rendering
     - add central escaping/safe URL handling for token-driven UI
     - review CSRF posture now that auth is cookie-based
     - only after that, move into real email-backed recovery flows
  2. password reset with real email delivery
     - choose provider
     - add reset-token generation/validation
     - add backend endpoints and frontend screens
  3. 2FA / secondary verification
  4. lower-priority auth polish
     - final support/recovery wording pass
     - optional flash/icon treatment pass

#### Next auth/security preparation plan
1. Real password reset
   - production email provider chosen for the first rollout: `Resend`
   - define reset-token storage, expiry, consume-once behavior, and revocation semantics
   - add backend endpoints for:
     - request reset
     - validate/reset token
     - consume token and set new password
   - add frontend screens for:
     - request reset
     - reset form
     - success / invalid / expired states
   - keep all user-facing responses neutral enough to avoid account enumeration
   - align reset completion with the current backend-owned session model:
     - revoke old sessions after password change/reset
     - clear active cookie session
     - force next login with the new password

2. 2FA / secondary verification
   - start only after the real password-reset flow is stable
   - decide whether the first version is TOTP, email OTP, or another secondary verification step
   - define enrollment, backup/recovery, and disable/reset flows before implementation
   - ensure the login/auth UI can absorb the extra verification step without a full redesign

3. Session policy review
   - re-evaluate session expiration and cleanup cadence
   - review how many historical sessions a single account is allowed to accumulate
   - keep `logout-all` behavior as the reference point for expected session invalidation
   - decide whether older inactive sessions should be capped, pruned faster, or surfaced more clearly in admin tooling

4. Final security pass
   - continue reducing older render surfaces that still rely heavily on HTML-string rendering
   - prioritize the most sensitive auth/account/config surfaces first
   - preserve the current CSP and cookie-auth posture while reducing structural XSS risk
   - only after the auth roadmap is stable, consider broader `innerHTML` reduction in lower-risk UI areas

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
  - authenticated users can request verification-email resend
  - verification confirm route is in place and consumes single-use tokens
  - password-reset request + confirm routes are in place
  - password reset now revokes all active sessions after success

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

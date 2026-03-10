# V68 Migration Checklist

## Goal
Migrate `volume-alert-botV68.html` without losing the production fixes already validated in the current integrated frontend.

## Frontend Fixes Required

- Preserve backend-aware `API_BASE` resolution.
  - Keep `?api=...` override.
  - Keep localhost/dev behavior.
  - Keep automatic Railway fallback when hosted on `vercel.app`.

- Preserve account-scoped browser storage.
  - Keep user-scoped storage key helper for `bot_config`.
  - Keep user-scoped storage key helper for `manual_tokens`.
  - Do not fall back to global `localStorage` keys for authenticated state.

- Preserve server-backed auth/session flow.
  - Login must use `/api/auth/login`.
  - Register must use `/api/auth/register`.
  - Session restore must use `/api/auth/me`.
  - Logout must use `/api/auth/logout`.
  - Socket auth must use `auth: { token }`.

- Preserve backend config sync behavior.
  - Config updates must keep syncing to `/api/config`.
  - Full token/config sync must keep using the server as source of truth after login.
  - Failed syncs must surface as errors, not silently fall back to local-only state.

- Preserve per-account persistence semantics.
  - Same account in another browser must load the same config.
  - Same account in another browser must load the same manual tokens.
  - Different accounts on the same browser must not share `bot_config`.
  - Different accounts on the same browser must not share `manual_tokens`.

- Preserve manual token reload fix.
  - `loadManualTokens()` must create the token immediately in local state.
  - `_userManual` and `manual` must be set before async enrichment finishes.
  - Reload / `F5` must not randomly drop manual tokens.

- Preserve manual token add fix.
  - `addManualToken()` must create the token immediately before async Dex enrichment.
  - Save/render must happen even if enrichment is delayed.

- Preserve session revocation behavior.
  - Revoked session must return user to login state.
  - `logout-all` must invalidate all open sessions of the same account.
  - Periodic session validation must remain in place unless replaced by a better server-driven mechanism.

- Preserve current integrated production assumptions.
  - Frontend hosted on Vercel.
  - Backend hosted on Railway.
  - No direct dependency on `file://` behavior for production.

## Backend Changes Required For V68

- Expand `/api/config` schema in `src/models/user-config.js` to cover V68 fields:
  - `old-per-page`
  - `old-week-mcap-min`
  - `old-week-mcap-max`
  - `old-week-per-page`
  - `meteora-min-pool`

- Reconcile naming/behavior differences between current frontend and V68.
  - Current integrated bar is `Old Tokens`; V68 uses `Recent Tokens`.
  - Confirm whether persistence keys and semantics stay the same or need a migration step.

- Decide server contract for V68-only persisted features.
  - Starred tokens:
    - choose whether they stay browser-local initially or become per-user backend state.
  - Additional old-token paging/sort preferences:
    - decide whether they belong in `/api/config`.
  - Trade terminal preferences:
    - likely frontend-only unless user-specific persistence is needed.

- Decide backend scope for Meteora integration.
  - Initial migration path:
    - allow `meteora-min-pool` as persisted config only.
    - keep Meteora polling client-side at first if the goal is a faster migration.
  - Later hardening path:
    - move Meteora polling and TVL history to backend if it becomes part of the protected product logic.

- Re-check `/api/config` compatibility before swapping frontends.
  - Unknown keys must not cause V68 to fail silently.
  - Full sync payload from V68 must be validated against the final backend schema.

## Regression Gates

- Login works.
- Session restore works.
- Config sync works.
- Manual token sync works.
- `F5` does not drop manual tokens.
- Same account across browsers stays in sync.
- Different accounts do not leak state through browser storage.
- Socket connects with JWT via `auth.token`.
- `logout-all` invalidates every open session.
- Vercel frontend talks to Railway backend without `?api=` override.

## Recommended Migration Order

1. Extend backend config schema for V68 fields.
2. Port the auth/API/storage fixes from the current integrated frontend into V68.
3. Port the manual-token reload/add fixes into V68.
4. Run regression gates locally against Railway.
5. Deploy V68 to Vercel.
6. Re-run regression gates in production.


- Cold-start bootstrap seed implemented via backend `/api/bootstrap/tokens`.
  - Seed is applied only to cold-start accounts.
  - Seed does not become `manual_tokens`.
  - Seed is a monitored baseline only.

## Post-Migration Hardening Direction

- Do not treat obfuscation as primary protection.
- After V68 is stable in production, move high-value bot logic to the backend in stages.
- First candidates to move server-side:
  - token monitoring decisions
  - alert thresholds/rules execution
  - PumpFun processing logic beyond raw transport
  - Meteora polling/history if retained
  - any future token history / liquidity history features

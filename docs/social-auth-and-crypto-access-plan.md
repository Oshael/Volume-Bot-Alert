# Social Auth And Crypto Access Plan

## Purpose

This document defines the approved rollout plan for:

- paid access windows
- crypto payment support
- Google login
- Discord login
- invite-based onboarding

It is intentionally anchored to the current repository architecture and to the product decisions already made for this project.

## Current Repository Baseline

These points are true in the codebase today:

- registration is invite-gated
- registration is local-account based:
  - `username`
  - `email`
  - `password`
  - `inviteCode`
- registration does not auto-login the user
- email verification is required before login
- login is local-account based:
  - `email`
  - `password`
  - email OTP challenge
- sessions are backend-issued cookie sessions
- session validity is enforced in HTTP middleware and websocket auth
- account deactivation already revokes sessions and sockets
- access entitlement now exists on `users`
- billing foundation now exists:
  - plans
  - orders
  - webhook-driven access crediting
  - local mock checkout for development
- Google/Discord identity storage and OAuth flows do not exist yet

Relevant code anchors:

- `src/routes/auth.js`
- `src/routes/billing.js`
- `src/routes/account.js`
- `src/routes/admin.js`
- `src/middleware/auth.js`
- `src/services/billing-service.js`
- `src/services/moonpay-commerce.js`
- `src/services/socket-hub.js`
- `src/models/user.js`
- `src/models/user-access.js`
- `src/models/session.js`
- `src/models/billing-order.js`
- `src/models/billing-event.js`
- `src/utils/db-init.js`
- `frontend/src/state/app-controller.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/ui/app-shell.ts`
- `frontend/src/ui/sections/layout-sections.ts`
- `tests/auth.test.js`
- `tests/admin.test.js`
- `tests/billing.test.js`

## Current Gaps

The repository now implements the internal pre-access purchase flow, but some rollout work is still pending.

Today:

- new non-admin accounts default to `inactive`
- a dedicated `/access` flow exists outside the normal bot shell
- verified users without product access are routed into that pre-access flow
- local mock checkout and backend-driven access confirmation are already working
- `User Settings` billing still exists as support/admin-facing foundation UI, but it is no longer the primary no-access user journey
- MoonPay sandbox and real provider validation are still pending
- Google/Discord identity storage and OAuth flows still do not exist

## Approved Product Decisions

These decisions are now closed and should be treated as binding for implementation.

### Access and Invite Rules

1. New non-admin accounts must start as `inactive`.
2. Standard invites still gate account creation.
3. Special invites may grant immediate bot access for a limited duration chosen at invite creation time.
4. Special-invite access is still time-bound entitlement, not permanent bypass.
5. When a special-invite access window expires, the user must go through the paid flow to regain access.
6. Admin accounts keep unlimited access.
7. Only new users need to follow the paid-access model.
8. There is no grandfathered-user migration problem for this rollout.

### Access-State Rules

1. `is_active = false` means the account is administratively deactivated and is a total block.
2. `access_status = revoked` is treated as a total block, not as a billing-recovery state.
3. `access_status = inactive` and time-expired access are billing-recovery states.
4. `manual`, `admin`, and approved special-invite grants may bypass the paid flow while they remain valid.
5. Entitlement and account activation remain separate checks.

### Login and Billing Flow Rules

1. Users without current product access must not receive the normal bot session.
2. The paid flow must happen outside the normal bot session.
3. The user should be redirected into a dedicated pre-access part of the site.
4. In that dedicated flow, the user chooses a plan and is then sent to MoonPay.
5. After MoonPay redirects back, the site waits for backend confirmation.
6. Only after confirmed payment should the user be redirected into the bot.

## Critical Architectural Clarification

The approved product direction is "outside the normal session", not "anonymous".

That matters because the backend still needs a secure, user-bound way to know:

- which verified account is attempting to buy access
- which billing orders belong to that account
- which successful payment should unlock which user

So the next flow must use a dedicated pre-access auth state, not the normal app session and not a loose public flow.

Recommended implementation shape:

- user completes the existing local login checks:
  - email
  - password
  - OTP
- if the account has product access:
  - create the normal app session
  - redirect to the bot
- if the account is `inactive` or `expired`:
  - do not create the normal app session
  - create a short-lived pre-access flow token or cookie
  - redirect to the dedicated billing flow
- if the account is `revoked` or `is_active = false`:
  - deny access entirely

This keeps the product flow "outside the normal bot session" while still binding payment to a verified account safely.

## Phase Overview

## Phase 1

Entitlement foundation

Status:

- implemented

Delivered:

- access fields on `users`
- backend access helpers
- HTTP auth enforcement
- websocket auth enforcement
- admin access management
- account access endpoint
- frontend access visibility

## Phase 2

Billing and pre-access purchase flow

Status:

- partially implemented

Phase 2 is now split into two layers so the rollout stays manageable.

### Phase 2A

Billing foundation

Status:

- implemented

Delivered:

- billing tables
- plan catalog
- order creation
- MoonPay provider integration
- webhook-driven idempotent access crediting
- billing history UI
- local mock checkout flow for development

### Phase 2B

Dedicated pre-access purchase flow

Status:

- implemented
- manually validated with local mock checkout

Goal:

Allow a verified user without current product access to purchase access before entering the bot.

## Phase 3

Social identity linking for existing accounts

Status:

- not started

## Phase 4

Login with linked Google and Discord identities

Status:

- not started

## Phase 5

Optional future direct social signup

Status:

- deferred
- not part of the current roadmap

## Phase 2B Detailed Scope

## Target User Journey

Approved target flow:

1. user creates account with invite
2. user verifies email
3. successful verification creates the dedicated pre-access session when the account still lacks product access
4. frontend routes the user into the dedicated billing flow
5. if access is valid:
   - create normal bot session
   - redirect to bot
6. if access is `inactive` or `expired`:
   - keep the dedicated billing flow active
7. user selects a plan in the dedicated billing flow
8. backend creates local billing order
9. backend creates MoonPay charge for that order
10. frontend redirects user to hosted MoonPay checkout
11. MoonPay redirects back to the dedicated billing flow
12. frontend waits for backend confirmation
13. backend confirms payment by webhook
14. backend grants or extends access
15. frontend exchanges the pre-access flow state for the normal bot session
16. user is redirected into the bot

## Required Behavior By State

### Normal Access

- `is_active = true`
- access valid
- normal app session is created
- websocket and dashboard access allowed

### Billing Recovery States

- `is_active = true`
- access `inactive` or expired
- no normal app session
- user is routed into the dedicated billing flow

### Hard Block States

- `is_active = false`
- or `access_status = revoked`
- no normal app session
- no pre-access billing flow
- show explicit blocked messaging

## Dedicated Pre-Access Flow Requirements

The dedicated billing flow must be isolated from the normal bot shell.

It should support:

- current account identity summary
- current access status summary
- plan selection
- billing order creation
- redirect to MoonPay
- post-redirect waiting state
- polling or refresh for payment confirmation
- success state before entering the bot
- logout / cancel

It must not expose:

- bot dashboards
- bot settings
- websocket connections
- live alerts
- token-management features

## Backend Requirements For Phase 2B

### New Flow State

Add a dedicated pre-access flow state with a short TTL.

Recommended properties:

- tied to a concrete user id
- issued after successful login plus OTP or after successful verify-email
- separate from the normal bot session
- invalidated when upgraded to the normal session
- invalidated on logout

Possible implementation shapes:

- short-lived dedicated JWT
- short-lived HTTP-only cookie
- dedicated server-side flow table plus opaque token

The exact mechanism is open, but it must remain clearly separate from the normal product session.

### Login Branching

Update the local login flow so that after OTP validation it branches into:

- normal session creation for valid access
- pre-access flow issuance for `inactive` or expired access
- full denial for `revoked` or deactivated accounts

### New Pre-Access Endpoints

Recommended endpoint family:

- `GET /api/pre-access/me`
- `GET /api/pre-access/plans`
- `GET /api/pre-access/orders`
- `POST /api/pre-access/orders`
- `GET /api/pre-access/orders/:id`
- `POST /api/pre-access/complete`
- `POST /api/pre-access/logout`

Purpose:

- the dedicated flow should not depend on the normal app session middleware contract
- it needs its own auth boundary
- it still reuses the same billing/order backend logic wherever possible

### Payment Confirmation

Payment confirmation remains backend-driven only.

Source of truth:

- MoonPay webhook

Not a source of truth:

- redirect query params
- frontend success pages
- client-reported payment state

### Session Upgrade

After backend confirms payment:

- the user returns to the dedicated flow
- frontend detects paid order state
- backend creates the normal bot session
- pre-access flow state is consumed
- user is redirected to the bot

## Invite Model Changes Required

The invite system will need two product modes:

### Standard Invite

- permits registration
- grants no immediate product access
- new account lands in `inactive`

### Special Invite

- permits registration
- grants immediate access for a configured duration
- duration is chosen by the admin when the invite is created
- access source should remain distinguishable from payment access

Recommended additional source value:

- `invite`

That is cleaner than overloading `manual` or `promo`.

## Data Model Decisions For Next Implementation

These model changes are now expected:

### Users

- default new non-admin account access should become `inactive`
- admin account creation path should still land with active unlimited access

### Invites

Invite records will likely need new optional fields such as:

- `grants_access`
- `grant_access_days`
- possibly `grant_access_source`

The exact schema can stay minimal, but the invite itself must be able to encode "registration only" versus "registration plus timed access".

## Frontend Requirements For Phase 2B

Add a dedicated pre-access route or route family, separate from the normal bot shell.

Recommended shape:

- `/access`
- `/access/plans`
- `/access/checkout`
- `/access/waiting`

The exact route design can vary, but it should be clearly separate from:

- `/alerts`
- `/monitor`
- normal in-app settings

Required UX states:

- no access yet
- selecting plan
- redirected to provider
- waiting for confirmation
- payment confirmed
- payment failed
- blocked account

## What Must Be Removed Or Changed From The Old Plan

The previous assumptions below no longer match the approved flow and must not guide implementation:

- billing inside authenticated `User Settings` as the main user journey
- "billing-only normal app session" as the preferred recovery path
- invite always meaning entry only and never granting timed access
- deferring the no-access login flow to a later separate policy decision

Those assumptions were valid as intermediate rollout ideas, but they are not the approved target anymore.

## Security Rules

1. Never auto-link provider identity by email alone.
2. Never credit access from client-reported payment success.
3. Webhook processing must remain idempotent.
4. Payment confirmation must remain backend-authoritative.
5. `is_active = false` and `revoked` stay stronger than billing recovery.
6. Pre-access flow state must be short-lived and separate from the normal app session.
7. A paid user should only receive the normal bot session after confirmed backend state.

## Testing Order

Implementation and testing should follow this order:

1. finish Phase 2B with local mock checkout
2. manually test the full internal journey:
   - register
   - verify email
   - enter `/access`
   - redirect to pre-access flow
   - choose plan
   - local mock checkout
   - confirmation
   - redirect into bot
3. only after that, test MoonPay sandbox
4. only after Phase 2 is stable, move to social identity linking

## Final Recommendation

Execution order from here:

1. MoonPay sandbox validation
2. Phase 3: social identity linking
3. Phase 4: social login
4. Phase 5 only if onboarding policy changes

Do not start Google or Discord work before Phase 2 and sandbox validation are considered stable.

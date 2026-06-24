# Volume Bot Alert

Volume Bot Alert is the backend + frontend codebase for the TrendScope Solana monitoring bot.

The app monitors Solana tokens, builds catalog/history state, evaluates alert rules, exposes authenticated workspaces, and runs background workers for discovery, cleanup, enrichment, Meteora snapshots, bid-zone data, PumpFun capture, and mock-trading automation.

Use this README as the primary project entry point. Use `docs/bot-reference.md` for deeper implementation details.

## Current Status

Current production-like shape:

- Public frontend is hosted separately from the backend, currently at `https://www.trendscope.pro`.
- Backend/API runs as a single Node process on a private VPS, behind `nginx`, currently at `https://api.trendscope.pro`.
- PostgreSQL runs locally on the same VPS as the backend and is not intended to be exposed publicly.
- `railway.json` still exists, but Railway is legacy deployment context rather than the current production contract.
- Current production assumption is still one backend process unless runtime roles are deliberately split.

## Architecture

Main runtime pieces:

- `frontend/`
  - Vite + TypeScript frontend.
  - Main orchestration lives in `frontend/src/state/app-controller.ts`.
  - UI shell and sections live in `frontend/src/ui/`.
  - API clients live in `frontend/src/services/api/`.
  - Socket client lives in `frontend/src/services/socket/`.
- `src/`
  - Express + Socket.io backend.
  - Routes live in `src/routes/`.
  - DB models live in `src/models/`.
  - Workers, upstream clients, alert logic, auth helpers, and billing services live in `src/services/`.
  - DB/schema utilities live in `src/utils/`.
- `tests/`
  - Node test runner tests for backend behavior.
  - Playwright smoke tests are wired through `npm run test:smoke`.

Current authenticated UI workspaces:

- `/alerts`
  - `Monitored Tokens`
  - `Manual Tokens`
  - `Alerts`
- `/monitor`
  - visible label: `RADAR`
  - `Recent Tokens`
  - `Old Tokens 1 Week+`
  - `Bid Zone Coins`

Public/account surfaces include `/`, `/login`, `/access`, and `/account-security`.

## Runtime Roles

The default backend runtime is `combined`, meaning the web server, socket hub, and background workers run together.

Role controls:

- `RUN_SOCKET_HUB`
- `RUN_BACKGROUND_JOBS`

Available scripts:

```bash
npm run start
npm run start:web
npm run start:worker
npm run dev
npm run dev:web
npm run dev:worker
```

Important: do not horizontally scale the full backend by simply starting more complete backend processes against the same production DB. Unless the runtime is intentionally split into web/background roles, each process can start its own workers and duplicate catalog, cleanup, discovery, Meteora, bid-zone, Helius, GMGN, token-risk, and mock-trading work.

## Local Setup

Install dependencies from the repository root:

```bash
npm install
npm --prefix frontend install
```

Create local environment files:

```bash
cp .env.example .env
```

Keep normal runtime config in `.env`. Keep automated test DB config in `.env.test`.

Start backend development server:

```bash
npm run dev
```

Start frontend development server:

```bash
npm --prefix frontend run dev
```

In local frontend development, Vite proxies `/api` and `/socket.io` to the backend.

## Database Safety

Automated tests are destructive against the selected database.

Mandatory rules:

- Never run `npm test` against the normal `.env` database.
- Never point tests at production, Railway, a VPS DB, or a local production snapshot.
- Keep `.env` and `.env.test` separate.
- In `.env.test`, use explicit test-only DB variables:
  - `DATABASE_URL_TEST`
  - `POSTGRES_URL_TEST`
  - `DB_HOST_TEST`
  - `DB_PORT_TEST`
  - `DB_NAME_TEST`
  - `DB_USER_TEST`
  - `DB_PASSWORD_TEST`
- Use a local DB name that clearly looks test-only, for example `volume_alert_test`.
- Treat names like `volume_alert_railway_snapshot` as unsafe for automated tests.

Before running destructive tests, verify the selected test DB:

```bash
node -e "process.env.NODE_ENV='test'; const config=require('./config'); console.log(config.db)"
```

Schema checks:

```bash
npm run db:schema-check
npm run db:schema-check:test
```

## Common Commands

Root backend commands:

```bash
npm run lint
npm run test
npm run test:admin
npm run test:auth
npm run test:catalog
npm run test:config
npm run test:billing
npm run test:smoke
npm run db:init
npm run db:schema-check
```

Frontend commands:

```bash
npm --prefix frontend run dev
npm --prefix frontend run build
npm --prefix frontend run preview
```

Backfill and maintenance commands:

```bash
npm run market-buckets:backfill
npm run market-buckets-agg:backfill
npm run market-volume-buckets:backfill
npm run invite:create
```

`npm run market-snapshots:drop` is intentionally destructive and requires its built-in confirmation flag.

## Validation Policy

Use lint as the first line of defense:

```bash
npm run lint
```

Minimum validation by change type:

- Small frontend change: `npm run lint`
- Medium frontend change: `npm run lint` and `npm --prefix frontend run build`
- Visible flow, auth, billing, config, app shell, controller, or central routes: `npm run lint`, `npm --prefix frontend run build`, and `npm run test:smoke` when applicable
- Schema/init change: `npm run db:schema-check`
- Backend behavior change: run the affected `node --test ...` test file or the matching npm test script
- Larger task before closing: run repo-level `npm run lint`

Warnings should not be introduced without a clear reason. If a warning cannot be fixed in the same work, document why it remains and what risk it carries.

## Important Implementation Areas

Auth and account state:

- `src/routes/auth.js`
- `src/routes/social-auth.js`
- `src/routes/account.js`
- `src/routes/account-security.js`
- `src/services/auth-session.js`
- `src/services/social-auth.js`
- `src/services/email-service.js`

Billing and access:

- `src/routes/billing.js`
- `src/routes/pre-access.js`
- `src/services/billing-service.js`
- `src/services/moonpay-commerce.js`
- `src/models/user-access.js`

Config and user state:

- `src/routes/config.js`
- `src/models/user-config.js`
- `src/models/user-token.js`
- `src/models/user-ui-pref.js`
- `src/models/user-starred-token.js`

Catalog, market history, and discovery:

- `src/routes/catalog.js`
- `src/services/catalog-worker.js`
- `src/services/catalog-cleanup-worker.js`
- `src/services/dex-discovery-worker.js`
- `src/services/gmgn-discovery-worker.js`
- `src/services/meteora-snapshot-worker.js`
- `src/models/token-catalog.js`

Alerts:

- `src/services/backend-alert-rules.js`
- `src/services/backend-alert-feed.js`
- `src/services/backend-alert-publisher.js`
- `src/services/high-cap-dump-alert.js`
- `src/services/user-alert-matcher.js`
- `src/models/token-alert-event.js`
- `src/models/user-alert-event.js`

Frontend orchestration:

- `frontend/src/state/app-controller.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/ui/app-shell.ts`
- `frontend/src/ui/sections/`
- `frontend/src/services/api/`

## Operational Checks

Useful quick checks when reviewing a running bot:

1. `GET /api/health`
2. `GET /api/admin/ws-status`
3. Confirm workers are running and the expected runtime role is active.
4. Confirm recent token discovery is entering `token_catalog`.
5. Confirm catalog reevaluation updates `last_seen_at`.
6. Log in and open `/alerts`.
7. Add a manual token and refresh the page.
8. Confirm `D`, alert behavior, and manual-token persistence are stable after refresh.

## Current Weak Spots

Known areas that deserve extra care during changes:

- Full backend horizontal scaling can duplicate worker execution unless runtime roles are split.
- GMGN discovery intervals near a few seconds can be CPU-heavy on small VPS hosts.
- Test safety depends on keeping `.env.test` pointed at a clearly isolated local test DB.
- Billing, auth, account recovery, and cookie/session behavior are high-impact surfaces and need broader validation than isolated unit tests.
- Browser-local state and account-scoped backend state both exist; reload and cross-device restore paths must be checked after related changes.

## Documentation Policy

This repository intentionally keeps two primary docs:

- `README.md`
  - project entry point
  - local setup
  - commands
  - validation policy
  - architecture map
  - operational cautions
- `docs/bot-reference.md`
  - deeper implementation reference
  - feature contracts
  - worker details
  - persistence details
  - alert behavior
  - endpoint map

Avoid creating another broad "current bot state" document. New long-lived technical details should go into `docs/bot-reference.md`; short operational guidance should go into this README.

Older plan docs in `docs/` are historical or feature-specific unless they are explicitly called out as current runbooks/checklists.

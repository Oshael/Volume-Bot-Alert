# Volume Bot Alert

Volume Bot Alert is the backend + frontend codebase for the TrendScope Solana monitoring bot.

The app monitors Solana tokens, builds catalog/history state, evaluates alert rules, exposes authenticated workspaces, and runs background workers for discovery, cleanup, enrichment, Meteora snapshots, bid-zone data, PumpFun capture, and mock-trading automation.

Use this README as the primary project entry point. Use `docs/bot-reference.md` for deeper implementation details.

## Current Status

Current production-like shape:

- Public frontend is hosted separately from the backend, currently at `https://www.trendscope.pro`.
- Backend/API runs on a private VPS behind `nginx`, currently at `https://api.trendscope.pro`.
- The intended VPS runtime is split into four `systemd` services:
  - `volume-bot-alert-web.service`
    - `RUN_SOCKET_HUB=true`
    - `RUN_BACKGROUND_JOBS=false`
  - `volume-bot-alert-worker-core.service`
    - `RUN_SOCKET_HUB=false`
    - `RUN_BACKGROUND_JOBS=true`
    - `BACKGROUND_WORKER_GROUPS=core`
  - `volume-bot-alert-worker-market.service`
    - `RUN_SOCKET_HUB=false`
    - `RUN_BACKGROUND_JOBS=true`
    - `BACKGROUND_WORKER_GROUPS=market`
  - `volume-bot-alert-worker-maintenance.service`
    - `RUN_SOCKET_HUB=false`
    - `RUN_BACKGROUND_JOBS=true`
    - `BACKGROUND_WORKER_GROUPS=maintenance`
- Robinhood ingestion has a prepared optional fifth isolated runtime. It is not
  included in `all` and should only be activated during its controlled rollout:
  - suggested future unit name: `volume-bot-alert-worker-robinhood.service`
    - `RUN_SOCKET_HUB=false`
    - `RUN_BACKGROUND_JOBS=true`
    - `BACKGROUND_WORKER_GROUPS=robinhood`
    - `ROBINHOOD_INGESTION_ENABLED=true`
- PostgreSQL runs locally on the same VPS as the backend and is not intended to be exposed publicly.
- `railway.json` still exists, but Railway is legacy deployment context rather than the current production contract.
- The old single-process/combined runtime is a local fallback or emergency rollback shape, not the preferred launch topology.
- Do not use the legacy monolithic `volume-bot-alert-worker.service` in production deploy/restart commands.

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

The default backend runtime remains `combined`, meaning the web server, socket hub, and background workers run together. That is useful for local development and emergency rollback.

The launch topology should use split roles:

```bash
npm run start:web
npm run start:worker:core
npm run start:worker:market
npm run start:worker:maintenance
# Controlled Robinhood rollout only (requires ROBINHOOD_START_BLOCK initially)
npm run start:worker:robinhood
```

Role controls:

- `RUN_SOCKET_HUB`
- `RUN_BACKGROUND_JOBS`
- `BACKGROUND_WORKER_GROUPS`

Available scripts:

```bash
npm run start
npm run start:web
npm run start:worker
npm run start:worker:core
npm run start:worker:market
npm run start:worker:maintenance
npm run dev
npm run dev:web
npm run dev:worker
npm run dev:worker:core
npm run dev:worker:market
npm run dev:worker:maintenance
npm run dev:worker:robinhood
```

Important: do not horizontally scale the full backend by simply starting more complete backend processes against the same production DB. The launch rule is:

- web process: socket/API only, no background jobs
- worker process: background jobs only, no public traffic
- exactly one active owner per worker lease

Worker leases protect the individual worker loops from duplicate execution, but they are still an operational guardrail, not a reason to run arbitrary extra background processes without checking `/api/admin/ws-status`.

Production `systemd` operations should target the current split services:

```bash
sudo systemctl status volume-bot-alert-web volume-bot-alert-worker-core volume-bot-alert-worker-market volume-bot-alert-worker-maintenance -l --no-pager

sudo systemctl restart volume-bot-alert-web
sudo systemctl restart volume-bot-alert-worker-core
sudo systemctl restart volume-bot-alert-worker-market
sudo systemctl restart volume-bot-alert-worker-maintenance

sudo systemctl is-enabled volume-bot-alert-web
sudo systemctl is-enabled volume-bot-alert-worker-core
sudo systemctl is-enabled volume-bot-alert-worker-market
sudo systemctl is-enabled volume-bot-alert-worker-maintenance
```

Expected production ports are `3000` for web, `3001` for worker-core, `3002` for worker-market, and `3003` for worker-maintenance. If `volume-bot-alert-worker.service` exists on a host, treat it as legacy and keep it disabled unless intentionally performing an emergency rollback.

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

Unit tests do not intentionally use the real database. Integration tests are destructive against the selected test database.

Mandatory rules:

- Never run `npm run test:integration`, `npm run test:all`, or an individual integration suite against the normal `.env` database.
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

Before running integration tests, verify the selected test DB:

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
npm run test:unit
npm run test:integration
npm run test:all
npm run test:admin
npm run test:auth
npm run test:catalog
npm run test:config
npm run test:billing
npm run test:dashboard
npm run test:mock-trading-routes
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
- `src/services/user-alert-matcher.js`
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
3. Confirm the public service reports `runtime.role = web`.
4. Confirm the worker service reports `runtime.role = background`.
5. Confirm `workerLeases` has one current owner per active worker.
6. Confirm recent token discovery is entering `token_catalog`.
7. Confirm catalog reevaluation updates `last_seen_at`.
8. Log in and open `/alerts`.
9. Add a manual token and refresh the page.
10. Confirm `D`, alert behavior, and manual-token persistence are stable after refresh.

Emergency operation and rollback commands live in `docs/ops-runbook.md`.

## Current Weak Spots

Known areas that deserve extra care during changes:

- Full backend horizontal scaling can duplicate worker execution unless runtime roles and worker leases are verified.
- Rate limits are process-local memory counters; multiple web instances need a shared store or deliberately adjusted limits.
- GMGN discovery intervals near a few seconds can be CPU-heavy on small VPS hosts.
- QuickNode/Jupiter/onchain files and scripts are lab/probe work unless explicitly promoted.
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
- `docs/ops-runbook.md`
  - launch operations
  - emergency switches
  - rollback checks

Avoid creating another broad "current bot state" document. New long-lived technical details should go into `docs/bot-reference.md`; short operational guidance should go into this README.

Older plan docs in `docs/` are historical or feature-specific unless they are explicitly called out as current runbooks/checklists.

# Volume Bot Alert

Volume Bot Alert is the backend + frontend codebase for the TrendScope
multichain monitoring bot.

The app monitors Solana tokens, is rolling out Robinhood Chain support, builds
catalog/history state, evaluates alert rules, exposes authenticated workspaces,
and runs background workers for discovery, cleanup, enrichment, market
aggregation, Meteora snapshots, bid-zone data, PumpFun capture, and mock-trading
automation.

Use this README as the primary project entry point. Use `docs/bot-reference.md` for deeper implementation details.

## Current Status

Current deployment contract (with the worker rollout still being completed):

- VPS1, `TrendScopeBot-01`, serves the public product:
  - `https://www.trendscope.pro` is a static Vite build served by `nginx`;
  - `https://api.trendscope.pro` is reverse-proxied by `nginx` to Node on port
    `3000`;
  - the current web unit is `trendscope-web.service`;
  - `RUN_SOCKET_HUB=true`;
  - `RUN_BACKGROUND_JOBS=false`;
  - Vercel is no longer in the frontend request path.
- VPS2, `TrendScopeWorkers-01`, is the data/processing host:
  - PostgreSQL 16 runs locally on VPS2;
  - shared workers belong on VPS2 with `RUN_SOCKET_HUB=false`;
  - the application database is not intended to be exposed publicly;
  - VPS1 reaches PostgreSQL through WireGuard at `10.77.0.2`.
- Robinhood backfill temporarily also uses the `rh-node` WSL environment:
  - Nitro runs locally in WSL;
  - SSH tunnels connect the local RPC and backfill processes to VPS2;
  - this is a temporary backfill topology, not the final live-chain contract.
- Robinhood live ingestion, head capture and backfill use isolated worker groups:
  - `BACKGROUND_WORKER_GROUPS=robinhood` (monolithic live: capture + valuation + catalog + alerts);
  - `BACKGROUND_WORKER_GROUPS=robinhood-head` (isolated head capture only: writes durable
    evidence to the capture queue and advances its own cursor, no valuation/catalog/alerts);
  - `BACKGROUND_WORKER_GROUPS=robinhood-backfill`;
  - isolated groups cannot be combined with shared worker groups or with each other.

The `robinhood-head` group runs a separate process (systemd
`trendscope-worker@robinhood-head.service`) that captures live evidence during the
migration away from the monolithic `robinhood` path. It runs in shadow alongside
`robinhood` with an independent cursor; it is enabled only by deploying its own unit
with `ROBINHOOD_INGESTION_ENABLED=true` and a fresh `ROBINHOOD_START_BLOCK`. No current
`.env` selects it, so production is unaffected until that unit exists. Run it directly with:

```bash
RUN_SOCKET_HUB=false RUN_BACKGROUND_JOBS=true \
  BACKGROUND_WORKER_GROUPS=robinhood-head \
  ROBINHOOD_INGESTION_ENABLED=true ROBINHOOD_START_BLOCK=<fresh_block> \
  node src/server.js
```
- The old single-process/combined runtime is a local fallback or emergency
  rollback shape, not the preferred production topology.
- `railway.json` remains legacy deployment context rather than the production
  contract.
- Wallet tracking must be designed multichain, but product wallet tracking and
  SHYFT/Yellowstone ingestion are still roadmap items.

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
# Durable Robinhood replay only
npm run start:worker:robinhood-backfill
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
npm run start:worker:robinhood
npm run start:worker:robinhood-backfill
npm run dev
npm run dev:web
npm run dev:worker
npm run dev:worker:core
npm run dev:worker:market
npm run dev:worker:maintenance
npm run dev:worker:robinhood
npm run dev:worker:robinhood-backfill
```

Important: do not horizontally scale the full backend by simply starting more complete backend processes against the same production DB. The launch rule is:

- web process: socket/API only, no background jobs
- worker process: background jobs only, no public traffic
- exactly one active owner per worker lease

Worker leases protect the individual worker loops from duplicate execution, but they are still an operational guardrail, not a reason to run arbitrary extra background processes without checking `/api/admin/ws-status`.

On VPS1, production `systemd` operations target the current web service:

```bash
sudo systemctl status trendscope-web.service -l --no-pager
sudo systemctl restart trendscope-web.service
sudo systemctl is-enabled trendscope-web.service
curl -i https://api.trendscope.pro/api/health
```

On VPS2, first inventory the units that actually exist and restart only the
affected group:

```bash
sudo systemctl list-units --type=service --all \
  | grep -Ei 'trendscope|volume|robinhood|backfill'
```

The npm script defaults are `3000` for web, `3001` for worker-core, `3002` for
worker-market, `3003` for worker-maintenance, `3004` for Robinhood live, and
`3005` for Robinhood backfill. Worker ports are internal process defaults, not
public endpoints.

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

1. Confirm `https://www.trendscope.pro` returns the current frontend.
2. Confirm `https://api.trendscope.pro/api/health` returns without `502`.
3. Confirm `trendscope-web.service` is active on VPS1.
4. Confirm the public service reports `runtime.role = web`.
5. Confirm WireGuard reaches VPS2 and PostgreSQL is not public.
6. Confirm each VPS2 worker reports `runtime.role = background`.
7. Confirm `workerLeases` has one current owner per active worker.
8. Confirm recent Solana discovery is entering `token_catalog`.
9. Confirm Robinhood ranges, staging, watermarks, and aggregation outbox advance.
10. Log in, open `/alerts`, add a manual token, refresh, and confirm persistence.

Deployment, recovery, backup, and rollback cautions live in
`docs/bot-reference.md`.

## Current Weak Spots

Known areas that deserve extra care during changes:

- Full backend horizontal scaling can duplicate worker execution unless runtime roles and worker leases are verified.
- Rate limits are process-local memory counters; multiple web instances need a shared store or deliberately adjusted limits.
- Automated off-host PostgreSQL backup and tested restore still need to be formalized.
- The static frontend deployment currently updates the active directory directly; there is no documented atomic release/symlink rollback yet.
- The permanent VPS2 worker-unit inventory must remain explicit while the Robinhood backfill uses temporary processes and tunnels.
- GMGN discovery intervals near a few seconds can be CPU-heavy on small VPS hosts.
- QuickNode/Jupiter/onchain files and scripts are lab/probe work unless explicitly promoted.
- Test safety depends on keeping `.env.test` pointed at a clearly isolated local test DB.
- Billing, auth, account recovery, and cookie/session behavior are high-impact surfaces and need broader validation than isolated unit tests.
- Browser-local state and account-scoped backend state both exist; reload and cross-device restore paths must be checked after related changes.
- Wallet tracking multichain, 30-day normalized swap retention, and SHYFT/Yellowstone are approved directions, not completed production capabilities.

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
  - current Netcup/WireGuard production topology
  - deeper implementation reference
  - feature contracts
  - worker details
  - persistence details
  - alert behavior
  - endpoint map
  - deployment, backup, recovery, and rollback cautions

Avoid creating another broad "current bot state" document. New long-lived technical details should go into `docs/bot-reference.md`; short operational guidance should go into this README.

Older plan docs in `docs/` are historical or feature-specific unless they are explicitly called out as current runbooks/checklists.

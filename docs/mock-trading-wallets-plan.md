# Mock Trading Wallets Plan

## Goal

Split mock trading state by user-created mock wallets.

Target behavior:

- one user can have multiple mock wallets
- each wallet has independent cash, positions, trades, take-profit orders, and plays
- the same token can be held separately in different wallets
- UI can switch the active mock wallet

Example:

- `Wallet X` has `TOKEN_A`, `TOKEN_B`
- `Wallet Y` has `TOKEN_A`, `TOKEN_C`
- selling `TOKEN_A` in `Wallet X` must not affect `TOKEN_A` in `Wallet Y`

## Current Repo Evidence

The current mock trading schema is user-scoped, not wallet-scoped:

- `mock_trading_accounts` uses `user_id` as the primary key
- `mock_trading_positions` uses `PRIMARY KEY (user_id, token_address)`
- `mock_trading_trades` stores only `user_id` and `token_address`
- `mock_trading_take_profit_orders` stores only `user_id` and `token_address`

The current service mirrors this shape:

- account lookup is by `userId`
- position lookup is by `userId + tokenAddress`
- take-profit matching joins orders to positions by `userId + tokenAddress`
- list/summary/trades are scoped by `userId`

So the requested model conflicts with the current architecture. A wallet dimension must become part of the persistence and service contract.

## Proposed Data Model

Add a first-class wallet table:

```sql
mock_trading_wallets
- id SERIAL PRIMARY KEY
- user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
- name VARCHAR(80) NOT NULL
- sort_order INTEGER NOT NULL DEFAULT 0
- is_default BOOLEAN NOT NULL DEFAULT false
- archived_at TIMESTAMPTZ
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Constraints/indexes:

- `UNIQUE (user_id, name)` for active names, or enforce in service if partial unique is preferred
- at most one default wallet per user
- index `(user_id, sort_order, id)`

Add `wallet_id` to existing mock trading tables:

```sql
mock_trading_accounts.wallet_id
mock_trading_positions.wallet_id
mock_trading_trades.wallet_id
mock_trading_take_profit_orders.wallet_id
```

New keys:

- `mock_trading_accounts`: unique account per wallet
- `mock_trading_positions`: `PRIMARY KEY (wallet_id, token_address)`
- `mock_trading_trades`: indexes by `(wallet_id, executed_at DESC, id DESC)` and `(wallet_id, token_address, executed_at DESC, id DESC)`
- `mock_trading_take_profit_orders`: open order indexes by `wallet_id + token_address`

Keep `user_id` on child tables too.

Reason:

- makes user authorization cheap and explicit
- keeps old query patterns easier during migration
- avoids needing a join just to enforce user ownership in every route

## Migration Strategy

Create a default wallet for every user that already has mock trading state.

Suggested default wallet name:

- `Main`

Migration steps:

1. Create `mock_trading_wallets`.
2. Insert one default wallet per user found in any existing mock trading table.
3. Add nullable `wallet_id` columns to current mock trading tables.
4. Backfill each row to the user's default wallet.
5. Add indexes and constraints.
6. Make `wallet_id` non-null after backfill.
7. Update runtime schema checker.

Do not drop `user_id` from child tables in the first pass.

Block 1 implementation note:

- the first migration is additive and compatibility-safe
- it creates/backfills `wallet_id`, but keeps the current `user_id` primary keys until the backend becomes wallet-aware
- database triggers fill `wallet_id` with the user's default wallet for legacy insert paths during the transition

## Backend Contract

Add wallet endpoints under existing admin mock trading route:

- `GET /api/admin/mock-trading/wallets`
- `POST /api/admin/mock-trading/wallets`
- `PATCH /api/admin/mock-trading/wallets/:walletId`
- `POST /api/admin/mock-trading/wallets/:walletId/archive`
- `POST /api/admin/mock-trading/wallets/:walletId/default`

Update existing endpoints to accept wallet scope:

- `GET /summary?walletId=...`
- `GET /positions?walletId=...`
- `GET /trades?walletId=...`
- `POST /buy` with `walletId`
- `POST /sell` with `walletId`
- `POST /take-profit-orders` with `walletId`
- `POST /take-profit-orders/:id/cancel`
- `POST /add-cash` with `walletId`
- `POST /reset` with `walletId`

Compatibility rule:

- if `walletId` is absent, resolve the user's default wallet
- this keeps old frontend/tests easier during rollout

Authorization rule:

- every wallet operation must verify `wallet.user_id === req.user.id`
- order cancel must verify order belongs to a wallet owned by the user

## Service Changes

Add helpers:

- `normalizeWalletId`
- `ensureDefaultWallet(userId, runner)`
- `resolveWalletScope(userId, walletId, runner)`
- `listWallets(userId)`
- `createWallet(userId, payload)`
- `updateWallet(userId, walletId, payload)`
- `archiveWallet(userId, walletId)`
- `setDefaultWallet(userId, walletId)`

Refactor existing mock trading service:

- `ensureAccount(userId, walletId, runner, options)`
- `loadPositionForUpdate(userId, walletId, address, runner)`
- `savePosition(userId, walletId, address, position, runner)`
- `insertTrade(userId, walletId, address, trade, runner)`
- `listPositions(userId, walletId, runner)`
- `listTrades({ userId, walletId, address, limit }, runner)`
- `getSummary(userId, walletId, runner)`

Take-profit worker must become wallet-aware:

- candidate query joins on `wallet_id + token_address`
- execution loads account/position by `wallet_id`
- triggered trade stores `wallet_id`

## Frontend Contract

Add state:

```ts
mockTradingWallets: MockTradingWalletEntry[];
activeMockTradingWalletId: number | null;
```

Add API functions:

- `fetchMockTradingWallets`
- `createMockTradingWallet`
- `updateMockTradingWallet`
- `archiveMockTradingWallet`
- `setDefaultMockTradingWallet`

Update existing API calls to pass `walletId`:

- summary
- positions
- trades
- buy
- sell
- add cash
- reset
- take-profit create/cancel when relevant

UI changes:

- wallet selector in the mock trading header
- create wallet action
- rename/archive wallet controls
- active wallet label near cash
- optional aggregated total later

V1 UI should show only the active wallet's:

- cash
- equity
- open positions
- plays
- trade markers

Aggregated all-wallet view should be deferred unless explicitly needed.

## Chart Markers And Plays

Current markers are account/user-specific. With wallets:

- compact and expanded sparklines should show markers for the active wallet only
- Plays modal should show trades for the active wallet only
- optional future mode: show all wallets with marker colors per wallet

V1 should not mix markers from multiple wallets because that can mislead sell/buy history.

## Implementation Blocks

### Block 1: Schema and migration

Status:

- implemented

Scope:

- create `mock_trading_wallets`
- add/backfill `wallet_id`
- update stage 35 init
- update runtime schema
- add migration/backfill tests if existing test structure supports it

Implemented behavior:

- creates `mock_trading_wallets`
- creates/backfills default `Main` wallet for users with existing mock trading rows
- adds `wallet_id` to mock trading accounts, positions, trades, and take-profit orders
- adds foreign keys and wallet-scoped indexes
- initially kept old primary keys intact for backend compatibility
- adds transition triggers so legacy inserts receive the default `wallet_id`

Implemented files:

- `src/utils/db-init-stage35.js`
- `src/utils/runtime-schema.js`

Expected size:

- medium

Validation:

- `npm run lint`
- `npm run db:schema-check`
- affected `node --test` schema/mock trading tests

### Block 2: Backend wallet service

Status:

- implemented

Scope:

- wallet CRUD helpers
- default wallet resolution
- update account/position/trade/order queries to include wallet scope
- preserve fallback to default wallet when `walletId` is omitted

Implemented behavior:

- mock trading service now exposes wallet CRUD helpers
- existing service operations accept optional `walletId`
- missing `walletId` resolves to the user's default wallet for compatibility
- accounts are keyed by `wallet_id`
- positions are keyed by `wallet_id + token_address`
- stage 35 now migrates account/position primary keys to wallet scope
- trades and take-profit orders store and filter by `wallet_id`
- take-profit candidate matching joins orders to positions by `wallet_id + token_address`
- added service-level integration coverage for holding the same token in two wallets

Expected size:

- medium to large

Split note:

- if this grows too much, split into:
  - Block 2A: read/list/default wallet resolution
  - Block 2B: buy/sell/add/reset wallet scoping
  - Block 2C: take-profit wallet scoping

Validation:

- `npm run lint`
- `node --test tests/mock-trading-service.test.js`
- `node --test tests/mock-trading-routes.test.js`
- `npm run db:schema-check`

### Block 3: Backend routes and tests

Status:

- implemented

Scope:

- add wallet endpoints
- update existing routes to pass `walletId`
- route tests for:
  - default wallet fallback
  - creating wallet
  - same token in two wallets
  - sell in one wallet does not touch the other
  - take-profit order only affects its wallet

Implemented behavior:

- added admin wallet routes for list, create, rename, set default, and archive
- existing summary, positions, trades, buy, sell, take-profit, add-cash, and reset routes accept `walletId`
- existing routes still fall back to the default wallet when `walletId` is omitted
- take-profit cancel can be scoped by `walletId` and rejects a wallet mismatch
- archiving a wallet cancels its open take-profit orders
- take-profit worker candidates ignore archived wallets
- route coverage verifies wallet route lifecycle and same-token isolation through HTTP

Expected size:

- medium

Validation:

- `npm run lint`
- `node --test tests/mock-trading-routes.test.js`

### Block 4: Frontend API and state

Status:

- implemented

Scope:

- add wallet API client functions
- add wallet state
- hydrate wallets with mock trading state
- pass active `walletId` into existing mock trading calls

Implemented behavior:

- frontend API client now normalizes wallet/account/position/trade/order `walletId`
- added wallet API calls for list, create, rename, archive, and set default
- app state now stores `mockTradingWallets` and `activeMockTradingWalletId`
- mock trading refresh loads wallets first, resolves active/default wallet, then loads summary/positions/trades for that wallet
- buy, sell, take-profit, cancel, add cash, and reset pass the active `walletId`
- controller exposes wallet actions for the next UI block

Expected size:

- medium

Validation:

- `npm run lint`
- `npm --prefix frontend run build`

### Block 5: Frontend wallet UI

Status:

- implemented

Scope:

- wallet selector in mock trading header
- create/rename/archive wallet controls
- active wallet-specific cash/positions/trades/markers
- default wallet fallback in UI

Implemented behavior:

- added active wallet selector in the mock trading header
- added header controls to create, rename, set default, and archive mock wallets
- active wallet changes clear wallet-specific overlays and refresh wallet-scoped positions/trades/summary
- ticket, plays, and PnL modals show the active wallet name
- header and overlay render keys include wallet state so wallet switches re-render correctly

Expected size:

- medium

Validation:

- `npm run lint`
- `npm --prefix frontend run build`

### Block 6: Docs and QA

Status:

- implemented

Scope:

- update `docs/current-bot-state.md`
- update `docs/bot-complete-reference.md`
- add manual QA checklist

Implemented behavior:

- updated the current-state doc with wallet-scoped mock trading behavior
- updated the complete reference with wallet endpoints, schema ownership, frontend behavior, and active-wallet marker behavior
- added a more explicit manual QA checklist for migration, backend behavior, UI behavior, and take-profit isolation

Validation:

- review `git diff`

## Manual QA Checklist

### Migration and Default Wallet

1. Run the stage 35 init against a database with existing mock trading rows.
2. Confirm each user with old mock trading state gets one active default `Main` wallet.
3. Confirm old accounts, positions, trades, and take-profit orders have `wallet_id`.
4. Confirm old positions/trades/orders appear under `Main` in the UI.
5. Confirm summary/positions/trades still work when `walletId` is omitted.

### Backend Wallet Behavior

1. Create `Wallet X` and `Wallet Y`.
2. Rename `Wallet Y`.
3. Set `Wallet Y` as default.
4. Confirm `GET /summary` without `walletId` now resolves to `Wallet Y`.
5. Confirm invalid/foreign/archived `walletId` returns a wallet-not-found error.
6. Confirm cancelling a take-profit order with the wrong `walletId` returns not found.

### Trading Isolation

1. Add cash to `Wallet X` and `Wallet Y` independently.
2. Buy the same token in both wallets.
3. Confirm each wallet has separate cash, quantity, cost basis, realized PnL, and unrealized PnL.
4. Sell from `Wallet X`.
5. Confirm `Wallet Y` position and trades are unchanged.
6. Reset `Wallet X`.
7. Confirm `Wallet Y` positions, trades, cash, and open orders are unchanged.

### Take-Profit Isolation

1. Create a take-profit order in `Wallet Y`.
2. Create or keep a separate position in `Wallet X` for the same token.
3. Move token MCAP to the target and run the take-profit worker.
4. Confirm only `Wallet Y` sells.
5. Confirm the triggered trade stores `walletId = Wallet Y`.
6. Archive a non-default wallet with an open take-profit order.
7. Confirm that wallet's open orders are cancelled and no archived-wallet order later triggers.

### Frontend Wallet UI

1. Confirm the mock trading header shows the active wallet selector.
2. Confirm create wallet adds a new wallet and switches to it.
3. Confirm rename updates the selector label.
4. Confirm set-default marks the selected wallet with `*`.
5. Confirm archive removes a non-default wallet from the selector.
6. Confirm archive is disabled for the default wallet and when only one wallet is available.
7. Confirm switching wallets closes active mock trading overlays.
8. Confirm buy/sell ticket, Plays modal, and PnL modal show the active wallet name.
9. Confirm the header cash, open positions, Plays rows, and chart markers change with the active wallet.
10. Confirm compact and expanded sparklines show active-wallet markers only.

## Pontos importantes

- Current schema cannot represent multiple wallets because positions are keyed by `user_id + token_address`.
- This change touches schema, backend service, routes, frontend state, UI, tests, and docs.
- Take-profit orders must include `wallet_id`; otherwise an order can sell the wrong wallet's position.
- Trade markers should be active-wallet scoped in V1 to avoid misleading chart history.
- Existing data needs a default `Main` wallet migration.
- Keeping `user_id` on child tables makes authorization and migration safer.
- Default wallet fallback should exist during rollout, but new frontend calls should always send `walletId`.
- This is a bigger feature than browser notifications V1 and should be split into blocks before implementation.

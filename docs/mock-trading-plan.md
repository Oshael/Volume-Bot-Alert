# Mock Trading Plan

## Purpose
This document defines the proposed architecture for an admin-only mock trading module.

The goal is to simulate trades with fake USD balance, token positions, realized/unrealized PnL, and simple buy/sell markers on the existing mini charts.

This is a planning document only. It is grounded in the current repository behavior and should be reviewed before implementation starts.

## Core Trading Semantics

The module should execute trades with `priceUsd`, but display the trade in the market-cap language used during token review.

Reason:
- a real trade buys token quantity at a unit price
- `priceUsd` is the unit price
- market cap is derived from price and supply
- if supply is stable, a move from `100k` MCAP to `200k` MCAP corresponds to approximately a `2x` move in `priceUsd`

V1 should therefore:
- calculate quantity, cash, realized PnL, and unrealized PnL from `priceUsd`
- calculate the trade return percentage from `priceUsd`
- also persist the market cap observed at execution time
- show entry/exit/current MCAP in the UI so the fake trade matches the way the admin actually evaluates the chart
- show `% in trade` together with profit/loss so the admin can read both money and return

Example:
```text
entryMcap = 100000
entryPriceUsd = 0.0001
buyNotionalUsd = 100
quantity = 100 / 0.0001 = 1000000 tokens

exitMcap = 200000
exitPriceUsd = 0.0002
sellValueUsd = 1000000 * 0.0002 = 200
realizedPnlUsd = 100
multiple = 2x
returnPct = +100%
```

Important:
- `priceUsd` is not market cap.
- `mcap = priceUsd * supply`.
- The money ledger should use `priceUsd`.
- The trade return percentage should use `priceUsd`.
- The operational display should show MCAP entry/exit multiples.

### Return percentage semantics
The main percentage shown beside profit should answer:

```text
How many percent is this position up or down from entry?
```

For an open position:
```text
priceReturnPct = ((currentPriceUsd - avgEntryPriceUsd) / avgEntryPriceUsd) * 100
```

For a closed or partial sell:
```text
realizedReturnPct = (realizedPnlUsd / costBasisSoldUsd) * 100
```

Equivalent when there are no fees/slippage:
```text
priceReturnPct = ((exitPriceUsd / avgEntryPriceUsd) - 1) * 100
```

Display examples:
```text
Profit +$100.00 (+100.0%)
Profit -$25.00 (-25.0%)
```

This percentage should be shown next to:
- open position unrealized PnL
- realized PnL on sell trades
- portfolio totals when useful

## Current Code Reality

### What already exists
- Auth is backend-owned and cookie-backed.
- Admin authorization already exists through `requireAdmin`.
- Existing admin routes are mounted under `/api/admin`.
- Token market state is already persisted in `token_catalog`.
- Latest token price is already available as `token_catalog.last_price`.
- Existing mini charts are driven by `POST /api/catalog/sparklines`.
- The chart series comes from `token_market_buckets_1m.close_mcap`.
- Frontend chart state is stored separately from token state in `sparklineByAddress`.

Relevant files:
- `src/middleware/auth.js`
- `src/routes/admin.js`
- `src/routes/catalog.js`
- `src/models/token-catalog.js`
- `src/models/token-market-bucket-1m.js`
- `frontend/src/state/app-state.ts`
- `frontend/src/ui/sections/shared.ts`
- `frontend/src/services/api/catalog.ts`

### Important constraints
- Frontend-only admin gating is not enough.
- Every mock trading write must be protected by backend `requireAdmin`.
- Trade execution should not call Dex directly from the user click path.
- Trade execution should use the latest backend-known `priceUsd`.
- If backend-known price is missing, zero, invalid, or stale, the trade should be rejected.
- Mock trading must not alter alert delivery, manual-token ownership, blocklist behavior, catalog eligibility, or worker scheduling.

## Product Scope

### V1 goals
- Admin can see fake portfolio summary:
  - starting cash
  - current cash
  - open position value
  - realized PnL
  - unrealized PnL
  - total equity
- Admin can buy a token using fake USD notional.
- Admin can sell a token by quantity or percent of the open position.
- Admin can reset the fake portfolio.
- Admin can see current open position and PnL on relevant token rows/cards.
- Existing mini charts can show simple buy/sell markers.

### V1 non-goals
- No real trade execution.
- No wallet integration.
- No slippage simulation in the first pass.
- No fees in the first pass unless explicitly added later.
- No short selling.
- No leverage.
- No stop loss / take profit automation.
- No copy-trading behavior.
- No multi-user sharing unless deliberately selected.
- No changes to catalog worker behavior.
- No changes to alert rule behavior.

## Ownership Decision

### Recommended V1 ownership
Use one mock trading portfolio per admin user.

Reason:
- The current app already scopes account data by authenticated user in many places.
- It avoids accidental coupling between multiple admins.
- It keeps reset behavior safer.
- It lets future admins test independently.

### Alternative
Use one global bot-level portfolio.

Tradeoff:
- Simpler mental model if there is only ever one admin.
- Riskier if more than one admin exists because every admin would mutate the same fake balance and trade history.

Recommendation:
- Start with `user_id` scoped state.
- Add a global portfolio mode later only if there is a clear product need.

## Data Model

### `mock_trading_accounts`
One row per admin user.

Suggested columns:
- `user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE`
- `starting_cash_usd NUMERIC(20, 6) NOT NULL`
- `cash_usd NUMERIC(20, 6) NOT NULL`
- `realized_pnl_usd NUMERIC(20, 6) NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Notes:
- `starting_cash_usd` should be immutable during normal trading.
- Reset can replace `starting_cash_usd`, `cash_usd`, and zero PnL.

### `mock_trading_positions`
One open-position row per admin user and token.

Suggested columns:
- `user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `token_address VARCHAR(64) NOT NULL`
- `quantity NUMERIC(36, 18) NOT NULL`
- `avg_entry_price_usd NUMERIC(20, 12) NOT NULL`
- `cost_basis_usd NUMERIC(20, 6) NOT NULL`
- `realized_pnl_usd NUMERIC(20, 6) NOT NULL DEFAULT 0`
- `opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (user_id, token_address)`

Recommended indexes:
- `(user_id, updated_at DESC)`
- `(token_address, updated_at DESC)`

Notes:
- `quantity` stores token units.
- `avg_entry_price_usd` is weighted average entry.
- `cost_basis_usd` should track remaining cost basis for the open position.
- Closed positions can either be deleted or retained with quantity zero. V1 should delete closed position rows and keep permanent history in trades.

### `mock_trading_trades`
Permanent trade ledger.

Suggested columns:
- `id SERIAL PRIMARY KEY`
- `user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `token_address VARCHAR(64) NOT NULL`
- `side VARCHAR(8) NOT NULL`
- `quantity NUMERIC(36, 18) NOT NULL`
- `price_usd NUMERIC(20, 12) NOT NULL`
- `market_cap_usd NUMERIC(20, 2)`
- `notional_usd NUMERIC(20, 6) NOT NULL`
- `realized_pnl_usd NUMERIC(20, 6) NOT NULL DEFAULT 0`
- `realized_pnl_pct NUMERIC(20, 8)`
- `price_return_pct NUMERIC(20, 8)`
- `price_multiple NUMERIC(20, 8)`
- `mcap_multiple NUMERIC(20, 8)`
- `source VARCHAR(32) NOT NULL DEFAULT 'token_catalog'`
- `executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`

Recommended constraints:
- `side IN ('buy', 'sell')`
- `quantity > 0`
- `price_usd > 0`
- `notional_usd > 0`

Recommended indexes:
- `(user_id, executed_at DESC, id DESC)`
- `(user_id, token_address, executed_at DESC, id DESC)`
- `(token_address, executed_at DESC)`

## Price Source

### Recommended execution price
Use:
- `token_catalog.last_price` as `priceUsd`

Also read:
- `token_catalog.last_seen_at`
- `token_catalog.last_evaluated_at`
- `token_catalog.symbol`
- `token_catalog.name`
- `token_catalog.last_mcap`
- `token_catalog.last_pair_address`

The execution price should be `last_price`.

The execution market cap snapshot should be `last_mcap`.

If `last_mcap` is missing but `last_price` is valid:
- allow the trade
- persist `market_cap_usd = null`
- keep PnL calculations valid from `priceUsd`
- show MCAP display as unavailable for that execution

### Price validation
Reject trade execution when:
- token address is malformed
- token is absent from `token_catalog`
- `last_price` is null
- `last_price <= 0`
- `last_price` is not finite
- catalog row is stale beyond the configured max age

Suggested V1 staleness:
- default max age: `5 minutes`
- config key can be added later if needed

Important:
- Do not fetch Dex during buy/sell.
- If price is stale, the admin can wait for normal worker refresh or manually track the token if it is not in catalog yet.

## Trading Math

### Buy
Input:
- `address`
- `notionalUsd`

Validation:
- `notionalUsd > 0`
- `notionalUsd <= cash_usd`
- valid fresh `priceUsd`

Calculation:
```text
quantityBought = notionalUsd / priceUsd
newQuantity = oldQuantity + quantityBought
newCostBasis = oldCostBasis + notionalUsd
newAvgEntryPrice = newCostBasis / newQuantity
newCash = oldCash - notionalUsd
```

Ledger:
- insert `mock_trading_trades` row with side `buy`
- `realized_pnl_usd = 0`
- persist `market_cap_usd` from `token_catalog.last_mcap` when available
- leave trade multiples null for the first buy unless the position already has an average entry reference

### Sell
Input options:
- `address`
- `quantity`

or:
- `address`
- `percent`

Validation:
- open position exists
- sell quantity is greater than zero
- sell quantity is less than or equal to open quantity
- valid fresh `priceUsd`

Calculation:
```text
notionalUsd = quantitySold * priceUsd
costBasisSold = oldCostBasis * (quantitySold / oldQuantity)
realizedPnl = notionalUsd - costBasisSold
remainingQuantity = oldQuantity - quantitySold
remainingCostBasis = oldCostBasis - costBasisSold
newCash = oldCash + notionalUsd
```

If remaining quantity is effectively zero:
- delete position row

Otherwise:
```text
avgEntryPrice = remainingCostBasis / remainingQuantity
```

Ledger:
- insert `mock_trading_trades` row with side `sell`
- store `realized_pnl_usd`
- store `realized_pnl_pct = realizedPnlUsd / costBasisSold * 100`
- store `price_return_pct = ((sellPriceUsd / avgEntryPriceUsd) - 1) * 100`
- persist `market_cap_usd` from `token_catalog.last_mcap` when available
- persist `price_multiple = sellPriceUsd / avgEntryPriceUsd`
- persist `mcap_multiple = sellMcapUsd / avgEntryMcapUsd` when both values are available

### Market-cap display fields
The open position response should include:
- `avgEntryPriceUsd`
- `avgEntryMcapUsd`
- `currentPriceUsd`
- `currentMcapUsd`
- `priceMultiple`
- `mcapMultiple`
- `priceReturnPct`
- `unrealizedPnlUsd`
- `unrealizedPnlPct`

For open positions:
```text
priceMultiple = currentPriceUsd / avgEntryPriceUsd
mcapMultiple = currentMcapUsd / avgEntryMcapUsd
priceReturnPct = (priceMultiple - 1) * 100
```

Use `mcapMultiple` for the UI label when available because it matches the admin workflow:
```text
100k -> 200k = 2.0x
```

Use `priceMultiple` as the reliable fallback when market cap is unavailable.

Use `priceReturnPct` beside the PnL value:
```text
PnL +$84.20 (+42.1%)
PnL -$18.50 (-9.3%)
```

### Unrealized PnL
For each open position:
```text
currentValueUsd = quantity * currentPriceUsd
unrealizedPnlUsd = currentValueUsd - costBasisUsd
unrealizedPnlPct = costBasisUsd > 0 ? unrealizedPnlUsd / costBasisUsd * 100 : null
priceReturnPct = avgEntryPriceUsd > 0 ? ((currentPriceUsd / avgEntryPriceUsd) - 1) * 100 : null
```

In V1, `unrealizedPnlPct` and `priceReturnPct` should normally be the same because there are no fees/slippage.

Keep both names conceptually separate:
- `unrealizedPnlPct` belongs to the money/profit view
- `priceReturnPct` belongs to the token price movement view

Portfolio:
```text
openPositionValueUsd = sum(currentValueUsd)
totalEquityUsd = cashUsd + openPositionValueUsd
totalPnlUsd = totalEquityUsd - startingCashUsd
totalPnlPct = startingCashUsd > 0 ? totalPnlUsd / startingCashUsd * 100 : null
```

## Backend Architecture

### Files
Suggested new files:
- `src/models/mock-trading-account.js`
- `src/models/mock-trading-position.js`
- `src/models/mock-trading-trade.js`
- `src/services/mock-trading-service.js`
- `src/routes/mock-trading.js`
- `src/utils/db-init-stage35.js`

Suggested edits:
- `src/server.js`
  - mount `/api/admin/mock-trading`
- `src/utils/runtime-schema.js`
  - add stage 35 schema guard
- `package.json`
  - no new script required unless we want a dedicated init command alias

### Route mounting
Recommended:
- mount as `/api/admin/mock-trading`
- route file should use:
  - `authenticate`
  - `requireAdmin`
  - `requireTrustedOrigin`

Reason:
- Keeps the admin-only API surface explicit.
- Reuses the existing admin access model.
- Keeps mock trading out of general catalog/dashboard route ownership.

### Endpoints

#### `GET /api/admin/mock-trading/summary`
Returns:
- account cash and starting balance
- aggregate portfolio metrics
- open position count
- latest generated timestamp

#### `GET /api/admin/mock-trading/positions`
Returns:
- open positions with current catalog price
- token symbol/name where available
- current value
- realized PnL per token
- unrealized PnL per token
- return percentage from entry, positive or negative
- MCAP multiple when available

#### `GET /api/admin/mock-trading/trades`
Query params:
- optional `address`
- optional `limit`

Returns:
- recent ledger rows
- enough fields for table and chart markers

#### `GET /api/admin/mock-trading/markers`
Query params:
- `addresses`
- optional `hours`

Returns:
- trade markers grouped by token address
- only trades inside the visible chart window

Suggested marker item:
```json
{
  "address": "tokenAddress",
  "markers": [
    {
      "id": 123,
      "side": "buy",
      "executedAt": "2026-04-30T12:00:00.000Z",
      "priceUsd": 0.00123,
      "notionalUsd": 100,
      "quantity": 81300.813,
      "realizedPnlUsd": 0,
      "realizedPnlPct": null,
      "priceReturnPct": null,
      "mcapMultiple": null
    }
  ]
}
```

#### `POST /api/admin/mock-trading/buy`
Body:
```json
{
  "address": "tokenAddress",
  "notionalUsd": 100
}
```

#### `POST /api/admin/mock-trading/sell`
Body option 1:
```json
{
  "address": "tokenAddress",
  "quantity": 1000
}
```

Body option 2:
```json
{
  "address": "tokenAddress",
  "percent": 50
}
```

#### `POST /api/admin/mock-trading/reset`
Body:
```json
{
  "startingCashUsd": 1000
}
```

Behavior:
- transactionally delete this admin user's positions and trades
- recreate/update account balance
- reset realized PnL to zero

## Transaction Boundaries

Every buy/sell/reset should run in a DB transaction.

Buy transaction:
1. lock account row
2. read and validate fresh catalog price
3. lock existing position row if present
4. update cash and position
5. insert trade ledger row
6. commit

Sell transaction:
1. lock account row
2. lock position row
3. read and validate fresh catalog price
4. update cash and realized PnL
5. update/delete position
6. insert trade ledger row
7. commit

Reset transaction:
1. lock account row or create it
2. delete trades for user
3. delete positions for user
4. reset account values
5. commit

Reason:
- avoids inconsistent cash/position/trade state if a request fails midway
- avoids double-click race conditions on buy/sell buttons

## Frontend Architecture

### State additions
Suggested state:
- `mockTradingSummary`
- `mockTradingPositionsByAddress`
- `mockTradingTradesByAddress`
- `mockTradingMarkersByAddress`
- `mockTradingLoading`
- `mockTradingError`

These should stay separate from:
- `trackedTokensByAddress`
- `sparklineByAddress`
- alert card state

Reason:
- Positions and trades are not canonical token metadata.
- Keeping them separate avoids causing broad token rerenders when only trading state changes.

### API client
Suggested new file:
- `frontend/src/services/api/mock-trading.ts`

Functions:
- `fetchMockTradingSummary`
- `fetchMockTradingPositions`
- `fetchMockTradingTrades`
- `fetchMockTradingMarkers`
- `buyMockTradingToken`
- `sellMockTradingToken`
- `resetMockTradingPortfolio`

### UI surfaces

V1 admin-only UI can be minimal:
- compact portfolio summary in workspace header or admin-only panel
- buy/sell actions on token rows/cards where admin actions already appear
- position badge near token identity or chart column showing PnL and return percentage
- reset action behind a confirmation modal

Suggested first target surfaces:
- `Manual Tokens`
- `Recent Tokens`
- `Old Tokens 1 Week+`
- `Monitored Tokens`

Reason:
- These surfaces already expose token actions.
- Admin-only block actions already exist there, so the UI pattern is familiar.

### Buy/sell controls
V1 should avoid large modals everywhere.

Suggested interaction:
- Buy button opens a compact admin trade popover:
  - USD amount input
  - current execution price
  - current MCAP when available
  - estimated quantity
  - submit button
- Sell button appears only when there is an open position:
  - `25%`
  - `50%`
  - `100%`
  - optional quantity input can come later

Reason:
- Faster operational flow.
- Keeps the initial UI small.
- Avoids a large trading terminal inside existing monitoring tables.

### Position display
Open position display should include:
- invested amount / cost basis
- current value
- unrealized PnL in USD
- return percentage from `priceUsd`
- entry MCAP
- current MCAP
- MCAP multiple when available

Suggested compact label:
```text
PnL +$42.18 (+21.4%) · MCAP 140k -> 170k
```

Negative example:
```text
PnL -$12.50 (-8.7%) · MCAP 140k -> 128k
```

Use color only as reinforcement:
- green for positive
- red for negative
- neutral for zero / unavailable

Do not rely only on color; keep `+` / `-` signs in the text.

## Chart Markers

### Current chart limitation
The current sparkline payload contains:
- `series`
- `latestBucketAt`
- `effectiveHours`
- `granularityMinutes`

It does not include one timestamp per rendered point.

### V1 marker placement
For V1, place markers approximately by time using:
```text
startTs = latestBucketAt - effectiveHours
x = (executedAt - startTs) / effectiveHours
```

Clamp:
- markers before the chart window are hidden
- markers after the latest bucket are hidden
- markers inside the window are clamped to the chart bounds

Marker Y position options:
1. use the closest rendered series point
2. or render marker along the bottom rail

Recommendation:
- Use closest rendered series point for expanded charts.
- Use bottom rail for compact table charts if visual overlap becomes noisy.

### Marker visual language
- Buy marker:
  - green triangle or dot
  - tooltip: `BUY`, price, notional, time
- Sell marker:
  - red/orange triangle or dot
  - tooltip: `SELL`, price, notional, realized PnL, time

### Contract shape
Keep chart series and trading markers separate.

Do not mutate `TokenSparklineEntry.series` to carry marker state.

Reason:
- Existing sparkline rendering and caching are already stable.
- Markers are account/admin-specific, while the sparkline series is global market history.

## Validation Plan

### Backend tests
Add focused tests for:
- account creation/default balance
- buy with valid fresh price
- buy rejected when cash is insufficient
- buy rejected when price is missing
- buy rejected when price is stale
- weighted average entry after multiple buys
- partial sell PnL
- full sell closes position
- sell rejected with no position
- sell rejected above held quantity
- reset clears only the authenticated admin user's mock trading state
- non-admin cannot access any route

Likely test files:
- `tests/mock-trading-service.test.js`
- `tests/mock-trading-routes.test.js`

### Frontend validation
After frontend changes:
- `npm --prefix frontend run build`

Also run:
- `npm run lint`

### Schema validation
Because this feature adds schema:
- `npm run db:schema-check`

For test profile:
- `npm run db:schema-check:test`

### Affected node tests
At minimum:
- `node --test tests/mock-trading-service.test.js`
- `node --test tests/mock-trading-routes.test.js`

If route mounting touches admin route behavior:
- `node --test tests/admin.test.js`

## Implementation Blocks

Current implementation status:
- Block 1 is implemented:
  - stage 35 schema
  - runtime schema guard
  - backend calculation helpers
  - calculation tests
- Block 2 is implemented:
  - admin-only backend routes under `/api/admin/mock-trading`
  - transactional buy/sell/reset persistence
  - summary, positions, and trades reads
  - admin/non-admin route tests
- Block 3 is implemented:
  - frontend API client
  - frontend state for summary and open positions
  - admin-only buy/sell actions on monitored/manual/recent/old-week token surfaces
  - visible PnL and return percentage for open positions
  - compact admin portfolio summary in the workspace header
  - buy/sell ticket modal with presets and custom amount/percent
  - reset UI for the authenticated admin portfolio
- Block 4 is implemented:
  - loads the authenticated admin's recent mock trades
  - groups trades by token address in frontend state
  - renders buy/sell markers on compact manual/recent/old-week sparklines
  - renders the same markers on the expanded sparkline modal
  - marker placement is time-based within the sparkline window and uses trade MCAP when available
  - adds a `Plays` modal for recent closed sell executions, realized PnL, profitable/unprofitable counts, and win rate
  - renders the mock header cash pill with exact USD formatting so realized gains are not hidden by compact `$10K` rounding

### Block 1: schema and backend calculation core
Estimated size:
- small to medium

Scope:
- add db-init stage
- add runtime schema guard
- add model/service files
- add calculation tests

Do not include frontend changes in this block.

### Block 2: admin routes
Estimated size:
- small to medium

Scope:
- mount `/api/admin/mock-trading`
- add route validation
- add route tests for admin/non-admin behavior

Do not include chart markers in this block.

### Block 3: frontend portfolio state and controls
Estimated size:
- medium

Scope:
- add API client
- add app state
- load summary/positions for admin
- add buy/sell/reset UI
- build frontend

Do not include chart markers in this block unless the diff stays small.

### Block 4: chart markers
Estimated size:
- medium

Scope:
- fetch marker data for charted visible addresses
- render buy/sell markers in compact and expanded chart surfaces
- add hover tooltip behavior
- build frontend

## Rollout Order

Recommended rollout:
1. backend schema/service with tests
2. admin routes with tests
3. minimal frontend trade controls
4. chart markers
5. update `README.md` if the operational workflow changes
6. update `docs/bot-reference.md` if the technical contract changes

Reason:
- The backend math and access control are the critical safety boundary.
- Frontend can iterate after the ledger is correct.
- Docs should be updated only after implementation behavior is real.

## Pontos importantes

- This module should be admin-only at the backend route level, not only hidden in the UI.
- The first version should use `priceUsd` from `token_catalog.last_price`, not direct Dex calls during trade execution.
- Stale price rejection is important because the catalog worker cadence varies by token priority and market state.
- Markers are account-specific and should not be mixed into global sparkline cache.
- Reset must be scoped to the authenticated admin user if V1 uses per-admin portfolios.
- PnL should be calculated from token quantity and USD execution price, not from market cap.
- The main return percentage should be calculated from `priceUsd`, not from market cap.
- The UI should show both PnL money and return percentage, including negative values.
- Adding schema requires `npm run db:schema-check` before considering the implementation complete.
- Frontend work requires `npm --prefix frontend run build`.
- If this grows beyond the proposed blocks, pause and split the implementation further before continuing.

## Open Questions Before Implementation

1. What should the default fake starting balance be?
   - Implemented: `$1,000`.

2. Should sell V1 support only percent buttons, or also exact quantity?
   - Suggested: percent buttons first, exact quantity later.

3. Should buy V1 support fixed presets?
   - Suggested: `$50`, `$100`, `$250`, custom input.

4. How stale is too stale for execution price?
   - Suggested: `5 minutes`.

5. Should closed positions remain visible in a historical positions view?
   - Suggested: no for V1; trade ledger is enough.

6. Should the fake portfolio be per admin or global?
   - Suggested: per admin.

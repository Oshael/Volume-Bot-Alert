# Mock Trading SOL Price Sync Plan

## Purpose
Plan the change that makes mock trading use a live SOL/USD price from CoinMarketCap instead of the current manually configured mock SOL rate.

This is a planning document only. It is grounded in the current repository state and should be reviewed before implementation.

Reviewed against:
- `docs/current-bot-state.md`
- `docs/bot-complete-reference.md`
- `docs/mock-trading-plan.md`
- `src/services/mock-trading-service.js`
- `src/services/sol-price.js`
- `frontend/src/utils/mock-trading-display.ts`
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/state/app-controller.ts`
- `tests/mock-trading-service.test.js`
- `tests/mock-trading-routes.test.js`

## Current Code Reality

Mock trading already exists. This is not a greenfield feature.

Current behavior:
- backend mock trading routes are mounted at `/api/admin/mock-trading`
- all writes are admin-only and protected by `requireTrustedOrigin`
- buys, sells, and take-profit executions use `token_catalog.last_price` as the traded token execution price
- PnL is calculated from token quantity and `priceUsd`
- market cap is display/trigger context, not the money ledger source
- the UI currently displays the internal USD ledger as mock SOL by dividing values by `mock-sol-usdc-rate`
- `mock-sol-usdc-rate` is a per-admin config stored in `user_configs`
- default `mock-sol-usdc-rate` is `88`
- executed trade rows snapshot `mockSolUsdcRate` into `mock_trading_trades.metadata`
- old trade display uses the saved rate, so historical SOL amounts do not change when the admin changes the config later

Important existing files:
- backend conversion snapshot:
  - `src/services/mock-trading-service.js`
- frontend conversion helpers:
  - `frontend/src/utils/mock-trading-display.ts`
- admin config field:
  - `frontend/src/ui/sections/layout-sections.ts`
  - `src/models/user-config.js`
- current unrelated SOL price service:
  - `src/services/sol-price.js`

## Critical Interpretation

The requested change should update the SOL/USD conversion layer, not the token trade execution price.

Keep:
- token buys/sells executing against `token_catalog.last_price`
- token PnL math in internal USD accounting
- MCAP display/trigger behavior
- per-trade rate snapshots for historical trade display

Change:
- replace the manually maintained `mock-sol-usdc-rate` used for live mock SOL display and SOL-to-USD input conversion with a backend-provided live SOL/USD price from CoinMarketCap

Do not change:
- alert behavior
- catalog worker behavior
- token eligibility/blocklist behavior
- take-profit trigger source, which remains token MCAP from `token_catalog.last_mcap`
- the DB meaning of existing `*_usd` and `notionalUsd` fields

## CoinMarketCap Source

Recommended source:
- CoinMarketCap Pro API
- endpoint family: `GET /v3/cryptocurrency/quotes/latest`
- production lookup should use CoinMarketCap's Solana asset id, not `symbol=SOL`, to avoid ambiguous symbols
- Solana CoinMarketCap id: `5426`
- convert currency: `USD`

Required env:
- `COINMARKETCAP_API_KEY`

Recommended optional env:
- `SOL_PRICE_PROVIDER=coinmarketcap`
- `SOL_PRICE_POLL_INTERVAL_MS=264500`
- `SOL_PRICE_STALE_AFTER_MS=300000`
- `SOL_PRICE_REQUEST_TIMEOUT_MS=10000`

Reasoning:
- CoinMarketCap documents latest quote cache/update frequency around 60 seconds.
- Polling every `264500ms` targets about `9800` requests per 30-day month.
- Backend-side polling avoids exposing the CMC API key to the browser.

## Service Design

Recommended implementation:
- add a dedicated backend service for SOL/USD quote state, for example:
  - `src/services/sol-usd-price-service.js`

Responsibilities:
- poll CoinMarketCap with `X-CMC_PRO_API_KEY`
- cache the latest valid SOL/USD price in memory
- expose status:
  - `priceUsd`
  - `provider`
  - `lastUpdatedAt`
  - `lastFetchAt`
  - `ageSeconds`
  - `stale`
  - `lastError`
  - `nextFetchAt`
- use timeout and abort handling
- use backoff for `429` and temporary upstream errors
- keep serving the last valid price while marked stale if CMC temporarily fails

Do not put the CMC key in frontend code or `user_configs`.

### Reuse vs replacement of `src/services/sol-price.js`

There is already a SOL price service, but it currently:
- is named generically as `sol-price`
- polls CoinGecko
- is used by PumpFun pre-migration capture and socket hub code
- returns only a bare numeric price through `getPrice()`

Safer implementation options:

1. Add a new service dedicated to mock trading display.
   - Lowest blast radius.
   - Avoids changing PumpFun/pre-migration calculations in the same feature.
   - Recommended for first implementation.

2. Refactor the existing service into a provider-configurable SOL/USD service.
   - Cleaner long-term naming.
   - Higher regression risk because it touches non-mock runtime paths.
   - Should be a separate block if selected.

Recommendation:
- implement option 1 first
- after stable rollout, decide whether to migrate PumpFun/socket users to the same service

## Backend API Contract

Add a small admin-readable endpoint under the existing mock trading route:

```text
GET /api/admin/mock-trading/sol-price
```

Response:

```json
{
  "provider": "coinmarketcap",
  "priceUsd": 176.42,
  "lastUpdatedAt": "2026-05-11T12:00:00.000Z",
  "lastFetchAt": "2026-05-11T12:00:05.000Z",
  "ageSeconds": 5,
  "stale": false,
  "lastError": null
}
```

Also include the same quote snapshot in:
- `GET /api/admin/mock-trading/summary`
- buy response
- sell response
- take-profit execution trade metadata

Reason:
- the frontend needs one source of truth for current display conversion
- responses that mutate or summarize the portfolio should be self-describing
- trade metadata already snapshots `mockSolUsdcRate`; the new live value can preserve that same contract name initially or introduce a clearer field

Recommended metadata compatibility:
- keep writing `mockSolUsdcRate` for now, but source it from the current live CMC quote
- add `mockSolUsdcRateSource: "coinmarketcap"`
- add `mockSolUsdcRateUpdatedAt`

This avoids breaking existing frontend and tests that already read `mockSolUsdcRate`.

## Frontend Behavior

Current frontend conversion helpers should continue to convert internal USD ledger values into displayed SOL.

Change the source of the rate:
- current source:
  - `state.data.configs['mock-sol-usdc-rate']`
- new source:
  - backend live quote from mock trading summary or `/sol-price`

Recommended state additions:
- `mockTradingSolPrice`
- `mockTradingSolPriceLoading`
- `mockTradingSolPriceError`

UI changes:
- remove the editable admin config field `Mock SOL rate (USDC)`
- show a read-only SOL/USD status near the mock trading header, for example:
  - `SOL $176.42`
  - `SOL stale`
  - `SOL unavailable`
- keep buy/add-cash inputs in SOL
- send SOL input amounts to the backend and let the backend convert to internal USD using the latest non-stale CoinMarketCap quote
- if no usable quote exists, disable buy/add-cash actions and show a short error

Historical display:
- closed trade rows and chart markers should keep using each trade's saved `mockSolUsdcRate`
- open positions and portfolio cash/equity should use the latest live SOL/USD quote

Important behavioral consequence:
- when SOL/USD changes, the displayed SOL amount for existing internal USD cash and open-position value will change even if token prices do not move
- the internal USD accounting remains stable; only SOL-denominated display changes

## Accounting Semantics

Keep internal account tables unchanged:
- `mock_trading_accounts.cash_usd`
- `mock_trading_accounts.starting_cash_usd`
- `mock_trading_positions.cost_basis_usd`
- `mock_trading_trades.notional_usd`
- `mock_trading_trades.realized_pnl_usd`

Reason:
- the current backend and tests correctly model fake cash and token PnL in USD terms
- renaming or changing schema semantics would be larger and riskier than needed
- SOL is a display/input denomination layered on top of existing USD accounting

Open portfolio display:
```text
displaySol = internalUsd / currentSolUsd
```

Historical trade display:
```text
displaySolAtExecution = tradeInternalUsd / trade.metadata.mockSolUsdcRate
```

Buy/add-cash input:
```text
notionalUsd = inputSol * currentSolUsd
```

Implementation decision:
- SOL-to-USD conversion for new writes should happen in the backend.
- Frontend buy/add-cash requests should send SOL-denominated inputs, for example `amountSol` or `notionalSol`.
- Backend responses can still return `notionalUsd` for compatibility and should include the SOL/USD quote snapshot used for the conversion.

## Startup And Failure Behavior

On startup:
- start polling only when background jobs are enabled, or explicitly when the web role needs the quote endpoint
- first fetch should run immediately
- until a valid quote exists, frontend buy/add-cash actions should be disabled

When CoinMarketCap fails:
- keep the last valid quote in memory
- mark it stale after `SOL_PRICE_STALE_AFTER_MS`
- reject SOL-denominated writes if the quote is stale or unavailable
- continue allowing reads, but clearly mark the displayed rate stale

Fallback:
- do not silently fall back to the old hardcoded `88` for new writes
- old trades without metadata can still use `88` for backward-compatible display only

## Implementation Blocks

### Block 1: Backend quote service
Status:
- implemented

Estimated size:
- small to medium

Scope:
- add CMC-backed SOL/USD service
- add config/env parsing
- add parser/backoff tests
- expose service status

Implemented files:
- `src/services/sol-usd-price-service.js`
- `tests/sol-usd-price-service.test.js`
- `config/index.js`

Validation:
- `npm run lint`
- `node --test tests/sol-usd-price-service.test.js`

### Block 2: Mock trading backend integration
Status:
- implemented

Estimated size:
- small to medium

Scope:
- include live quote in mock trading summary/status
- use live quote when snapshotting `mockSolUsdcRate` on buy/sell/take-profit trades
- add backend SOL-denominated buy/add-cash inputs and convert them to internal USD using the fresh CMC quote
- reject write paths that need SOL conversion when the live quote is unavailable or stale
- update route tests

Implemented behavior:
- `GET /api/admin/mock-trading/sol-price` returns backend SOL/USD quote status
- `GET /api/admin/mock-trading/summary` includes `solUsdPrice`
- buy accepts `notionalSol` and converts it to internal `notionalUsd` in the backend
- add-cash accepts `amountSol` and converts it to internal `amountUsd` in the backend
- buy/sell/take-profit trades snapshot the fresh CMC-backed `mockSolUsdcRate`
- trade metadata includes `mockSolUsdcRateSource` and `mockSolUsdcRateUpdatedAt`
- `GET /api/admin/ws-status` includes `solUsdPrice`

Implemented files:
- `src/services/mock-trading-service.js`
- `src/routes/mock-trading.js`
- `src/server.js`
- `tests/mock-trading-routes.test.js`

Validation:
- `npm run lint`
- `node --test tests/mock-trading-service.test.js`
- `node --test tests/mock-trading-routes.test.js`

### Block 3: Frontend quote consumption
Status:
- implemented

Estimated size:
- medium

Scope:
- store quote status in app state
- use live quote for `resolveMockSolUsdcRate`
- remove `Mock SOL rate (USDC)` from editable config
- send SOL amounts to backend buy/add-cash endpoints instead of pre-converted `notionalUsd` / `amountUsd`
- disable buy/add-cash when no fresh quote exists
- show current/stale/unavailable SOL price status in the mock trading header

Implemented behavior:
- `Mock SOL rate (USDC)` was removed from editable config fields
- mock trading summary carries backend `solUsdPrice`
- mock portfolio display uses the live backend SOL/USD quote when available
- buy/add-cash submit SOL amounts to the backend
- buy/add-cash are blocked in the controller when no fresh SOL/USD quote is available
- header shows `SOL $...`, `SOL stale $...`, or `SOL unavailable`

Implemented files:
- `frontend/src/services/api/mock-trading.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/ui/app-shell.ts`
- `frontend/src/ui/sections/layout-sections.ts`
- `frontend/src/ui/sections/manual-section.ts`
- `frontend/src/ui/sections/monitored-section.ts`
- `frontend/src/ui/sections/routed-sections.ts`
- `frontend/src/utils/mock-trading-display.ts`

Validation:
- `npm run lint`
- `npm --prefix frontend run build`

### Block 4: Docs and rollout polish
Status:
- implemented

Estimated size:
- small

Scope:
- update `docs/current-bot-state.md`
- update `docs/bot-complete-reference.md`
- update or supersede the relevant parts of `docs/mock-trading-plan.md`

Implemented files:
- `docs/current-bot-state.md`
- `docs/bot-complete-reference.md`
- `docs/mock-trading-solana-price-sync-plan.md`

Validation:
- `npm run lint`
- review `git diff` before suggesting commit

## Pontos importantes

- This change should not make token trade execution depend directly on CoinMarketCap. Token execution price remains `token_catalog.last_price`.
- CoinMarketCap should only drive the SOL/USD conversion used for mock SOL display, buy input conversion, add-cash conversion, and per-trade rate snapshots.
- A moving SOL/USD rate means the same internal USD balance can display as a different SOL amount over time.
- Do not expose the CoinMarketCap API key to the frontend.
- Do not silently use the old `88` default for new writes after the live-rate feature is enabled.
- Historical trades should keep their execution-time rate snapshot so old plays do not visually change every time SOL/USD moves.
- If frontend changes are implemented, `npm --prefix frontend run build` is mandatory.
- If config/init/schema is touched, `npm run db:schema-check` is mandatory.
- Keep implementation blocks under roughly 300 changed lines each. If the frontend change grows, split display status and buy/add-cash conversion into separate passes.

## Open Questions Before Implementation

1. Should the editable `Mock SOL rate (USDC)` config disappear completely, or stay as an emergency manual override?
   - Decision: remove the editable field completely.

2. Should buy/add-cash SOL-to-USD conversion remain frontend-side using the backend quote, or move backend-side so the client sends `amountSol` instead of `notionalUsd`?
   - Safer long-term: backend-side conversion.
   - Smaller first change: frontend-side conversion with backend quote.
   - Decision: backend-side conversion; frontend sends `notionalSol` / `amountSol`.

3. Should the existing CoinGecko `src/services/sol-price.js` continue serving PumpFun/socket code for now?
   - Recommended first pass: yes, leave it untouched.

4. Should mock portfolio starting balance remain internally `$1000`, meaning displayed starting SOL floats with SOL/USD, or should reset/add-cash accept a SOL amount and persist the converted USD at reset time?

5. What should happen if CoinMarketCap is unavailable for more than the stale window during active trading?
   - Recommended: disable buy/add-cash and reject any backend path that depends on a fresh SOL conversion.

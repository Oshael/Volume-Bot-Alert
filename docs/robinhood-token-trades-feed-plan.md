# Robinhood — Token Trades Feed (Axiom-style) — Implementation Plan

Status: **proposed / not started**. This document is the architecture-checkpoint
report required by `CLAUDE.md` before editing. No production code has been touched.

## 1. Goal

Add an Axiom-style **per-swap trades feed** to a token's detail view: a live table
where each row is a single swap, with columns:

| Column        | Meaning                                    |
| ------------- | ------------------------------------------ |
| **Amount** ($)| USD size of the swap (buy green / sell red)|
| **MC**        | Market cap (FDV) at that swap              |
| **Trader**    | The wallet (EOA) that signed the swap      |
| **Age**       | Time since the swap                        |

Left-edge volume bars scale with the trade size; buy/sell drive the row color.
The reference screenshot also shows **DEV / TRACKED / YOU** tabs — those are
**Phase 2** (see §6).

## 2. Key finding — the hard part already exists

The per-swap **trader attribution** is already built and materialized. We are not
building a data pipeline; we are building the **consumer** (read model + API +
realtime + UI) on top of existing data.

### 2.1 `robinhood_wallet_swaps` (source of truth for the feed)

Defined in `src/utils/db-init-stage90.js`. One row per **accepted swap**, with the
resolved signing wallet:

- `wallet_address` — `tx.from`, the real trader (better than router/recipient).
  Resolved by `src/services/robinhood-wallet-swap-attributor.js` via the
  block → `tx.from` sender adapter; **every** accepted swap is attributed (rows are
  never written with a null wallet; unresolved ones are retried), so this is the
  **full feed**, not just tracked wallets.
- `transaction_hash`, `action_index`, `block_number`, `block_time`
- `protocol`, `market_key`, `token_address`, `quote_address`, `side`
- `token_amount_raw`, `quote_amount_raw`, `token_amount`, `quote_amount`,
  `price_usd`, `volume_usd`
- `router_address`, `recipient_address`
- Partitioned by `RANGE (block_time)`.

**Indexes already fit the feed** (no new schema for Phase 1):

- `idx_robinhood_wallet_swaps_token_time (chain, token_address, block_time DESC)`
  → "recent trades for token X", paginated by `block_time DESC`.
- `idx_robinhood_wallet_swaps_wallet_time (chain, wallet_address, block_time DESC)`
  → Phase 2 tabs (per-wallet filtering).
- `idx_robinhood_wallet_swaps_chain_time (chain, block_time DESC)`.

### 2.2 Data mapping (feed column → existing field)

| Feed column   | Source                                                        |
| ------------- | ------------------------------------------------------------- |
| Amount        | `robinhood_wallet_swaps.volume_usd`                           |
| Trader        | `robinhood_wallet_swaps.wallet_address`                       |
| side (color)  | `robinhood_wallet_swaps.side`                                 |
| Age           | `now() - robinhood_wallet_swaps.block_time`                   |
| **MC**        | **not in this table** — see §2.3                              |

### 2.3 MC (market cap) source — decision: **LEFT JOIN to observations**

`robinhood_wallet_swaps` has no FDV/MC column. The attributor sets
`actionIndex = observation.log_index`
(`robinhood-wallet-swap-attributor.js:25`), so `action_index` **is** the
observation `log_index`. A wallet-swap row therefore joins 1:1 to
`robinhood_market_observations` on `(chain, transaction_hash, action_index = log_index)`
and can read the already-computed **`fdv_usd`** as MC. That triple is the
observations **primary key** (verified — stage64, and a stage83 FK targets it), so
the join is a cheap point lookup; the earlier "confirm the PK / else recompute"
note is resolved and the recompute fallback is dead code.

- **Chosen:** MC via a **LEFT JOIN** (not INNER). See the retention caveat below —
  an INNER JOIN would silently drop trades whose observation has been pruned.

**Hard limit — MC is only retained ~3 days (this is not cosmetic):**

Observations carry `expires_at` (`OBSERVATION_RETENTION_DAYS = 3`, stage64) and are
**cascade-deleted**: `robinhood-retention-worker` deletes expired
`robinhood_processed_logs` (retention 3 days, stage63) once the accepted
observation has been safely folded into a 1m bucket, and observations have
`FOREIGN KEY … ON DELETE CASCADE` to processed_logs, so the observation row goes
with it. `robinhood_wallet_swaps` is durable (partitioned), so the **trade never
disappears**, but the per-swap FDV lives **only** on the observation (the bucket
tables keep per-minute OHLC FDV, not per-swap FDV). Consequently:

- **Recent trades (< ~3 days): `mcUsd` present** (exact per-swap FDV).
- **Older trades (> ~3 days): `mcUsd` null** — the exact per-swap FDV is gone and is
  unrecoverable at per-swap granularity. This is why the join must be a LEFT JOIN:
  the trade stays visible (trader/amount/side/price/age intact) with MC blank,
  instead of vanishing. This matches how DEX trade tables show **price**, not MC,
  for old trades. Per-swap **price, USD size, token/quote amounts, side, trader**
  are all copied durably into `robinhood_wallet_swaps` at attribution time
  (`attributor.js` `buildRow`), so only MC is affected by retention.
- Restoring MC on old trades (Axiom-style) is **Phase 2 §8**, not Phase 1.

**sqrtPriceX96 repair note:** the repair corrects `observations.price_usd`/`fdv_usd`;
the live feed reads recent (post-repair-range, sqrt-based) trades, so it is
unaffected. But note `wallet_swaps.price_usd` is **crystallized** at attribution
(copied, never re-read) — see the price-provenance risk in §5 and §8.

### 2.4 Realtime template already exists

There is an established `pg_notify` → socket relay for `market:bucket`:

- Backend fan-out: `createRobinhoodMarketBucketFanout` (`src/server.js:688`).
- Frontend typed handler: `frontend/src/services/socket/market-events.ts`
  (`type: 'market:bucket'`).

A new `market:trade` stream follows the **same** path (see Slice C).

### 2.5 Route/UI plug-in points

- Read routes follow `src/routes/*.js` mounted in `server.js`
  (e.g. `app.use('/api/catalog', catalogRoutes)`). There is **no** existing
  Robinhood routes module (`ls src/routes | grep robinhood` is empty), so
  `/api/robinhood/trades` is a **new file** `src/routes/robinhood-trades.js`
  mounted at `/api/robinhood` — the earlier "or fold into existing" is resolved.
- Frontend: api client under `frontend/src/services/api/`, socket handling in
  `market-events.ts`, and a new panel wired into the token detail section
  (`frontend/src/ui/sections/*`).

## 3. Architecture / boundaries

This is an **architecture checkpoint** (~12–15 production files, hub touches in
`server.js` and the frontend app-shell/sections). Rules applied:

- Hubs (`server.js`, app-shell/sections) receive **wiring only**.
- Feed business logic lives in a dedicated **read model** behind a tested interface;
  it is not spread through hub files.
- No new `chain === …` branches in central modules; the feed is Robinhood-scoped and
  reads Robinhood tables directly, mirroring existing Robinhood read models.

### 3.1 Fan-out

**Backend**
- `src/models/robinhood-wallet-swap-read.js` *(new)* — recent-trades read model:
  query `robinhood_wallet_swaps` by `(chain, token_address, block_time DESC)`,
  join `observations.fdv_usd` for MC, keyset pagination on `block_time`.
- `src/routes/robinhood-trades.js` *(new, or fold into existing robinhood routes)* —
  `GET /api/robinhood/trades`.
- `src/server.js` *(hub)* — one `app.use(...)` wiring line.
- Realtime emit in the wallet-swap group + server relay (Slice C).

**Frontend**
- `frontend/src/services/api/…` *(new method)* — fetch recent trades.
- `frontend/src/ui/sections/…trades panel…` *(new component)* — the Axiom-style table.
- `frontend/src/ui/sections/*` *(hub)* — wire the panel into the token detail view.
- `frontend/src/services/socket/market-events.ts` — `market:trade` handler (Slice C).
- Frontend state/store for the trades list (append/prepend, cap length).

**Tests**
- Read-model unit test (query shape, MC join, pagination, buy/sell, empty).
- Route integration test (200 + payload contract; token param validation).
- Socket handler test (Slice C).

## 4. Phase 1 — "all trades" feed (no tabs)

Confirmed scope: the full per-token trades feed with Amount / Trader / MC / Age /
side, live. **No** DEV/TRACKED/YOU tabs. **No new schema.**

### Slice A — backend read model + route + tests
- New read model + `GET /api/robinhood/trades?token=…&cursor=<opaque>&limit=`.
- **Keyset pagination is a composite cursor** `(block_time, block_number,
  action_index)`, not `block_time` alone: `block_time` is per-block, so many swaps
  share it and a bare `block_time` cursor would skip/repeat rows at block
  boundaries. The ORDER BY prefix (`block_time DESC`) still rides the `token_time`
  index; the cursor is opaque (`nextCursor`). MC via the LEFT JOIN (§2.3).
- **Status: production + unit test landed** (`robinhood-wallet-swap-read.js`,
  `robinhood-trades.js`, server wiring, `robinhood-wallet-swap-read.test.js`;
  ~319 lines). The route integration test (auth + visibility gating + DB fixtures,
  added to `INTEGRATION_TESTS` in `run-test-group.js`) is split to **Slice A2** to
  respect the 500-line cap.
- **Deploy-light** (a read route). Safe to build during the repair.

### Slice B — frontend panel (polling)
- API client method + trades panel component + section wiring.
- Renders the table (Amount/Trader/MC/Age, buy/sell color, volume bars), fed by
  Slice A via refresh/polling.
- `npm --prefix frontend run build`.
- **Deliverable:** visible feature without realtime.
- Est.: ~400–500 changed lines.

### Slice C — realtime (`market:trade`)
- Emit `market:trade` when new `robinhood_wallet_swaps` rows land (mirror the
  `market:bucket` `pg_notify` fan-out), server relay, and a `market-events.ts`
  handler that prepends live trades (opt-in per watched token — **not** a global
  broadcast; per-swap volume is far higher than the current aggregated alerts).
- **Touches the wallet-swap worker → requires deploy/worker restart → do AFTER the
  sqrtPriceX96 repair completes.**
- **Verify first (cheap, on prod DB):** `robinhood_wallet_swap_cursors` position vs
  head — if attribution lags the head, the "live" feed shows stale trades.
- Est.: ~300–450 changed lines.

## 5. Risks & constraints

- **Repair in flight:** the sqrtPriceX96 observation re-pricing job is running on the
  same VPS as the DB and head worker. Slices A/B are pure development + a read route +
  a frontend build → safe now. **Any deploy (worker restart) and any schema change
  waits until the repair finishes.**
- **Realtime volume (Slice C):** every swap, not just alerts. Must be opt-in per
  watched token and length-capped client-side, or it floods sockets/clients.
- **Attribution liveness — affects Slices A/B too, not just C (measured blocker):**
  the isolated `robinhood-wallet` group is **stopped**. On 2026-08-06 the `live`
  cursor (`robinhood_wallet_swap_cursors`) was frozen at block 29 003 237 since the
  head cutover (~2026-08-05 23:51), **~746k blocks behind** the observations head and
  only growing. Root cause (code-verified): before `bd529c37` the live attributor
  ran inside `if (hasWorkerGroup('robinhood'))` (the now-off monolith); the isolation
  moved it to its own `robinhood-wallet` group whose systemd unit
  (`trendscope-worker@robinhood-wallet`) was never enabled on VPS2. So the feed reads
  a table that stops at that block: **any feed built now is stale/incomplete until the
  group is restarted and catches up (post-repair)**. Label the feed "attributed up to
  block X", not "live", until then. Fix is operational, not code.
- **`wallet_swaps.price_usd` is crystallized (repair-provenance trap):** it is copied
  from the observation at attribution and **never re-read** (no `UPDATE` path). The
  sqrtPriceX96 repair fixes `observations.price_usd` but not the already-copied
  `wallet_swaps.price_usd`. The seed range (≤25.47M) sits inside the repair window
  (1.68M–25.47M), so historical trades can show **pre-repair price** — and any
  `price × supply` MC reconstruction (§8) inherits that error. Re-hydrating
  `wallet_swaps.price_usd` from the repaired observations is a §8 prerequisite.
- **MC join key:** relies on `action_index == log_index` (verified in the attributor)
  and on the observations PK `(chain, transaction_hash, log_index)` (verified) — point
  lookups are cheap.
- **Trader semantics:** `wallet_address` = `tx.from`. For Robinhood's own routed
  swaps this is the end user; router/recipient are retained if a future heuristic
  needs them.

## 6. Phase 2 — DEV / TRACKED / YOU tabs

Each tab is a **filter of the same feed by wallet classification**; the
`wallet_time` index already supports per-wallet queries.

- **YOU** — filter `wallet_address` against the authenticated user's wallets in
  `user_wallets` (`src/utils/db-init-stage44.js`). No new schema; needs auth context
  on the trades route and a `mine=true` filter.
- **DEV** — the token **deployer/creator** wallet. **Needs a source**: the creator is
  not in `robinhood_wallet_swaps`. Candidates: the pool/token registry
  (`robinhood_pool_registry`) or the token-creation event; likely a small lookup or a
  new column/table. **Schema decision deferred to Phase 2.**
- **TRACKED** — the user's **tracked-wallet watchlist**. This concept does not exist
  yet (`user_wallets` holds the user's *own* wallets, not a watchlist). **Requires a
  new table** (e.g. `user_tracked_wallets`) + CRUD + UI to manage the list.

Phase 2 fan-out (estimate, to be re-checked before starting):
- Backend: `mine` / `tracked` / `dev` filters on the read model + route; deployer
  source; tracked-wallet table + CRUD routes.
- Frontend: tab UI on the panel; tracked-wallet management UI; wire auth/user wallets.
- Schema: `user_tracked_wallets` (+ possibly a deployer column/lookup) → **migration
  → must be run in a maintenance-safe window, not during a heavy repair.**

Phase 2 is intentionally **not** sliced here; it gets its own architecture-checkpoint
pass once Phase 1 ships and the deployer/tracked sources are decided.

## 8. Phase 2 — MC parity on old trades (Axiom-style)

Axiom shows MC even on 2-month-old trades; our `mcUsd` goes null after ~3 days
(§2.3). Because per-swap **price is retained** and MC = `price × supply`, MC is
reconstructable — but the exact per-swap **FDV and supply were captured then
thrown away** (both live only on the pruned observation:
`observation.fdv_usd`, `observation.token_total_supply_raw`, at the swap block).
Direction (decided 2026-08-06):

**Two horizons.**

1. **Going forward — crystallize into `robinhood_wallet_swaps` (zero RPC, exact).**
   The attributor's `buildRow` already copies `price_usd`/`volume_usd` from the
   observation but drops `fdv_usd` and `token_total_supply_raw`. Add durable columns
   for both and copy them at attribution; the read model then prefers
   `COALESCE(swap.fdv_usd, observation.fdv_usd)`. `token_decimals` is already durable
   on the row, so `price × supply` is fully reconstructable later too.
   - Requires: **new schema stage** (`ALTER TABLE … ADD COLUMN IF NOT EXISTS
     fdv_usd`, `token_total_supply_raw`) + register the columns in
     `runtime-schema.js` + attributor + persistence `insertWalletSwaps` + read-model
     `COALESCE` + tests + `npm run db:schema-check`.
   - **Blocked until post-repair:** a migration + a wallet-worker deploy, and the
     wallet group is stopped (§5) — so nothing is "saved for new swaps" until the
     group is restarted. The code can be written/validated in dev now (test DB); it
     is **inert in prod until post-repair**. Forward-only: pre-column rows stay null
     until backfill.

2. **Already-pruned history — archive backfill via the PC↔VPS tunnel.**
   For trades whose observation is gone, the exact FDV is unrecoverable; reconstruct
   `fdv ≈ totalSupply(at block) × price_usd`. Supply-at-block must come from the
   **self-hosted archive node** (the three configured RPCs —
   `rpc.mainnet.chain.robinhood.com`, Alchemy, dRPC — are external; there is **no**
   archive-node URL wired today, only a `ROBINHOOD_ARCHIVE_RPC_MIN_INTERVAL_MS`
   knob). `evm-erc20-metadata.js` already supports at-block `totalSupply` via
   `blockTag`, so wiring the node makes it **exact** (no mint/burn approximation).
   - The node is an **on-demand tunnel resource** (PC serves archive RPC ←tunnel→ VPS
     worker writes PSQL — the same pattern used for the earlier enrichment backfill),
     **not** a standing endpoint. Therefore the **live feed must never call the archive
     node**: it reads only the durable column; RPC is backfill-only, offline.
   - **Dependency order:** repair `price_usd` → re-hydrate `wallet_swaps.price_usd`
     from repaired observations → restart wallet group + catch-up → run the
     supply/FDV backfill via tunnel. All post-repair.

Phase 2 (MC parity + DEV/TRACKED/YOU tabs) is an architecture checkpoint; it gets
its own slicing pass once Phase 1 ships.

## 9. Suggested order

1. Finish the sqrtPriceX96 repair + bucket rebuild (separate effort).
2. **Slice A** (backend read model + route + tests) — landed (prod + unit); A2 (route
   integration) pending. Safe during the repair.
3. **Slice B** (frontend polling panel) — safe to build during the repair; deploy after.
   Label the feed "attributed up to block X" while the wallet group is behind (§5).
4. Restart the `robinhood-wallet` group + catch-up (post-repair, operational).
5. **Slice C** (realtime) — after the group is at head.
6. **Phase 2 §8** — crystallize FDV/supply going forward (schema + attributor); then
   the tunnel backfill for pruned history; then DEV/TRACKED/YOU tabs.

The "going-forward crystallize" code (§8.1) may be written in dev during the repair
but must not be migrated/deployed until the repair finishes and the wallet group is
restarted.

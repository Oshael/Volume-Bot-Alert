# Robinhood — Token Trades Feed (Axiom-style) — Implementation Plan

Status: **Phase 1 built.** Slices A + A2 + B are committed; Slice C is implemented
in the checkout and awaits commit/deploy. The durable MC path
(sidecar `robinhood_swap_mc` + forward-write + history backfill) is built and
committed. The sqrtPriceX96 repair is **done**, and the sidecar backfill has been
**run in prod** (33.5M+ rows and climbing when last checked). The `robinhood-wallet`
attribution worker is **running and at head** (2026-08-09: lag ≈ 45 blocks) — the
earlier "stopped, 746k behind" blocker is resolved (§5). Remaining: deploy Slice C,
verify the sidecar backfill is complete then prune observations, and the Phase 2
tabs. This document began as the `CLAUDE.md` architecture-checkpoint report;
it is kept current as the work lands.

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

### 2.3 MC (market cap) source — sidecar-first, observation fallback

`robinhood_wallet_swaps` has no FDV/MC column. The attributor sets
`actionIndex = observation.log_index`
(`robinhood-wallet-swap-attributor.js:25`), so `action_index` **is** the
observation `log_index`. A wallet-swap row therefore joins 1:1 to
`robinhood_market_observations` on `(chain, transaction_hash, action_index = log_index)`
and can read the already-computed **`fdv_usd`** as MC. That triple is the
observations **primary key** (verified — stage64, and a stage83 FK targets it), so
the join is a cheap point lookup; the earlier "confirm the PK / else recompute"
note is resolved and the recompute fallback is dead code.

- **How MC is read now:** `COALESCE(mc.fdv_usd, observation.fdv_usd)` — the durable
  sidecar `robinhood_swap_mc` (§8) first, the live observation as fallback. Both are
  **LEFT JOINs** (not INNER): a swap whose MC is genuinely absent surfaces
  `mcUsd: null` instead of vanishing (trader/amount/side/age stay intact).

**The original ~3-day retention worry does not bite today.** Observations carry
`expires_at` (`OBSERVATION_RETENTION_DAYS = 3`, stage64) and would cascade-delete with
`robinhood_processed_logs` (stage63, `ON DELETE CASCADE`) — **but only if the retention
worker runs, and it lives in the `maintenance` group, which is disabled.** So
observations are **intact** (full FDV history on the VPS, oldest ~2026-06-10) and MC is
available for **all** trades via the join right now. The sidecar (§8) then copies that
FDV into durable storage, so MC survives even once observations are eventually pruned
for disk. `robinhood_wallet_swaps` is itself durable (partitioned), and per-swap price,
USD size, side and trader are copied there at attribution (`attributor.js` `buildRow`).

**sqrtPriceX96 repair note:** the repair (now done) corrected
`observations.price_usd`/`fdv_usd`, and the sidecar backfill ran **after** it, so the
MC the feed shows is the corrected value. Only `wallet_swaps.price_usd` stays
**crystallized** at attribution (copied, never re-read) — see the price-provenance
risk in §5.

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
  `robinhood-trades.js`, server wiring, `robinhood-wallet-swap-read.test.js`).
- **Deploy-light** (a read route). Safe to build during the repair.

### Slice A2 — read-model integration test — **landed**
- `robinhood-wallet-swap-read.integration.test.js`, registered in
  `INTEGRATION_TESTS` (`run-test-group.js`). Ensures stages 63/64/90/109 in
  `before` (the wallet-swap stages are outside the test schema profile), seeds
  through the real persistence repo, and asserts against the real DB the part the
  fake-db unit test cannot: the 2-JOIN `RECENT_TRADES_SQL` executing on the
  daily-partitioned `robinhood_wallet_swaps` + `robinhood_swap_mc` sidecar +
  `robinhood_market_observations` — token filtering, `COALESCE` MC (sidecar wins,
  null when absent), newest-first ordering, and keyset pagination across a
  partition boundary with no overlap/skip. Seeding via `insertWalletSwaps` also
  exercises the forward-write `insertSwapMc` end-to-end on the real schema.
- **Deliberately not re-tested here:** auth and the Robinhood visibility gating.
  Those are thin `router.use` composition already covered by `auth.test.js` and
  the visibility middleware's own tests; rebuilding an authenticated express
  harness would duplicate that for marginal gain (per the testing-discipline
  guardrail). The route's own 400 mapping (invalid token/cursor/limit) is covered
  at the unit layer by the read model's `normalizeQuery`.

### Slice B — frontend panel (polling) — **landed**
- **Placement (corrected):** there is **no** token-detail view; the only per-token
  detail surface is the **expanded-chart modal** (`renderExpandedSparklineModal` in
  `layout-sections.ts`). The panel sits **beside** that chart, **Robinhood-only** —
  the chart shrinks (`.has-trades` flex) and a `<aside data-robinhood-trades-panel>`
  holds the table. Other chains render byte-identical markup (no wrapper/aside).
- **Hub discipline:** all logic is in new modules — `services/api/robinhood-trades.ts`
  (client), `ui/robinhood-trades-format.ts` (pure formatters + row markup, unit-tested),
  `ui/robinhood-expanded-trades.ts` (mount/poll/cleanup). `layout-sections.ts` (an
  already-huge hub) only gained **wiring**: one import, a `renderExpandedChartArea`
  helper (extracted so the chain branching did not raise the modal's complexity), and
  mount/destroy calls at the existing hydrate/`destroyExpandedCandlestickChart` points.
- Table columns Amount/Trader/MC/Age with buy/sell color; polls Slice A every 5s
  (fetches the latest 30, replaces the list); cleaned up on close.
- Validated: format unit test (5/5), `tsc --noEmit` + `vite build`, lint 0. ~451
  changed lines (one slice).
- **Deliverable:** visible feature without realtime. No deploy/schema — pure frontend.

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
- **Status: implemented locally.** The attributor publishes through `pg_notify` to
  a web listener, which relays only to the dedicated
  `market-trade:robinhood:<token>` room. Opening the panel opts in; closing it
  unsubscribes. The client deduplicates and caps at 30, while the 5s poll remains
  the reconciliation path. Web + `robinhood-wallet` deploy/restarts are pending.

## 5. Risks & constraints

- **Repair (done):** the sqrtPriceX96 observation re-pricing job has completed. All
  code was built read-only/frontend while it ran; deploy/worker-restart/schema were
  correctly deferred until it finished. That gate is now lifted — the remaining work
  is operational (start the wallet worker), not repair-blocked.
- **Realtime volume (Slice C):** every swap, not just alerts. Must be opt-in per
  watched token and length-capped client-side, or it floods sockets/clients.
- **Attribution liveness — RESOLVED (was the main blocker):** the `robinhood-wallet`
  group is now **running and at head**. On 2026-08-09 the `live` cursor was at
  31 699 090 vs a head-capture tip of 31 699 135 — **lag ≈ 45 blocks** (reorg depth /
  in-flight queue), and climbing between reads. History: on 2026-08-06 the cursor was
  frozen at 29 003 237 (~746k behind) because the live worker derived its source
  frontier from the retired monolith cursor `robinhood_ingestion_cursors` ('market'),
  which froze at the cutover block and pinned the live cursor there. That is fixed in
  code (`robinhood-wallet-swap-live-worker.js:69-74`): the worker now takes the
  frontier from `headProcessingRepository.getOldestActiveCapture('market')` (the live
  pipeline). So the feed is genuinely live now; the "attributed up to block X" label is
  no longer needed. **Check query:** compare `robinhood_wallet_swap_cursors` (live)
  `next_block` to `MAX(block_number)` of `robinhood_head_captures` — **not** to
  `robinhood_ingestion_cursors` 'market', which is dead and reads ~29.0M forever.
- **`wallet_swaps.price_usd` is crystallized (repair-provenance trap):** it is copied
  from the observation at attribution and **never re-read** (no `UPDATE` path). The
  sqrtPriceX96 repair fixes `observations.price_usd` but not the already-copied
  `wallet_swaps.price_usd`. The seed range (≤25.47M) sits inside the repair window
  (1.68M–25.47M), so the displayed **price** column can still show a pre-repair value.
  **MC is not affected:** it comes from the sidecar `robinhood_swap_mc`, whose
  `fdv_usd` was backfilled from the *repaired* observations (§8) — so the earlier
  "re-hydrate `wallet_swaps.price_usd` / reconstruct `price × supply`" plan is moot.
  Only the secondary `priceUsd` field carries the crystallized value; if it ever
  needs to be correct, re-hydrate it from repaired observations too.
- **MC join key:** relies on `action_index == log_index` (verified in the attributor)
  and on the observations PK `(chain, transaction_hash, log_index)` (verified) — point
  lookups are cheap.
- **Trader semantics:** `wallet_address` = `tx.from`. For Robinhood's own routed
  swaps this is the end user; router/recipient are retained if a future heuristic
  needs them.

## 6. Phase 2 — DEV / TRACKED / YOU tabs

Each tab is a **filter of the same feed by wallet classification**; the
`wallet_time` index already supports per-wallet queries.

- **YOU** — requires EVM wallet linkage by a domain-bound SIWE signature. The
  existing `user_wallets` model is Solana-only and must not be reused as if it were
  already multichain. The signature is authentication only: no transaction or token
  approval belongs in this flow.
- **DEV** — filter by the token's direct on-chain contract creator. Stage 110 adds
  `robinhood_token_attributions`; a dry-run-first Blockscout backfill resolves
  creators from registry tokens. A creator can be a factory contract, so this is
  provenance, not proof of the human developer's identity. The read model and
  panel now support `scope=dev`; the HTTP page supplies `creatorAddress` so the
  existing per-token realtime stream can be filtered without another socket room.
  Provider timeout/transport/429/5xx failures receive bounded exponential retries.
- **TRACKED** — the user's **tracked-wallet watchlist**. This concept does not exist
  yet (`user_wallets` holds the user's *own* wallets, not a watchlist). **Requires a
  new table** (e.g. `user_tracked_wallets`) + CRUD + UI to manage the list.

Phase 2 fan-out (estimate, to be re-checked before starting):
- Backend: `mine` / `tracked` / `dev` filters on the read model + route; deployer
  source; tracked-wallet table + CRUD routes.
- Frontend: tab UI on the panel; tracked-wallet management UI; wire auth/user wallets.
- Schema: `user_tracked_wallets` (+ possibly a deployer column/lookup) → **migration
  → must be run in a maintenance-safe window, not during a heavy repair.**

Phase 2 architecture checkpoint: Slice 1 is the persistent DEV attribution
foundation and Slice 2 wires the ALL/DEV feed filter. Later slices add TRACKED
CRUD/UI and only then implement YOU with SIWE.

## 8. Durable MC parity — the sidecar (BUILT / done)

Axiom shows MC even on 2-month-old trades. MC (FDV) is not stored on
`robinhood_wallet_swaps`; it lives on the observation
(`observation.fdv_usd`, `observation.token_total_supply_raw`, at the swap block).
The feed therefore joins the observation for MC — but observations are meant to be
pruned for disk, so MC would eventually go null. This section solved that durably.

**Key discovery (2026-08-06, overturns the old plan):** observations are **not**
pruned today — the retention worker lives in the `maintenance` group, which is
**disabled**. So the full FDV history is **intact on the VPS** (oldest ~2026-06-10).
That retires the earlier design entirely: **no archive node and no PC↔VPS tunnel are
needed** — the exact FDV is already in `robinhood_market_observations`, so there is
nothing to reconstruct via `price × supply`.

**Architecture (implemented): a narrow sidecar, not columns on `wallet_swaps`.**
`robinhood_wallet_swaps` has ~426M rows, so an in-place `ALTER … ADD COLUMN` +
UPDATE backfill was rejected as too heavy. Instead, a dedicated table
`robinhood_swap_mc` (stage109) keyed by `(chain, transaction_hash, log_index)` holds
`fdv_usd` + `token_total_supply_raw`. The read model reads
`COALESCE(mc.fdv_usd, observation.fdv_usd)` — the sidecar wins, the observation is
the transitional fallback.

1. **Going forward — written at attribution (committed).** The source-reader now
   carries `fdv_usd`/`token_total_supply_raw`; the attributor's `buildRow` forwards
   them; `insertWalletSwaps → insertSwapMc` upserts the sidecar (`ON CONFLICT DO
   NOTHING`). New swaps crystallize their MC as they are attributed by the running
   **`robinhood-wallet` worker** (§5).

2. **History — backfilled from the intact observations (committed; run in prod).**
   `src/utils/backfill-robinhood-swap-mc.js` keyset-scans accepted observations
   (`status='accepted' AND fdv_usd IS NOT NULL`) and upserts the sidecar
   (refresh-safe `DO UPDATE`, throttled, checkpointed, dry-run by default). It was run
   **after** the repair so the copied `fdv_usd` is the corrected value; **33.5M+ rows
   copied** when last observed. No RPC, no tunnel — it reads observations directly.

**Disk reclamation (the point of all this) — not yet done.** Only once the sidecar
backfill is verified complete may `robinhood_market_observations` be pruned; at that
cutover, drop the observation-fallback LEFT JOIN from the read model so MC comes from
the sidecar alone. Ordering for the head region: the wallet worker must catch up
first (it is the only durable copy of the trader/`wallet_address`, which the
observation lacks), then prune.

The DEV/TRACKED/YOU tabs (§6) remain the open Phase-2 architecture checkpoint.

## 9. Suggested order

1. ✅ sqrtPriceX96 repair — **done**.
2. ✅ **Slice A** (read model + route + unit) and **A2** (read-model integration test)
   — landed and committed.
3. ✅ **Slice B** (frontend polling panel) — landed & committed (expanded-chart side
   panel, Robinhood-only). The "attributed up to block X" label is no longer needed —
   the wallet group is at head (§5).
4. ✅ **Durable MC (§8)** — sidecar `robinhood_swap_mc` + forward-write + history
   backfill built & committed; backfill **run in prod** post-repair.
5. ✅ **`robinhood-wallet` worker running + at head** (2026-08-09, lag ≈ 45) — the
   frozen legacy-cursor bug is fixed; forward-write of the sidecar is now live (§5).
6. ✅ **Slice C** (realtime) — committed; production still depends on its rollout.
7. **Observation pruning deferred** — keep the table and fallback JOIN for now (§8).
8. ◐ **Phase 2** — DEV attribution and the ALL/DEV feed filter are built; TRACKED
   and YOU remain subsequent slices (§6).

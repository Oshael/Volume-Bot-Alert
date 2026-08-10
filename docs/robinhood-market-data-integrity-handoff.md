# Robinhood Market-Data Integrity — Handoff / Briefing

> Self-contained briefing for continuing work on the Robinhood-chain market-data
> pipeline of this repo (a crypto volume/alert bot). Written for a fresh AI or
> engineer with no prior context. Covers: what was repaired, what is still broken,
> the root cause of the "fake wick" problem, and the recommended fix.

---

## 0. TL;DR

- We re-priced historical v3/v4 observations to the **sqrtPriceX96 spot basis**,
  rebuilt the 1m buckets + aggregates, and fixed a wallet-worker bug. **Done.**
- The **live active problem** is **fake price/FDV "wicks"** on charts (market-cap
  spikes to absurd values, e.g. $120B / $2B / $8T on a token really worth ~$100M).
  They poison the bucket `high_fdv`/`high_price` and blow up the chart axis.
- **Root cause (confirmed by data):** these are **swaps in dead / near-zero-liquidity
  pools**. The sqrtPriceX96 decode is *correct*; the pool genuinely has that price
  because it has no liquidity, so a single swap moves the price anywhere. The value
  is **economically meaningless, not a math bug**.
- A **threshold-based cleanup** removed the catastrophic ones (fdv > 1e13). It does
  **not** and **cannot** catch the moderate fakes (they overlap real values). The
  real fix is a **relative-per-token outlier guard**, still TODO.
- The **live pipeline keeps producing new fakes** (~tens per few hours). Until the
  guard ships, charts slowly re-poison.

Status table:

| Workstream | State |
| --- | --- |
| sqrtPriceX96 re-pricing of history | ✅ done |
| 1m bucket rebuild + aggregates | ✅ done (with caveats, see §4/§5) |
| Wallet-swap LIVE worker cutover bug | ✅ fixed + committed (`bddfa73b`) + deployed, cursor advancing |
| Fake-wick cleanup (threshold band-aid) | ⚠️ partial — big ones gone, moderate remain |
| Relative-outlier guard (the real fix) | ❌ TODO — design in §6 |
| Timeframe switcher bug (1h/4h/24h show 30m) | ❌ open, not investigated (§7) |

---

## 1. System architecture (what you need to know)

Post-"cutover" (~2026-08-05) the old monolith was split into isolated worker groups,
each a `node src/server.js` with `BACKGROUND_WORKER_GROUPS=<group>`:

- `robinhood-head` — captures head blocks into `robinhood_head_captures` (queue).
- `robinhood-processing` — consumes the queue, decodes swaps, writes
  `robinhood_market_observations` (the per-swap ledger, source of truth).
- `robinhood-derived` — builds derived data / live buckets / alerts.
- `robinhood-wallet` — attributes each swap to its signing wallet (`tx.from`).

### Key tables

- **`robinhood_market_observations`** (`src/utils/db-init-stage64.js`) — one row per
  swap. PK `(chain, transaction_hash, log_index)`. Relevant columns:
  `protocol` (`uniswap-v2|v3|v4`), `status` (`pending|accepted|rejected`),
  `rejection_reason`, `price_quote`, `price_usd`, `fdv_usd` (nullable),
  `token_total_supply_raw`, `token_decimals`, `quote_decimals`, `quote_address`,
  `liquidity_usd`, `liquidity_status`, `market_key`, `side`, `observed_at`,
  `block_number`. 3-day retention (`expires_at`).
  - **Constraint** `..._accepted_metrics_check`: an **accepted** row must have
    `price_usd > 0`, `price_quote > 0`, `quote_usd_price > 0`, `fdv_usd >= 0`.
    → **You cannot NULL `price_usd` on an accepted row**; you can NULL `fdv_usd`
    (`fdv_usd >= 0` passes on NULL). To drop a whole row from aggregation, set
    `status='rejected'`.
- **`robinhood_market_buckets_1m`** — 1-minute OHLC. Columns `open/high/low/close_price_usd`,
  `open/high/low/close_fdv_usd`, `volume_usd`, `swaps`, liquidity cols, block/log
  bounds. Built by `GROUP BY (chain, protocol, market_key, token, quote, minute)`,
  `high_fdv_usd = MAX(fdv_usd)` etc. **This MAX is what a single fake poisons.**
- **`robinhood_market_buckets_1h`** — hourly, built from 1m. **Its upsert has an
  identity `WHERE` guard** (only updates if existing `token/quote` match the
  recomputed) that **can block overwriting existing rows** — see §5.
- **`robinhood_market_buckets_agg`** — multi-granularity (5/15/30/60/240/1440) via a
  `granularity_minutes` column; columns include `high_fdv_usd`, `high_price_usd`.
  Fine (5/15/30) built from 1m; coarse (60/240/1440) built from 1h.
- **`robinhood_swap_mc`** (`stage109`) — durable per-swap MC sidecar, PK
  `(chain, tx_hash, log_index)`, holds `fdv_usd` + `token_total_supply_raw` copied
  from observations (for the trades feed after observations are pruned).
- **`robinhood_wallet_swaps`** (`stage90`) — per-swap attribution, `wallet_address`
  = `tx.from`. `action_index == log_index` (join key to observations).
- **`robinhood_wallet_swap_cursors`** — streams `seed` (deep history) and `live`.
- **`robinhood_head_capture_cursors`** — streams `discovery`/`market`, `next_block`,
  `safe_head`. Post-cutover head position lives here.
- **`robinhood_ingestion_cursors`** — the **OLD monolith** cursor; **frozen** since
  cutover. (Caused the wallet bug, §3.)
- **`worker_leases`** (`stage50`) — distributed leases (`lease_key`, `owner_pid`,
  `heartbeat_at`, `lease_until`).

### Key code

- `src/services/evm-market-metrics.js` — `buildMarketObservation`, `resolvePriceQuote`.
  Constant `MAX_FINITE_HUMAN_SUPPLY = 1e15` suppresses FDV when whole-token supply
  exceeds the ceiling (guards *supply*, not *price*). Existing reject example:
  `price_below_persisted_precision`. **This is where a price/FDV sanity guard would go.**
- `src/services/uniswap-v3-decoder.js` — `exactPriceRatio(sqrtPriceX96, pool)`
  (`Q192/sqrt²` or inverse). The decode is **correct**; not the bug.
- `src/models/robinhood-persistence.js` — `resolveMarketFrontier(pendingBlock)` =
  strict processing frontier (used by derived + now the wallet worker); `loadCursor`
  reads the legacy `robinhood_ingestion_cursors`.
- `src/models/robinhood-market-aggregate.js` — `refreshHourlyRange` (has the identity
  `WHERE` guard, lines ~139-146) and the agg `UPSERT_SQL`.
- Utils (all support `--mode dry-run|write`, checkpoints, throttle):
  - `src/utils/repair-robinhood-fdv-observations.js` — sqrt re-pricer (`--target spot`).
  - `src/utils/backfill-robinhood-market-buckets-1m.js` — 1m rebuild (its
    `AGGREGATION_SELECT` is the canonical bucket-build SQL; needs `--from-block/--to-block`).
  - `src/utils/backfill-robinhood-market-aggregates.js` — fine/hourly/coarse; phases
    run `fine → hourly → coarse`; `--from/--to`, `--checkpoint`, `--maxChunks`,
    `--tokenLimit`, `--sleepMs`, `--statementTimeoutMs`.
  - `src/utils/backfill-robinhood-swap-mc.js` — MC sidecar backfill.

### Infra

- VPS **TrendScopeWorkers-01**: all worker groups + Postgres (`volume_alert`), app at
  `/opt/trendscope/app`. Web VPS serves `trendscope.pro` (IPv4 `159.195.17.104`, nginx,
  no AAAA). Long jobs run in **tmux**; checkpoints under `/opt/trendscope/`.
- systemd unit template `trendscope-worker@<group>` (e.g.
  `trendscope-worker@robinhood-wallet`), env from a drop-in `override.conf`.
- Postgres: run heavy DB work throttled; watch head health between chunks (see §8).

---

## 2. Workstream: sqrtPriceX96 re-pricing (DONE)

**Why:** historical v3/v4 observations were priced on the old amount-ratio basis (+ an
FDV/transposition defect). The bot now prices v3/v4 by `sqrtPriceX96` spot
(`resolvePriceQuote` prefers `swap.priceQuotePerTokenRaw` for v3/v4).

**What:** `repair-robinhood-fdv-observations.js --target spot --mode write` recomputes
`price_quote/price_usd/fdv_usd` from `sqrtPriceX96` read from
`COALESCE(staging.data, capture.data)` (**never hits the node**). Ran over blocks
`1681020 → 25473075` (~68M rows), throttled + checkpointed, head stayed healthy.

**Evidence holes (left as-is):** rows with `missing_raw_log` and rows below block
1.68M were skipped (`--on-missing skip`). They keep amount-based prices. Fixing them
would need re-fetching raw logs from an **archive node** (the PC node; the VPS node is
pruned). **Low priority / probably not needed** — the real problem turned out to be the
dead-pool wicks (§4), not these.

Post-repair: `VACUUM (ANALYZE) robinhood_market_observations;` (autovacuum had already
reclaimed most dead tuples).

---

## 3. Workstream: wallet-swap LIVE worker cutover bug (FIXED, committed `bddfa73b`)

**Symptom:** the `robinhood-wallet` group was running (lease held, heartbeating) but the
`live` cursor was frozen at the cutover block; CPU idle, no attribution, exactly since
the cutover timestamp.

**Root cause:** `robinhood-wallet-swap-live-worker.js` computed its processable frontier
via `loadMarketCursor('market')` → `robinhood_ingestion_cursors` — the **dead monolith
cursor**, frozen at cutover. The worker thought it was caught up → idled.

**Fix:** repointed `loadMarketCursor` to the **strict processing frontier**
(`getOldestActiveCapture('market')` → `resolveMarketFrontier(...)`), mirroring
`robinhood-processing`'s `resolveDerivedEmit`. Committed `bddfa73b`
(`fix(robinhood-wallet): bound live worker by strict processing frontier`), deployed
(`git pull` + `systemctl restart trendscope-worker@robinhood-wallet`), **cursor now
advancing / caught up.**

Note: the `seed` cursor (deep-history backfill) is a **separate** worker and remains
frozen — deep history, low priority, and the pruned node may not serve those blocks.

---

## 4. Workstream: FAKE WICKS (the active problem)

### Symptom
Charts (especially longer timeframes, because they show more history) display
market-cap/price "wicks" spiking to absurd values — e.g. axis blown to `$3.2e+53M`, or
a single candle wick to `$120,000M` on a token whose real MC is `$115M`. Every token
is affected to some degree; new/low-liquidity tokens worst.

### Investigation & findings (in order)

1. **Not supply.** Broken CashCat rows had sane supply (1e9 = 1B tokens). The
   `MAX_FINITE_HUMAN_SUPPLY` guard was not the issue.
2. **It's PRICE.** `price_usd` up to ~`3.4e50` per token (impossible). The extreme
   value ≈ the price at `MAX_SQRT_RATIO` (the sqrt tick boundary) → a boundary/sentinel
   read.
3. **Live pipeline is fine for healthy pools.** Recent CashCat rows (near head) are
   correct: `price_usd ≈ $0.096`, FDV ≈ $95M. So it is **not** a global decode bug.
4. **Spread, not a single sentinel.** A scan (`price_usd > 1e9`) found ~4,452 rows
   across ~794 tokens, spanning block 524k → head, with **2,287 distinct** garbage
   prices → a *spectrum* of impossible values, ongoing (up to the head).
5. **ROOT CAUSE = liquidity.** Sampling the moderate fakes (`fdv BETWEEN 1e10 AND 1e13`)
   showed **all** of them are **dead / near-zero-liquidity pools**:
   `liquidity_usd` of `$0.007`, `$0.80`, `$755`, or `liquidity_status =
   requires_tick_liquidity_distribution` with NULL liquidity. The `sqrtPriceX96` is
   correct — the pool genuinely sat at that price because it has no liquidity, so one
   swap moves the "price" anywhere. **Economically meaningless, not a math bug.**

### Why a threshold cannot fully fix it
- Absolute cut (`fdv > 1e13`) catches the catastrophic ones but **misses moderate
  fakes** ($120B, $2B) and **can never** catch relative ones (e.g. a $40M wick on a
  token really worth $5M — $40M is a normal FDV for other tokens, so no absolute number
  isolates it without nuking real tokens).

### Why liquidity is NOT a usable guard signal (important)
- `liquidity_status = requires_tick_liquidity_distribution` is the **dominant** status
  even for **healthy** CashCat: **1,655,725 rows**, mostly real, with **NULL**
  liquidity. So the status does not separate fake from real.
- `liquidity_usd` values are themselves **poisoned** (observed maxima like `1.2e31`,
  `9.5e13`). So neither the status nor the value is a clean filter.

### The signal that DOES separate: RELATIVE per-token
For CashCat: real FDV ≈ **$41M–$212M** (the `spot_tvl_from_pool_balances` rows) vs
fakes at **$8T, $128B, $11.8B** — orders of magnitude above the token's own norm. The
robust discriminator is **magnitude relative to the token's own typical FDV**, not any
absolute number or liquidity value.

### Cleanup already applied (threshold band-aid — partial)
Ran (repeatedly, because the live pipeline keeps producing new ones):
```sql
-- reject impossible-price rows (whole obs is garbage)
UPDATE robinhood_market_observations
SET status='rejected', rejection_reason='impossible_price'
WHERE chain='robinhood' AND status='accepted' AND price_usd > 1e9;

-- suppress impossible-FDV rows that have a sane price (huge/unguarded fdv)
UPDATE robinhood_market_observations
SET fdv_usd=NULL
WHERE chain='robinhood' AND status='accepted' AND price_usd <= 1e9 AND fdv_usd > 1e13;
```
Then rebuilt buckets (see §5 for the crucial ordering gotchas). Result: historical
poison in 1h dropped **538 → 39**; the residual 39 (1h) / ~92 (1m) are all from the
**last several hours = new live garbage** (guard needed to stop it).

**Still visible after cleanup:** wicks below the 1e13 cut (e.g. $120B, $2B) and the
small relative fakes ($40M-on-$5M). Those are what the relative guard (§6) must handle.

---

## 5. Bucket-rebuild mechanics & the gotchas learned

To rebuild buckets after cleaning observations:

1. **Observations first, then 1m, then 1h/agg.** Rebuilding aggregates before the
   source tier is clean just propagates poison. (We hit this — the 1h stayed poisoned
   because aggregates ran against a still-dirty 1m.)
2. **The 1m rebuild** can be full-range via `backfill-robinhood-market-buckets-1m.js`
   (`--mode write --from-block X --to-block Y`, **one DELETE+INSERT transaction per
   range → chunk it** to protect the head), OR **targeted** via SQL (fast, only the
   poisoned minutes):
   ```sql
   BEGIN;
   CREATE TEMP TABLE _poison ON COMMIT DROP AS
     SELECT DISTINCT protocol, market_key, bucket_ts
     FROM robinhood_market_buckets_1m
     WHERE chain='robinhood' AND (high_fdv_usd > 1e13 OR high_price_usd > 1e9);
   DELETE FROM robinhood_market_buckets_1m b USING _poison p
     WHERE b.chain='robinhood' AND b.protocol=p.protocol
       AND b.market_key=p.market_key AND b.bucket_ts=p.bucket_ts;
   -- re-INSERT from clean observations using the tool's AGGREGATION_SELECT,
   -- JOINed to _poison on (protocol, market_key, date_trunc('minute', observed_at)),
   -- WHERE o.status='accepted'. (Full column list mirrors
   -- backfill-robinhood-market-buckets-1m.js INSERT_SQL.)
   COMMIT;
   ```
3. **The 1h/agg tiers will NOT be overwritten by the aggregates tool** if the poisoned
   rows already exist — `refreshHourlyRange`'s upsert has a `WHERE existing.token/quote
   = EXCLUDED.token/quote` guard that skips them. **You must DELETE the poisoned rows
   first, then run the aggregates tool so they re-INSERT clean:**
   ```sql
   DELETE FROM robinhood_market_buckets_1h
   WHERE chain='robinhood' AND (high_fdv_usd > 1e13 OR high_price_usd > 1e9);
   DELETE FROM robinhood_market_buckets_agg
   WHERE chain='robinhood' AND (high_fdv_usd > 1e13 OR high_price_usd > 1e9);
   ```
4. **Then run aggregates with a FRESH checkpoint** (an existing checkpoint at
   `phase:null` = "done" and re-running is a no-op):
   ```bash
   rm -f /opt/trendscope/agg-fix.checkpoint
   node src/utils/backfill-robinhood-market-aggregates.js --mode write \
     --from 2026-06-30T00:00:00Z --to 2026-08-09T00:00:00Z \
     --checkpoint /opt/trendscope/agg-fix.checkpoint \
     --maxChunks 100000 --sleepMs 25 --tokenLimit 100 --statementTimeoutMs 30000
   ```
   The aggregates tool is checkpointed + resumable (Ctrl+C = graceful pause). Run in tmux.

### Poison-check query (ground truth — run before trusting the chart)
```sql
SELECT '1m' AS tier, count(*) AS poisoned, min(bucket_ts) AS first, max(bucket_ts) AS last
FROM robinhood_market_buckets_1m
WHERE chain='robinhood' AND (high_fdv_usd > 1e13 OR high_price_usd > 1e9)
UNION ALL
SELECT '1h', count(*), min(bucket_ts), max(bucket_ts)
FROM robinhood_market_buckets_1h
WHERE chain='robinhood' AND (high_fdv_usd > 1e13 OR high_price_usd > 1e9);
```
(Lower the `1e13`/`1e9` thresholds to see the moderate fakes still present.)

---

## 6. The real fix — RELATIVE-outlier guard (TODO, design)

**Goal:** stop economically-meaningless (dead-pool) prices from poisoning bucket
high/low, at all magnitudes, without nuking real tokens or real pumps.

**Signal:** magnitude relative to the token's own robust reference FDV/price
(median / percentile), NOT absolute, NOT liquidity (liquidity is NULL/poisoned).

**Core rule (starting point):** suppress an observation's contribution to bucket
high/low when its `fdv` (or `price`) exceeds `K ×` the token's robust reference.
- CashCat: median ≈ $100M, `K=20` → cut above ~$2B (kills $8T/$128B/$11.8B, keeps real).
- The hard case ($40M on a $5M token = 8×) needs a smaller K, but small K risks cutting
  **real pumps** (a token that legitimately 5×'d). → precision/recall tradeoff on `K`.

**Refinement to resolve the tradeoff:** only suppress an **isolated spike** (a value
that is `>K×` its immediate neighbors / the bucket's own median), not a **sustained
level** (real pump = many consecutive candles at the new level). This distinguishes a
one-swap dead-pool wick from a genuine move.

**Placement options:**
- **Bucket aggregation (recommended):** compute `high/low` robustly (exclude per-token
  outliers) in the bucket-build SQL — both the batch rebuild AND the live bucket writer.
  Wicks vanish; independent of ingestion. Requires a per-token reference available at
  build time.
- **Ingestion guard:** in `buildMarketObservation`, reject/flag when price is an extreme
  relative outlier vs the market's recent price. Prevents new fakes forward but needs
  rolling per-market context; doesn't fix history by itself.
- A hybrid is likely: ingestion flag forward + a one-shot historical cleanup + robust
  bucket build.

**Rebuild implication:** applying the guard to history needs **one final targeted
bucket rebuild** (existing buckets were built with raw `MAX`). It is the **last** one —
the guard stops recurrence, it's targeted (only buckets containing an outlier), and it
reuses the fast delete+reinsert of §5. **Do the definitive relative pass once** rather
than repeated threshold passes (avoid redundant rebuilds).

**Open decisions for whoever builds this:**
- Reference statistic (median vs trimmed max vs percentile) and window (all-history vs
  rolling).
- `K` and the isolated-spike criterion.
- Guard placement (bucket vs ingestion vs hybrid) and whether the live bucket writer
  must change too.
- Whether to also fix the **liquidity computation** for `requires_tick_liquidity_distribution`
  v4 pools and the **poisoned `liquidity_usd`** values (parallel data-quality issue,
  not blocking the wick fix).

---

## 7. Open bug — timeframe switcher (NOT investigated)

Clicking **1h / 4h / 24h** on a token chart shows the **30m** candles instead; the
higher timeframes never render their own candles. Separate from the poison. Likely
causes to check:
- Frontend timeframe → granularity mapping (`frontend/src/...` chart component / API
  client) not requesting `granularity_minutes` 60/240/1440.
- The `robinhood_market_buckets_agg` rows for granularity 240/1440 are missing/incomplete
  (possibly after the DELETE + partial aggregate rebuild) → API returns empty → UI falls
  back. Verify with:
  ```sql
  SELECT granularity_minutes, count(*), min(bucket_ts), max(bucket_ts)
  FROM robinhood_market_buckets_agg
  WHERE chain='robinhood' GROUP BY 1 ORDER BY 1;
  ```

---

## 8. Operational cheat-sheet

- **Head health (must stay ~0 during heavy DB work):**
  ```sql
  SELECT stream, safe_head-next_block AS backlog, now()-updated_at AS since_update
  FROM robinhood_head_capture_cursors WHERE chain='robinhood';
  SELECT processing_status, count(*) FROM robinhood_head_captures
  WHERE processing_status IN ('pending','leased','blocked') GROUP BY processing_status;
  ```
  `backlog ~0/-1` and `pending` small/rolling = healthy. `pending` climbing across
  checks = the job is starving the head → throttle/pause. (Processing backlog is
  latency, not data loss — captures are durable; loss only if the CAPTURE cursor falls
  behind the pruned node, which it isn't.)
- Long jobs → **tmux** (`tmux new -s <name>`, detach `Ctrl+b d`, `tmux attach -t <name>`).
- Backfill/aggregate progress → `watch -n 10 cat <checkpoint-file>`; tools print a
  summary JSON only at the end (`"paused": false` / `cursor.phase: null` = done).
- Don't put big DELETE+INSERT into one giant transaction on the head box; chunk it.
- App unreachable from a phone but `curl` from a machine returns 200 + correct DNS →
  it's the phone/carrier DNS, not the server (fix: Android Private DNS `one.one.one.one`,
  or Cloudflare 1.1.1.1 app on iOS).

---

## 9. Recommended next steps (priority order)

1. **Design + build the relative-outlier guard (§6).** This is the real fix; it also
   stops the ongoing live re-poisoning. Decide reference stat + `K` + isolated-spike
   rule + placement first.
2. **One definitive historical pass** using that rule (suppress outliers + targeted
   bucket rebuild per §5). The last rebuild.
3. **Timeframe switcher bug (§7).**
4. (Optional) fix liquidity computation / poisoned `liquidity_usd`.
5. (Low priority) archive-node re-pricing of the deep-history evidence holes (§2).

Interim (optional) relief while designing: lower the cleanup cut to `fdv > 1e10`
($10B — no real token on this chain approaches it) to kill the currently-visible big
wicks; but this is a throwaway band-aid — prefer doing the definitive relative pass once.

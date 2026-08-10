# Robinhood — Dead-Pool Guard & Fake-Wick Fix — Handoff

> Continuation of `docs/robinhood-market-data-integrity-handoff.md`. Self-contained
> briefing on the "fake wick" work: what it is, the guard we built, the historical
> backfill, calibration lessons, and the KEY architectural discovery that changes the
> strategy. Written for a fresh AI/engineer.

---

## 0. TL;DR

- **Problem:** token charts show fake "wicks" — market-cap (fdv) spikes up (to $8T) or
  crashes down (to ~$0 / $8M on a $90M token) in a single candle. Root cause: swaps in
  **dead / near-zero-liquidity pools** drive the pool price to an economically
  meaningless extreme (one swap moves an empty pool anywhere). The `sqrtPriceX96`
  decode is correct; the price is real-on-chain but junk.
- **What we built:** a **live dead-pool guard** in `robinhood-processing` that rejects
  these at ingestion, plus a **historical backfill script** that replays the same rule
  over the past. Both committed (see §5).
- **KEY DISCOVERY (§6):** the fakes are almost always in **secondary/dead pools**, not
  the token's main pool — and the bot **already** selects a primary market **by volume**
  and the `buckets_agg` table already filters fdv to it. So the guard is treating a
  symptom; the real leak is the **chart read path** pulling per-market (all-pool) data
  instead of the primary-filtered aggregate. Fixing that is the cleaner fix and lets the
  guard be light instead of aggressive.
- **Calibration lesson:** the guard/backfill is a per-token relative band
  `[ref/K, ref*K]` (ref = rolling median of recent fdv) gated by swap volume. K=2.5 was
  clean on major tokens (~0.01-0.07% rejected) but K=2 + a $100 volume floor
  **over-rejected ~12%** (ate real small trades on volatile low-caps). Do **not** run
  the aggressive version.

---

## 1. Root cause (confirmed with data)

- fdv = price × supply. Price comes from a specific pool's swap. A dead pool
  (liquidity ~$0.80) lets one swap push the price to any extreme → junk fdv.
- Not a supply bug (supply is sane), not a decode bug (sqrt is correct), not fixable by
  an archive node (the data is present; it's economically meaningless).
- Live pipeline still produces them → needed a forward guard, not just a cleanup.
- Liquidity is **not** a usable signal: `liquidity_status = requires_tick_liquidity_distribution`
  dominates even healthy tokens with NULL liquidity, and `liquidity_usd` values are
  themselves poisoned. **Volume** is the reliable signal (a dead-pool swap moves ~no
  value → tiny volume; a real pump/dump has real volume).

---

## 2. The live guard (design)

Reject an accepted observation whose fdv is a **per-token relative outlier**, gated by
volume so real fast moves survive:

```
ref = rolling median of the token's last `sampleSize` accepted fdvs
outlier if  (fdv > K*ref  OR  fdv < ref/K)  AND  volumeUsd < minVolumeUsd
```

- **Relative-to-recent** (ref rolls with the price): kills a $0 crash while the token
  trades at $100M, yet keeps a genuine $0 at genesis (ref itself is ~$0 then). A gradual
  multi-day move is never cut — ref tracks it down/up; only isolated single-swap jumps
  far from the recent level are candidates.
- **Volume gate (both directions):** an out-of-band swap with `volumeUsd >= minVolumeUsd`
  is a REAL pump/dump and is **kept**. This was validated live: a token dumped in
  real time and the guard showed the whole dump (did not reject it).
- Rejected rows are set `status='rejected', rejection_reason='dead_pool_price'` — kept
  as evidence, excluded from buckets (bucket builds filter `status='accepted'`).

### Config (`config/index.js` → `robinhoodDeadPoolGuard`)
- `ROBINHOOD_DEAD_POOL_GUARD_ENABLED` (default true)
- `ROBINHOOD_DEAD_POOL_GUARD_MAX_MULTIPLE` (K, **float**, default **2.5**, min 1.5) —
  `parseFloatInRange` was added so decimals work.
- `ROBINHOOD_DEAD_POOL_GUARD_SAMPLE_SIZE` (default 500)
- `ROBINHOOD_DEAD_POOL_GUARD_MIN_VOLUME_USD` (default 100)

### Code
- `src/services/robinhood-price-spike-guard.js` — `evaluateFdvBand({fdvUsd, reference,
  maxMultiple, volumeUsd, minVolumeUsd})` (pure, tested). (Also holds `evaluatePriceSpike`
  / `replayMarket` used by the read-only PoC — legacy, superseded by the band function.)
- `src/models/robinhood-persistence.js` — `loadTokenFdvReference(token, sampleSize)` =
  median of the token's last N accepted fdvs (via the `market_time` index).
- `src/services/robinhood-processing-runner.js` — `createDeadPoolGuardApplier(...)` +
  wired into `valueObservationEntry` (reference cached per token per batch, like
  `v4RangesByPool`). Flips `accepted:false` so `normalizeObservation` persists it as
  `status='rejected'` (that status mapping is at `robinhood-persistence.js:509-523`).

---

## 3. Historical backfill (`src/utils/backfill-dead-pool-guard.js`)

Replays the **exact live rule** over persisted observations (do NOT use a coarse
calendar-median SQL cut — a per-day/per-hour median over-rejected 5-7M because low-
activity tokens have noisy bucket medians). Per token, in on-chain order, keeps a
rolling last-`sampleSize` window, bands each swap with the volume gate, marks
`status='rejected'/'dead_pool_price'`.

```
# dry-run (read-only), one token to sanity-check:
node src/utils/backfill-dead-pool-guard.js --token 0x<addr>
# full dry-run (tmux, resumable), throttled so it doesn't starve processing:
node src/utils/backfill-dead-pool-guard.js --max-multiple 2.5 --min-volume 15 \
  --sleep-ms 150 --checkpoint /opt/trendscope/dpg-dry.json
# apply (fresh checkpoint):
node src/utils/backfill-dead-pool-guard.js --apply --max-multiple 2.5 --min-volume 15 \
  --sleep-ms 150 --checkpoint /opt/trendscope/dpg-apply.json
```
- Dry-run prints `{scanned, rejected}`; progress = `scanned / ~84M`.
- `--sleep-ms` is mandatory in practice: without it the per-token scan starved the live
  processing worker (queue lag climbed). Processing lag = **latency, not loss** (captures
  are durable); it drains when the scan stops.
- After apply → rebuild buckets (see §7 of the other handoff): targeted 1m rebuild
  filtering `rejection_reason='dead_pool_price'`, then `DELETE` the poisoned 1h + agg
  rows and re-run `backfill-robinhood-market-aggregates.js` (its hourly upsert won't
  overwrite existing rows — must delete first).

---

## 4. Calibration lessons (IMPORTANT — do not repeat the mistakes)

- **K (maxMultiple):** on major tokens K=2.5 rejected ~0.01-0.07% (clean). Tightening to
  **K=2 with a $100 volume floor over-rejected ~12%** of ALL observations — it ate real
  small trades on volatile low-caps (memecoin swaps are often < $100, and low-caps swing
  > 2x their median naturally). **Do not ship the aggressive version.**
- **Volume floor:** $100 is too high (catches real micro-trades). $1-15 is safer —
  `$1` only cuts truly-empty pools (~$0 volume) and spares essentially all real trades;
  the risk is a moderate dead-pool (liquidity up to ~$755 observed) with $2-50 volume
  slipping through. Calibrate between $1 and $15 by watching `rejected/scanned` (target
  a low single-digit %, not 12%).
- **Band is symmetric.** Because ref rolls, a symmetric K does NOT clip gradual trends
  (a slow dump to $40M keeps ref ~ $40M). It only catches isolated single-swap jumps.
- A real dump's **overshoot bottom** may still print deeper than DEX/Axiom (which
  disagree with each other too — no single "correct" bottom). Tightening K or raising
  the volume floor pulls it up, at the cost of over-rejection. Prefer fixing §6 instead.

---

## 5. Commits (branch `Robinhood-Implementation`)

- `f28baef1` feat: reject dead-pool fdv outliers at ingestion (band vs recent median)
- `3361d032` feat: volume gate (keep real fast pump/dump)
- `23591ad4` chore: accept decimal maxMultiple (default 2.5) + `parseFloatInRange`
- `b1e68912` feat: historical dead-pool backfill (replays live guard)
- `d5e98321` perf: `--sleep-ms` throttle on the backfill
- (earlier) `bddfa73b` fix: wallet live worker bound by strict processing frontier
- (earlier PoC, read-only) `5444d7c0`, `01873bb6`, `3684f0b8`, `src/utils/poc-price-spike-guard.js`

**Deploy the guard:** `git push` → on VPS `git pull` +
`systemctl restart trendscope-worker@robinhood-processing`. (The processing worker was
accidentally SIGTERM'd once mid-session — keep it running / `systemctl enable` it.)

---

## 6. KEY DISCOVERY — the real fix is primary-market selection, not the guard

**The fakes live in secondary/dead pools, not the token's main pool.** Sampling CashCat's
rejected rows showed many different low-volume `market_key`s (v3/v4 dead pools), never the
main pool.

**The bot already selects a primary market — by VOLUME (not the unreliable liquidity):**
- `src/models/robinhood-market-aggregate.js:228-241` — `primary_markets` CTE picks, per
  (token, granularity, bucket_ts), the market with the highest `volume_24h_usd`.
- `src/models/robinhood-market-aggregate.js:246-277` — the aggregate candle's
  open/high/low/close for **both price and fdv** is `FILTER (WHERE market_key = primary)`.
  So the **`robinhood_market_buckets_agg` table is already correct** (dead pools excluded).
- `src/models/robinhood-token-read.js:98-146` — token list also ranks a primary by volume.

**So why do wicks still show?** Because cleaning secondary-pool observations changed the
chart — which means the **chart read path is NOT reading the primary-filtered agg**; it's
reading **per-market** data (`robinhood_market_buckets_1m` and `robinhood_market_buckets_1h`
are keyed by `market_key`, i.e. per-pool, with no primary filter) and letting dead pools
leak in. The primary-market logic exists in the AGG build but is bypassed by whatever the
chart actually queries.

**→ Next investigation (the productive one):** `src/models/robinhood-market-history-read.js`
(the candle read model that serves the chart). Determine, per granularity, whether it
reads the primary-filtered `buckets_agg` or the per-market `buckets_1m`/`buckets_1h`, and
route the token chart through the primary-filtered representation at **all** levels. If
the chart consumes only the primary (highest-volume) market's price/fdv, dead pools can't
poison it and the guard can be a **light safety net** (only catching an extreme swap that
lands in the primary pool itself, or volume-gamed primary selection) instead of an
aggressive filter that over-rejects.

---

## 7. Recommended path forward (priority)

1. **Deploy the live guard** (push/pull/restart processing) with **conservative** knobs:
   `MAX_MULTIPLE=2.5`, `MIN_VOLUME_USD` low (1-15). This stops the worst new fakes without
   over-rejecting. Keep processing worker running.
2. **Fix the read-path leak (§6)** — the real architectural fix. Route the chart through
   the primary-market-filtered data (`buckets_agg`) at all granularities, including 1m/1h.
   This removes most dead-pool wicks at the source.
3. **Then** re-run the historical backfill only if residual wicks remain in the primary
   pool — and keep it conservative (do not repeat the 12% over-reject).
4. Do NOT `ALTER` the hot pipeline tables (`robinhood_market_observations`,
   `robinhood_market_buckets_*`, cursors, `head_captures`) while a backfill or processing
   is running (exclusive lock → hang). Creating NEW tables (e.g. a holders feature) is
   safe anytime.

## 8. Quick reference queries

```sql
-- guard active on live? (count should climb over time)
SELECT count(*), max(observed_at) FROM robinhood_market_observations
WHERE chain='robinhood' AND rejection_reason='dead_pool_price';

-- processing health (latency, not loss; captures durable)
SELECT c.safe_head - (SELECT min(block_number) FROM robinhood_head_captures
  WHERE processing_status='pending') AS lag_blocks
FROM robinhood_head_capture_cursors c WHERE c.chain='robinhood' AND c.stream='market';

-- which pool a token's fakes came from (primary vs secondary)
SELECT market_key, volume_usd, fdv_usd, block_number
FROM robinhood_market_observations
WHERE chain='robinhood' AND token_address='0x<addr>' AND rejection_reason='dead_pool_price'
ORDER BY fdv_usd DESC LIMIT 10;
```

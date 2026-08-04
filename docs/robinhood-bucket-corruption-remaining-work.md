# Robinhood bucket corruption — remaining work

Handoff from the 2026-08-04 debugging session. Two separate defects behind the
broken charts (big up/down wicks, absurd FDV/volume). Root causes found; forward
fixes committed; historical cleanup still pending.

## The two defects

1. **v4 native-ETH transposition (live).** The head-processing decoder derived the
   v4 quote slot from the WETH *substitute* address instead of native ETH
   (`0x0` = currency0, slot 0), so it swapped token↔quote for native-ETH v4 pools —
   inflating price/volume ~1e9 (a real ~$1.6k swap surfaced as ~$46M/token,
   ~$39M volume). Scope: **22 tokens, 423 observations** (`market_key` v4 +
   `price_usd > 1e6`).
2. **Stale buckets (historical).** The old v2/v3 transposition was already repaired
   in the *observations* (Pass 1), but the *buckets* were never rebuilt, so the
   absurd wicks are frozen pre-repair values. Confirmed on `0x4b0c…`: observation
   `0.045`, bucket `2.15e25`. Not all tokens are affected — sampled 4, only 1 had
   the stale absurd wicks; the others matched observations (real volatility).

## Done 

- `b04e0790` — decoder fix: for v4, trust the frozen `quoteIndex` from `selectQuote`;
  keep address-ordering for v2/v3. Stops the live source. Regression test proven
  fail-before/pass-after.
- `28689c67` — repair tool `--target v4` pass: isolates the 423 transposed rows and
  reverses them with `recomputeTransposed` (same swap+revalue as v2/v3). Dry-run by
  default.

## Done

1. **Deploy the decoder fix.** Done
   ```bash
   git push
   # VPS2:
   cd /opt/trendscope/app && git pull
   sudo systemctl restart trendscope-worker@robinhood-processing
   ```
2. **Repair the 423 v4 observations** (after deploy, so no new corruption races it). Done
   ```bash
   node src/utils/repair-robinhood-fdv-observations.js --target v4 --mode dry-run
   # verify candidates ≈ 423, sample.after.priceUsd sane (~0.07), volume real; then:
   node src/utils/repair-robinhood-fdv-observations.js --target v4 --mode write
   ```
3. **Rebuild the buckets (chunked).** THE step that makes the charts look fixed —
   nothing before this touches a bucket. Rebuilds per-pool bucket data from the now-clean
   observations; the read-time pool merge is fine once the per-pool buckets are correct
   (the wicks were stale bucket rows, **not** the merge — no merge refactor needed).

   **What to target / how you know it worked:** for the previously-bad tokens
   `bucket_high == obs_max` (no more 2e25 wicks), the card's **VOL 24H** drops from ~1e17
   to real (millions), and the charts lose the up/down wicks. The rebuild recomputes
   `fdv_usd` from observations too, so it **auto-undoes the earlier bucket-FDV nulls**
   (`high_fdv > 1e12`) — correct FDV restored, or NULL for supply > 1e15.

   **Order:** finish all of 3a before 3b (3b reads from `_1m`).

   **3a — `_1m` from observations** — `backfill-robinhood-market-buckets-1m.js`.
   Block-windowed; each window is one DELETE+INSERT transaction, so it **must be sliced**.
   - Block span:
     ```sql
     SELECT MIN(block_number), MAX(block_number)
       FROM robinhood_market_observations WHERE chain='robinhood' AND status='accepted';
     ```
   - Slice with `--from-block`/`--to-block`, oldest→newest (`~875k blocks ≈ 1 day` here).
     Dry-run the first slice to size it (aim for a comfortable transaction, ≲ ~1M buckets),
     then write each:
     ```bash
     node src/utils/backfill-robinhood-market-buckets-1m.js --mode dry-run --from-block <X> --to-block <Y>
     node src/utils/backfill-robinhood-market-buckets-1m.js --mode write   --from-block <X> --to-block <Y>
     ```
   - Idempotent (re-run a slice freely); excludes the current live minute (won't race
     ingestion). **Never** run `--from-block 0` without `--to-block` in write — that is the
     single ~11.2M-bucket transaction to avoid.

   **3b — `_1h`/`_agg` from the corrected `_1m`** —
   `backfill-robinhood-market-aggregates.js`. Timestamp-windowed, `--mode write` needs
   `--checkpoint <file>` (phases fine/hourly/coarse, resumable from the checkpoint):
   ```bash
   node src/utils/backfill-robinhood-market-aggregates.js --mode dry-run --from '2026-06-10T00:00:00Z' --to '<now>'
   node src/utils/backfill-robinhood-market-aggregates.js --mode write   --from '2026-06-10T00:00:00Z' --to '<now>' --checkpoint /tmp/rh-agg-rebuild.json
   ```
   If heavy, split `--from`/`--to` into day/week windows; the checkpoint resumes.

   **Verify (a few known-bad tokens):**
   ```sql
   SELECT b.bucket_ts, b.high_price_usd,
          (SELECT MAX(o.price_usd) FROM robinhood_market_observations o
            WHERE o.chain='robinhood' AND o.status='accepted'
              AND o.token_address=b.token_address
              AND date_trunc('hour', o.observed_at)=b.bucket_ts) AS obs_max
     FROM robinhood_market_buckets_1h b
    WHERE b.chain='robinhood' AND b.token_address='<TOKEN>'
    ORDER BY b.high_price_usd DESC LIMIT 5;
   ```
   `high_price_usd` should now equal `obs_max`, and the card/chart should be clean.

   **Window:** 2026-06-10 → now — observations reach back to the start of the buckets,
   so the entire history is rebuildable, no un-recoverable gap.

## Key facts / gotchas

- Observations retain back to **2026-06-10** (not 3 days as first assumed) — confirmed
  the oldest bucket is also ~that date.
- Rebuild is **idempotent**: it fixes stale buckets and leaves clean ones identical.
- Card volume sources: **VOL 24H** = `_1h` full hours + `_1m` edges (fixed by the
  rebuild); **VOL 5M** = observations directly (fixed once obs are repaired + worker
  restarted).
- **Earlier self-inflicted damage to undo/verify in the rebuild:** during diagnosis we
  nulled bucket FDV where `high_fdv > 1e12` (1m/1h/agg) and nulled observation FDV for
  supply `> 1e15`. The FDV guard change to `evm-market-metrics.js` (human-supply ceiling)
  was deployed. The bucket-FDV nulls are restored by the rebuild (within the obs window)
  or expire; not a permanent loss.
- The Corte 5 derived-outbox work is still uncommitted WIP in the tree — leave it alone.
- Pre-existing red test: `tests/robinhood-processing-runner.test.js` (`['20000','20000']`)
  was already failing on HEAD before this session (WIP file); unrelated to these fixes.

## Open questions

- True breadth of the stale-bucket corruption (sampled 1/4). Doesn't block the rebuild
  (idempotent), but worth a count before committing to full-history chunks.
- Confirm no *other* decode bug beyond v4 native-ETH once the rebuild exposes clean data.

# Market History And Lateralization Plan

## Purpose
This document records the current working plan for reducing market-history storage cost while preserving the features we actually need next:

- `5m` market-cap delta
- `24h` mini sparklines
- future sideways / lateralized-token detection over `24-48h`

This plan is intentionally grounded in the current repository behavior rather than assumptions.

## Current Code Reality

### What happens today
- `src/services/catalog-worker.js`
  - reevaluates catalog tokens on a `2s` loop
  - persists one row into `token_market_snapshots` for every successful evaluation
- `src/models/token-market-snapshot.js`
  - stores raw point-in-time market snapshots
  - supports:
    - per-token history reads
    - current vs baseline market-cap lookup
    - latest-per-address reads
- `src/routes/dashboard.js`
  - uses `token_market_snapshots` to compute `prevMcap` and `mcapDelta`
  - only needs a current point and an approximate `5m` baseline
- `src/routes/catalog.js`
  - exposes `GET /catalog/history/:address` for raw market history
- `src/services/catalog-cleanup-worker.js`
  - deletes market snapshots only when tokens are archived from the catalog

### What this means in practice
- The current model stores far more granularity than the dashboard needs.
- For market history, the application mostly benefits from:
  - current state in `token_catalog`
  - a small amount of recent comparative history
- The raw market history endpoint exists, but the current frontend does not appear to depend on it directly.
- `listLatestByAddresses()` exists in `src/models/token-market-snapshot.js`, but there is no current caller for it.

### Important correction about priority semantics
Our discussion surfaced an assumption that `dormant` meant "low volume and under `30k` mcap".

That is not how the current worker behaves:
- `< 30k` mcap -> `low`
- `30k` to `< 100k` -> `normal`
- `>= 100k` -> `high`
- `dormant` is currently associated with missing / suppressed / unavailable cases rather than the normal low-cap path

This matters because the planned sideways finder is intended to consider only tokens above `90k` mcap, which means it will mainly operate on tokens that already receive relatively dense reevaluation coverage.

## Problem Statement

The current market-history storage strategy is too expensive for the value it returns.

Why:
- one successful evaluation inserts a new row
- hot tokens can be reevaluated every `2-5s`
- this produces tens of thousands of rows per token per day
- each row stores multiple numeric columns plus indexed timestamps

This is not needed for:
- `5m` delta
- `24h` sparkline
- `24-48h` sideways detection

## Target Design

### Keep `token_catalog` as the source of current truth
`token_catalog` should remain the place for:
- latest market cap
- latest price
- latest volume windows
- latest pair metadata
- current eligibility / priority state

This is already aligned with the current architecture.

### Replace raw high-frequency market snapshots with `1m` buckets
Introduce a new table for minute buckets, for example:

- `token_market_buckets_1m`

Suggested columns:
- `token_address`
- `bucket_ts`
- `open_mcap`
- `high_mcap`
- `low_mcap`
- `close_mcap`
- `open_price`
- `high_price`
- `low_price`
- `close_price`
- `sample_count`
- optional: `source`

Suggested key:
- unique `(token_address, bucket_ts)`

### Write with `UPSERT`, not append-only raw inserts
The worker can keep polling at its current cadence, but persistence should change:

1. derive the current minute bucket
2. `INSERT ... ON CONFLICT ... DO UPDATE`
3. on conflict:
   - preserve original `open_*`
   - update `high_*`
   - update `low_*`
   - update `close_*`
   - increment `sample_count`

This keeps high responsiveness without paying storage cost for every poll.

## Why `1m` Buckets Are The Best Fit

### For `5m` delta
Minute buckets are precise enough to compute a stable `5m` comparison without the excessive write rate of raw `2-3s` snapshots.

### For `24h` sparklines
`24h` at `1m` resolution means:
- `1440` points per token per day

That is dramatically cheaper than:
- `43200` points per token per day at `2s`

And it is more than enough for a PumpFun-style mini sparkline.

### For future sideways detection
`1m` buckets provide:
- enough density for `24-48h` window analysis
- much lower storage cost
- reusable input for future `5m` / `1h` rollups if needed

## What Not To Persist At High Frequency

The history table should not try to duplicate the entire current market-state payload.

In particular, avoid storing high-frequency history for:
- `vol_5m`
- `vol_1h`
- `vol_6h`
- `vol_24h`

Reason:
- these are already rolling aggregate values from Dex responses
- they are already useful in `token_catalog` as current state
- persisting them every minute adds cost without much future analytical value

For the planned sparkline and sideways detector, the most useful long-lived fields are:
- `price`
- `mcap`

## Planned Feature Uses

### 1. Dashboard `5m` delta
Future implementation should read:
- current `close_mcap` from the latest minute bucket or `token_catalog`
- baseline `close_mcap` from the bucket nearest to `now - 5m`

This replaces the current dependency on raw `token_market_snapshots`.

### 2. `24h` mini sparkline
Sparkline source:
- last `24h` of `close_price` or `close_mcap` from `token_market_buckets_1m`

Display recommendation:
- use `price` if the visual goal is a classic line chart
- use `mcap` if the UI emphasis is market-cap movement

Either way, the backend should return a pre-bounded series rather than raw unbounded history.

### 3. Sideways / lateralized token finder
Planned universe:
- tokens above `90k` mcap

This is a good fit for the current architecture because those tokens are usually in `normal` or `high` priority bands and already get denser refresh coverage than low-value tokens.

Suggested detection window:
- `24h`
- optional second pass on `48h`

Suggested minimum quality filters:
- minimum coverage ratio in the window
  - for example `>= 80%` of expected minute buckets
- minimum recent activity / volume
- exclude suppressed or clearly unhealthy tokens

Suggested sideways signals:
- compressed range
  - `(max(close) - min(close)) / avg(close)` below a threshold
- low net drift
  - `abs(last_close - first_close) / first_close` below a threshold
- controlled volatility
  - standard deviation of minute returns below a threshold

Important:
- do not classify illiquid dead tokens as "sideways" just because they barely moved
- volume and coverage filters are mandatory

## Retention Strategy

Recommended starting retention:
- `token_market_buckets_1m`
  - keep `48h` minimum
  - optionally keep `7d` if sideways analysis and chart tuning benefit from longer lookback

Optional later rollups:
- `token_market_buckets_5m`
- `token_market_buckets_1h`

Recommended later retention model:
- `1m` buckets for short horizon analysis and sparklines
- `5m` or `1h` buckets for longer-term historical reference

## Migration Plan

### Phase 1: Introduce minute buckets
- add `token_market_buckets_1m`
- add indexes on:
  - `(token_address, bucket_ts DESC)`

## Current State Update

The repository has now already completed the market-history migration that the earlier sections described:

- `token_market_buckets_1m` exists and is the primary market-history store
- the catalog worker writes minute buckets
- fresh raw `token_market_snapshots` are no longer written by the catalog worker
- `GET /api/catalog/history/:address` now reads bucket history
- dashboard `5m` market-cap baseline now prefers `1m` buckets and only falls back to legacy snapshots when needed
- soft archive cleanup now deletes `1m` market buckets for archived tokens
- a first production-calibrated `GET /api/catalog/lateralized` finder now exists

So the next step is no longer "design the lateralization finder". The next step is to move the current on-demand finder into a precomputed backend flow.

## Next Step: Precomputed Lateralization Worker

### Why this is the next step
The current lateralization finder is useful for rule calibration, but it is still an on-demand analytical route:

- request comes in
- backend fetches candidate rows and bucket history
- backend computes the ranking in-process
- response returns the result

This is acceptable for calibration, but it is not the best production shape because:

- it can become slow under larger candidate pools
- it is harder to compare one run vs another
- frontend/operator UX should not depend on heavy recomputation for every view

The target production direction is:

- backend worker computes the lateralization list periodically
- results are persisted
- API reads the latest completed run
- frontend only renders the prepared result

### Worker cadence
Recommended starting cadence:

- every `20m`

Why:

- lateralization is not a sub-second or even sub-minute signal
- `20m` is frequent enough for discovery/review
- `20m` is slow enough to avoid constant heavy recomputation

### Worker responsibilities
The worker should **reuse the current finder logic**, not invent a parallel implementation.

Each run should:

1. choose the configured evaluation window and candidate-pool policy
2. fetch the eligible candidate universe from `token_catalog`
3. apply the same banded pre-pool logic now used by the on-demand route
4. fetch the required `token_market_buckets_1m` rows
5. compute the same current lateralization metrics:
   - `rangePct`
   - `driftPct`
   - `coverageRatio`
   - `windowHoursUsed`
   - liquidity penalties / bonuses
   - age / bid-zone bonuses
   - final `score`
6. sort/rank candidates
7. persist the finished result set as one completed run

Important:

- the worker should call the same model-level calculation code the route uses today
- the route should later become a simple reader of the latest completed run
- do not maintain two independent scoring implementations

## Suggested Persistence Shape

### `lateralization_runs`
Purpose:

- store metadata about each completed or failed run

Suggested columns:

- `id`
- `started_at`
- `completed_at`
- `status`
  - e.g. `running`, `completed`, `failed`
- `requested_hours`
- `candidate_count`
- `result_count`
- `notes`
- `error_message`

### `lateralization_results`
Purpose:

- store the ranked candidates for one run

Suggested columns:

- `run_id`
- `token_address`
- `rank`
- `score`
- `mcap`
- `catalog_mcap`
- `window_mcap`
- `volume_1h`
- `volume_6h`
- `volume_24h`
- `range_pct`
- `range_limit_pct`
- `drift_pct`
- `drift_limit_pct`
- `coverage_ratio`
- `bucket_count`
- `sample_count`
- `expected_bucket_count`
- `age_hours`
- `current_position_pct`
- `window_hours_used`
- `minimum_window_hours`
- `liquidity_penalty`
- `monitor_priority`
- optional diagnostic JSON / columns for:
  - `passes_range`
  - `passes_drift`
  - `passes_coverage`
  - `passes_liquidity`
  - `passes_position`

Suggested index direction:

- `(run_id, rank)`
- `(token_address, run_id DESC)`

## API shape after worker migration

### What should change
`GET /api/catalog/lateralized` should stop doing the heavy calculation live.

Instead, it should:

- read the latest completed run
- return its persisted rows

Suggested response:

- `generatedAt`
- `runId`
- `requestedHours`
- `count`
- `candidates`

### Optional admin/manual trigger
In addition to the periodic worker, it is useful to expose an admin/manual recompute path.

Reason:

- calibration becomes easier
- rule tweaks can be validated immediately
- operators do not need to wait the full `20m`

This can be:

- admin-only route
- manual CLI/script
- or a worker method exposed through an admin action

The key requirement is:

- periodic automatic run for production
- manual recompute path for tuning/debugging

## Candidate-pool policy after worker migration

The current on-demand route uses a pre-pool guardrail mainly for latency control.

Once the worker owns the calculation:

- the pre-pool can be increased and remeasured
- but it should not be removed blindly

Recommended rollout:

1. keep the same current pool policy first
2. measure job duration and DB cost
3. only then consider increasing the per-band pool size

This avoids replacing request latency problems with background-job overload.

## Frontend consumption after worker migration

The frontend should **not** run the analytical computation.

It should read the stored result and render a dedicated lateralization panel/table.

Suggested fields to display first:

- rank
- symbol / name
- market cap
- `rangePct`
- `driftPct`
- `volume1h`
- `volume6h`
- `volume24h`
- `windowHoursUsed`
- score
- optionally a market-cap band badge:
  - `sub-1M`
  - `1M-4M`
  - `4M+`

This keeps the frontend simple and makes future ranking changes backend-owned.

## Recommended implementation order

1. add result tables
2. add worker service
3. reuse the current finder logic inside the worker
4. persist completed runs
5. switch `GET /api/catalog/lateralized` to read latest results
6. add optional manual/admin recompute path
7. only after that design the final frontend panel

This order keeps the current calibration work useful while moving the production system toward a cheaper and more stable runtime model.
  - optionally `bucket_ts DESC`
- add a model module for bucket writes / reads

### Phase 2: Change persistence behavior
- keep `token_catalog` writes as-is
- replace raw `token_market_snapshots` writes in `src/services/catalog-worker.js`
- write minute-bucket upserts instead

### Phase 3: Move consumers
- update dashboard `5m` delta reads to use minute buckets
- add a dedicated sparkline endpoint based on minute buckets

### Phase 4: Add cleanup / retention
- add scheduled deletion of expired `1m` buckets
- avoid relying only on catalog archival cleanup

### Phase 5: Add sideways finder
- build a query or service that scans `24-48h` minute-bucket windows
- restrict candidates by:
  - `mcap >= 90k`
  - coverage threshold
  - volume threshold
- return ranked sideways candidates

## Open Decisions

These points should be decided before implementation:

- Should the sparkline use `price` or `mcap` as the main series?
- Should the sideways detector use `price`, `mcap`, or both?
- Should `1m` buckets be retained for `48h` only or for a full `7d`?
- Should a small compatibility layer remain for `GET /catalog/history/:address`, or can that endpoint change shape later?

## Recommended First Implementation Pass

The highest-value first pass is:

1. add `token_market_buckets_1m`
2. switch market persistence from raw snapshots to minute-bucket `UPSERT`
3. move dashboard `5m` delta to minute buckets
4. add a basic `24h` sparkline API

Only after that:
- tune retention
- add sideways scoring
- decide whether the old raw market history endpoint should be preserved, adapted, or removed

## Non-Goals For This Plan

This plan does not attempt to replicate a full DexScreener historical engine.

Specifically, it does not aim to:
- reconstruct historical per-trade buy/sell data
- build full long-range market charts from raw swap events
- store every high-frequency Dex poll forever

That level of history would require a different ingestion model based on on-chain trade/event indexing rather than API polling snapshots.

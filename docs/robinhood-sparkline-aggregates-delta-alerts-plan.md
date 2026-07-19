# Robinhood sparkline, aggregate buckets, delta and standard alerts plan

Status: approved direction, implementation pending

Created: 2026-07-18

## Objective

Restore usable Robinhood monitored charts, materialize multi-resolution market
buckets, provide a stable canonical VOL 5M delta and connect the standard user
alerts to committed Robinhood market updates.

Execution order is mandatory:

1. fix the current sparkline timeout and incorrect range resolution;
2. persist Robinhood aggregate buckets and migrate history reads;
3. provide the canonical VOL 5M baseline and delta;
4. publish standard Robinhood alerts from the committed-swap path.

HVNC and custom spot alerts are outside this plan. They already have separate
Robinhood matchers and must not be used as evidence that standard alerts work.

## Confirmed repository state

### Robinhood history storage

Robinhood currently persists:

- `robinhood_market_buckets_1m`, retained for 14 days;
- `robinhood_market_buckets_1h`, retained permanently.

The 1m and 1h rows are market-level rows identified by protocol and market.
The history reader calculates token-level 5m, 15m, 30m, 4h and 24h candles at
read time. There is no persistent Robinhood multi-resolution aggregate table.

### Solana aggregate storage

Solana persists `token_market_buckets_agg` at these resolutions:

```text
5m, 15m, 30m, 60m, 240m, 1440m
```

That means 4h, not 6h, is a stored resolution. Six hours is a rolling analysis
window and can be computed from 1h or smaller buckets.

Although `token_market_buckets_agg` has a `chain` column, its payload is not a
valid Robinhood aggregate contract. It stores price and market-cap OHLC but has
no FDV OHLC, volume, swaps, buys, sells, transactions, market count or protocol
breakdown. Its writer and backfill also explicitly read Solana source rows.

### Standard alert ownership

The complete standard matcher is currently fixed to `ALERT_CHAIN = 'solana'`.
It owns:

- `monitored-vol`;
- `monitored-mcap`;
- 1h and 6h recent surge;
- 1h and 6h old-week surge.

The Robinhood publication batch currently owns HVNC and custom spot alerts,
not the standard rules above.

## Measured incident evidence

The 14-day monitored view requests 336 points at 5-minute resolution. The
Robinhood reader therefore scans and aggregates the 1m source across the full
14-day window and applies the 336-row limit only after grouping and ranking.

Read-only measurements on CASHCAT, JUGGERNAUT and MEMEDb:

```text
sparkline batch: 15,345 ms -> statement timeout
bounded source count: 10,179 ms -> statement timeout
```

For a continuously active token, 336 five-minute candles span only 28 hours.
The current request is therefore both expensive and unable to represent the
selected 14-day range faithfully.

The VOL 5M percentage flickers because the row renderer requires
`prevVolume5mCanonical`, but the exact dashboard enriches that field only for
Solana. A local snapshot may temporarily substitute the previous displayed
volume; a newer authoritative Robinhood response then replaces it with null.

## Target architecture

```text
committed Robinhood swaps
          |
          +--> durable 1m market buckets
          |          |
          |          +--> bounded aggregate refresh queue
          |                      |
          |                      +--> token-level RH aggregate buckets
          |
          +--> immediate token/window signal calculation
                     |
                     +--> standard alert state + transactional event

dashboard/chart readers --> precomputed aggregate buckets
```

The projection worker remains a cold catalog repair mechanism. It must not own
swap-time token updates, aggregate freshness or alert latency.

## Storage decision

Create a dedicated token-level table, provisionally named:

```text
robinhood_market_buckets_agg
```

Do not reuse `token_market_buckets_agg` without a separately approved schema
unification. A dedicated table preserves the distinct Robinhood valuation and
activity contract and avoids nullable cross-chain columns in the Solana path.

Required identity:

```text
(chain, token_address, granularity_minutes, bucket_ts)
```

Allowed granularities:

```text
5, 15, 30, 60, 240, 1440
```

Minimum payload:

- price USD OHLC;
- FDV USD OHLC;
- total USD volume across accepted V2, V3 and V4 markets;
- swaps, buys, sells and transaction contributions;
- market count and protocol coverage;
- first and last canonical block/log ordering values;
- source granularity and update timestamp.

Aggregation is token-level. Protocol and market contributions may be retained
as bounded observability metadata, but charts and standard alerts must never
mistake a single market for total token activity.

Retention target:

- 5m, 15m and 30m: at least the same 14-day detailed horizon as the 1m source;
- 1h, 4h and 24h: permanent, derived from the permanent 1h source;
- retention must never delete 1m data before the existing permanent 1h copy is
  complete.

## Execution cuts

Each cut must remain below 450 changed lines, stop after validation and wait
for explicit authorization before the next cut.

### Cut 1 - Immediate sparkline correctness and load shedding

Goal: make the current dashboard usable before introducing new storage.

Changes:

- derive chart granularity from effective range divided by requested points;
- snap to supported resolutions;
- expected mapping for a full range:
  - 1D -> 5m;
  - 3D -> 15m;
  - 7D -> 30m;
  - 14D -> 60m;
- keep finer resolution for genuinely young tokens only when it fits the point
  budget;
- split workspace sparkline batches by chain so a Robinhood timeout cannot
  discard an otherwise successful Solana result;
- add a bounded request timeout/abort path that clears loading state and exposes
  a retryable unavailable state instead of an indefinite spinner.

The 14D Robinhood request will then use the existing permanent 1h source.

Acceptance:

- a 14D request never queries the RH 1m table for its full range;
- dense 14D tokens return approximately one point per hour, capped at 336;
- a failed RH batch does not remove Solana charts;
- loading state always terminates on success, empty history, timeout or abort;
- measured first-page batch stays below the backend statement timeout under the
  same database load used in the incident measurement.

Validation:

- focused frontend granularity/cache tests;
- catalog market-history service tests;
- Robinhood history reader tests;
- `npm run lint`;
- `npm --prefix frontend run build`.

### Cut 2 - Aggregate schema and repository

Goal: add the durable RH token-level aggregate contract without changing live
readers yet.

Changes:

- add the next schema/init stage for `robinhood_market_buckets_agg`;
- add primary key, token/range lookup index and range cleanup index;
- register the table, columns, constraints and indexes in runtime schema checks;
- add a repository that deterministically folds market-level rows into one
  token candle;
- make upserts idempotent and safe when the active source bucket changes.

Acceptance:

- rerunning the same source range produces identical aggregate rows;
- V2+V3+V4 activity is summed exactly once;
- open/close ordering uses block/log order, not arbitrary SQL row order;
- high/low and FDV remain non-negative and internally consistent.

Validation:

- repository unit tests with multi-market and late-update cases;
- schema tests;
- `npm run db:schema-check` and test schema check;
- `npm run lint`.

### Cut 3 - Incremental aggregate writer

Goal: keep aggregates current without delaying the committed-swap critical
path.

Changes:

- enqueue only touched token/time ranges after a durable commit;
- coalesce duplicate refreshes by token and source bucket;
- refresh 5m, 15m and 30m directly from 1m source;
- refresh 1h, 4h and 24h from the permanent 1h source;
- bound batch size, concurrency, retry and memory;
- expose queue depth, oldest pending age, refresh latency and failures.

Unlike the current synchronous Solana aggregate-on-write path, RH aggregation
must not be awaited before immediate alert evaluation. Charts may lag briefly;
alerts may not.

Acceptance:

- ingestion cursor and alert publication proceed while aggregate refresh is
  delayed or failing;
- repeated updates to an active minute repair every affected parent bucket;
- queue recovery after restart is explicit and bounded, not a global scan.

Validation:

- queue/coalescing unit tests;
- persistence integration test for late updates;
- worker lifecycle test;
- `npm run lint`.

### Cut 4 - Chunked backfill and retention

Goal: populate existing RH history without saturating PostgreSQL.

Changes:

- add dry-run and write modes;
- backfill by bounded time/token chunks with statement timeout;
- support resume checkpoints and idempotent reruns;
- backfill fine resolutions only inside their retention horizon;
- build permanent 1h/4h/24h history from `robinhood_market_buckets_1h`;
- report scanned, written, skipped, failed and remaining ranges.

Acceptance:

- aborting and resuming does not duplicate or corrupt candles;
- normal ingestion latency remains observable during backfill;
- the operator can pause the backfill without disabling live aggregation.

### Cut 5 - Aggregate-backed history readers

Goal: remove expensive read-time regrouping from normal chart requests.

Changes:

- read exact stored resolutions from `robinhood_market_buckets_agg`;
- preserve an explicitly measured fallback during rollout only;
- batch and limit by canonical token identity;
- cache successful empty and non-empty results separately from failures;
- remove the fallback after aggregate coverage is proven.

Acceptance:

- normal sparkline reads do not aggregate the RH 1m table;
- 14D first-page chart batches return inside the agreed UI budget;
- old inactive tokens return empty quickly rather than timing out;
- expanded and mini charts agree on valuation type and time bounds.

### Cut 6 - Canonical VOL 5M delta

Definition:

```text
current = rolling USD volume in (T-5m, T]
baseline = rolling USD volume in (T-10m, T-5m]
deltaPct = ((current - baseline) / baseline) * 100
```

Changes:

- calculate both windows from the same committed RH coverage boundary;
- return `prevVolume5mCanonical`, baseline timestamp and coverage state;
- update live current volume on committed swaps while expiring contributions
  that leave the rolling window;
- stop fabricating the canonical field from the previously rendered value;
- do not let an omitted field erase a valid baseline for the same window;
- render `-` when baseline is zero, incomplete or unavailable.

Acceptance:

- the percentage does not appear and disappear across REST/socket merges;
- backend and frontend calculate the same result for fixed fixtures;
- combined V2+V3+V4 volume is used;
- a gap or partial window fails visibly instead of inventing a percentage.

Validation:

- rolling-window unit tests including expiry and late commits;
- dashboard route integration test;
- frontend merge/render regression test;
- `npm run lint` and frontend build.

### Cut 7 - Standard Robinhood alert signal source

Goal: construct standard signals immediately from each committed token update.

Required signals:

- VOL 5M change using the canonical windows from Cut 6;
- price/FDV change over 1h and 6h from committed bucket baselines;
- token age bucket and all existing user thresholds/filters;
- explicit coverage and valuation provenance.

This path must be targeted by touched token. It must not poll the entire catalog
or wait for the projection worker.

Acceptance:

- a committed swap can change the signal in the same publication cycle;
- no external metadata request exists in the commit-to-evaluation path;
- replaying the same committed observation is idempotent;
- missing baselines arm/fail closed according to the existing rule contract.

### Cut 8 - Standard matcher, state and publication

Goal: connect RH signals to the existing user-facing rule behavior without
weakening chain guards.

Changes:

- extract chain-neutral crossing/state logic where behavior is genuinely the
  same;
- keep chain-specific valuation and data-source adapters;
- persist state and event dedupe by user, rule, chain and token;
- reuse the opaque Robinhood publication authorization;
- publish after transactional event creation through the existing feed/socket;
- preserve cooldown, rearm and continuation behavior per standard rule.

Scope includes `monitored-vol` and 1h/6h surge rules. HVNC and custom spot rules
remain on their existing paths.

#### Required MCAP/FDV product decision

Robinhood currently has trusted FDV, not circulating market cap. Before this
cut, choose one explicit contract:

1. add a Robinhood `monitored-fdv` rule and label it FDV; or
2. keep `monitored-mcap` unavailable on Robinhood until circulating supply is
   trustworthy.

Never feed FDV into `monitored-mcap` while labeling the result MCAP.

Acceptance:

- threshold crossing emits once and replay emits zero additional events;
- a second user with a different threshold is evaluated independently;
- blocked rollout leaves rule state safe and emits nothing;
- Solana behavior and dedupe remain unchanged;
- commit-to-alert latency is measured separately from provider/block latency.

Validation:

- matcher unit tests per rule and valuation type;
- transactional publication integration tests;
- cross-chain identity and dedupe regression tests;
- alert-feed/socket contract tests;
- `npm run lint`.

## Rollout gates

Each behavioral cut progresses through:

```text
schema/repository -> dry-run -> shadow compare -> UI read -> publication
```

Required production evidence:

- aggregate queue age and error rate;
- chart query p50/p95/p99 and timeout rate by chain/resolution;
- coverage ratio between source and aggregate buckets;
- VOL 5M backend/frontend parity samples;
- expected-vs-published alert counts and suppression reasons;
- ingestion block lag before and after each rollout.

Rollback must be possible independently:

- readers can temporarily return to the existing 1h-safe path;
- aggregate writer can stop without stopping ingestion or alerts;
- alert publication can disable while shadow evaluation continues;
- no rollback deletes aggregate history automatically.

## Pontos importantes

- Aggregate buckets improve reads; they are not the source of low-latency alert
  truth. Alerts consume committed swap updates and bounded rolling state.
- Adding synchronous aggregate writes to the ingestion transaction would risk
  recreating the block-lag problem this work is intended to solve.
- Combined-chain sparkline requests require failure isolation; otherwise one RH
  timeout can still make healthy Solana charts appear unavailable.
- A stored 4h bucket does not replace the 6h alert window. Six-hour signals use
  a real six-hour baseline/window assembled from smaller buckets.
- Backfill is an operational workload and must be throttled against ingestion,
  not run as an unbounded migration.
- Empty history, incomplete coverage, timeout and internal error are distinct
  states and must remain distinguishable in metrics and UI behavior.
- No stage/schema cut is complete until runtime schema checks pass.
- No alert cut is complete until Solana regression tests prove unchanged
  behavior.

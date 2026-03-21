# Performance Optimization Plan

## Purpose
This document tracks the active plan for improving bot performance and reducing resource usage.

The current priority is:
- lower frontend RAM usage
- reduce CPU churn from repeated state rebuilds
- shrink backend response cost on hot paths
- improve bootstrap and config responsiveness

This plan is intentionally execution-oriented so we can use it as a working checklist while iterating.

## Current Working Hypothesis

The current performance issue is most likely not a single isolated bug.

The strongest hypothesis is a combination of:
- large and frequent `GET /api/dashboard/monitored` payloads
- full frontend state reconstruction every refresh cycle
- retention of in-memory structures longer than necessary
- repeated emits / recomputations under polling + socket activity

## Main Suspected Hotspots

### Frontend
- `frontend/src/state/app-controller.ts`
  - `refreshMonitoredDashboard()`
  - `applyMonitoredDashboard()`
  - `rebuildTrackedState()`
  - `deriveAgeBuckets()`
  - alert derivation during refresh cycles
- possible long-lived in-memory structures:
  - `state.data.meteoraByAddress`
  - `state.data.monitoredTokens`
  - `state.data.manualTokens`
  - `state.data.recentTokens`
  - `state.data.oldWeekTokens`
  - `state.data.eligibleCatalogTokens`
  - `state.data.pumpTokens`
  - `state.data.recentPumpMigrations`
  - `state.data.pumpToasts`

### Backend
- `src/routes/dashboard.js`
  - `GET /api/dashboard/monitored`
- `src/routes/config.js`
  - `GET /api/config`
  - `PUT /api/config`
  - `PATCH /api/config`
- snapshot/catalog read paths:
  - `src/models/token-catalog.js`
  - `src/models/token-market-snapshot.js`
  - `src/models/token-meteora-snapshot.js`

## Primary Goal

Reduce RAM usage, lower repeated allocation churn, and improve perceived responsiveness without changing the bot's intended behavior.

## Execution Plan

### Phase 1: Baseline Measurement

Before changing behavior, collect baseline numbers.

Checklist:
- measure response time of `GET /api/dashboard/monitored`
- measure payload size of `GET /api/dashboard/monitored`
- measure response time of `GET /api/config`
- measure payload size of `GET /api/config`
- record token counts in:
  - monitored
  - manual
  - recent
  - old week
  - pumpfun
- inspect whether these structures grow without shrinking:
  - `meteoraByAddress`
  - `eligibleCatalogTokens`
  - `pumpTokens`
  - alert/removal log collections
- capture RAM and CPU baseline:
  - idle session
  - active monitored polling
  - active socket/pumpfun session
  - long-running tab after 10-15 minutes

Outputs:
- measured hot endpoints
- estimated payload weights
- confirmed or rejected memory-growth suspects

### Phase 2: Highest-Impact Read Path Optimizations

Focus on the monitored refresh path first.

Goals:
- reduce payload size
- reduce backend per-request work
- reduce frontend object churn per refresh

Checklist:
- shrink `GET /api/dashboard/monitored` to only fields required for current UI and alerts
- reduce or eliminate expensive per-request history assembly where possible
- avoid recomputing data that can be pre-aggregated or persisted
- avoid rebuilding the full tracked state if only a subset of tokens changed
- avoid recreating large arrays/maps/sets unnecessarily

Likely targets:
- Meteora summary generation
- market baseline generation
- token-by-token enrichment on every request
- frontend full merge/rebuild flow on each polling cycle

### Phase 3: Frontend Memory Retention Control

Focus on long-lived state and cleanup discipline.

Checklist:
- prune `meteoraByAddress` entries for tokens no longer present
- cap temporary collections where safe
- review whether removed tokens still remain referenced in derived structures
- make PumpFun GC more aggressive if needed
- verify that removal logs, toasts, and recent migration state stay bounded
- reduce unnecessary `emit()` frequency on high-churn flows

Success condition:
- state size remains bounded during long sessions
- RAM does not climb aggressively over time

### Phase 4: Config and Bootstrap Optimizations

After the monitored hot path, optimize config/bootstrap.

Checklist:
- reduce cost of `PUT /api/config`
- replace sequential write loops with batch-friendly operations where possible
- avoid unnecessary rereads after writes
- avoid full reloads after small config changes
- keep first paint dependent on minimal required data
- defer non-essential hydration behind the initial usable UI

Success condition:
- login/session restore feels faster
- save/apply config operations feel more immediate

### Phase 5: Validation and Regression Safety

After each optimization wave, verify both correctness and performance.

Checklist:
- compare RAM before vs after
- compare CPU churn before vs after
- compare bootstrap time before vs after
- compare monitored refresh latency before vs after
- confirm alerts still trigger correctly
- confirm buckets/routing still match existing behavior
- confirm manual tokens, blocklist, and starred token flows still persist correctly

## Recommended Order Of Work

1. Instrument measurements for monitored/config paths.
2. Optimize `GET /api/dashboard/monitored`.
3. Reduce frontend rebuild churn on monitored refresh.
4. Add cleanup for retained in-memory state.
5. Optimize `PUT /api/config` and bootstrap follow-ups.
6. Re-measure and compare.

## Immediate Next Actions

The next concrete implementation pass should start with:
- adding lightweight timing / payload instrumentation
- identifying the largest contributors inside `GET /api/dashboard/monitored`
- identifying which frontend state collections are growing or being recreated most aggressively

## Experiment Results

### Phase 1 Baseline Findings

The first measurement pass confirmed that the main bottleneck was backend enrichment work in:
- `GET /api/dashboard/monitored`

Initial measured behavior:
- `GET /api/config`
  - healthy
  - low latency
  - small payload
- `GET /api/dashboard/monitored`
  - very slow before optimization
  - roughly multi-second response time
  - `catalogMs` was small
  - `enrichMs` dominated request time

Initial measured snapshot load patterns:
- `meteoraRows`
  - roughly ~27k rows per request
- `marketRows`
  - roughly ~15k rows per request
- response payload
  - around ~266-277 KB

Important conclusion from baseline:
- the main problem was not frontend render lag alone
- the strongest confirmed server-side bottleneck was monitored enrichment

### Backend Optimization Results

#### 1. Market snapshot read reduction

What changed:
- stopped loading up to 60 raw market snapshots per token for dashboard refresh
- replaced that with a targeted current + baseline read

Result:
- `marketRows` fell from roughly ~15k to roughly the token count

#### 2. Meteora snapshot read reduction

What changed:
- stopped loading raw 30h Meteora history per token for each monitored refresh
- replaced that with a summarized read that still preserves:
  - latest TVL
  - pool info
  - `1h`
  - `6h`
  - `24h` deltas

Result:
- `meteoraRows` fell from roughly ~27k to roughly the number of tokens with snapshots

#### 3. Query timing split

What changed:
- added separate timing metrics for:
  - `meteoraMs`
  - `marketMs`

What this revealed:
- after row-count reduction, the dominant remaining bottleneck was `marketMs`
- `marketMs` was still in the ~2.7s range before query rewrite
- `meteoraMs` was much lower by comparison

#### 4. Market query rewrite

What changed:
- rewrote the market baseline query to use a more targeted address-driven lookup strategy

Measured result after rewrite:
- `totalMs`
  - dropped from roughly ~2.5-3.1s to roughly ~138-200ms
- `marketMs`
  - dropped from roughly ~2.7-2.9s to roughly ~10-21ms
- `meteoraMs`
  - landed around ~109-166ms

Important conclusion:
- this solved the main backend bottleneck for monitored dashboard refresh

## Current Status

### Keep

These changes should remain:
- market baseline query optimization
- Meteora summary query optimization
- reduced market snapshot workload for dashboard refresh
- reduced Meteora snapshot workload for dashboard refresh
- backend monitored endpoint now operating around ~150ms instead of multi-seconds

### Temporary Instrumentation

These items are still useful for validation, but should be removed after performance work stabilizes:
- backend `[Perf]` request logs
- response perf headers:
  - `Server-Timing`
  - `X-Perf-Label`
  - `X-Perf-Response-Bytes`
- frontend `[Perf][Frontend]` logs
- `?perf=1`-driven frontend measurement mode
- `PERF_METRICS_ENABLED`

### In Progress

Current active focus:
- frontend memory / session-long RAM behavior

Why:
- backend hot path is now dramatically faster
- the browser tab still appears too heavy over long sessions
- current suspicion is frontend churn / browser-side overhead rather than the old backend bottleneck

## Frontend Follow-Up Focus

### Confirmed frontend pressure points

Areas under active suspicion:
- full app-shell rerender path on frequent `emit()`
- repeated tracked-state reconstruction on monitored refresh
- long-lived collections that may retain stale data
- session-long browser overhead from continuous updates

### First frontend cuts already applied

Changes already made:
- coalesced `emit()` calls into a frame-friendly flush path
- reduced uptime refresh frequency from 1s to 30s
- pruned stale `meteoraByAddress` entries

These changes should remain if validation looks good.

### Next frontend target

The next likely high-impact frontend target is:
- reducing full `rebuildTrackedState()` churn on each monitored refresh

## Next Steps

1. Test the current frontend with the backend improvements already in place.
2. Measure browser RAM behavior again with less instrumentation overhead.
3. Confirm whether frontend memory growth is materially improved after:
   - coalesced emits
   - slower uptime refresh
   - stale Meteora pruning
4. If the tab is still too heavy, optimize:
   - monitored refresh merge strategy
   - full state rebuild behavior
   - high-frequency render triggers

## Success Criteria

We should consider this effort successful when:
- the bot tab uses materially less RAM
- memory growth is more stable over time
- monitored refresh is cheaper and more responsive
- config/bootstrap latency is lower
- no important monitoring behavior regresses

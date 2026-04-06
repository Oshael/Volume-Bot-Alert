# High Cap Dump Alert Plan

## Purpose
This document defines the exact rule and staged implementation plan for a new alert type:

- `HIGH CAP DUMP 5M`

The goal is to make this alert work correctly according to real market behavior, not just fit the current frontend-owned alert shortcuts.

This plan is intentionally grounded in the current repository behavior and should be treated as the working implementation guide.

## Current Code Reality

### What exists today
- `src/services/catalog-worker.js`
  - already evaluates the canonical token market state on the backend
  - already writes `1m` market buckets through:
    - `tokenMarketBucket1m.upsertSnapshotBucket(...)`
    - `tokenMarketVolumeBucket1m.upsertSnapshotBucket(...)`
- `src/models/token-market-bucket-1m.js`
  - already persists:
    - `open_mcap`
    - `high_mcap`
    - `low_mcap`
    - `close_mcap`
  - already gives us the data quality needed for intrawindow dump detection
- `src/routes/dashboard.js`
  - currently exposes monitored-token market baselines for UI use
  - computes `prevMcap` / `mcapDelta` from recent buckets
- `frontend/src/state/app-controller.ts`
  - still owns monitored alert decisions in the browser
  - still depends on local/session alert state
- `docs/backend-alerts-migration-plan.md`
  - already documents that alert ownership should move to the backend over time

### What this means
- the backend already has the canonical market data needed for this alert
- the frontend is not the right source of truth for detecting a critical dump event
- if this alert stays frontend-only, the system will miss events when no live tab is open

## Rule Specification

## Alert name
- `HIGH CAP DUMP 5M`

## Product intent
Detect when a high-cap token suffers a sharp intrawindow collapse over the last `5m`, even if it partially recovers before the current bucket closes.

This is not the same as:
- current `MCAP` alert semantics
- current monitored-table `5m` delta display semantics

## Canonical source
Use backend `1m` market buckets from:
- `src/models/token-market-bucket-1m.js`

Do **not** make this rule depend on:
- frontend local token state
- browser session baselines
- currently mounted live tabs

## Universe
Initial recommended universe:
- tokens in `token_catalog`
- with recent backend market coverage
- with valid `1m` market buckets for the evaluation window

Important:
- this rule should not be limited to the frontend `Monitored` payload
- this rule should not depend on the current `LIMIT 500` dashboard-monitored query

## High-cap gate
Use:
- `baseline_mcap >= 2_000_000`

Do **not** use:
- `current mcap >= 2_000_000`

Reason:
- a token that falls from `8m` to `3m` is exactly the type of event we want
- gating on the current value would suppress true dump events

## Window
- evaluation window: `5m`

## Baseline
Use:
- the latest valid bucket with `bucket_ts <= current_ts - 5m`
- baseline value = that bucket's `close_mcap`

Rule:
- if there is no strict baseline for the `5m` anchor, do not alert

Do **not** reuse the looser UI fallback strategy used for dashboard visualization.

Reason:
- alert semantics must remain strict
- "5m dump" should not silently become "some older snapshot dump"

## Dump measurement
Inside the interval:
- `bucket_ts > baseline_ts`
- `bucket_ts <= current_ts`

Compute:
- `window_low_mcap = MIN(low_mcap)`

Then:
- `dump_pct = ((window_low_mcap - baseline_mcap) / baseline_mcap) * 100`

## Trigger condition
Alert when:
- `dump_pct <= -threshold_pct`

Initial threshold recommendation:
- `50`

This keeps the rule aligned with the current product discussion while leaving room for later tuning.

## Wick policy
This rule should count intrawindow wicks.

That means:
- if the token touched a `-50%` collapse within the last `5m`
- and later partially recovered
- it should still count as a valid dump event

Reason:
- using only `close_mcap` would miss the exact kind of violent failure this alert is meant to catch

## Minimum data quality requirements
To avoid bad alerts from sparse or stale data:
- require a valid strict baseline bucket
- require a fresh latest bucket
- require enough valid buckets in the evaluation window

Recommended starting constraints:
- latest bucket age <= `90s`
- at least `4` valid buckets in the window
- `baseline_mcap > 0`
- `window_low_mcap > 0`

If these conditions are not met:
- skip evaluation
- do not synthesize a weaker fallback alert

## Dedupe and rearm semantics

### Why this matters
Without backend state, the same dump can re-alert repeatedly every time the evaluator runs.

### Recommended semantics
Per token:
- when a dump event fires, mark the rule as `triggered`
- while still `triggered`, do not emit a duplicate alert for the same collapse leg
- rearm only after meaningful recovery or enough elapsed time

### Recommended recovery rule
Rearm when either condition becomes true:
- latest `close_mcap >= 85%` of the last alert baseline
- at least `6h` have elapsed since `last_alerted_at`

This means:
- one collapse leg -> one alert
- a real recovery -> rule can become armed again
- a long-stuck token can become eligible again after `6h` even without a near-full recovery
- a second collapse after recovery -> new alert allowed

Reason:
- recovery-based rearm avoids duplicate alerts during the same collapse leg
- the `6h` fallback avoids permanently deadlocking a token that never recovers to `85%` of the old baseline
- the alert still remains gated by the same minimum market-cap and dump conditions at the time of the next detection

## What this rule should not depend on
- current frontend `VOL` / `MCAP` monitored alert engine
- `min-vol`
- `min-mcap`
- `max-mcap`
- frontend cross-alert cooldown
- browser-local alert storage

Reason:
- those controls belong to the legacy/local monitored alert model
- they do not represent the semantics of a backend-owned high-cap crash detector

## Recommended Backend Shape

## Detection owner
Preferred owner:
- backend

Initial evaluation location:
- a backend-owned alert evaluator that reads `token_market_buckets_1m`

This can begin as a focused subsystem for this one rule before the broader alert migration is complete.

## Persistence
Recommended minimum persisted state:
- alert event record
- per-token rule state

Suggested minimum event fields:
- `rule_key`
- `token_address`
- `baseline_ts`
- `baseline_mcap`
- `window_low_mcap`
- `current_ts`
- `current_close_mcap`
- `dump_pct`
- `threshold_pct`
- `triggered_at`

Suggested minimum rule-state fields:
- `token_address`
- `rule_key`
- `status`
- `last_baseline_ts`
- `last_baseline_mcap`
- `last_window_low_mcap`
- `last_alerted_at`
- `last_alerted_pct`
- `rearm_required`
- `updated_at`

Important:
- this is intentionally smaller than the full future backend-alert model
- but it is already enough to avoid duplicate events and missed rearm behavior

## Frontend contract
The frontend should eventually:
- read the emitted alert feed
- render a dedicated card/badge/sound for `HIGH CAP DUMP 5M`
- stop owning the truth of whether the event exists

## Main Architectural Rule

Do **not** implement this as:
- "just another local alert in `app-controller.ts`"

Why:
- the frontend alert engine is session-local
- it only exists when the live workspace is open
- it depends on per-tab local state
- that is acceptable for legacy monitored alerts, but weak for a serious dump detector

This alert should be used to establish a proper backend-owned event path.

## Implementation Blocks

## Block 1: Backend Detection Foundation

### Goal
Create a strict, testable backend detector for `HIGH CAP DUMP 5M` using canonical `1m` buckets, without yet exposing the final frontend product surface.

### Part 1
Add a read-only detection query/model that can answer:
- what is the strict `5m` baseline for a token
- what is the minimum `low_mcap` in the window
- whether the token qualifies as a `HIGH CAP DUMP 5M` candidate

Expected output shape per token:
- `tokenAddress`
- `baselineTs`
- `baselineMcap`
- `currentTs`
- `currentCloseMcap`
- `windowLowMcap`
- `bucketCount`
- `latestBucketAgeMs`
- `dumpPct`
- `passesHighCapGate`
- `passesCoverageGate`
- `passesFreshnessGate`
- `passesThreshold`

Recommended write scope:
- `src/models/token-market-bucket-1m.js`
- tests for the new query/logic

This is the first implementation slice we should do.

### Part 2
Expose a temporary backend inspection surface for validation.

Example options:
- admin/debug endpoint
- internal-only route
- service method used by tests and manual inspection scripts

Purpose:
- inspect real candidates without yet committing to end-user delivery
- validate the rule against live data shape

### Part 3
Add automated coverage for:
- strict baseline requirement
- wick-based dump detection
- no false positive when current mcap falls below `2m` after starting above it
- no trigger on stale/sparse data

## Block 2: Backend Event State

### Goal
Turn the detector into a real event producer with dedupe and rearm semantics.

### Part 1
Add minimum persistence for:
- alert events
- per-token rule state

### Part 2
Implement dedupe and rearm logic:
- one collapse leg -> one event
- recovery to `85%` of baseline -> rule rearmed
- or `6h` elapsed since the last alert -> rule rearmed

### Part 3
Integrate the evaluator into backend runtime cadence without creating a second parallel market-ingestion pipeline.

Important:
- detection should consume the buckets already produced by the catalog worker
- do not invent a separate external polling worker

## Block 3: Frontend Consumption

### Goal
Expose the backend-owned event in the product UI without falling back to frontend-owned truth.

### Part 1
Add frontend alert type support for:
- card rendering
- badge semantics
- optional sound mapping

### Part 2
Add user-facing toggle / threshold controls only after the backend event path is stable.

Important:
- do not prematurely wire this into the old local monitored config semantics

### Part 3
Render backend-emitted dump alerts in the alerts surface and validate user experience.

## Block 4: Generalize Into The Larger Backend Alerts Migration

### Goal
Use the high-cap dump path as the first concrete step toward the broader backend-alert direction already described in:
- `docs/backend-alerts-migration-plan.md`

### Work
- compare the minimal dump-alert subsystem with the broader target alert architecture
- decide which pieces should be generalized next
- avoid duplicating tables/state models if Block 2 already proves the right shape

### Current implementation direction
The first generalization step should stay small and code-driven:
- create a backend alert rule registry in code
- centralize rule defaults there so the detector and the state machine cannot drift
- expose dashboard alert feeds through a service layer, not route-local ad hoc mapping
- reject unsupported backend alert rule keys explicitly instead of silently accepting arbitrary strings
- reuse the authenticated socket channel for realtime alert delivery, while keeping persisted-event polling as replay/recovery
- add per-user per-rule delivery cursors so replay/seen state does not depend on browser-local dedupe alone

Important:
- this does **not** mean the full multi-user backend alert migration is complete
- the current `HIGH CAP DUMP 5M` path is still a global token-event rule, not a per-user evaluated rule
- per-user thresholds/state belong to the larger migration and should not be faked by overloading the current global event model

## Recommended Execution Order
1. Block 1 Part 1
2. Block 1 Part 2
3. Block 1 Part 3
4. Block 2 Part 1
5. Block 2 Part 2
6. Block 2 Part 3
7. Block 3 Part 1
8. Block 3 Part 2
9. Block 3 Part 3
10. Block 4

## Why Block 1 Part 1 Comes First

This is the highest-signal first move because it lets us validate:
- the exact SQL/data semantics
- whether strict baseline selection is stable enough in real data
- whether wick-based dump detection produces the expected candidates

Without this step, we would be guessing about:
- event rates
- false positives
- sparse-data behavior
- how much of the later backend event layer is actually justified by real detections

## Ponto importantes
- O gate de high cap precisa usar `baseline_mcap`, nunca `current mcap`.
- O alerta precisa usar `low_mcap` intrajanela, nao apenas `close_mcap`.
- O baseline de `5m` deve ser estrito; fallback frouxo de UI nao serve para alerta critico.
- Esse alerta nao deve depender do `LIMIT 500` do dashboard monitored.
- Esse alerta nao deve depender da aba live estar aberta.
- O evaluator deve consumir buckets ja produzidos pelo catalog worker, sem criar pipeline paralelo de ingestao.
- Antes de expor toggle e som no frontend, precisamos provar que a deteccao backend esta correta e sem duplicacoes.

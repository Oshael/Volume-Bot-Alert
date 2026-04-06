# Meteora Refresh Fix Plan

## Goal
Fix the current Meteora behavior where new tokens/pools can stay undiscovered for too long and previously discovered pools can appear "current" even when the worker has not refreshed them recently.

## Current code-backed problems

### 1. Meteora scheduling is tied to the wrong freshness signal
- `src/services/meteora-snapshot-worker.js` currently selects tokens through `tokenCatalog.listEligibleForSnapshots(BATCH_LIMIT)`.
- `src/models/token-catalog.js` currently implements that query with:
  - `eligible_for_monitoring = TRUE`
  - `ORDER BY last_evaluated_at DESC`
- This means Meteora refresh priority is indirectly inherited from the catalog evaluation loop instead of using Meteora-specific freshness.
- Result:
  - recently evaluated tokens can monopolize the Meteora worker
  - never-checked or stale tokens can wait far too long

### 2. The worker only persists positive Meteora results
- `src/services/meteora-snapshot-worker.js` skips persistence when `tvl <= 0` or no result is returned.
- Result:
  - the system does not persist fresh "no pool right now" knowledge
  - old positive snapshots remain the latest known state

### 3. Historical snapshots are being used as if they were current state
- `src/models/token-meteora-snapshot.js` exposes latest snapshot summaries from the historical table only.
- There is no dedicated "current Meteora state" table today.
- Result:
  - a stale positive snapshot can still look current in the dashboard
  - lack of fresh checks is not distinguishable from stable pool state

### 4. Frontend hydration is narrower than the worker universe
- `GET /api/dashboard/monitored` embeds Meteora summary only for the monitored dashboard addresses.
- `frontend/src/state/app-controller.ts` hydrates `state.data.meteoraByAddress` from `monitoredDashboardTokens` only.
- Result:
  - even if the backend starts checking a broader universe, non-monitored tokens still will not automatically surface Meteora data in the current UI path

### 5. Current Meteora request shape is risky for low-visibility pools
- `src/services/meteora.js` calls `pair/all_by_groups` with:
  - `page=0`
  - `limit=100`
  - `sort_key=tvl`
  - `order_by=desc`
  - multiple `include_token_mints`
- This can bias results toward the top TVL pairs of the grouped response.

## Constraints and decisions
- No boost lane for migrated/manual/new tokens in Block 1.
- Worker loop should move from `30s` to `20s`.
- Block 1 should focus on scheduling fairness first.
- State-vs-history cleanup comes after scheduling.
- Meteora scheduling should now adapt automatically to the eligible universe size.
- The refresh budget is capped at `800 tokens/min`.
- Once the eligible universe grows beyond `800`, a full sweep is no longer guaranteed within `1m` and this is expected behavior, not scheduler drift.

## Implementation status
- Block 1: implemented
- Block 2: implemented
- Block 3: implemented
- Block 4: implemented

## Plan

### Block 1. Meteora Scheduling Foundation
Objective:
- stop using `last_evaluated_at` as Meteora freshness
- make the worker rotate fairly through the active Meteora universe

Scope:
- add Meteora-specific scheduling metadata to `token_catalog`
  - `last_meteora_checked_at`
- add a dedicated selection query for the Meteora worker
- base ordering on Meteora freshness, not catalog freshness
- widen the worker universe from `eligible_for_monitoring = TRUE` to active catalog candidates
- reduce loop cadence from `30s` to `20s`
- mark successfully checked tokens even when the worker does not find a positive pool snapshot

Expected outcome:
- newly seen or never-checked active tokens stop starving behind the hottest catalog rows
- the Meteora worker rotates through the catalog more evenly

### Block 2. Separate Current Meteora State From Historical Snapshots
Objective:
- stop treating historical snapshots as the canonical present-tense state

Scope:
- add a dedicated `token_meteora_state` table
- persist both positive and negative Meteora checks
- do not treat chunk/request failures as negative pool checks
- track:
  - `last_checked_at`
  - `has_pool`
  - `current_tvl`
  - `best_pool_address`
  - `pool_count`
  - `last_error`
- keep `token_meteora_snapshots` as history, not current truth
- switch dashboard summary reads to current state first

Expected outcome:
- stale positive snapshots stop pretending to be current
- the app can explicitly know "no pool found on the latest check"

### Block 3. Meteora Request Strategy Cleanup
Objective:
- reduce the risk that grouped/top-sorted Meteora responses miss lower-visibility relevant pools

Scope:
- revisit chunk size and request shape in `src/services/meteora.js`
- evaluate whether smaller chunks or one-token requests are needed
- keep total request rate comfortably under the documented DLMM API limit

Expected outcome:
- better coverage for smaller or newer pools
- lower chance that grouping/sorting hides relevant results

### Block 4. Frontend/Data-Surface Alignment
Objective:
- align the UI with the broader Meteora backend universe

Scope:
- review whether Meteora state should remain embedded only in `GET /api/dashboard/monitored`
- decide whether additional frontend surfaces need broader Meteora hydration

Expected outcome:
- backend coverage improvements are actually visible in the intended UI surfaces

## Block 1 implementation notes
- Block 1 should not introduce a fake current-state model on top of snapshots.
- Block 1 should stay limited to:
  - better selection
  - fair rotation
  - `20s` loop
  - Meteora-specific checked timestamps

## Block 2 implementation notes
- `token_meteora_state` is now the canonical current-state source for Meteora summary reads.
- `token_meteora_snapshots` remains historical-only.
- the worker persists:
  - positive checks with snapshot + current state
  - successful no-pool checks with current state only
  - chunk/request failures as `last_error`, without advancing `last_checked_at`
- dashboard and catalog Meteora summaries now read current state first, so stale positive snapshots no longer pretend to be current pool truth.

## Block 3 implementation notes
- Meteora requests now default to `1 token per request` instead of grouped multi-token lookups.
- requests are processed in small parallel waves instead of one giant serial stream.
- the default pacing is intentionally conservative:
  - concurrency `4`
  - wave delay `150ms`
- this keeps the worker comfortably under the previously verified DLMM API headroom while removing the main grouped-response bias from `sort_key=tvl`.

## Block 4 implementation notes
- the frontend no longer depends exclusively on `GET /api/dashboard/monitored` for all Meteora hydration.
- a dedicated batch-read surface now exists for explicit addresses outside the monitored dashboard payload.
- the app uses that surface to hydrate `meteoraByAddress` for tracked tokens that are rendered in manual/recent/old-week tables but are not currently present in the monitored dashboard result.
- `dashboard/monitored` remains scoped to its existing responsibility instead of becoming a generic Meteora payload for every rendered token.

## Important
- Block 1 improves fairness and refresh latency, but it does not fully solve stale Meteora truth by itself.
- The stale-state problem is only actually closed in Block 2.
- After Block 2, a missing Meteora result only counts as "no pool" if the chunk request itself succeeded.
- After Block 4, Meteora coverage improvements are visible in the existing tracked-token tables without bloating the monitored dashboard contract.
- The worker now sizes each cycle automatically from the current Meteora universe while honoring the `800 tokens/min` cap.
- The `20s` loop now compensates for its own run duration, so the scheduler targets a true wall-clock cadence instead of waiting `20s` after every completed run.

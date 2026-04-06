# Meteora Priority Scheduler Plan

## Goal
Add volume-aware Meteora prioritization without breaking fairness, current pool freshness, or the global `800 tokens/min` cap.

## Current constraint
- The current worker in `src/services/meteora-snapshot-worker.js` already adapts batch size to the eligible universe.
- It still treats the entire eligible Meteora universe as one flat queue.
- That means higher-volume tokens do not receive a shorter refresh target than lower-signal tokens.

## Design principles
- Keep the current Meteora eligibility rule:
  - `last_mcap >= 100k`
  - or `has_pool = true`
- Derive priority in runtime from catalog volume instead of introducing manual boosts.
- Respect a hard global refresh budget of `800 tokens/min`.
- Guarantee stronger cadence only while the priority tier fits inside the budget.
- Degrade automatically when demand exceeds budget.

## Tier model
- `high`
  - `last_vol_24h >= 100000`
- `normal`
  - `last_vol_24h >= 15000`
  - and below `high`
- `low`
  - remaining eligible Meteora tokens

## SLA model
- `high`
  - target refresh: `30s`
  - target behavior: can be checked `2x` inside `1m`
- `normal`
  - target refresh: `60s`
- `low`
  - target refresh: `5m`

## Budget model
- Global cap: `800 tokens/min`
- Each tier contributes a required checks-per-minute demand:
  - `tier_demand = tier_size * (60000 / target_refresh_ms)`
- If total demand is below `800`, all tiers get their target cadence.
- If total demand is above `800`, the scheduler degrades automatically:
  - preserve `high` first
  - then `normal`
  - then `low`

## Plan

## Implementation status
- Block 1: implemented
- Block 2: implemented
- Block 3: implemented
- Block 4: pending

### Block 1. Tier Foundation
Objective:
- define and expose Meteora priority tiers from existing catalog data

Scope:
- add tier derivation helpers in `src/models/token-catalog.js`
- add tier-aware Meteora counting
- add tier-aware Meteora listing
- keep current worker behavior unchanged for now

Expected outcome:
- the backend can describe the eligible Meteora universe as:
  - `total`
  - `high`
  - `normal`
  - `low`
- the next block can move scheduling logic without duplicating tier rules

### Block 2. SLA Budget Engine
Objective:
- compute how many checks each tier should receive per minute and per cycle

Scope:
- add budget helpers to `src/services/meteora-snapshot-worker.js`
- derive:
  - tier demand per minute
  - tier effective budget per minute
  - per-cycle batch targets
  - degraded state
- expose tier budget/status in worker telemetry

Expected outcome:
- the scheduler knows how much work it should attempt for each tier under the `800/min` cap

### Block 3. Tiered Execution
Objective:
- stop pulling one flat Meteora batch and execute by tier budget

Scope:
- fetch due addresses by tier
- compose the cycle batch from tier slices
- preserve freshness ordering inside each tier

Expected outcome:
- high-volume tokens get revisited more often whenever budget allows
- lower tiers still make forward progress instead of starving completely

### Block 4. Runtime Observation And Tuning
Objective:
- make the new scheduler observable and tunable

Scope:
- log effective tier budgets and degrade mode
- review whether the initial cutoffs and SLAs are correct under production load

Expected outcome:
- the bot can be tuned from real behavior instead of guesswork

## Important
- `2x/min` for `high` is conditional, not absolute. If the `high` tier alone grows too large, the cadence must degrade.
- This design does not require schema changes in the first pass because tier is derived from current catalog fields.
- Preserving `has_pool = true` below `100k` remains mandatory; otherwise known pools go stale again.
- Block 2 exposes tier math in worker status.
- Block 3 now composes the real cycle batch by tier and applies tier-specific due cutoffs before selecting addresses:
  - `high`: only tokens not checked in the last `30s`
  - `normal`: only tokens not checked in the last `60s`
  - `low`: only tokens not checked in the last `5m`
- Carryover slots from an underfilled higher tier can spill into lower tiers, but only for addresses that are also due under the lower tier SLA.

# Token Market Snapshots Removal Plan

## Purpose
This document defines the migration plan for removing `token_market_snapshots` completely without changing how the bot currently behaves.

The goal is not to redesign the alert engine.
The goal is to finish the old migration safely and eliminate the legacy raw-snapshot table that still exists mainly because earlier bucket migration work needed historical continuity.

## Current Code Reality

This plan is based on the current repository code, not on older assumptions.

### What must remain true after the migration
- `VOL` monitored alerts remain frontend-owned and session-local.
- `MCAP` monitored alerts continue to use backend-provided baseline data.
- current token values shown in the frontend continue to come from `token_catalog`.
- the frontend monitored polling cadence remains `3s`.
- `Manual`, `Recent`, and `Old Week` must continue receiving hot-field updates from the same monitored dashboard flow rather than degrading to `1m` bucket refresh.
- the bot must not become less reactive because of the migration.
- the bot must not require a fresh history reset to keep working.

### Current live sources of truth
- Current monitored values:
  - `token_catalog.last_*`
  - files:
    - `src/models/token-catalog.js`
    - `src/routes/dashboard.js`
- Current frontend `VOL` alert baseline:
  - session-local `prevVolume5m`
  - file:
    - `frontend/src/state/app-controller.ts`
- Current backend `MCAP` baseline:
  - primary: `token_market_buckets_1m`
  - fallback: `token_market_snapshots`
  - file:
    - `src/routes/dashboard.js`
- Current visual-only monitored `VOL 5M` card delta:
  - backend-provided `prevVolume5mCanonical`
  - currently sourced from `token_market_snapshots`
  - files:
    - `src/routes/dashboard.js`
    - `frontend/src/ui/sections/monitored-section.ts`

### Important current constraint
`token_market_buckets_1m` currently stores only minute-bucket market-cap/price fields:
- `open_mcap`
- `high_mcap`
- `low_mcap`
- `close_mcap`
- `open_price`
- `high_price`
- `low_price`
- `close_price`
- `sample_count`
- `source`

It does not currently store canonical minute-bucket volume-window fields such as:
- `vol_5m`
- `vol_1h`
- `vol_6h`
- `vol_24h`

That gap is the reason `token_market_snapshots` still matters today.

## Migration Goal

Remove `token_market_snapshots` entirely while preserving:
- frontend `VOL` alert behavior
- frontend `MCAP` alert behavior
- current monitored card values
- current monitored visual `VOL 5M` delta
- dashboard payload shape, unless a compatible internal source change is enough
- archival cleanup behavior
- runtime boot/schema validation behavior

## Chosen Direction

### Preferred architecture
Create a new sibling minute-bucket table dedicated to volume-window persistence instead of expanding `token_market_buckets_1m`.

Suggested name:
- `token_market_volume_buckets_1m`

Suggested responsibility:
- hold the canonical minute-bucket close values for rolling volume windows
- replace the remaining runtime need for `token_market_snapshots`
- avoid inflating the row width of `token_market_buckets_1m`, which already supports lateralization and bid-zone queries

### Why not simply expand `token_market_buckets_1m`
That option is possible, but it creates more risk in the most query-sensitive historical table in the system.

Problems:
- wider rows for a table that is already large
- more storage and I/O pressure on lateralization / bid-zone queries
- mixes two different semantic roles:
  - OHLC-style `mcap/price`
  - rolling-window close-only volume metrics

### Why not keep `token_market_snapshots`
That would preserve the current legacy complexity and ongoing storage cost.
It would also leave the migration half-finished.

## Proposed New Table

### Table
- `token_market_volume_buckets_1m`

### Key
- primary key:
  - `(token_address, bucket_ts)`

### Proposed columns
- `token_address VARCHAR(64) NOT NULL`
- `bucket_ts TIMESTAMPTZ NOT NULL`
- `close_vol_5m NUMERIC(20, 2)`
- `close_vol_1h NUMERIC(20, 2)`
- `close_vol_6h NUMERIC(20, 2)`
- `close_vol_24h NUMERIC(20, 2)`
- `sample_count INTEGER NOT NULL DEFAULT 1`
- `source VARCHAR(32) NOT NULL DEFAULT 'dexscreener'`

### Optional columns
Only add if the implementation genuinely benefits:
- `last_snapshot_ts TIMESTAMPTZ`

This should stay optional. The runtime behavior does not require it.

## Semantic Rules

### For the new volume bucket table
Treat the stored values as minute-bucket close values.

Within each minute:
- the first write starts the bucket row
- subsequent writes overwrite the `close_vol_*` fields with the latest observed values in that minute
- `sample_count` increments per additional write in the same minute

### Important semantic note
Do not model `vol_5m`, `vol_1h`, `vol_6h`, `vol_24h` as OHLC.
These are rolling aggregate windows from upstream market data, not natural candle-series fields.

Persisting close values per minute is the lowest-risk interpretation for:
- canonical visual baseline
- potential future debugging
- parity with current monitored dashboard needs

## Required Behavioral Invariants

The migration is only acceptable if all of the following remain true:

### Frontend monitored alerts
- `VOL` alert still compares:
  - session-local `prevVolume5m`
  - vs current `volume5m`
- it must not switch to backend canonical baseline
- it must not become bucket-driven

### Frontend hot-field refresh behavior
- `Manual`, `Recent`, and `Old Week` must continue showing current hot fields from the monitored dashboard/state merge path
- these hot fields include:
  - `mcap`
  - `priceUsd`
  - `volume5m`
  - `volume1h`
  - `volume6h`
  - `volume24h`
  - `priceChange1h`
  - `priceChange6h`
  - `priceChange24h`
- these values must continue refreshing on the current monitored dashboard cadence rather than degrading to `1m`
- minute buckets remain history/canonical-baseline inputs only

### Frontend monitored card visual delta
- `VOL 5M` card small delta should still use backend-provided canonical baseline
- only the internal source may change
- the frontend meaning of `prevVolume5mCanonical` must stay the same

### Backend dashboard contract
- current monitored values remain sourced from `token_catalog`
- `prevMcap` / `mcapDelta` remain backend-owned
- `prevVolume5mCanonical` remains available

### Worker cadence
- no slowing of the current catalog evaluation cadence
- no additional worker step that blocks token evaluation
- minute-bucket persistence must remain cheap enough to run inline with the current write path

## Migration Phases

## Phase 1: Add new volume bucket schema

### Scope
- create the new `token_market_volume_buckets_1m` table
- add its init script
- add it to runtime schema validation

### Deliverables
- `src/utils/db-init-stageXX.js` for the new table
- `src/utils/runtime-schema.js` updated
- indexes:
  - `(token_address, bucket_ts DESC)`
  - `(bucket_ts DESC)` if needed for retention/cleanup operations

### Acceptance criteria
- runtime schema can boot with both old and new tables present
- no existing runtime behavior changes yet

## Phase 2: Add model and dual-write path

### Scope
- create a new model for volume minute buckets
- keep existing `token_market_snapshots` writes temporarily
- add dual-write from the catalog worker

### Write behavior
On each successful market evaluation:
- continue updating `token_catalog`
- continue upserting `token_market_buckets_1m`
- also upsert `token_market_volume_buckets_1m`
- still write `token_market_snapshots` for now

### Reason
This de-risks the cutover by allowing:
- side-by-side verification
- data backfill parity checks
- zero immediate behavior change

### Acceptance criteria
- no frontend changes required
- current monitored dashboard output remains unchanged
- no worker regressions

## Phase 3: Backfill the new volume buckets from legacy snapshots

### Scope
- build a dedicated backfill utility for the new volume bucket table
- backfill minute-bucket close values from `token_market_snapshots`

### Backfill rule
For each `(token_address, minute)`:
- use the latest raw snapshot in that minute as:
  - `close_vol_5m`
  - `close_vol_1h`
  - `close_vol_6h`
  - `close_vol_24h`
- set `sample_count` to the number of raw snapshots that contributed to the bucket
- use a distinct `source` value such as `snapshot_backfill`

### Important note
Backfill should not try to reconstruct nonexistent semantics.
It should not create fake open/high/low volume data.

### Acceptance criteria
- a chosen validation window shows expected parity between:
  - old raw-snapshot-derived canonical `VOL 5M` baseline
  - new volume-bucket-derived canonical `VOL 5M` baseline

## Phase 4: Switch dashboard read path

### Scope
- update `GET /api/dashboard/monitored`
- remove runtime dependence on `token_market_snapshots`
- compute `prevVolume5mCanonical` from the new volume bucket table

### Read behavior after change
- current values:
  - still from `token_catalog`
- `prevMcap` and `mcapDelta`:
  - from `token_market_buckets_1m`
  - no legacy snapshot fallback
- `prevVolume5mCanonical`:
  - from `token_market_volume_buckets_1m`

### Important design rule
The dashboard route should not change the meaning of the payload fields.
Only the internal data source should change.

### Acceptance criteria
- frontend monitored cards render the same large `VOL 5M` current value
- frontend monitored small `VOL 5M` delta remains visually correct
- monitored `VOL` alerts remain unchanged because they still use frontend-local `prevVolume5m`

## Phase 5: Remove legacy runtime usage

### Scope
- remove `token_market_snapshots` writes from `catalog-worker`
- remove its cleanup deletion path
- remove model imports/usages in runtime code

### Files likely affected
- `src/services/catalog-worker.js`
- `src/services/catalog-cleanup-worker.js`
- `src/routes/dashboard.js`
- `src/models/token-market-snapshot.js`

### Acceptance criteria
- the application can boot and run without touching `token_market_snapshots`
- no remaining runtime reads/writes depend on it

## Phase 6: Remove migration-only support

### Scope
- remove stage-7 schema requirement for snapshots
- remove or archive backfill tools that only exist to read `token_market_snapshots`
- update docs to reflect the final architecture

### Files likely affected
- `src/utils/runtime-schema.js`
- `src/utils/db-init-stage7.js`
- `src/utils/backfill-market-buckets-1m.js`
- docs that still mention live usage of `token_market_snapshots`

### Acceptance criteria
- runtime schema no longer expects `token_market_snapshots`
- docs no longer contradict code reality

## Phase 7: Final production cleanup

### Scope
- stop dual-write if still active
- confirm no runtime references remain
- drop the table in the target environment

### Final cleanup actions
- optionally take a backup/export first
- then drop `token_market_snapshots`
- remove obsolete indexes if needed

### Acceptance criteria
- production/runtime behavior unchanged
- storage reduced
- no boot/schema failure

## Validation Plan

### Required code-level validations
- `VOL` monitored alert behavior unchanged
- `MCAP` monitored alert behavior unchanged
- `Monitored` `VOL 5M` visual delta still renders
- `Monitored` `D`/`MCAP` delta still renders
- `Manual`, `Recent`, and `Old Week` still receive hot-field updates on the existing monitored refresh cadence
- no boot failure from runtime schema checks
- cleanup worker still handles archived addresses correctly

### Required runtime comparisons during dual-write period
For a sample of active tokens:
- compare current `prevVolume5mCanonical` old-source vs new-source values
- compare monitored UI rendering before and after read-path cutover
- confirm alert firing cadence is unchanged for:
  - `monitored-vol`
  - `monitored-mcap`
  - `hvnc`
  - `old-surge`

### Required manual validation scenarios
1. Login and start monitoring.
2. Keep `/alerts` open and confirm the monitored list still refreshes every `3s`.
3. Confirm a token can still fire a frontend `VOL` alert.
4. Confirm the same token still respects cooldown and repeat-step behavior.
5. Confirm a token can still fire an `MCAP` alert.
6. Confirm `VOL 5M` card delta still shows a canonical backend baseline.
7. Confirm `Manual Tokens` still refreshes hot values such as `VOL`, `MCAP`, and `PCHANGE` on the existing dashboard cadence rather than `1m`.
8. Confirm `/monitor` still loads routed/history views and that `Recent Tokens` and `Old Tokens 1 Week+` still refresh hot values on the existing dashboard cadence rather than `1m`.
9. Confirm routed/lateralized/bid-zone views still load normally.
10. Confirm archived tokens still remove their minute-history rows.

## Rollback Strategy

### Rollback rule
Do not drop `token_market_snapshots` until the cutover has already been validated in production-like runtime.

### Safe rollback path before final drop
- keep old table intact
- if the new read path is wrong:
  - revert dashboard reads back to legacy snapshot source
- if new writes show issues:
  - disable new dual-write path
- if cleanup or schema changes fail:
  - restore prior runtime-schema requirements

### Unsafe rollback point
After final table drop, rollback becomes harder because historical raw snapshots are gone.
That is why final drop must be the last step, not an early cleanup.

## Non-Goals

This migration should not:
- redesign frontend alert semantics
- move `VOL` alerts from frontend to backend
- change monitored polling cadence
- change token priority cadence
- redesign lateralization or bid-zone ranking
- convert volume rolling-window data into OHLC candles
- rework `token_catalog` current-state ownership

## Open Questions Before Implementation

### 1. Table naming
Decide whether the final table should be named:
- `token_market_volume_buckets_1m`
- `token_market_metrics_1m`

Recommendation:
- prefer the more explicit `token_market_volume_buckets_1m`
because this table is specifically covering the volume-window gap left by removing `token_market_snapshots`.

### 2. Backfill window
Decide whether backfill should run:
- full history
- bounded recent history only

Recommendation:
- support both
- default to recent bounded history for safety
- allow `--all` for one-time controlled migrations

### 3. Cleanup retention
Decide whether volume minute buckets should follow exactly the same archive deletion rule as market-cap minute buckets.

Recommendation:
- yes, keep cleanup behavior symmetric by address archive

## Risks

### Highest-risk areas
- accidentally changing frontend `VOL` alert semantics
- accidentally making `prevVolume5mCanonical` unavailable in the monitored payload
- inflating worker write cost enough to affect freshness
- leaving runtime schema/docs partially inconsistent during the transition

### Lower-risk but still important
- stale or incomplete backfill causing visual delta gaps
- cleanup worker removing one bucket table but not the other
- tests covering only syntax/parsing while missing runtime behavior changes

## Decision Summary

The safest path to fully remove `token_market_snapshots` is:
- keep `token_catalog` as current-state source
- keep `token_market_buckets_1m` focused on `mcap/price`
- add a separate `1m` volume bucket table for canonical visual volume baselines
- dual-write first
- backfill second
- switch reads third
- remove legacy runtime usage fourth
- drop the old table only after validation

This is the lowest-risk route for preserving current bot behavior exactly while completing the migration cleanly.

## Pontos importantes
- O alerta `VOL` nao pode, em nenhuma fase, trocar `prevVolume5m` local por baseline persistido do backend.
- O `token_catalog` precisa continuar sendo a fonte dos valores atuais que o frontend consome a cada `3s`.
- `Manual`, `Recent` e `Old Week` nao podem passar a ler valores atuais a partir de bucket `1m`; os buckets devem continuar servindo apenas como historico/canonical baseline.
- O campo `prevVolume5mCanonical` precisa continuar existindo e com o mesmo significado visual no payload de `GET /api/dashboard/monitored`.
- `token_market_buckets_1m` ja e uma tabela critica para lateralizacao e bid-zone; inflar essa tabela sem necessidade aumenta o risco de regressao de performance.
- O `drop` final de `token_market_snapshots` so deve acontecer depois que nao houver mais nenhuma leitura, escrita, cleanup ou validacao de schema dependente dela.

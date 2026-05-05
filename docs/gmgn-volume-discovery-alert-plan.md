# GMGN Volume Discovery And Alert Plan

Last reviewed: 2026-05-03

This plan adds GMGN as a high-frequency discovery and volume-signal source without replacing the existing DexScreener catalog path. GMGN should find and refresh hot tokens quickly; DexScreener remains the fallback owner after a token leaves the GMGN panel.

Official docs checked: [GMGN Agent API](https://docs.gmgn.ai/index/gmgn-agent-api). The docs confirm API-key based query access, market/trending capabilities, IPv4-only support, and market data/candles. The page does not publish a hard request limit, so the requested cadence must be configurable and must back off on `429`/network failures.

## Implementation Status

- Block 1 - Schema and bucket model: implemented locally on 2026-05-03.
  - `token_market_volume_buckets_1m.close_vol_1m`
  - `tokenMarketVolumeBucket1m.upsertSnapshotBucket({ vol1m })`
  - safe `1m`/`5m`/`1h`/`6h`/`24h` volume baseline selection
- Block 2 - GMGN client and rate scheduler: implemented locally on 2026-05-03.
  - `gmgn-client` uses `gmgn-cli market trending --order-by volume --raw`
  - trending normalization maps queried interval volume into `vol1m`/`vol5m`/`vol1h`/`vol6h`/`vol24h`
  - scheduler plans `5` requests across `2s`, merges duplicate token rows by address across intervals, and backs off on `429`/rate-limit failures
- Block 3 - GMGN panel state and Dex handoff: implemented locally on 2026-05-03.
  - `token_gmgn_panel_state` tracks active/stale panel membership
  - panel cycles mark currently seen tokens active and stale missing tokens after `GMGN_PANEL_STALE_AFTER_MS`
  - stale transitions call `tokenCatalog.scheduleImmediateEvaluation(address)` for Dex refresh
- Block 4 - GMGN catalog ingestion: implemented locally on 2026-05-03.
  - GMGN snapshots update `token_catalog`; existing `user-manual` source is preserved
  - GMGN volume snapshots write `token_market_volume_buckets_1m` with `source='gmgn'`
  - per-token alert evaluation is debounced by `GMGN_ALERT_EVALUATION_MIN_INTERVAL_MS`
  - incomplete GMGN cycles do not mark missing panel tokens stale
- Block 5 - Alert matcher integration: implemented locally on 2026-05-03.
  - GMGN `5m` volume updates continue to use normal `monitored-vol`
  - GMGN `1m` spike alerts use separate `gmgn-vol-1m` state, but are disabled by default after live GMGN trending proved too noisy
  - one GMGN update can emit both normal `VOL` and `GMGN 1M` only if `GMGN_VOL_1M_ALERT_ENABLED=true`
- Block 6 - Observability and rollout: implemented locally on 2026-05-03.
  - `gmgn-discovery-worker` is controlled by `GMGN_DISCOVERY_ENABLED`
  - `GET /api/admin/ws-status` exposes GMGN worker request, ingestion, alert, backoff, and handoff counters
  - dashboard alert feeds include `gmgn-vol-1m`, and frontend alert cards render it as `VOL 1M`
  - `.env.example`, current state docs, and complete reference docs document rollout switches
- Noise-control update on 2026-05-03:
  - new GMGN tokens discovered only in the `1m` trending interval are skipped instead of inserted into `token_catalog`
  - existing catalog tokens can still be refreshed if they appear in `1m`
  - `gmgn-vol-1m` alert emission is disabled by default with `GMGN_VOL_1M_ALERT_ENABLED=false`
- GMGN junk guard update on 2026-05-03:
  - GMGN snapshots now run through the existing junk classifier before catalog upsert
  - high-confidence `junk_probable`/`junk_permanent` GMGN tokens are inserted into `admin_blocked_tokens` with `created_by=NULL`
  - medium-confidence junk from a brand-new GMGN token is skipped, not auto-blocked
  - existing `user-manual` tokens are protected from GMGN auto-blocking

## Target Behavior

- Poll GMGN with `5` requests every `2s`.
- Use `limit=30` per request.
- Persist market volume snapshots in `1m` buckets, matching the current DexScreener bucket period.
- While a token is visible in GMGN trending/panel results, GMGN can refresh its current catalog values.
- Once the token is no longer visible in GMGN panel results, hand it back to DexScreener refresh.
- Keep the normal `5m` volume alert semantics aligned with the existing `monitored-vol` rule.
- Add a GMGN-specific `1m` spike alert with an initial fixed threshold of `50%`.
- Add per-token alert limiting for both GMGN `5m` and GMGN `1m` alert paths.

## Current Repo Reality

The current Dex path already has most of the plumbing:

- [catalog-worker.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/services/catalog-worker.js) fetches DexScreener data, updates `token_catalog`, writes market buckets, then calls `user-alert-matcher.evaluateUpdatedToken(...)`.
- [token-market-volume-bucket-1m.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/models/token-market-volume-bucket-1m.js) stores minute-bucket close values for `vol_5m`, `vol_1h`, `vol_6h`, and `vol_24h`.
- [user-alert-matcher.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/services/user-alert-matcher.js) already applies the user `monitored-vol` threshold, min volume, min market cap, max market cap, mcap-declining suppression, cooldown, anchored repeat, event persistence, and realtime dashboard publishing.

Important mismatch: the bucket table does not currently store `close_vol_1m`. A GMGN `1m` volume alert needs either a new `close_vol_1m` column or a separate GMGN short-window table. The lowest-risk implementation is adding `close_vol_1m` to `token_market_volume_buckets_1m` and teaching the volume bucket model to query different volume columns safely.

## Request Cadence

Requested cadence:

```text
GMGN_REQUESTS_PER_WINDOW=5
GMGN_REQUEST_WINDOW_MS=2000
GMGN_TRENDING_LIMIT=30
```

Initial request slots:

1. trending by `1m` volume, `limit=30`
2. trending by `5m` volume, `limit=30`
3. trending by `1h` volume, `limit=30`
4. trending by `6h` volume, `limit=30`
5. trending by `24h` volume, `limit=30`

If GMGN starts returning rate-limit errors, the worker should not die. It should:

- pause the cadence for a short backoff window
- keep the last good panel state
- log the rate-limit mode
- resume with the same configured target cadence after recovery

The request cadence is ingestion cadence. Alert evaluation should still be debounced per token to about the existing `3s` comparison feel, because evaluating every `2s` would be subtly more aggressive than the current Dex-driven alert behavior.

## Data Flow

### 1. GMGN client

Add a small client layer:

- `src/services/gmgn-client.js`
- reads `GMGN_API_KEY`
- invokes `gmgn-cli` via `execFile`, without shell interpolation
- only supports query/data endpoints for this phase
- no private key, no swap/trading integration
- normalizes GMGN token rows into the same internal snapshot shape used by the catalog worker:
  - `address`
  - `symbol`
  - `name`
  - `imageUrl`
  - `pairAddress`
  - `pairUrl`
  - `mcap`
  - `price`
  - `vol1m`
  - `vol5m`
  - `vol1h`
  - `vol6h`
  - `vol24h`
  - `priceChange1h`
  - `priceChange6h`
  - `priceChange24h`
  - `liquidityUsd`
  - `tokenCreatedAt`

### 2. GMGN discovery worker

Add a worker:

- `src/services/gmgn-discovery-worker.js`
- runs only when `GMGN_DISCOVERY_ENABLED=true`
- schedules `5` GMGN requests per `2s`
- merges duplicate tokens across intervals before writing, preserving each interval's volume field
- marks each token as currently seen in GMGN panel state
- updates `token_catalog`
- writes `token_market_volume_buckets_1m`
- calls the alert matcher for eligible updates
- skips stale panel processing when the GMGN cycle is incomplete or rate-limited

The worker should not fetch DexScreener for active GMGN tokens during the hot panel phase. GMGN is the fresh source while the token is visible in GMGN.

### 3. Panel state and Dex handoff

Add persistent panel state so "left GMGN panel" is explicit:

```text
token_gmgn_panel_state
- token_address primary key
- first_seen_at
- last_seen_at
- last_interval
- last_rank
- last_mcap
- last_vol_1m
- last_vol_5m
- last_payload jsonb
- status active | stale
- dex_handoff_at
```

Handoff rule:

- If a token is absent from all GMGN result sets for `GMGN_PANEL_STALE_AFTER_MS`, mark it `stale`.
- On stale transition, call `tokenCatalog.scheduleImmediateEvaluation(address)` so the existing DexScreener catalog worker can refresh it.
- Do not interpret GMGN absence as a negative quality signal. It only means GMGN is no longer the freshest source.

Suggested initial value:

```text
GMGN_PANEL_STALE_AFTER_MS=15000
```

## Persistence

Use the existing `token_market_volume_buckets_1m` table period, with one schema addition:

```sql
ALTER TABLE token_market_volume_buckets_1m
  ADD COLUMN IF NOT EXISTS close_vol_1m NUMERIC(20, 2);
```

Then update:

- `src/utils/runtime-schema.js`
- a new `db-init-stageXX.js`
- `src/models/token-market-volume-bucket-1m.js`
- affected tests

The write semantics should stay the same as Dex:

- one row per `(token_address, bucket_ts)`
- latest sample in the minute wins
- `sample_count` increments
- `source='gmgn'` when GMGN wrote the latest close

Ponto importante: the current primary key is `(token_address, bucket_ts)`, not `(token_address, bucket_ts, source)`. That means Dex and GMGN cannot store separate close values for the same token/minute in this table. For v1 this is acceptable if we treat the row as "latest known market close", but it means source can flip between `gmgn` and `dexscreener`. If we later need side-by-side source comparison, that is a separate schema change.

## Alert Behavior

### GMGN 5m volume alert

The GMGN `5m` path should reuse the existing `monitored-vol` behavior instead of creating a parallel rule.

Flow:

1. GMGN worker receives token with `vol5m`.
2. Worker updates `token_catalog.last_vol_5m`.
3. Worker writes `close_vol_5m` to the `1m` bucket table with `source='gmgn'`.
4. Worker calls `userAlertMatcher.evaluateUpdatedToken(...)`.
5. Existing `monitored-vol` logic decides whether to alert.

This preserves:

- user `thresholdPct`
- user `minVol`
- user `minMcap`
- user `maxMcap`
- mcap-declining suppression
- `60s` cooldown
- anchored repeat against last alerted volume
- backend event persistence
- dashboard realtime delivery
- ticker-peer badge enrichment

Per-token spam limit:

- Keep the existing per-user/token/rule `user_alert_rule_state` cooldown and anchored repeat behavior.
- Add a GMGN ingestion debounce so the same token is not evaluated more often than `GMGN_ALERT_EVALUATION_MIN_INTERVAL_MS`.

Suggested initial value:

```text
GMGN_ALERT_EVALUATION_MIN_INTERVAL_MS=3000
```

### GMGN 1m volume spike alert

Add a new user-token backend rule:

```text
ruleKey: gmgn-vol-1m
kind: monitored-vol
label: GMGN 1M
default threshold: 50
```

Initial v1 should not add a new user setting in the UI. It should be gated by the existing `monitoredVol` enabled flag and existing common filters. This keeps the behavior aligned with users who already asked to receive volume alerts.

Qualification:

- GMGN provided `vol1m`
- `close_vol_1m` baseline exists at about `current_bucket - 1m`
- `((current_vol_1m - baseline_vol_1m) / baseline_vol_1m) * 100 >= 50`
- passes common filters:
  - current `vol5m >= profile.minVol`
  - current `mcap >= profile.minMcap`
  - current `mcap <= profile.maxMcap` when configured
  - not mcap-declining if the same signal inputs can prove decline
- token/user/rule is not cooling down
- token has advanced enough beyond the last alerted `vol1m`

Repeat/spam policy:

- cooldown: `60s` to start
- anchored repeat: next `vol1m` must be at least `50%` above the last alerted `vol1m`
- state key must be separate from `monitored-vol`, so `gmgn-vol-1m` does not block normal `5m` alerts and normal `5m` alerts do not block GMGN `1m`
- if both the normal `5m` alert and GMGN `1m` alert qualify in the same evaluation, emit both with independent state keys

Suggested config:

```text
GMGN_VOL_1M_ALERT_THRESHOLD_PCT=50
GMGN_VOL_1M_ALERT_COOLDOWN_MS=60000
GMGN_VOL_1M_REPEAT_STEP_PCT=50
```

Payload additions:

```text
source: gmgn
gmgnInterval: 1m
prevVolume1m
volume1m
volume5m
pct
label: GMGN 1M
```

Frontend can initially render it through the existing monitored volume alert card because `kind='monitored-vol'`, but the label should distinguish it from standard `VOL`.

## Source Priority

While `token_gmgn_panel_state.status='active'`:

- GMGN writes current market values.
- GMGN may trigger alert evaluation.
- DexScreener should not be forced for every GMGN update.

After GMGN status becomes `stale`:

- Schedule immediate Dex evaluation.
- DexScreener resumes ownership of catalog freshness.
- The token can still alert normally through existing monitored Dex path.

If Dex and GMGN disagree on values during a transition, the most recent catalog write wins in v1.

## Config

Add these env/config values:

```text
GMGN_DISCOVERY_ENABLED=false
GMGN_API_KEY=
GMGN_REQUESTS_PER_WINDOW=5
GMGN_REQUEST_WINDOW_MS=2000
GMGN_TRENDING_LIMIT=30
GMGN_PANEL_STALE_AFTER_MS=15000
GMGN_ACTIVE_DEX_RECHECK_MS=30000
GMGN_ALERT_EVALUATION_MIN_INTERVAL_MS=3000
GMGN_VOL_1M_ALERT_ENABLED=false
GMGN_VOL_1M_ALERT_THRESHOLD_PCT=50
GMGN_VOL_1M_ALERT_COOLDOWN_MS=60000
GMGN_VOL_1M_REPEAT_STEP_PCT=50
GMGN_BACKOFF_MIN_MS=5000
GMGN_BACKOFF_MAX_MS=60000
```

Keep `GMGN_DISCOVERY_ENABLED=false` by default until the VPS has the API key and the schema migration is applied.

## Implementation Blocks

### Block 1 - Schema and bucket model

- Add `close_vol_1m`.
- Update runtime schema check.
- Update `token-market-volume-bucket-1m` to write `vol1m`.
- Add a safe baseline reader for `1m` and `5m` volume columns.
- Tests:
  - bucket upsert stores `close_vol_1m`
  - baseline lookup for `1m`
  - schema check

### Block 2 - GMGN client and rate scheduler

- Add `gmgn-client`.
- Add token-bucket/rate-window scheduler for `5` requests per `2s`.
- Add request normalization and error/backoff handling.
- Tests:
  - rate slots
  - de-dupe by token address
  - 429 backoff does not crash worker

### Block 3 - GMGN panel state and Dex handoff

- Add `token_gmgn_panel_state` model/table.
- Mark active tokens each cycle.
- Mark stale tokens after absence window.
- Schedule Dex evaluation on stale transition.
- Tests:
  - active update
  - stale transition
  - immediate Dex evaluation scheduled once

### Block 4 - GMGN catalog ingestion

- Apply GMGN snapshots to `token_catalog`.
- Write `source='gmgn'` volume buckets.
- Debounce per-token alert evaluation to `3s`.
- Call `userAlertMatcher.evaluateUpdatedToken(...)` after valid updates.
- Tests:
  - catalog update
  - bucket write
  - alert matcher called after debounce

### Block 5 - Alert matcher integration

- Reuse existing `monitored-vol` for GMGN `5m`.
- Add `gmgn-vol-1m` candidate.
- Add rule metadata to `backend-alert-rules`.
- Ensure dashboard feed accepts the new rule key.
- Tests:
  - `5m` GMGN update emits normal `monitored-vol`
  - `1m` GMGN update emits `GMGN 1M` at `>=50%`
  - `1m` below threshold suppresses
  - per-token cooldown suppresses repeat
  - anchored repeat allows only a real advance

### Block 6 - Observability and rollout

- Add worker health metrics:
  - last successful GMGN poll
  - last GMGN error
  - current backoff
  - active panel token count
  - stale handoffs count
  - alert evaluations count
  - emitted GMGN 1m alerts count
- Add log lines with concise labels.
- Update docs after implementation:
  - `docs/current-bot-state.md`
  - `docs/bot-complete-reference.md`

Implemented status:

- Worker: `src/services/gmgn-discovery-worker.js`
- Config: `config.gmgnDiscoveryWorker`
- Status: `GET /api/admin/ws-status -> gmgnDiscoveryWorker`
- Frontend feed: `gmgn-vol-1m` is part of backend-owned alert rules
- Required VPS rollout:
  1. run `node src/utils/db-init-stage17.js`
  2. run `node src/utils/db-init-stage36.js`
  3. set `GMGN_API_KEY`
  4. set `GMGN_DISCOVERY_ENABLED=true`
  5. restart the background runtime

## Rollout

1. Deploy schema with GMGN disabled.
2. Set `GMGN_API_KEY` on VPS.
3. Enable `GMGN_DISCOVERY_ENABLED=true` in dry-run mode if implemented, or with alert emission disabled for one observation window.
4. Inspect:
   - GMGN request success rate
   - active panel count
   - bucket writes per minute
   - Dex handoff count
   - would-alert count for `gmgn-vol-1m`
5. Enable alert emission.
6. Keep `GMGN_VOL_1M_ALERT_THRESHOLD_PCT=50` until we have enough false-positive/false-negative examples.

## Pontos importantes

- The requested `5 requests / 2s` cadence is aggressive relative to unknown public rate limits. It should be config, not hardcoded.
- The GMGN docs currently mention IPv4-only support. If the VPS egress uses IPv6 for that route, requests may fail even with a valid API key.
- GMGN panel absence is not a ban signal and not a junk signal. It only triggers Dex handoff.
- While GMGN owns a hot token, `GMGN_ACTIVE_DEX_RECHECK_MS` keeps Dex from immediately re-evaluating it on every catalog update; stale handoff still sets Dex evaluation to `NOW()`.
- The existing bucket table cannot preserve Dex and GMGN side-by-side for the same token/minute. V1 should treat the bucket row as latest known close; source comparison is a later schema decision.
- The `1m` alert is intentionally separate from standard `monitored-vol` state. Otherwise a fast GMGN spike could block the normal `5m` alert, or the normal `5m` alert could hide the `1m` spike.
- The `1m` GMGN alert should start with fixed `50%` because `1m` rolling volume is noisy and GMGN panel tokens are already biased toward high activity.
- Do not add GMGN trading/private-key behavior in this implementation. Query API key only.

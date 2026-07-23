# Operations Runbook

Last reviewed against code on `2026-07-13`.

This runbook is for launch operation and emergency response. It assumes the VPS runtime is split into:

- `volume-bot-alert-web.service`
  - public API/socket process behind `nginx`
  - `RUN_SOCKET_HUB=true`
  - `RUN_BACKGROUND_JOBS=false`
- `volume-bot-alert-worker.service`
  - background jobs only
  - `RUN_SOCKET_HUB=false`
  - `RUN_BACKGROUND_JOBS=true`

## First Checks

Use these before changing anything during an incident:

```bash
systemctl status volume-bot-alert-web
systemctl status volume-bot-alert-worker
journalctl -u volume-bot-alert-web -n 120 --no-pager
journalctl -u volume-bot-alert-worker -n 160 --no-pager
```

Runtime endpoints:

```bash
curl -sS https://api.trendscope.pro/api/health
```

Admin-only status:

```text
GET https://api.trendscope.pro/api/admin/ws-status
```

Expected launch shape:

- public health reports `runtime.role = web`
- public health reports `socketEnabled = true`
- public health reports `backgroundJobsEnabled = false`
- admin status shows worker health and `workerLeases`
- every active worker lease has one current owner

## Log Sources

Web/API and sockets:

```bash
journalctl -u volume-bot-alert-web -f
```

Background workers:

```bash
journalctl -u volume-bot-alert-worker -f
```

Nginx:

```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

Postgres logs depend on distro/config. Check the active path before relying on one:

```bash
sudo systemctl status postgresql
sudo journalctl -u postgresql -n 120 --no-pager
```

Slow-query logging is controlled by:

- `DB_LOG_SLOW_QUERIES`
- `DB_SLOW_QUERY_LOG_MS`

The app default is to log slow queries, with a production threshold of `2500ms`.

## Safe Restarts

Restart web without restarting workers:

```bash
sudo systemctl restart volume-bot-alert-web
```

Restart worker without dropping the public UI/API:

```bash
sudo systemctl restart volume-bot-alert-worker
```

Stop only worker work:

```bash
sudo systemctl stop volume-bot-alert-worker
```

After stopping or restarting workers, verify leases:

```text
GET /api/admin/ws-status
```

The worker process releases leases on clean `SIGINT`/`SIGTERM`. A hard crash or `kill -9` relies on lease TTL expiry before another standby owner can take over.

## Emergency Switches

These are environment/config switches read by the backend. Change the worker environment, then restart the worker service.

Pause Bid Zone worker:

```text
BID_ZONE_WORKER_ENABLED=false
```

Disable GMGN discovery:

```text
GMGN_DISCOVERY_ENABLED=false
```

Keep GMGN 1m volume alerts disabled:

```text
GMGN_VOL_1M_ALERT_ENABLED=false
```

Reduce aggregate write pressure:

```text
MARKET_BUCKET_AGGREGATE_ON_WRITE_ENABLED=false
```

Tune DB pressure:

```text
DB_POOL_MAX=20
DB_SLOW_QUERY_LOG_MS=2500
DB_LOG_SLOW_QUERIES=true
```

Split worker groups only if the service units are configured with different ports and the operator is watching leases:

```text
BACKGROUND_WORKER_GROUPS=core
BACKGROUND_WORKER_GROUPS=market
BACKGROUND_WORKER_GROUPS=maintenance
```

Robinhood ingestion is deliberately outside `all`. During its controlled
rollout, run it as a separate service/process only:

```text
BACKGROUND_WORKER_GROUPS=robinhood
ROBINHOOD_INGESTION_ENABLED=true
ROBINHOOD_TRANSPORT_ENABLED=true
ROBINHOOD_PERSISTENCE_ENABLED=true
ROBINHOOD_ALERTS_ENABLED=false
ROBINHOOD_START_BLOCK=<declared initial coverage block>
ROBINHOOD_MARKET_LOG_FILTER_MODE=topics-only
ROBINHOOD_MAX_ADDRESSES_PER_LOG_REQUEST=100
```

After both persistent cursors exist, restarts use the DB cursors; retaining the
same `ROBINHOOD_START_BLOCK` is safe because it is only the missing-cursor
fallback. Never combine the isolated `robinhood` group with shared groups.

Use `topics-only` for the current registry scale. It requests the supported
market event topics once per range and the pipeline discards emitters absent
from the registry before persistence. `tracked-addresses` is the rollback mode,
but it shards every registered V2/V3 address and is not suitable for the
current registry without provider capacity validation.

If the worker reports `observation.priceQuote must be greater than zero`, stop
the old process and deploy the precision fix before resuming. Positive prices
below the persisted 80-decimal boundary are rejected as
`price_below_persisted_precision`; they must never keep a market range retrying
indefinitely.

Timestamp enrichment uses JSON-RPC batches of up to 10 block reads. Batch
responses are matched by request ID rather than response order; one failed or
missing item fails the range atomically. Providers without batch support fall
back once to bounded individual requests. Check
`lastSnapshot.enrichment.timestamps.rpcBatchRequests`, `batchFallbacks` and
`batchEnabled` in admin status when diagnosing throughput or 429s.

Continuous ingestion pins `eth_getLogs`, head reads, block reads and timestamp
batches to the Robinhood public provider. Only state methods with an explicit
historical block tag (`eth_call`, `eth_getCode`, `eth_getStorageAt`) may use the
configured archive fallback. This prevents large log ranges from consuming an
Alchemy Free allowance. `ROBINHOOD_RANGE_SIZE` and `ROBINHOOD_MAX_RANGE_SIZE`
accept values from 1 through 10,000; increase them only after a public transport
probe and a persistence soak, because larger market ranges commit atomically.

Persistent ingestion deliberately disables the read-only rollback maps and
24-hour analytical window aggregator after an extended soak exhausted the
Node.js heap. Persistence, cursor commits and timestamp batching are unchanged.
During soak, confirm the admin status remains:

```text
lastSnapshot.inMemoryState.rollbackEnabled=false
lastSnapshot.inMemoryState.observations=0
lastSnapshot.inMemoryState.discoveries=0
lastSnapshot.inMemoryState.windowAggregationEnabled=false
lastSnapshot.inMemoryState.windowEvents=0
```

The standalone read-only runner still exposes analytical windows and keeps a
bounded rollback map compatible with the poller's 10,000-log retention. Do not
enable those read-only structures in the persistent writer to obtain reports;
use the persisted buckets and the separate signal dry-run instead.

Before persistence starts, every configured Robinhood RPC provider must answer
`eth_chainId = 4663`. A wrong chain, missing bootstrap boundary or persistent
reorg halts ingestion fail-closed. The fatal state is durable and appears at:

```text
robinhoodIngestionWorker.sharedLease.metadata
```

Do not clear `state=halted` just to make the worker run again. First stop the
dedicated Robinhood service, diagnose `haltCode`/`haltMessage`, verify the RPC
chain and confirm that the persistent cursors/checkpoint are safe. Then remove
only the diagnosed tombstone and restart the dedicated service:

```sql
SELECT lease_key, owner_id, heartbeat_at, lease_until, metadata
FROM worker_leases
WHERE lease_key = 'robinhood-ingestion-worker';

DELETE FROM worker_leases
WHERE lease_key = 'robinhood-ingestion-worker'
  AND metadata->>'state' = 'halted';
```

After restart, confirm `sharedLease.metadata.state` is no longer `halted` and
both persistent cursors advance. If the tombstone returns, keep ingestion
stopped and investigate the underlying checkpoint/configuration failure.

When the pool registry is empty, bootstrap historical discovery before the
market soak. This command does not start the market writer or publish signals:

```bash
ROBINHOOD_DISCOVERY_BOOTSTRAP_START_BLOCK=<verified deployment boundary> \
  npm run robinhood:discovery-bootstrap
```

The first batch requires the explicit boundary. Later batches resume from the
persisted `discovery` cursor, even if the environment variable is unchanged.
Each invocation is bounded by `ROBINHOOD_DISCOVERY_BOOTSTRAP_MAX_RANGES`; rerun
until the report returns `status=caught-up`. Keep Alchemy disabled initially:
its 250-block `eth_getLogs` requests returned HTTP 400 during the latest probe,
while the public RPC accepted them and can adaptively shrink rejected ranges.
Do not start the market worker merely because discovery caught up; declare its
separate recent `ROBINHOOD_START_BLOCK` first.

The historical bootstrap intentionally excludes NOXA launch enrichment because
the corresponding pools are already discovered authoritatively through the V3
factory. Replaying every old launch required historical `eth_call` and changed
an estimated sub-hour registry scan into a multi-hour metadata job. New NOXA
launches remain in the continuous discovery filter after the bootstrap cutoff.

The Block 11 signal comparison is a separate one-shot read-only command:

```bash
npm run robinhood:signal-dry-run
```

The initial calibrated profile is enabled for `uniswap-v2` only: a closed
five-minute window, USD 3,000 liquidity, USD 1,000 volume, 10 transactions and
a maximum token age of 24 hours. `ROBINHOOD_SIGNAL_PROTOCOLS` is an explicit
allowlist; do not add V3/V4 merely because their raw liquidity field is
non-null. The report always returns `publishable=false` and
`publicationAttempts=0`; it must not be used as evidence that catalog or alert
delivery is enabled. Candidate windows use closed one-minute buckets and
cannot exceed the 14-day retention.
`ROBINHOOD_SIGNAL_STATEMENT_TIMEOUT_MS` bounds the global window scan; do not
raise it before inspecting a representative production `EXPLAIN`.

Liquidity is currently actionable only for Uniswap V2. The persisted value is
twice the quote reserve at the observed spot quote, carries `medium` confidence,
and is explicitly manipulable. Uniswap V3/V4 retain their raw liquidity scalar
but expose no USD value, so the liquidity gate stays fail-closed. Old buckets
created before Stages 67/68 are nullable and also stay fail-closed until new
observations refresh them. Do not backfill either case with a V2 formula.

The address limit controls request partitioning, not cursor partitioning. Every
shard for a block range must succeed before the discovery/market cursor moves.
Lowering it reduces provider filter size but increases RPC requests. During
soak, watch `logRequests`, `addressShardedRanges`, provider bytes/429s, and the
compact NOXA `seen/accepted/rejected` counters before changing the default.
NOXA validation reads historical state at the launch block. Confirm the public
RPC supports that depth or enable the Alchemy fallback before a deep backfill;
otherwise the discovery cursor will correctly remain stopped at that range.

### Robinhood catalog inactivity semantics

The catalog projection worker does not demote persistent identities after 15
minutes without swaps. Existing `robinhood-dashboard-inactive` and
`robinhood-no-swaps-15m` values are legacy diagnostic history, not current
workspace lifecycle or alert authority. Do not repair or mass-update those
rows during an incident.

`robinhoodCatalogProjectionWorker.lastSummary.demoted` remains temporarily in
admin telemetry and is always `0`. Use the normalized activity/valuation
freshness and per-window coverage fields when diagnosing stale tokens.

The similarly named `monitored_token_exit_events` table is historical Solana
signal-eligibility evidence. Its admin API and CLI output explicitly report
`workspaceExit=false`. Do not use its counts as workspace disappearance,
catalog deletion or Robinhood lifecycle telemetry.

Before removing the Solana-only socket `{ address }` compatibility adapter,
inspect `marketSubscriptionProtocol` in `/api/admin/ws-status`. Record
`observedSince`, `legacyAddressOnlyRequests` and `lastLegacyAddressOnlyAt` over
the declared deprecation window. The counters are process-local and reset on
deployment/restart, so a short fresh process with zero legacy calls is not
sufficient evidence. Canonical and mixed-client traffic remains visible in the
companion canonical counter and timestamps.

### Robinhood immediate shutdown

Robinhood alert publication is implemented behind the existing rollout gates.
The legacy master switch and all Robinhood rollout switches are read only at
process startup; changing them without stopping the dedicated process does not
stop an already-running worker. Transport-only operation remains unsupported,
so closing either transport or persistence prevents the whole ingestion worker
from starting.

1. Stop the dedicated Robinhood process or service first. If the optional
   systemd unit is in use:

```bash
sudo systemctl stop volume-bot-alert-worker-robinhood
```

2. Set the service environment to fail closed before any restart:

```text
ROBINHOOD_INGESTION_ENABLED=false
ROBINHOOD_TRANSPORT_ENABLED=false
ROBINHOOD_PERSISTENCE_ENABLED=false
ROBINHOOD_ALERTS_ENABLED=false
```

`ROBINHOOD_INGESTION_ENABLED` remains the master kill switch. When the newer
transport/persistence variables are absent, they inherit the master value for
backward compatibility. Declare them explicitly in controlled rollout service
configuration so `/api/admin/ws-status` reports `explicit=true` for each axis.
`ROBINHOOD_ALERTS_ENABLED=true` authorizes the staging worker to evaluate, but
does not make delivery publishable by itself. While another rollout blocker is
present, custom rules run in shadow mode against committed observations and
must report `deliveryReason=shadow_only`, `attempted=0` and `persisted=0`.
Delivery is authorized only when `robinhoodRollout.axes.alerts.effective=true`.

3. Confirm the shared lease is released or expires. Do not delete a halted
   tombstone as part of routine shutdown:

```sql
SELECT lease_key, owner_id, heartbeat_at, lease_until, metadata
FROM worker_leases
WHERE lease_key IN (
  'robinhood-ingestion-worker',
  'robinhood-catalog-staging-worker'
);
```

4. Check `/api/admin/ws-status`. The consolidated status must keep
   `robinhoodRollout.publishable=false`, report transport/persistence as not
   effective, and show no active shared lease. A remote active lease means
   another Robinhood process is still running.

5. If the incident requires freezing all Robinhood storage maintenance too,
   disable `ROBINHOOD_RETENTION_ENABLED` in the maintenance service and restart
   that service separately. Retention does not ingest or publish alerts, so do
   not disrupt shared maintenance workers unless the storage freeze is needed.

The dedicated worker publishes bounded operational telemetry inside the same
lease heartbeat write, normally every 30 seconds. After deploy/restart and one
successful heartbeat, `/api/admin/ws-status` exposes it at
`robinhoodRollout.telemetry`, including discovery/market head, safe head,
cursor, calculated lag, processing delay, runner recoveries, aggregate provider
requests/bytes/429s and bounded in-memory counters.

Before the first successful poll, telemetry reports `status=warming-up` and
head/cursor remain unavailable. An old process that has not been restarted with
this contract still produces `worker_metrics_process_local`. If telemetry
generation fails, the heartbeat keeps the lease alive and replaces the snapshot
with `metadataProviderError`; do not interpret a telemetry error as permission
to start a second worker.

The lease heartbeat is operational telemetry, not an event or log store. Its
payload excludes pools, token addresses, observations, arbitrary error-code
maps and analytical windows. Inspect the raw shared payload with:

```sql
SELECT heartbeat_at, lease_until, metadata->'telemetry' AS telemetry,
       metadata->'metadataProviderError' AS telemetry_error
FROM worker_leases
WHERE lease_key = 'robinhood-ingestion-worker';
```

Custom-alert shadow and delivery telemetry is stored on the staging-worker
lease and is exposed under
`robinhoodCatalogStagingWorker.sharedLease.metadata.telemetry.lastSummary` in
`/api/admin/ws-status`. Inspect the raw lease with:

```sql
SELECT heartbeat_at, lease_until,
       metadata->'telemetry'->'lastSummary' AS last_summary,
       metadata->'metadataProviderError' AS telemetry_error
FROM worker_leases
WHERE lease_key = 'robinhood-catalog-staging-worker';
```

For shadow runs, require `status=shadow`, `reason=rollout_not_publishable`,
`publication.mode=shadow`, a bounded `queried` count and zero attempted,
persisted and notified deliveries. Compare `evaluatedCustomRules`,
`matchedCustomRules` and `intents` over multiple cycles; one cycle is not
enough to assess crossing stability. `lastDurationMs`, `duplicates`,
`publishErrors`, `errors` and the bounded `lastError` support latency, dedupe
and failure review without exposing user IDs, token addresses or rule payloads.

For launch, prefer one `volume-bot-alert-worker.service` with `BACKGROUND_WORKER_GROUPS=all` unless there is a specific reason to split groups.

## Rollback To Combined Runtime

Use this only as a fallback if the split services are suspected to be the incident source.

1. Stop the split services:

```bash
sudo systemctl stop volume-bot-alert-web
sudo systemctl stop volume-bot-alert-worker
```

2. Start a single combined service or manual process with:

```text
RUN_SOCKET_HUB=true
RUN_BACKGROUND_JOBS=true
```

3. Confirm:

```text
GET /api/health
```

Expected combined fallback:

- `runtime.role = combined`
- `socketEnabled = true`
- `backgroundJobsEnabled = true`

4. Confirm there is no second background process still running:

```bash
ps aux | grep 'node src/server.js' | grep -v grep
```

## No-Go Signals

Do not continue launch traffic if any of these are true:

- more than one process is running with `RUN_BACKGROUND_JOBS=true` without clear worker group ownership
- `/api/health` on the public API reports `runtime.role = combined` unexpectedly
- `workerLeases` shows stale owners that never expire
- Postgres pool saturation appears during normal single-user or low-user traffic
- catalog worker backlog grows continuously instead of stabilizing
- GMGN discovery is enabled with aggressive intervals on a CPU-constrained VPS
- auth, billing, or token-gate validation fails

## QuickNode And Jupiter

QuickNode/Jupiter/onchain scripts and docs are lab/probe work unless explicitly promoted. They should not be treated as production launch dependencies.

Reference commands:

```bash
npm run quicknode:smoke
npm run quicknode:probe
npm run quicknode:dry-run
npm run quicknode:continuous-dry-run
npm run quicknode:logs-dry-run
npm run jupiter:probe
```

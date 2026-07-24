# Robinhood durable backfill operations

This runbook covers the isolated shadow/canary process introduced for the
durable Robinhood backfill. It does not authorize historical reads or the final
scale-up.

## Current boundary

- `BACKGROUND_WORKER_GROUPS=robinhood-backfill` starts only discovery, market
  scan, enrichment, finalization and aggregation workers whose flags are enabled.
- The group is excluded from `all` and cannot be combined with any other group.
- It cannot start legacy Robinhood ingestion, catalog projection, alerts or
  user visibility, even if an unrelated environment file enables them.
- dRPC handles scans and historical state. The public endpoint is head-only.
- Alchemy handles only enrichment timestamps when
  `ROBINHOOD_BACKFILL_ALCHEMY_TIMESTAMPS_ENABLED=true`.
- Alchemy usage is monitored manually in its dashboard. There is no local CU
  ledger or automatic monthly cutoff.
- The Stage 83 outbox consumer rebuilds 5m/15m/30m/1h/4h/1d buckets
  idempotently. Aggregate-history reads remain disabled until a later canary.

## Files

- `deploy/systemd/robinhood-backfill.env.example`
- `deploy/systemd/volume-bot-alert-worker-robinhood-backfill.service.example`

The populated environment file contains credentials and must stay outside the
repository with mode `0600`.

## Preflight

Run from the deployed commit:

```bash
npm run db:schema-check
npm run lint
id
pwd
command -v node
systemctl list-unit-files 'postgresql*' --no-pager
```

Confirm Stage 82 and 83 objects exist:

```sql
SELECT to_regclass('public.robinhood_backfill_ranges') AS ranges,
       to_regclass('public.robinhood_market_log_staging') AS staging,
       to_regclass('public.robinhood_backfill_watermarks') AS watermarks,
       to_regclass('public.robinhood_backfill_aggregation_outbox') AS outbox;
```

Every result must be non-null. Do not run a schema initializer blindly against
production; use the normal reviewed deployment path.

## Install without starting

```bash
sudo install -d -m 0750 /etc/volume-bot-alert
sudo install -m 0600 deploy/systemd/robinhood-backfill.env.example \
  /etc/volume-bot-alert/robinhood-backfill.env
sudo install -m 0644 \
  deploy/systemd/volume-bot-alert-worker-robinhood-backfill.service.example \
  /etc/systemd/system/volume-bot-alert-worker-robinhood-backfill.service
sudoedit /etc/volume-bot-alert/robinhood-backfill.env
sudoedit /etc/systemd/system/volume-bot-alert-worker-robinhood-backfill.service
```

Replace every `REPLACE_*` value and confirm none remain:

```bash
sudo grep -n 'REPLACE_' \
  /etc/volume-bot-alert/robinhood-backfill.env \
  /etc/systemd/system/volume-bot-alert-worker-robinhood-backfill.service
```

The command must produce no lines. Confirm:

```text
BACKGROUND_WORKER_GROUPS=robinhood-backfill
ROBINHOOD_INGESTION_ENABLED=false
ROBINHOOD_TRANSPORT_ENABLED=false
ROBINHOOD_PERSISTENCE_ENABLED=false
ROBINHOOD_ALERTS_ENABLED=false
ROBINHOOD_USER_VISIBILITY_ENABLED=false
ROBINHOOD_SCAN_PROVIDER=drpc
ROBINHOOD_DISCOVERY_SCAN_PROVIDER=drpc
ROBINHOOD_USE_ALCHEMY=false
ROBINHOOD_BACKFILL_ALCHEMY_TIMESTAMPS_ENABLED=true
ROBINHOOD_BACKFILL_AGGREGATION_ENABLED=true
```

If PostgreSQL is local, add its verified unit to `After=` and `Requires=`.
Do not invent a local dependency when the database is remote.

Validate the unit before loading it:

```bash
sudo systemd-analyze verify \
  /etc/systemd/system/volume-bot-alert-worker-robinhood-backfill.service
sudo systemctl daemon-reload
```

## Canary start

The template starts with one range in flight. Keep it that way for the first
canary.

```bash
sudo systemctl start volume-bot-alert-worker-robinhood-backfill
systemctl status volume-bot-alert-worker-robinhood-backfill --no-pager
journalctl -u volume-bot-alert-worker-robinhood-backfill -n 100 --no-pager
```

Confirm the service reports only `robinhood-backfill` as active. Port `3005`
is a local health endpoint and must not be added to nginx or a public firewall:

```bash
curl -fsS http://127.0.0.1:3005/api/health
ss -ltnp | grep ':3005'
sudo nginx -T | grep -n '3005'
```

The final command must not show a proxy route.

## Alchemy manual budget

The Alchemy account is dedicated to Robinhood. Check its dashboard during the
canary and stop auxiliary use at `27,000,000 CU`, preserving `3,000,000 CU` of
the `30,000,000 CU` plan for diagnostics and accounting differences.

The application does not enforce that threshold. A transient Alchemy error or
429 falls back to dRPC, but dashboard consumption is still the operator's
responsibility.

To stop new Alchemy timestamp calls:

```text
ROBINHOOD_BACKFILL_ALCHEMY_TIMESTAMPS_ENABLED=false
```

Restart only the backfill service after changing the startup environment:

```bash
sudo systemctl restart volume-bot-alert-worker-robinhood-backfill
```

Confirm its lease telemetry reports `timestampProvider=drpc`. Do not set
`ROBINHOOD_SCAN_PROVIDER=alchemy` or
`ROBINHOOD_DISCOVERY_SCAN_PROVIDER=alchemy`.

## Audit

Check independent frontiers:

```sql
SELECT frontier, next_block, checkpoint_block, version, updated_at
FROM robinhood_backfill_watermarks
WHERE chain = 'robinhood'
ORDER BY frontier;
```

Check range health:

```sql
SELECT stream, status, COUNT(*) AS ranges,
       MIN(from_block) AS first_block, MAX(to_block) AS last_block,
       SUM(tracked_log_count) AS tracked_logs
FROM robinhood_backfill_ranges
WHERE chain = 'robinhood'
GROUP BY stream, status
ORDER BY stream, status;
```

Check enrichment backlog and dead letters:

```sql
SELECT enrichment_status, COUNT(*) AS logs,
       MIN(block_number) AS oldest_block,
       MAX(attempt_count) AS max_attempts
FROM robinhood_market_log_staging
WHERE chain = 'robinhood'
GROUP BY enrichment_status
ORDER BY enrichment_status;
```

Check the unconsumed aggregation boundary:

```sql
SELECT status, COUNT(*) AS targets,
       MIN(bucket_ts) AS oldest_bucket,
       MAX(bucket_ts) AS newest_bucket
FROM robinhood_backfill_aggregation_outbox
WHERE chain = 'robinhood'
GROUP BY status
ORDER BY status;
```

Check worker leases:

```sql
SELECT lease_key, owner_id, lease_until, metadata
FROM worker_leases
WHERE lease_key IN (
  'robinhood-backfill-discovery-scanner',
  'robinhood-backfill-market-scanner',
  'robinhood-backfill-enrichment-worker',
  'robinhood-backfill-finalizer-worker',
  'robinhood-backfill-aggregation-worker'
)
ORDER BY lease_key;
```

No frontier may be edited by hand. `market_scan` must not pass unexplained
discovery gaps, and `market_enriched` must not pass incomplete or blocked
ranges.

## Pause and rollback

Pause without deleting data:

```bash
sudo systemctl stop volume-bot-alert-worker-robinhood-backfill
systemctl is-active volume-bot-alert-worker-robinhood-backfill
```

Then set all four backfill component flags to `false` before any diagnostic
restart:

```text
ROBINHOOD_BACKFILL_DISCOVERY_ENABLED=false
ROBINHOOD_BACKFILL_SHADOW_ENABLED=false
ROBINHOOD_BACKFILL_ENRICHMENT_ENABLED=false
ROBINHOOD_BACKFILL_FINALIZER_ENABLED=false
ROBINHOOD_BACKFILL_AGGREGATION_ENABLED=false
```

Preserve range manifests, staging, watermarks, observations and outbox rows.
Do not reset cursors, delete leases, truncate tables or discard blocked rows as
an incident response.

For code rollback:

1. stop this service;
2. deploy the previous reviewed commit;
3. confirm additive-schema compatibility;
4. leave this service disabled until the audits above pass;
5. keep web, Solana workers and legacy Robinhood ingestion unchanged.

## Go/no-go

The canary may continue only while:

- discovery and market frontiers advance without gaps;
- enrichment backlog trends down or has a measured stable bound;
- aggregation pending/leased backlog trends down and blocked rows remain zero
  or are individually explained;
- dRPC has tolerable 429/timeout rates;
- PostgreSQL connections, CPU and disk remain within declared limits;
- legacy ingestion and Robinhood alerts remain absent from this process.

Do not enable historical aggregate reads until the outbox is drained and its
results pass the later canary. Alchemy usage must remain below the manually
monitored limit.

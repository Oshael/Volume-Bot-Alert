# Operations Runbook

Last reviewed against code on `2026-07-10`.

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

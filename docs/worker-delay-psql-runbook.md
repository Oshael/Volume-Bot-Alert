# Diagnóstico leve de atraso dos workers no `psql`

Este runbook foi derivado do runtime, das leases e dos schemas atuais do bot. O objetivo é responder, com pouco custo no PostgreSQL:

- o processo está vivo e renovando a lease?
- o cursor/frontier está avançando?
- existe backlog, lease interna vencida ou dead letter?
- o estágio é live, shadow, backfill ou apenas manutenção?

## Como usar

Entre no banco da VPS com `psql`, ative uma saída compacta e limite consultas acidentalmente caras:

```sql
\pset pager off
\timing on
SET statement_timeout = '5s';
SET lock_timeout = '1s';
```

As consultas são somente leitura. Os `COUNT` exatos abaixo ficam restritos a filas ativas ou tabelas pequenas/indexadas; tabelas históricas grandes não são contadas integralmente.

**Ponto importante:** lease saudável prova que o processo Node está renovando heartbeat, mas não prova sozinha que o trabalho avançou. Nos pipelines com cursor, considere saudável apenas quando lease **e** frontier estiverem saudáveis. Inversamente, uma lease ausente pode significar worker opt-in desabilitado, não necessariamente falha: confira a flag da unit.

Os limites usados para triagem seguem os perfis do monitor do bot:

- live: 3 minutos sem progresso, 2 minutos em execução ou mais de 50 blocos de lag;
- polling: 30 minutos sem progresso;
- manutenção: 2 horas sem progresso;
- filas live: backlog antigo por mais de 3 minutos merece investigação, mesmo antes de virar incidente.

## 1. Consulta padrão por processo — cobre as 53 chaves de worker/lease

Use esta consulta para `web`, `core`, `market`, manutenções, X, callouts e também como visão rápida de qualquer grupo. Troque apenas a primeira linha.

Grupos aceitos:

```sql
\set grupo 'web'
-- \set grupo 'core'
-- \set grupo 'market'
-- \set grupo 'solana-maintenance'
-- \set grupo 'robinhood-maintenance'
-- \set grupo 'maintenance'                 -- alias legado
-- \set grupo 'robinhood'
-- \set grupo 'robinhood-head'
-- \set grupo 'robinhood-processing'
-- \set grupo 'robinhood-derived'
-- \set grupo 'robinhood-liquidity'
-- \set grupo 'robinhood-wallet'
-- \set grupo 'robinhood-wallet-classification'
-- \set grupo 'robinhood-signed-origin'
-- \set grupo 'robinhood-holders'
-- \set grupo 'robinhood-holder-global'
-- \set grupo 'robinhood-backfill'
-- \set grupo 'x-match'
-- \set grupo 'x-ingest'
-- \set grupo 'callouts'
```

Depois execute:

```sql
WITH catalog(component_key, process_groups, perfil, expectativa) AS (
  VALUES
    ('web-realtime-runtime', ARRAY['web'], 'live', 'permanente'),
    ('core-support-runtime', ARRAY['core'], 'maintenance', 'permanente'),
    ('telegram-alert-runtime', ARRAY['core'], 'live', 'opt-in'),
    ('catalog-worker', ARRAY['core'], 'polling', 'permanente'),
    ('dex-discovery-worker', ARRAY['core'], 'polling', 'permanente'),
    ('token-risk-enrichment-worker', ARRAY['core'], 'polling', 'permanente'),
    ('token-risk-review-sync-worker', ARRAY['core'], 'polling', 'permanente'),
    ('meteora-snapshot-worker', ARRAY['market'], 'polling', 'permanente'),
    ('bid-zone-worker', ARRAY['market'], 'polling', 'opt-in'),
    ('gmgn-discovery-worker', ARRAY['market'], 'polling', 'permanente'),
    ('gmgn-claim-signal-worker', ARRAY['market'], 'polling', 'permanente'),
    ('catalog-cleanup-worker', ARRAY['solana-maintenance','maintenance'], 'maintenance', 'permanente'),
    ('robinhood-retention-worker', ARRAY['robinhood-maintenance','maintenance'], 'maintenance', 'opt-in'),
    ('mock-trading-take-profit-worker', ARRAY['maintenance'], 'polling', 'opt-in'),
    ('robinhood-ingestion-worker', ARRAY['robinhood'], 'live', 'rollout legado'),
    ('robinhood-catalog-staging-worker', ARRAY['robinhood'], 'live', 'opt-in'),
    ('robinhood-head-capture-worker', ARRAY['robinhood-head'], 'live', 'permanente'),
    ('robinhood-processing-worker', ARRAY['robinhood-processing'], 'live', 'permanente'),
    ('robinhood-derived-worker', ARRAY['robinhood-derived'], 'live', 'permanente'),
    ('robinhood-catalog-projection-worker', ARRAY['robinhood','robinhood-derived'], 'polling', 'opt-in'),
    ('robinhood-holder-summary-worker', ARRAY['robinhood-derived'], 'polling', 'opt-in'),
    ('robinhood-wallet-swap-live-worker', ARRAY['robinhood-wallet'], 'live', 'opt-in'),
    ('robinhood-direct-creator-live-worker', ARRAY['robinhood-wallet'], 'live', 'opt-in'),
    ('robinhood-token-deployment-worker', ARRAY['robinhood-wallet-classification'], 'live', 'opt-in'),
    ('robinhood-sniper-shadow-worker', ARRAY['robinhood-wallet-classification'], 'polling', 'shadow opt-in'),
    ('robinhood-insider-shadow-worker', ARRAY['robinhood-wallet-classification'], 'polling', 'shadow opt-in'),
    ('robinhood-first-buy-live-worker', ARRAY['robinhood-wallet-classification'], 'live', 'opt-in'),
    ('robinhood-launch-anchor-live-worker', ARRAY['robinhood-wallet-classification'], 'live', 'opt-in'),
    ('robinhood-bundle-funding-live-worker', ARRAY['robinhood-wallet-classification'], 'live', 'shadow opt-in'),
    ('robinhood-fresh-wallet-live-worker', ARRAY['robinhood-wallet-classification'], 'live', 'shadow opt-in'),
    ('robinhood-wallet-position-live-worker', ARRAY['robinhood-wallet-classification'], 'live', 'opt-in'),
    ('robinhood-wallet-transfer-live-worker', ARRAY['robinhood-wallet-classification'], 'live', 'opt-in'),
    ('robinhood-wallet-transfer-backfill-worker', ARRAY['robinhood-wallet-classification'], 'maintenance', 'manual'),
    ('robinhood-signed-origin-live-worker', ARRAY['robinhood-signed-origin'], 'live', 'opt-in'),
    ('robinhood-holder-live-worker', ARRAY['robinhood-holders'], 'live', 'opt-in'),
    ('robinhood-holder-live-apply-worker', ARRAY['robinhood-holders'], 'live', 'opt-in'),
    ('robinhood-holder-intelligence-worker', ARRAY['robinhood-holders'], 'polling', 'opt-in'),
    ('robinhood-holder-backfill-worker', ARRAY['robinhood-holders'], 'polling', 'opt-in'),
    ('robinhood-holder-cold-worker', ARRAY['robinhood-holders'], 'maintenance', 'opt-in'),
    ('robinhood-holder-reconciliation-worker', ARRAY['robinhood-holders'], 'polling', 'opt-in'),
    ('robinhood-holder-journal-prune-worker', ARRAY['robinhood-holders'], 'maintenance', 'opt-in'),
    ('robinhood-holder-snapshot-worker', ARRAY['robinhood-holders'], 'maintenance', 'opt-in'),
    ('robinhood-holder-global-backfill-worker', ARRAY['robinhood-holder-global','robinhood-holders'], 'maintenance', 'opt-in'),
    ('robinhood-backfill-discovery-scanner', ARRAY['robinhood-backfill','robinhood'], 'polling', 'opt-in'),
    ('robinhood-backfill-market-scanner', ARRAY['robinhood-backfill','robinhood'], 'polling', 'opt-in'),
    ('robinhood-backfill-enrichment-worker', ARRAY['robinhood-backfill','robinhood'], 'polling', 'opt-in'),
    ('robinhood-backfill-finalizer-worker', ARRAY['robinhood-backfill','robinhood'], 'polling', 'opt-in'),
    ('robinhood-backfill-watchdog-worker', ARRAY['robinhood-backfill','robinhood'], 'polling', 'opt-in'),
    ('robinhood-backfill-aggregation-worker', ARRAY['robinhood-backfill','robinhood'], 'polling', 'opt-in'),
    ('callout-capture-worker', ARRAY['callouts'], 'live', 'opt-in'),
    ('token-image-fingerprint-worker', ARRAY['x-match'], 'polling', 'opt-in'),
    ('x-ingestion-worker', ARRAY['x-ingest'], 'live', 'opt-in'),
    ('robinhood-pool-liquidity-worker', ARRAY['robinhood-liquidity'], 'live', 'opt-in')
), selected AS (
  SELECT * FROM catalog WHERE :'grupo' = ANY(process_groups)
), incidents AS (
  SELECT component_key,
         COUNT(*) FILTER (WHERE status = 'open') AS open_count,
         COUNT(*) FILTER (WHERE status = 'observing') AS observing_count,
         STRING_AGG(severity || ':' || code, ', ' ORDER BY severity, code)
           FILTER (WHERE status <> 'resolved') AS incidentes
  FROM worker_health_incidents
  WHERE status <> 'resolved'
  GROUP BY component_key
), base AS (
  SELECT s.*, l.heartbeat_at, l.lease_until, l.owner_hostname, l.owner_pid,
         COALESCE(l.metadata->'telemetry', l.metadata) AS telemetry,
         l.metadata->>'state' AS persisted_state,
         COALESCE(i.open_count, 0) AS open_count,
         COALESCE(i.observing_count, 0) AS observing_count,
         i.incidentes
  FROM selected s
  LEFT JOIN worker_leases l ON l.lease_key = s.component_key
  LEFT JOIN incidents i ON i.component_key = s.component_key
), progress_raw AS (
  SELECT base.*,
         COALESCE(telemetry->>'lastCompletedAt', telemetry->>'lastTickAt',
                  telemetry->>'lastFrameAt', telemetry->>'lastRunAt') AS raw_progress
  FROM base
), progress AS (
  SELECT progress_raw.*,
         CASE
           WHEN raw_progress ~ '^\d+(\.\d+)?$' THEN
             TO_TIMESTAMP(raw_progress::numeric /
               CASE WHEN raw_progress::numeric > 100000000000 THEN 1000 ELSE 1 END)
           WHEN raw_progress IS NOT NULL THEN raw_progress::timestamptz
         END AS progress_at
  FROM progress_raw
)
SELECT component_key AS worker,
       expectativa,
       CASE
         WHEN heartbeat_at IS NULL THEN
           CASE WHEN expectativa = 'manual' THEN 'INATIVO' ELSE 'AUSENTE/CONFIRA FLAG' END
         WHEN persisted_state = 'halted' THEN 'HALTED'
         WHEN lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN open_count > 0 THEN 'INCIDENTE'
         WHEN observing_count > 0 THEN 'OBSERVANDO'
         WHEN progress_at IS NOT NULL AND NOW() - progress_at >
           CASE perfil
             WHEN 'live' THEN INTERVAL '3 minutes'
             WHEN 'polling' THEN INTERVAL '30 minutes'
             ELSE INTERVAL '2 hours'
           END THEN 'PROGRESSO ATRASADO'
         ELSE 'OK'
       END AS estado,
       ROUND(EXTRACT(EPOCH FROM (NOW() - heartbeat_at)))::bigint AS heartbeat_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - progress_at)))::bigint AS progresso_s,
       owner_hostname || ':' || owner_pid AS owner,
       telemetry->>'mode' AS modo,
       LEFT(COALESCE(telemetry->>'lastError', incidentes), 180) AS detalhe
FROM progress
ORDER BY component_key;
```

Leitura rápida: `heartbeat_s` deve ficar bem abaixo de 120; `progresso_s` deve respeitar o perfil. `AUSENTE/CONFIRA FLAG` exige comparar com o env da unit. `manual` ausente é normal.

## 2. Robinhood monolítico/legado — captura, market e discovery

Use enquanto a unit `robinhood` existir, inclusive durante overlap/shadow:

```sql
WITH lease AS (
  SELECT heartbeat_at, lease_until, metadata
  FROM worker_leases WHERE lease_key = 'robinhood-ingestion-worker'
), cursors AS (
  SELECT stream, next_block, safe_head, checkpoint_block, checkpoint_timestamp, updated_at
  FROM robinhood_ingestion_cursors WHERE chain = 'robinhood'
), isolated AS (
  SELECT stream, next_block FROM robinhood_head_capture_cursors WHERE chain = 'robinhood'
)
SELECT c.stream,
       CASE
         WHEN l.heartbeat_at IS NULL THEN 'AUSENTE/ROLL_OUT?'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN c.safe_head IS NULL THEN 'SEM HEAD'
         WHEN GREATEST(0::bigint, c.safe_head - c.next_block + 1) > 50 THEN 'ATRASADO'
         WHEN NOW() - c.updated_at > INTERVAL '3 minutes' THEN 'CURSOR PARADO'
         ELSE 'OK'
       END AS estado,
       c.next_block - 1 AS capturado_ate,
       c.safe_head,
       GREATEST(0::bigint, c.safe_head - c.next_block + 1) AS lag_blocos,
       i.next_block - c.next_block AS head_isolado_menos_legado,
       ROUND(EXTRACT(EPOCH FROM (NOW() - c.updated_at)))::bigint AS cursor_age_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s
FROM cursors c
LEFT JOIN isolated i USING (stream)
LEFT JOIN lease l ON TRUE
ORDER BY c.stream;
```

`head_isolado_menos_legado > 0` significa que o head isolado está à frente do monólito; `< 0`, que está atrás. Isso é comparação de shadow, não indicação automática de falha.

## 3. Robinhood head isolado

Esta é a consulta principal para saber “onde está o head”. Ela usa o `safe_head` já observado pelo worker, sem chamar RPC:

```sql
WITH lease AS (
  SELECT heartbeat_at, lease_until, metadata
  FROM worker_leases WHERE lease_key = 'robinhood-head-capture-worker'
), legacy AS (
  SELECT stream, next_block FROM robinhood_ingestion_cursors WHERE chain = 'robinhood'
)
SELECT c.stream,
       CASE
         WHEN l.heartbeat_at IS NULL THEN 'LEASE AUSENTE'
         WHEN l.metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN c.safe_head IS NULL THEN 'SEM HEAD'
         WHEN GREATEST(0::bigint, c.safe_head - c.next_block + 1) > 50 THEN 'ATRASADO'
         WHEN NOW() - c.updated_at > INTERVAL '3 minutes' THEN 'CURSOR PARADO'
         ELSE 'OK'
       END AS estado,
       c.next_block - 1 AS capturado_ate,
       c.safe_head,
       GREATEST(0::bigint, c.safe_head - c.next_block + 1) AS lag_blocos,
       c.checkpoint_block,
       c.checkpoint_timestamp,
       c.next_block - legacy.next_block AS isolado_menos_legado,
       ROUND(EXTRACT(EPOCH FROM (NOW() - c.updated_at)))::bigint AS cursor_age_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s
FROM robinhood_head_capture_cursors c
LEFT JOIN legacy USING (stream)
LEFT JOIN lease l ON TRUE
WHERE c.chain = 'robinhood'
ORDER BY c.stream;
```

## 4. Robinhood processing — market + discovery no mesmo processo

O “cursor” de processing é o primeiro bloco ainda não terminal. `blocked` é dead letter: não congela a cobertura live, mas precisa ser investigado e reprocessado explicitamente.

```sql
WITH streams(stream) AS (VALUES ('discovery'), ('market')),
lease AS (
  SELECT heartbeat_at, lease_until, metadata
  FROM worker_leases WHERE lease_key = 'robinhood-processing-worker'
), queue AS (
  SELECT stream,
         MIN(block_number) FILTER (WHERE processing_status IN ('pending','leased')) AS active_block,
         MIN(created_at) FILTER (WHERE processing_status IN ('pending','leased')) AS oldest_active_at,
         COUNT(*) FILTER (WHERE processing_status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE processing_status = 'leased') AS leased,
         COUNT(*) FILTER (WHERE processing_status = 'blocked') AS blocked,
         MIN(block_number) FILTER (WHERE processing_status = 'blocked') AS oldest_blocked_block
  FROM robinhood_head_captures
  WHERE chain = 'robinhood'
    AND processing_status IN ('pending','leased','blocked')
  GROUP BY stream
)
SELECT s.stream,
       CASE
         WHEN l.heartbeat_at IS NULL THEN 'LEASE AUSENTE'
         WHEN l.metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN h.safe_head IS NULL THEN 'SEM CURSOR DE HEAD'
         WHEN COALESCE(q.blocked, 0) > 0 THEN 'ATENCAO: DEAD LETTER'
         WHEN GREATEST(0::bigint, h.safe_head - COALESCE(q.active_block, h.safe_head + 1) + 1) > 50
           THEN 'ATRASADO'
         WHEN q.oldest_active_at < NOW() - INTERVAL '3 minutes' THEN 'FILA ANTIGA'
         ELSE 'OK'
       END AS estado,
       COALESCE(q.active_block - 1, h.safe_head) AS processado_ate,
       h.safe_head,
       GREATEST(0::bigint, h.safe_head - COALESCE(q.active_block, h.safe_head + 1) + 1) AS lag_blocos,
       COALESCE(q.pending, 0) AS pending,
       COALESCE(q.leased, 0) AS leased,
       COALESCE(q.blocked, 0) AS blocked,
       q.oldest_blocked_block,
       ROUND(EXTRACT(EPOCH FROM (NOW() - q.oldest_active_at)))::bigint AS oldest_active_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s,
       LEFT(l.metadata->'telemetry'->>'lastError', 180) AS last_error
FROM streams s
LEFT JOIN robinhood_head_capture_cursors h
  ON h.chain = 'robinhood' AND h.stream = s.stream
LEFT JOIN queue q ON q.stream = s.stream
LEFT JOIN lease l ON TRUE
ORDER BY s.stream;
```

## 5. Robinhood derived — outbox, delivery e shadow audit

O derived não tem cursor próprio; sua fonte de verdade é a outbox. O modo efetivo (`delivery`, `delivery-with-standard-alerts` ou `shadow-audit-only`) vem na telemetria da lease.

```sql
WITH lease AS (
  SELECT heartbeat_at, lease_until, metadata,
         metadata->'telemetry' AS telemetry
  FROM worker_leases WHERE lease_key = 'robinhood-derived-worker'
), queue AS (
  SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status = 'leased') AS leased,
         COUNT(*) FILTER (WHERE status = 'blocked') AS blocked,
         MIN(created_at) FILTER (WHERE status IN ('pending','leased')) AS oldest_active_at,
         MIN(last_block_number) FILTER (WHERE status IN ('pending','leased')) AS oldest_active_block,
         MAX(last_block_number) AS newest_queued_block
  FROM robinhood_derived_outbox
)
SELECT CASE
         WHEN l.heartbeat_at IS NULL THEN 'LEASE AUSENTE'
         WHEN l.metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN q.blocked > 0 THEN 'ATENCAO: DEAD LETTER'
         WHEN q.oldest_active_at < NOW() - INTERVAL '3 minutes' THEN 'ATRASADO'
         ELSE 'OK'
       END AS estado,
       l.telemetry->>'mode' AS modo,
       q.pending, q.leased, q.blocked,
       q.oldest_active_block, q.newest_queued_block,
       ROUND(EXTRACT(EPOCH FROM (NOW() - q.oldest_active_at)))::bigint AS oldest_active_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s,
       l.telemetry->>'lastTickAt' AS last_tick,
       LEFT(l.telemetry->>'lastError', 180) AS last_error
FROM queue q LEFT JOIN lease l ON TRUE;
```

Fila vazia é saudável: entregas concluídas são apagadas. `blocked > 0` não impede eventos novos, mas representa gaps recuperáveis.

## 6. Robinhood wallet — swaps atribuídos e creator direto

Os dois subworkers têm cursores independentes e podem estar habilitados separadamente:

```sql
WITH workers(component_key, worker) AS (
  VALUES
    ('robinhood-wallet-swap-live-worker', 'wallet-swap'),
    ('robinhood-direct-creator-live-worker', 'direct-creator')
), cursors AS (
  SELECT 'wallet-swap'::text AS worker, next_block, safe_head,
         checkpoint_block, updated_at
  FROM robinhood_wallet_swap_cursors
  WHERE chain = 'robinhood' AND stream = 'live'
  UNION ALL
  SELECT 'direct-creator', next_block, safe_head, checkpoint_block, updated_at
  FROM robinhood_direct_creator_cursors
  WHERE chain = 'robinhood' AND stream = 'live'
), incidents AS (
  SELECT component_key, STRING_AGG(severity || ':' || code, ', ') AS issues
  FROM worker_health_incidents WHERE status IN ('observing','open') GROUP BY component_key
)
SELECT w.worker,
       CASE
         WHEN l.heartbeat_at IS NULL THEN 'INATIVO/CONFIRA FLAG'
         WHEN l.metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN c.next_block IS NULL THEN 'SEM CURSOR'
         WHEN GREATEST(0::bigint, c.safe_head - c.next_block + 1) > 50 THEN 'ATRASADO'
         WHEN NOW() - c.updated_at > INTERVAL '3 minutes' THEN 'CURSOR PARADO'
         WHEN i.issues IS NOT NULL THEN 'ATENCAO'
         ELSE 'OK'
       END AS estado,
       c.next_block - 1 AS processado_ate,
       c.safe_head,
       GREATEST(0::bigint, c.safe_head - c.next_block + 1) AS lag_blocos,
       c.checkpoint_block,
       ROUND(EXTRACT(EPOCH FROM (NOW() - c.updated_at)))::bigint AS cursor_age_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s,
       LEFT(COALESCE(l.metadata->'telemetry'->>'lastError', i.issues), 180) AS detalhe
FROM workers w
LEFT JOIN cursors c USING (worker)
LEFT JOIN worker_leases l ON l.lease_key = w.component_key
LEFT JOIN incidents i USING (component_key)
ORDER BY w.worker;
```

## 7. Robinhood wallet classification — live, shadow e filas

Esta consulta retorna uma linha por subworker. `metrica` contém apenas o cursor ou backlog próprio daquele estágio.

```sql
WITH workers(component_key, modo) AS (
  VALUES
    ('robinhood-token-deployment-worker', 'live'),
    ('robinhood-sniper-shadow-worker', 'shadow'),
    ('robinhood-insider-shadow-worker', 'shadow'),
    ('robinhood-first-buy-live-worker', 'live'),
    ('robinhood-launch-anchor-live-worker', 'live'),
    ('robinhood-bundle-funding-live-worker', 'shadow'),
    ('robinhood-fresh-wallet-live-worker', 'shadow'),
    ('robinhood-wallet-position-live-worker', 'live/opt-in'),
    ('robinhood-wallet-transfer-live-worker', 'live/opt-in'),
    ('robinhood-wallet-transfer-backfill-worker', 'manual')
), metrics(component_key, metrica) AS (
  SELECT 'robinhood-token-deployment-worker', JSONB_BUILD_OBJECT(
    'active', COUNT(*), 'oldest_s', EXTRACT(EPOCH FROM NOW() - MIN(created_at))::bigint)
  FROM robinhood_token_deployment_outbox WHERE status IN ('pending','leased')
  UNION ALL
  SELECT 'robinhood-sniper-shadow-worker', JSONB_BUILD_OBJECT(
    'pending', COUNT(*) FILTER (WHERE status = 'pending'),
    'unavailable', COUNT(*) FILTER (WHERE status = 'unavailable'),
    'ready', COUNT(*) FILTER (WHERE status = 'ready'))
  FROM robinhood_holder_classification_states WHERE chain = 'robinhood' AND classifier = 'sniper'
  UNION ALL
  SELECT 'robinhood-insider-shadow-worker', JSONB_BUILD_OBJECT(
    'pending', COUNT(*) FILTER (WHERE status = 'pending'),
    'unavailable', COUNT(*) FILTER (WHERE status = 'unavailable'),
    'ready', COUNT(*) FILTER (WHERE status = 'ready'))
  FROM robinhood_holder_classification_states WHERE chain = 'robinhood' AND classifier = 'insider'
  UNION ALL
  SELECT 'robinhood-first-buy-live-worker', COALESCE((
    SELECT JSONB_BUILD_OBJECT('next_time', next_time, 'source_through', source_through,
      'lag_s', EXTRACT(EPOCH FROM source_through - next_time)::bigint,
      'source_next_block', source_next_block, 'updated_at', updated_at)
    FROM robinhood_first_buy_live_cursors WHERE chain = 'robinhood'), '{}'::jsonb)
  UNION ALL
  SELECT 'robinhood-launch-anchor-live-worker', JSONB_BUILD_OBJECT(
    'active', COUNT(*), 'oldest_s', EXTRACT(EPOCH FROM NOW() - MIN(created_at))::bigint)
  FROM robinhood_launch_anchor_outbox WHERE status IN ('pending','leased')
  UNION ALL
  SELECT 'robinhood-bundle-funding-live-worker', JSONB_BUILD_OBJECT(
    'active', COUNT(*), 'oldest_s', EXTRACT(EPOCH FROM NOW() - MIN(created_at))::bigint)
  FROM robinhood_bundle_funding_live_queue WHERE status IN ('pending','leased')
  UNION ALL
  SELECT 'robinhood-fresh-wallet-live-worker', JSONB_BUILD_OBJECT(
    'active', COUNT(*), 'oldest_s', EXTRACT(EPOCH FROM NOW() - MIN(created_at))::bigint)
  FROM robinhood_fresh_wallet_queue WHERE status IN ('pending','leased')
  UNION ALL
  SELECT 'robinhood-wallet-position-live-worker', COALESCE((
    SELECT JSONB_BUILD_OBJECT('projection', projection_version, 'state', lifecycle_state,
      'next_block', next_block, 'safe_head', safe_head,
      'lag_blocks', GREATEST(0::bigint, safe_head - next_block + 1), 'updated_at', updated_at)
    FROM robinhood_wallet_position_cursors
    WHERE chain = 'robinhood' AND stream = 'live' ORDER BY updated_at DESC LIMIT 1), '{}'::jsonb)
  UNION ALL
  SELECT 'robinhood-wallet-transfer-live-worker', COALESCE((
    SELECT JSONB_BUILD_OBJECT('projection', projection_version, 'state', lifecycle_state,
      'next_block', next_block, 'safe_head', safe_head,
      'lag_blocks', GREATEST(0::bigint, safe_head - next_block + 1), 'updated_at', updated_at)
    FROM robinhood_wallet_transfer_cursors
    WHERE chain = 'robinhood' AND stream = 'live' ORDER BY updated_at DESC LIMIT 1), '{}'::jsonb)
  UNION ALL
  SELECT 'robinhood-wallet-transfer-backfill-worker', '{}'::jsonb
)
SELECT w.component_key AS worker, w.modo,
       CASE
         WHEN l.heartbeat_at IS NULL THEN CASE WHEN w.modo = 'manual' THEN 'INATIVO' ELSE 'INATIVO/CONFIRA FLAG' END
         WHEN l.metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN NULLIF(m.metrica->>'lag_blocks', '')::bigint > 50 THEN 'ATRASADO'
         WHEN NULLIF(m.metrica->>'lag_s', '')::bigint > 60 THEN 'ATRASADO'
         WHEN NULLIF(m.metrica->>'oldest_s', '')::bigint > 180 THEN 'FILA ANTIGA'
         WHEN EXISTS (SELECT 1 FROM worker_health_incidents i
                      WHERE i.component_key = w.component_key AND i.status = 'open') THEN 'INCIDENTE'
         ELSE 'OK'
       END AS estado,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s,
       m.metrica,
       LEFT(l.metadata->'telemetry'->>'lastError', 180) AS last_error
FROM workers w
LEFT JOIN worker_leases l ON l.lease_key = w.component_key
LEFT JOIN metrics m USING (component_key)
ORDER BY w.component_key;
```

Interpretação especial:

- `SNIPER`, `INSIDER`, `BUNDLED` e `FRESH` continuam shadow conforme o código atual; `ready` não significa publicado na API/UI.
- first-buy mede lag de tempo (`source_through - next_time`), não apenas bloco.
- wallet position e wallet transfer possuem versões/projeções próprias; confira `state` e a versão mostrada.
- a lease do backfill de transferências deve existir apenas durante execução manual.

## 8. Robinhood signed-origin

O seed precisa estar `completed`; o worker automático só move o cursor `live`:

```sql
SELECT c.stream,
       CASE
         WHEN c.stream = 'seed' AND c.lifecycle_state <> 'completed' THEN 'SEED INCOMPLETO'
         WHEN c.stream = 'live' AND l.heartbeat_at IS NULL THEN 'INATIVO/CONFIRA FLAG'
         WHEN c.stream = 'live' AND l.metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN c.stream = 'live' AND l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN c.lifecycle_state = 'halted' THEN 'CURSOR HALTED'
         WHEN GREATEST(0::bigint, c.safe_head - c.next_block + 1) > 50 THEN 'ATRASADO'
         WHEN NOW() - c.updated_at > INTERVAL '3 minutes' AND c.stream = 'live' THEN 'CURSOR PARADO'
         ELSE 'OK'
       END AS estado,
       c.lifecycle_state,
       c.origin_block,
       c.next_block - 1 AS processado_ate,
       c.safe_head,
       GREATEST(0::bigint, c.safe_head - c.next_block + 1) AS lag_blocos,
       c.checkpoint_timestamp,
       ROUND(EXTRACT(EPOCH FROM (NOW() - c.updated_at)))::bigint AS cursor_age_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s,
       LEFT(COALESCE(c.last_error_code || ':' || c.last_error_message,
                     l.metadata->'telemetry'->>'lastError'), 180) AS detalhe
FROM robinhood_wallet_signed_origin_cursors c
LEFT JOIN worker_leases l
  ON l.lease_key = 'robinhood-signed-origin-live-worker'
WHERE c.chain = 'robinhood'
ORDER BY CASE c.stream WHEN 'seed' THEN 1 ELSE 2 END;
```

## 9. Robinhood holders — captura, apply, shadow/live e manutenção

Esta é a consulta principal do processo `robinhood-holders`. Ela lê apenas leases, a telemetria já calculada pelos workers e a única linha do cursor live. Não agrega a journal, a hot queue, os estados por token nem o histórico de snapshots.

```sql
WITH workers(component_key, papel) AS (
  VALUES
    ('robinhood-holder-live-worker', 'captura'),
    ('robinhood-holder-live-apply-worker', 'apply'),
    ('robinhood-holder-intelligence-worker', 'classificacoes'),
    ('robinhood-holder-backfill-worker', 'backfill local'),
    ('robinhood-holder-cold-worker', 'cold repair'),
    ('robinhood-holder-reconciliation-worker', 'reconciliacao'),
    ('robinhood-holder-journal-prune-worker', 'prune'),
    ('robinhood-holder-snapshot-worker', 'snapshots')
), cursor_metric AS (
  SELECT JSONB_BUILD_OBJECT(
    'next_block', c.next_block, 'safe_head', c.safe_head,
    'lag_blocks', GREATEST(0::bigint, c.safe_head - c.next_block + 1),
    'checkpoint_block', c.checkpoint_block,
    'journal_floor', c.journal_floor_block,
    'updated_at', c.updated_at) AS value
  FROM robinhood_holder_cursors c WHERE c.chain = 'robinhood' AND c.stream = 'live'
), observed AS (
  SELECT w.component_key, w.papel, l.heartbeat_at, l.lease_until, l.metadata,
         CASE
           WHEN w.component_key = 'robinhood-holder-live-worker'
             THEN COALESCE((SELECT value FROM cursor_metric), '{}'::jsonb)
           WHEN w.component_key = 'robinhood-holder-live-apply-worker'
             THEN COALESCE(l.metadata->'telemetry'->'lastResult'->'freshness', '{}'::jsonb)
           ELSE JSONB_STRIP_NULLS(JSONB_BUILD_OBJECT(
             'lastCompletedAt', l.metadata->'telemetry'->>'lastCompletedAt',
             'lastResult', l.metadata->'telemetry'->'lastResult'
           ))
         END AS metrica
  FROM workers w
  LEFT JOIN worker_leases l ON l.lease_key = w.component_key
)
SELECT o.component_key AS worker, o.papel,
       CASE
         WHEN o.heartbeat_at IS NULL THEN 'INATIVO/CONFIRA FLAG'
         WHEN o.metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN o.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN NULLIF(o.metrica->>'lag_blocks', '')::bigint > 50 THEN 'ATRASADO'
         WHEN NULLIF(o.metrica->>'worstLagBlocks', '')::bigint > 50 THEN 'APPLY ATRASADO'
         WHEN NULLIF(o.metrica->>'oldestAgeMs', '')::bigint > 180000 THEN 'FILA ANTIGA'
         WHEN EXISTS (SELECT 1 FROM worker_health_incidents i
                      WHERE i.component_key = o.component_key AND i.status = 'open') THEN 'INCIDENTE'
         ELSE 'OK'
       END AS estado,
       ROUND(EXTRACT(EPOCH FROM (NOW() - o.heartbeat_at)))::bigint AS heartbeat_s,
       o.metrica,
       LEFT(o.metadata->'telemetry'->>'lastError', 180) AS last_error
FROM observed o
ORDER BY o.component_key;
```

Na linha de `live-apply`, a métrica `freshness` mostra `pendingTokens`, `recentShadowTokens`, `staleLiveTokens`, `worstLagBlocks` e `oldestAgeMs`. Nos demais workers de manutenção, `lastCompletedAt` e `lastResult` mostram o último ciclo. O cursor direto continua sendo usado para `holder-live`.

O runbook configura `statement_timeout = '5s'` no começo. A query revisada deve caber nesse limite. Se ainda precisar aumentar apenas para a sessão atual do `psql`, use:

```sql
SHOW statement_timeout;
SET statement_timeout = '30s';
-- execute aqui a consulta desejada
SET statement_timeout = '5s';
```

Esse `SET` afeta somente a conexão atual; não altera o PostgreSQL globalmente. Para o apply, `pendingTokens > 0` pode ser normal, mas `oldestAgeMs > 180000`, `worstLagBlocks > 50` ou crescimento contínuo indicam atraso. `recentShadowTokens` é o shadow recente elegível; `staleLiveTokens` indica trabalho live antigo acumulado.

## 10. Robinhood holder global backfill

`frozen` e `paused` são estados intencionais, não atraso automático. `scanning`, `attached` e `materializing` devem avançar `next_block`/`updated_at`.

```sql
WITH anchor AS (SELECT 1), lease AS (
  SELECT heartbeat_at, lease_until, metadata
  FROM worker_leases WHERE lease_key = 'robinhood-holder-global-backfill-worker'
), run AS (
  SELECT * FROM robinhood_holder_global_backfill_runs
  WHERE chain = 'robinhood' ORDER BY id DESC LIMIT 1
), tokens AS (
  SELECT t.run_id, JSONB_OBJECT_AGG(t.status, t.qty) AS states
  FROM (SELECT run_id, status, COUNT(*) AS qty
        FROM robinhood_holder_global_backfill_tokens
        WHERE run_id = (SELECT id FROM run) GROUP BY run_id, status) t
  GROUP BY t.run_id
)
SELECT CASE
         WHEN r.id IS NULL THEN 'SEM CAMPANHA'
         WHEN l.heartbeat_at IS NULL THEN 'INATIVO/CONFIRA FLAG'
         WHEN l.metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN COALESCE(NULLIF(r.telemetry->>'liveLagBlocks', '')::bigint, 0) > 100
           THEN 'LIVE PRESSIONADO'
         WHEN r.status IN ('scanning','attached','materializing')
              AND NOW() - r.updated_at > INTERVAL '2 hours' THEN 'SEM PROGRESSO'
         WHEN r.status = 'paused' THEN 'PAUSADO'
         WHEN r.status = 'frozen' THEN 'AGUARDANDO START'
         ELSE 'OK'
       END AS estado,
       r.id AS run_id, r.status, r.next_block, r.barrier_block,
       GREATEST(0::bigint, COALESCE(r.barrier_block, r.next_block) - r.next_block) AS barrier_distance,
       r.cohort_token_count, t.states AS token_states,
       r.telemetry->>'liveLagBlocks' AS live_lag_blocks,
       r.telemetry->>'blocksPerSecond' AS blocks_per_second,
       r.telemetry->>'etaSeconds' AS eta_seconds,
       ROUND(EXTRACT(EPOCH FROM (NOW() - r.updated_at)))::bigint AS run_age_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s,
       LEFT(l.metadata->'telemetry'->>'lastError', 180) AS last_error
FROM anchor
LEFT JOIN run r ON TRUE
LEFT JOIN tokens t ON t.run_id = r.id
LEFT JOIN lease l ON TRUE;
```

## 11. Robinhood liquidity isolada

O `safe_head` deste cursor já é limitado pelo menor frontier de processing. Portanto lag aqui significa atraso em relação ao que já está processável, não necessariamente ao head bruto da chain.

```sql
WITH anchor AS (SELECT 1), lease AS (
  SELECT heartbeat_at, lease_until, metadata
  FROM worker_leases WHERE lease_key = 'robinhood-pool-liquidity-worker'
)
SELECT CASE
         WHEN l.heartbeat_at IS NULL THEN 'INATIVO/CONFIRA FLAG'
         WHEN l.metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN c.next_block IS NULL THEN 'SEM CURSOR'
         WHEN GREATEST(0::bigint, c.safe_head - c.next_block + 1) > 50 THEN 'ATRASADO'
         WHEN NOW() - c.updated_at > INTERVAL '3 minutes' THEN 'CURSOR PARADO'
         ELSE 'OK'
       END AS estado,
       c.coverage_start_block,
       c.next_block - 1 AS processado_ate,
       c.safe_head,
       GREATEST(0::bigint, c.safe_head - c.next_block + 1) AS lag_blocos,
       c.checkpoint_block, c.checkpoint_timestamp,
       ROUND(EXTRACT(EPOCH FROM (NOW() - c.updated_at)))::bigint AS cursor_age_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s,
       LEFT(COALESCE(l.metadata->>'lastError', l.metadata->'telemetry'->>'lastError'), 180) AS last_error
FROM anchor
LEFT JOIN robinhood_pool_liquidity_event_cursors c ON c.chain = 'robinhood'
LEFT JOIN lease l ON TRUE;
```

## 12. Robinhood backfill/replay

O backfill é shadow e opt-in. Esta consulta mostra os três watermarks, filas ativas e todas as leases do processo em uma linha:

```sql
WITH leases AS (
  SELECT STRING_AGG(lease_key || '=' ||
    CASE WHEN metadata->>'state' = 'halted' THEN 'HALTED'
         WHEN lease_until <= NOW() THEN 'ATRASADA' ELSE 'OK' END,
    ', ' ORDER BY lease_key) AS states,
    MAX(NOW() - heartbeat_at) AS max_heartbeat_age
  FROM worker_leases
  WHERE lease_key IN (
    'robinhood-backfill-discovery-scanner','robinhood-backfill-market-scanner',
    'robinhood-backfill-enrichment-worker','robinhood-backfill-finalizer-worker',
    'robinhood-backfill-watchdog-worker','robinhood-backfill-aggregation-worker')
), watermarks AS (
  SELECT JSONB_OBJECT_AGG(frontier, JSONB_BUILD_OBJECT(
    'next_block', next_block, 'checkpoint_block', checkpoint_block,
    'updated_at', updated_at)) AS value
  FROM robinhood_backfill_watermarks WHERE chain = 'robinhood'
), range_queue AS (
  SELECT COUNT(*) FILTER (WHERE status IN ('pending','fetching','failed')) AS active,
         COUNT(*) FILTER (WHERE status = 'blocked') AS blocked,
         MIN(from_block) FILTER (WHERE status IN ('pending','fetching','failed')) AS oldest_from
  FROM robinhood_backfill_ranges
  WHERE chain = 'robinhood' AND status <> 'captured'
), enrich_queue AS (
  SELECT COUNT(*) FILTER (WHERE enrichment_status IN ('pending','leased')) AS active,
         COUNT(*) FILTER (WHERE enrichment_status = 'blocked') AS blocked,
         MIN(block_number) FILTER (WHERE enrichment_status IN ('pending','leased')) AS oldest_block
  FROM robinhood_market_log_staging
  WHERE chain = 'robinhood' AND enrichment_status IN ('pending','leased','blocked')
), agg_queue AS (
  SELECT COUNT(*) FILTER (WHERE status IN ('pending','leased')) AS active,
         COUNT(*) FILTER (WHERE status = 'blocked') AS blocked,
         MIN(bucket_ts) FILTER (WHERE status IN ('pending','leased')) AS oldest_bucket
  FROM robinhood_backfill_aggregation_outbox
  WHERE chain = 'robinhood' AND status <> 'completed'
)
SELECT CASE
         WHEN l.states IS NULL THEN 'INATIVO/CONFIRA FLAGS'
         WHEN l.states LIKE '%HALTED%' THEN 'HALTED'
         WHEN l.states LIKE '%ATRASADA%' THEN 'LEASE ATRASADA'
         WHEN r.blocked + e.blocked + a.blocked > 0 THEN 'ATENCAO: BLOCKED'
         ELSE 'OK/EM EXECUCAO'
       END AS estado,
       l.states AS leases,
       ROUND(EXTRACT(EPOCH FROM l.max_heartbeat_age))::bigint AS max_heartbeat_s,
       w.value AS watermarks,
       JSONB_BUILD_OBJECT('ranges_active', r.active, 'ranges_blocked', r.blocked,
         'oldest_from', r.oldest_from, 'enrich_active', e.active,
         'enrich_blocked', e.blocked, 'oldest_enrich_block', e.oldest_block,
         'aggregation_active', a.active, 'aggregation_blocked', a.blocked,
         'oldest_bucket', a.oldest_bucket) AS filas
FROM leases l CROSS JOIN watermarks w CROSS JOIN range_queue r
CROSS JOIN enrich_queue e CROSS JOIN agg_queue a;
```

## 13. Callouts Pump/Fomo

Aqui o checkpoint é por coletor. `fomo:follow` pode ficar parado quando não há follow permitido; os checkpoints de captura que devem avançar são `pump:live` e `fomo:live`.

```sql
WITH lease AS (
  SELECT heartbeat_at, lease_until, metadata
  FROM worker_leases WHERE lease_key = 'callout-capture-worker'
), expected(collector_key) AS (
  VALUES ('pump:live'), ('fomo:live'), ('fomo:follow')
)
SELECT e.collector_key,
       CASE
         WHEN l.heartbeat_at IS NULL THEN 'INATIVO/CONFIRA FLAG'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN c.collector_key IS NULL THEN 'SEM CHECKPOINT'
         WHEN e.collector_key <> 'fomo:follow'
              AND NOW() - c.last_committed_at > INTERVAL '3 minutes' THEN 'SEM CAPTURA RECENTE'
         ELSE 'OK/SEM EVENTO'
       END AS estado,
       c.last_committed_at,
       ROUND(EXTRACT(EPOCH FROM (NOW() - c.last_committed_at)))::bigint AS checkpoint_age_s,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s,
       LEFT(l.metadata->'telemetry'->>'lastError', 180) AS last_error
FROM expected e
LEFT JOIN callout_collector_checkpoints c USING (collector_key)
LEFT JOIN lease l ON TRUE
ORDER BY e.collector_key;
```

Ausência de evento não prova falha de stream; use a telemetria aninhada da consulta padrão para `fomo.lastFrameAt`, conexão e browser health.

## 14. X ingestion

O worker consulta o head de cada lista; `last_cursor` é observabilidade, não gap-fill. O sinal principal é `last_polled_at` por lista:

```sql
WITH lease AS (
  SELECT heartbeat_at, lease_until, metadata
  FROM worker_leases WHERE lease_key = 'x-ingestion-worker'
)
SELECT x.label,
       CASE
         WHEN l.heartbeat_at IS NULL THEN 'INATIVO/CONFIRA FLAG'
         WHEN l.lease_until <= NOW() THEN 'LEASE ATRASADA'
         WHEN x.last_polled_at IS NULL THEN 'NUNCA POLLADA'
         WHEN NOW() - x.last_polled_at > INTERVAL '3 minutes' THEN 'ATRASADA'
         ELSE 'OK'
       END AS estado,
       x.last_polled_at,
       ROUND(EXTRACT(EPOCH FROM (NOW() - x.last_polled_at)))::bigint AS poll_age_s,
       (x.last_cursor IS NOT NULL) AS tem_cursor,
       ROUND(EXTRACT(EPOCH FROM (NOW() - l.heartbeat_at)))::bigint AS heartbeat_s,
       LEFT(l.metadata->'telemetry'->>'lastError', 180) AS last_error
FROM x_list x
LEFT JOIN lease l ON TRUE
WHERE x.enabled = TRUE
ORDER BY x.label;
```

O `x-match`/fingerprint não tem cursor. Use a consulta padrão: `lastRunAt`, lease e incidentes são a fonte de verdade.

## 15. Worker-health e saúde do PostgreSQL

O processo `worker-health` deliberadamente **não possui lease própria**. Portanto o PostgreSQL não consegue provar que ele está vivo quando não há incidentes. Systemd/monitor externo deve vigiar a unit.

**Ponto importante:** o runtime atual possui 53 chaves conhecidas neste runbook, mas `worker-health-registry.js` registra somente 52. A chave `robinhood-signed-origin-live-worker` está ausente do registry. Consequências atuais: sua lease aparece nas consultas diretas, mas não gera incidente automático; incluí-la em `WORKER_HEALTH_EXPECTED_COMPONENTS` faz o monitor rejeitar a configuração como componente desconhecido. Isso precisa de correção de código separada.

Dentro do `psql`, esta consulta mostra a última atividade do control plane e problemas abertos:

```sql
WITH monitor AS (
  SELECT MAX(last_observed_at) AS last_observed_at,
         MAX(updated_at) AS last_write_at
  FROM worker_health_incidents
), open_incidents AS (
  SELECT severity, component_key, code, path, consecutive_observations,
         last_observed_at, details
  FROM worker_health_incidents
  WHERE status = 'open'
  ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
           last_observed_at DESC
)
SELECT 'monitor-control-plane' AS component,
       CASE
         WHEN m.last_write_at IS NULL THEN 'SEM HISTORICO; CONFIRA SYSTEMD'
         ELSE 'ULTIMA ESCRITA CONHECIDA; NAO PROVA LIVENESS'
       END AS estado,
       m.last_observed_at, m.last_write_at,
       NULL::text AS code, NULL::text AS path, NULL::jsonb AS details
FROM monitor m
UNION ALL
SELECT i.component_key, UPPER(i.severity), i.last_observed_at, NULL,
       i.code, i.path, i.details
FROM open_incidents i;
```

Cheque também pressão do banco, pois um worker pode parecer atrasado por contenção:

```sql
SELECT COUNT(*) FILTER (WHERE cardinality(pg_blocking_pids(pid)) > 0) AS blocked_queries,
       COUNT(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx,
       ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - xact_start)))
         FILTER (WHERE state = 'idle in transaction')) AS oldest_idle_tx_s,
       COUNT(*) FILTER (WHERE wait_event_type IS NOT NULL) AS waiting_sessions
FROM pg_stat_activity
WHERE datname = current_database();
```

## Ordem recomendada durante incidente

1. Rode a consulta padrão para a unit afetada.
2. Se for Robinhood, rode a consulta específica e identifique o primeiro estágio atrasado: head → processing → derived/wallet/holders.
3. Trate `blocked`, `drifted`, `resyncing`, `halted` e cursores regressivos como sinais causais; não reinicie tudo às cegas.
4. Se várias units atrasarem juntas, cheque PostgreSQL, RPC e recursos do host antes de reprocessar filas.
5. Não confunda shadow saudável com publicação: SNIPER, INSIDER, BUNDLED e FRESH podem concluir sem aparecer na API/UI.

## Limitações intencionais

- Estas consultas não chamam `eth_blockNumber`; “head” significa o último `safe_head` persistido. Para detectar um RPC congelado que continua devolvendo o mesmo head, compare com um nó externo fora do `psql`.
- Uma fila vazia pode significar saudável ou produtor desligado. A cadeia causal entre as consultas resolve essa ambiguidade.
- Leases são apagadas em shutdown gracioso e ficam expiradas em crash/halt; por isso ausência precisa ser interpretada junto das flags esperadas.
- O monitor ignora leases expiradas de componentes que não estejam em `WORKER_HEALTH_EXPECTED_COMPONENTS`. A consulta padrão ainda as exibe quando o registro existe.
- Backfills manuais e estados `frozen`/`paused` não devem ser marcados como atraso sem intenção operacional explícita.

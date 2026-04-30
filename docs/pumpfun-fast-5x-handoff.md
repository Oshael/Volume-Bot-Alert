# PumpFun Fast 5x Handoff

## Objetivo

Estamos tentando descobrir se os dados que o bot já coleta conseguem antecipar ou confirmar tokens PumpFun com potencial de grande continuação, especialmente tokens que podem fazer `5x+` depois da migração.

A ideia atual não é transformar isso direto em alerta público. O foco é acumular dados, comparar winners contra falsos positivos e decidir se vale criar uma regra real depois.

## Estado Atual

Existem dois dry-runs isolados:

1. `pumpfun-fast-5x`
2. `pumpfun-post-migration-blast`
3. `pumpfun-combo-confirmation`

Eles nao emitem alertas reais enquanto estiverem em `DRY_RUN=true`. O objetivo e acumular dados para comparar os perfis.

### PumpFun Fast 5x

O `pumpfun-fast-5x` e uma regra de confirmacao pos-migration mais conservadora.

Ele:
- avalia tokens `pumpfun-migrated`
- roda em ciclo configurado por `PUMPFUN_FAST_5X_INTERVAL_MS`
- não emite alerta real quando `PUMPFUN_FAST_5X_DRY_RUN=true`
- salva os candidatos detectados em `pumpfun_fast_5x_detections`
- atualiza `latest_mcap_since_alert`, `max_mcap_since_alert` e `max_x_since_alert`
- agora tambem atualiza metricas de hold pos-alerta na mesma tabela:
  - `post_alert_low_x_15m`
  - `post_alert_low_x_30m`
  - `post_alert_high_x_30m`
  - `post_alert_max_vol_to_mcap`
  - `post_alert_hold_status`
  - `post_alert_hold_reason`
  - `post_alert_hold_evaluated_at`
- mostra uma view admin em `/api/admin/pumpfun-fast-5x/dry-run.html?refresh=true`

O status de hold do Fast 5x nao bloqueia a deteccao inicial. Ele e uma classificacao posterior, calculada com buckets depois do alerta:
- `pending_15m`
- `failed_drawdown_15m`
- `held_15m_pending_30m`
- `failed_drawdown_30m`
- `held_weak_expansion_30m`
- `held_expanded_volume_outside_band`
- `hold_confirmed`

Gates atuais do `hold_confirmed`:
- `post_alert_low_x_15m >= 0.8`
- `post_alert_low_x_30m >= 0.8`
- `post_alert_high_x_30m >= 1.5`
- `1.5 <= post_alert_max_vol_to_mcap <= 3`

Ponto importante:
- isso e uma classificacao pos-alerta, nao um alerta mais cedo
- ela serve para separar tokens que seguraram bem depois do Fast 5x de tokens que tiveram churn/venda forte logo apos o alerta
- nao misturar isso com o Blast inicial, porque o Blast precisa continuar rapido

### PumpFun Post-Migration Blast

O `pumpfun-post-migration-blast` e um experimento separado para detectar explosao imediata nos primeiros minutos pos-migration.

Ele foi criado porque alguns winners ficaram fora do Fast 5x por motivos como:
- `first_mcap` pos-migration abaixo de `15k`
- menos de 20 buckets no comeco
- pump muito rapido antes da regra conservadora ter cobertura suficiente

Gates iniciais:
- idade pos-migration <= 20m
- `first_mcap` entre 1k e 35k
- `high_mcap_recent >= 75k`
- atinge esse high em ate 10m
- `max/p95 vol5m >= 100k`
- minimo de 3 buckets

Ele:
- roda em ciclo configurado por `PUMPFUN_POST_MIGRATION_BLAST_INTERVAL_MS`
- nao emite alerta real quando `PUMPFUN_POST_MIGRATION_BLAST_DRY_RUN=true`
- salva os candidatos detectados em `pumpfun_post_migration_blast_detections`
- atualiza `latest_mcap_since_alert`, `max_mcap_since_alert` e `max_x_since_alert`
- mostra uma view admin em `/api/admin/pumpfun-post-migration-blast/dry-run.html?refresh=true`

O browser não precisa ficar aberto para acumular dados. A página só consulta/mostra o estado. Quem detecta e salva é o backend.

### PumpFun Combo Confirmation

O `pumpfun-combo-confirmation` e um terceiro dry-run criado depois da primeira analise combinada dos CSVs exportados em `2026-04-30`.

Ele nao reimplementa a leitura raw dos buckets. Ele usa as duas tabelas de dry-run existentes como fonte:
- `pumpfun_post_migration_blast_detections`
- `pumpfun_fast_5x_detections`

Ideia atual:
- Blast e a base principal
- faixa de entrada inicial: `alert_mcap` entre `50k` e `100k`
- `blast_score >= 120`
- `timeToHighMcapMs <= 6m`
- Fast 5x entra como confirmacao/bonus quando o mesmo token tambem aparece no Fast
- entrada `100k+` fica fora do combo inicial porque performou pior na amostra
- pre-migration entra como evidencia no payload, nao como gate duro

Ele:
- roda em ciclo configurado por `PUMPFUN_COMBO_CONFIRMATION_INTERVAL_MS`
- nao emite alerta real quando `PUMPFUN_COMBO_CONFIRMATION_DRY_RUN=true`
- salva os candidatos detectados em `pumpfun_combo_confirmation_detections`
- acompanha outcome por uma janela padrao de `24h`
- mostra uma view admin em `/api/admin/pumpfun-combo-confirmation/dry-run.html?refresh=true`

## Arquivos Relevantes

- `src/services/pumpfun-fast-5x-signal.js`
- `src/services/pumpfun-fast-5x-candidates.js`
- `src/services/pumpfun-fast-5x-dry-run.js`
- `src/models/pumpfun-fast-5x-detection.js`
- `src/utils/db-init-stage32.js`
- `src/utils/import-pumpfun-fast-5x-dry-run.js`
- `src/services/pumpfun-post-migration-blast-signal.js`
- `src/services/pumpfun-post-migration-blast-candidates.js`
- `src/services/pumpfun-post-migration-blast-dry-run.js`
- `src/models/pumpfun-post-migration-blast-detection.js`
- `src/utils/db-init-stage33.js`
- `src/services/pumpfun-combo-confirmation-signal.js`
- `src/services/pumpfun-combo-confirmation-candidates.js`
- `src/services/pumpfun-combo-confirmation-dry-run.js`
- `src/models/pumpfun-combo-confirmation-detection.js`
- `src/utils/db-init-stage34.js`
- `docs/pumpfun-fast-5x-alert-plan.md`
- `docs/pumpfun-fast-5x-analysis-query.md`

## Config Atual Esperada

```env
PUMPFUN_FAST_5X_ALERT_ENABLED=true
PUMPFUN_FAST_5X_DRY_RUN=true
PUMPFUN_FAST_5X_INTERVAL_MS=10000
PUMPFUN_POST_MIGRATION_BLAST_ENABLED=true
PUMPFUN_POST_MIGRATION_BLAST_DRY_RUN=true
PUMPFUN_POST_MIGRATION_BLAST_INTERVAL_MS=10000
PUMPFUN_COMBO_CONFIRMATION_ENABLED=true
PUMPFUN_COMBO_CONFIRMATION_DRY_RUN=true
PUMPFUN_COMBO_CONFIRMATION_INTERVAL_MS=10000
PUMPFUN_PRE_MIGRATION_CAPTURE_ENABLED=true
PUMPFUN_PRE_MIGRATION_TRACK_TTL_MS=7200000
```

`PUMPFUN_PRE_MIGRATION_TRACK_TTL_MS=7200000` significa acompanhar tokens pré-migração por até 2 horas, salvo se migrarem antes.

## Banco

Tabela de detecções do Fast 5x:

```sql
SELECT
  token_address,
  symbol,
  alert_triggered_at,
  alert_mcap,
  latest_mcap_since_alert,
  max_mcap_since_alert,
  max_x_since_alert,
  post_alert_low_x_15m,
  post_alert_low_x_30m,
  post_alert_high_x_30m,
  post_alert_max_vol_to_mcap,
  post_alert_hold_status,
  score
FROM pumpfun_fast_5x_detections
ORDER BY alert_triggered_at DESC;
```

Tabela de detecções do Post-Migration Blast:

```sql
SELECT
  token_address,
  symbol,
  alert_triggered_at,
  alert_mcap,
  latest_mcap_since_alert,
  max_mcap_since_alert,
  max_x_since_alert,
  score
FROM pumpfun_post_migration_blast_detections
ORDER BY alert_triggered_at DESC;
```

Tabela de detecções do Combo Confirmation:

```sql
SELECT
  token_address,
  symbol,
  combo_triggered_at,
  combo_mcap,
  latest_mcap_since_trigger,
  max_mcap_since_trigger,
  max_x_since_trigger,
  score,
  reason
FROM pumpfun_combo_confirmation_detections
ORDER BY combo_triggered_at DESC;
```

Stages de banco:

```bash
node src/utils/db-init-stage32.js
node src/utils/db-init-stage33.js
node src/utils/db-init-stage34.js
```

Ponto importante:
- se subir o codigo com `runtime-schema` novo e nao rodar as stages, o schema guard pode bloquear o boot
- stage32 e para `pumpfun_fast_5x_detections`
- stage33 e para `pumpfun_post_migration_blast_detections`
- stage34 e para `pumpfun_combo_confirmation_detections`

Buckets pré-migração usam as tabelas existentes:

```text
token_market_buckets_1m
token_market_volume_buckets_1m
```

O marcador é:

```sql
source = 'pumpfun-pre-migration'
```

Pós-migração geralmente aparece como:

```sql
source IN ('pumpfun-migrated', 'dexscreener')
```

## O Que Já Foi Observado

Com amostra pequena, o sinal atual pegou movimento real, mas ainda parece mais um detector de continuação forte do que um detector confiável de `5x`.

Na amostra inicial de 14 alertas:
- 7 bateram `2x+`
- 4 bateram `3x+`
- 1 bateu `5x+`
- mediana ficou perto de `2.09x`

Hipóteses iniciais:
- `score` sozinho não separa bem winner de falso positivo
- `time_to_2x` baixo ajuda, mas não garante continuação
- `alert_mcap` importa bastante
- alertas acima de `100k-160k` podem já estar tarde para mirar `5x`
- tokens com pré-migração forte parecem mais interessantes para entrada early

### Por Que Criamos o Post-Migration Blast

Um caso analisado tinha:
- 1 bucket pre-migration
- `pre_high_mcap` perto de `27.8k`
- pos-migration inicial perto de `12k-34k`
- em poucos minutos foi para `75k+`
- depois passou de `1M` em menos de 1h

Esse token nao entrou no Fast 5x porque:
- `first_mcap` pos-migration era perto de `12.3k`
- o minimo do Fast 5x era `15k`
- a regra tambem exigia `minBucketCoverage = 20`

Conclusao:
- Fast 5x continua sendo confirmacao conservadora
- Post-Migration Blast foi criado para capturar explosoes imediatas com poucos buckets
- os dois devem ser comparados lado a lado antes de qualquer alerta real

## Pré-Migração

Sinais pré-migração que começaram a aparecer nos bons casos:

```text
pre_high_mcap >= 25k
max_pre_vol_5m >= 20k-30k
pre_buckets >= 10
migração perto de 25k-35k mcap
```

Mas isso ainda tem falso positivo. Exemplo discutido: `chetgpt` tinha pré-migração forte, mas só fez `1.21x` desde o alerta.

Um caso importante foi `BEE`:
- 21 buckets pré-migração
- `pre_high_mcap` perto de `32.5k`
- `max_pre_vol_5m` perto de `46.3k`
- pós-migração caiu primeiro
- depois explodiu para mais de `1.5M`

Esse caso sugere que um sinal pré-migração não pode exigir subida linear logo após a migração. Pode haver shakeout antes do pump.

## Migration Grace

`migration_grace_until` hoje protege a reavaliação inicial do token migrado. O padrão atual é 10 minutos.

Um token pode "perder a grace" se só virar elegível depois de `migration_grace_until`.

Consulta para achar casos:

```sql
SELECT
  address,
  symbol,
  migration_grace_until,
  first_seen_at,
  last_evaluated_at,
  last_eligible_at,
  eligible_for_monitoring,
  eligibility_state,
  suppressed_reason,
  monitor_priority,
  last_mcap,
  ROUND(EXTRACT(EPOCH FROM (last_eligible_at - migration_grace_until)) / 60, 2) AS minutes_after_grace
FROM token_catalog
WHERE source = 'pumpfun-migrated'
  AND migration_grace_until IS NOT NULL
  AND last_eligible_at IS NOT NULL
  AND last_eligible_at > migration_grace_until
ORDER BY minutes_after_grace DESC
LIMIT 50;
```

Ponto importante:
- aumentar migration grace de 10m para 15m é simples e talvez razoável
- mas não resolveria todos os casos, como tokens que pumpam 20m+ depois da migração
- para esses casos, pré-migration momentum parece melhor do que só aumentar grace

## Consultas Úteis

Resumo geral do Fast 5x:

```sql
SELECT
  COUNT(*) AS total,
  MIN(alert_triggered_at) AS first_alert,
  MAX(alert_triggered_at) AS last_alert,
  ROUND(AVG(alert_mcap)::numeric, 2) AS avg_alert_mcap,
  ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY alert_mcap)::numeric, 2) AS median_alert_mcap,
  ROUND(AVG(score)::numeric, 2) AS avg_score,
  ROUND(AVG(max_x_since_alert)::numeric, 2) AS avg_max_x,
  ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY max_x_since_alert)::numeric, 2) AS median_max_x,
  COUNT(*) FILTER (WHERE max_x_since_alert >= 2) AS hit_2x,
  COUNT(*) FILTER (WHERE max_x_since_alert >= 3) AS hit_3x,
  COUNT(*) FILTER (WHERE max_x_since_alert >= 5) AS hit_5x
FROM pumpfun_fast_5x_detections;
```

Resumo geral do Post-Migration Blast:

```sql
SELECT
  COUNT(*) AS total,
  MIN(alert_triggered_at) AS first_alert,
  MAX(alert_triggered_at) AS last_alert,
  ROUND(AVG(alert_mcap)::numeric, 2) AS avg_alert_mcap,
  ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY alert_mcap)::numeric, 2) AS median_alert_mcap,
  ROUND(AVG(score)::numeric, 2) AS avg_score,
  ROUND(AVG(max_x_since_alert)::numeric, 2) AS avg_max_x,
  ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY max_x_since_alert)::numeric, 2) AS median_max_x,
  COUNT(*) FILTER (WHERE max_x_since_alert >= 2) AS hit_2x,
  COUNT(*) FILTER (WHERE max_x_since_alert >= 3) AS hit_3x,
  COUNT(*) FILTER (WHERE max_x_since_alert >= 5) AS hit_5x
FROM pumpfun_post_migration_blast_detections;
```

Comparar os dois dry-runs por faixa de resultado:

```sql
WITH detections AS (
  SELECT 'fast_5x' AS rule, token_address, symbol, alert_triggered_at, alert_mcap, max_x_since_alert, score
  FROM pumpfun_fast_5x_detections
  UNION ALL
  SELECT 'post_migration_blast' AS rule, token_address, symbol, alert_triggered_at, alert_mcap, max_x_since_alert, score
  FROM pumpfun_post_migration_blast_detections
)
SELECT
  rule,
  CASE
    WHEN max_x_since_alert >= 5 THEN '5x+'
    WHEN max_x_since_alert >= 3 THEN '3x-5x'
    WHEN max_x_since_alert >= 2 THEN '2x-3x'
    WHEN max_x_since_alert >= 1.5 THEN '1.5x-2x'
    ELSE '<1.5x'
  END AS outcome,
  COUNT(*) AS tokens,
  ROUND(AVG(alert_mcap)::numeric, 2) AS avg_alert_mcap,
  ROUND(AVG(score)::numeric, 2) AS avg_score
FROM detections
GROUP BY rule, outcome
ORDER BY rule, MIN(max_x_since_alert) DESC;
```

Cruzamento Fast 5x com pré-migração:

```sql
SELECT
  d.symbol,
  d.token_address,
  d.alert_triggered_at,
  d.alert_mcap,
  d.max_x_since_alert,
  COUNT(mb.*) AS pre_buckets,
  MIN(mb.bucket_ts) AS first_pre_bucket,
  MAX(mb.bucket_ts) AS last_pre_bucket,
  MIN(mb.low_mcap) AS pre_low_mcap,
  MAX(mb.high_mcap) AS pre_high_mcap,
  MAX(vb.close_vol_5m) AS max_pre_vol_5m
FROM pumpfun_fast_5x_detections d
LEFT JOIN token_market_buckets_1m mb
  ON mb.token_address = d.token_address
 AND mb.source = 'pumpfun-pre-migration'
LEFT JOIN token_market_volume_buckets_1m vb
  ON vb.token_address = mb.token_address
 AND vb.bucket_ts = mb.bucket_ts
 AND vb.source = 'pumpfun-pre-migration'
GROUP BY d.symbol, d.token_address, d.alert_triggered_at, d.alert_mcap, d.max_x_since_alert
ORDER BY d.max_x_since_alert DESC NULLS LAST;
```

Post-Migration Blast com pré-migração:

```sql
SELECT
  d.symbol,
  d.token_address,
  d.alert_triggered_at,
  d.alert_mcap,
  d.max_x_since_alert,
  COUNT(mb.*) AS pre_buckets,
  MIN(mb.bucket_ts) AS first_pre_bucket,
  MAX(mb.bucket_ts) AS last_pre_bucket,
  MIN(mb.low_mcap) AS pre_low_mcap,
  MAX(mb.high_mcap) AS pre_high_mcap,
  MAX(vb.close_vol_5m) AS max_pre_vol_5m
FROM pumpfun_post_migration_blast_detections d
LEFT JOIN token_market_buckets_1m mb
  ON mb.token_address = d.token_address
 AND mb.source = 'pumpfun-pre-migration'
LEFT JOIN token_market_volume_buckets_1m vb
  ON vb.token_address = mb.token_address
 AND vb.bucket_ts = mb.bucket_ts
 AND vb.source = 'pumpfun-pre-migration'
GROUP BY d.symbol, d.token_address, d.alert_triggered_at, d.alert_mcap, d.max_x_since_alert
ORDER BY d.max_x_since_alert DESC NULLS LAST;
```

Dados de um token específico:

```sql
SELECT *
FROM pumpfun_fast_5x_detections
WHERE token_address = 'TOKEN_X';
```

```sql
SELECT *
FROM pumpfun_post_migration_blast_detections
WHERE token_address = 'TOKEN_X';
```

```sql
SELECT
  mb.token_address,
  COUNT(*) AS pre_buckets,
  MIN(mb.bucket_ts) AS first_pre_bucket,
  MAX(mb.bucket_ts) AS last_pre_bucket,
  MIN(mb.low_mcap) AS pre_low_mcap,
  MAX(mb.high_mcap) AS pre_high_mcap,
  MAX(vb.close_vol_5m) AS max_pre_vol_5m,
  ROUND(AVG(vb.close_vol_5m)::numeric, 2) AS avg_pre_vol_5m
FROM token_market_buckets_1m mb
LEFT JOIN token_market_volume_buckets_1m vb
  ON vb.token_address = mb.token_address
 AND vb.bucket_ts = mb.bucket_ts
 AND vb.source = 'pumpfun-pre-migration'
WHERE mb.token_address = 'TOKEN_X'
  AND mb.source = 'pumpfun-pre-migration'
GROUP BY mb.token_address;
```

```sql
SELECT
  mb.bucket_ts,
  mb.source,
  mb.low_mcap,
  mb.high_mcap,
  mb.close_mcap,
  vb.close_vol_5m,
  vb.close_vol_1h
FROM token_market_buckets_1m mb
LEFT JOIN token_market_volume_buckets_1m vb
  ON vb.token_address = mb.token_address
 AND vb.bucket_ts = mb.bucket_ts
WHERE mb.token_address = 'TOKEN_X'
ORDER BY mb.bucket_ts ASC
LIMIT 180;
```

## O Que Ainda Nao Fazer

Nao transformar em alerta real ainda.

Com 14 registros, a amostra ainda e pequena. Um bom marco minimo para comecar a mexer em regra:
- 100 alertas para ver direcao
- 200-300 para comparar faixas com menos ruido
- 500+ para uma regra mais confiavel

## Proximos Passos Sugeridos

1. Deixar o dry-run acumular mais dados.
2. Acompanhar as paginas admin:
   - `/api/admin/pumpfun-fast-5x/dry-run.html?refresh=true`
   - `/api/admin/pumpfun-post-migration-blast/dry-run.html?refresh=true`
   - `/api/admin/pumpfun-combo-confirmation/dry-run.html?refresh=true`
3. Separar analise por faixa de `alert_mcap`:
   - `<50k`
   - `50k-100k`
   - `>100k`
4. Comparar winners e falsos positivos usando:
   - `pre_buckets`
   - `pre_high_mcap`
   - `max_pre_vol_5m`
   - `alert_mcap`
   - `timeTo2xMs`
   - `timeToHighMcapMs`
   - `p95Vol5mRecent`
   - `avgVol5mFirst30m`
   - `maxVol5mRecent`
5. Comparar Fast 5x vs Post-Migration Blast:
   - qual pega mais cedo
   - qual tem mais falso positivo
   - qual tem melhor `max_x_since_alert`
   - quanto tempo depois da migracao cada um dispara
6. Se o padrao pre-migration se confirmar, criar um terceiro dry-run separado:
   - nome sugerido: `pumpfun-pre-migration-momentum`
   - nao misturar com o Fast 5x atual
   - nao misturar com o Post-Migration Blast
   - nao emitir alerta real inicialmente

## Ponto Importante

O Fast 5x atual e um experimento de pos-migration confirmation.

O Post-Migration Blast e um experimento de explosao imediata pos-migration.

O que pode virar uma regra mais early provavelmente e outro experimento: pre-migration momentum. Manter os dois separados reduz risco de regressao e facilita remover a logica se a tese falhar.

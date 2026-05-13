# Sparkline performance plan

## Objetivo

Reduzir o tempo de carregamento das sparklines no Radar, principalmente em `Recent Tokens` e `Old Tokens 1 Week+`, sem mudar o comportamento visual esperado da UI.

Hoje o endpoint `POST /api/catalog/sparklines` calcula as series sob demanda a partir de `token_market_buckets_1m`. Para o Radar, o frontend pode pedir ate `100` charts no total entre Recent e Old, com janela de `14d` e orcamento de `336` pontos por chart.

O problema mais provavel nao e chamada externa. A sparkline vem do Postgres. A lentidao tende a vir da combinacao de:

- leitura de muitos buckets `1m`
- agregacao dinamica por granularidade
- `ROW_NUMBER() OVER (...)` no request
- batches de granularidades diferentes esperando todos terminarem antes de atualizar a UI

## Diagnostico atual

Arquivos principais:

- `frontend/src/state/app-controller.ts`
  - `SPARKLINE_WINDOW_HOURS = 14 * 24`
  - `SPARKLINE_POINT_COUNT = 336`
  - `SPARKLINE_VISIBLE_LIMIT_TOTAL = 100`
  - `fetchWorkspaceSparklinePayloads()` usa `Promise.all`
- `src/routes/catalog.js`
  - endpoint `POST /api/catalog/sparklines`
- `src/models/token-market-bucket-1m.js`
  - `listSparklineByAddresses()`
  - query principal em `token_market_buckets_1m`
- `src/utils/db-init-stage11.js`
  - tabela base `token_market_buckets_1m`

Query atual relevante:

```sql
WHERE token_address = ANY($1::varchar[])
  AND bucket_ts >= NOW() - ($2::int * INTERVAL '1 hour')
  AND close_mcap IS NOT NULL
```

Depois ela calcula `spark_bucket_ts`, ranqueia a ultima amostra de cada bucket com `ROW_NUMBER()`, e ordena por `token_address, bucket_ts`.

## Decisao tecnica

Nao vale tratar isso como problema apenas de VPS antes de medir. A VPS pode ampliar a lentidao, mas o desenho atual paga custo de agregacao no request.

TTL com recomputacao completa ajuda pouco como solucao principal, porque quando expira ainda recalcula a janela inteira. Ele so evita repeticao em requests proximos.

A solucao estrutural mais equilibrada e pre-agregar buckets por granularidade no banco, sem tentar ainda manter `series_json` final incremental.

## Bloco 1 - Instrumentacao e baseline

Objetivo: medir antes de mudar o modelo.

Status: implementado no backend para `/api/catalog/sparklines`.

Tarefas:

- Ativar/debugar `window.trendscopePerfDebug` no frontend para capturar:
  - `api.dashboard.history-bootstrap`
  - `api.catalog.sparklines`
- Ativar `PERF_METRICS_ENABLED=true` no backend para emitir headers/logs de `/api/catalog/sparklines`:
  - total de addresses
  - granularidade
  - duracao total
  - duracao da query
  - duracao de montagem da resposta
  - quantidade de rows lidas
  - quantidade de items retornados
- Rodar `EXPLAIN (ANALYZE, BUFFERS)` para um request real lento.

Comandos/checagens:

```js
window.trendscopePerfDebug.enable()
location.reload()
window.trendscopePerfDebug.dump().filter((entry) =>
  entry.label.includes('api.catalog.sparklines') ||
  entry.label.includes('api.dashboard.history-bootstrap')
)
```

No backend, com `PERF_METRICS_ENABLED=true`, o endpoint passa a emitir:

- header `Server-Timing`
- header `X-Perf-Label`
- header `X-Perf-Response-Bytes`
- log `[Perf] catalog.sparklines ...`

Resultado esperado:

- Confirmar se o gargalo esta no endpoint de sparkline.
- Separar tempo de DB, tempo de Node e tempo de render.

## Bloco 2 - Render parcial por batch

Objetivo: melhorar percepcao de velocidade sem mudar schema.

Status: implementado no frontend.

Hoje o frontend espera todos os batches:

```ts
const payloads = await Promise.all(...);
applyHistorySparklinePayload(mergeHistorySparklinePayloads(payloads));
```

Mudanca proposta:

- buscar batches em paralelo
- aplicar cada payload assim que chegar
- manter merge incremental no cache de `sparklineByAddress`
- nao apagar charts carregados por outros batches
- limpar estado `loading` apenas do batch que falhar

Cuidados:

- `applyHistorySparklinePayload()` agora faz merge incremental no cache existente.
- O estado `loading` deve ser limpo so para os addresses daquele payload.
- Expanded sparkline/modal deve continuar funcionando com o cache parcial.

Resultado esperado:

- Se `1m` ou `5m` voltar rapido, esses charts aparecem antes.
- `30m` de Old tokens deixa de bloquear Recent.

## Bloco 3 - Indice covering para fallback atual

Objetivo: acelerar a query atual e manter fallback bom mesmo depois da pre-agregacao.

Status: implementado em `src/utils/db-init-stage11.js`.

Indice proposto:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_market_buckets_1m_sparkline_cover
ON token_market_buckets_1m (token_address, bucket_ts DESC)
INCLUDE (pair_address, close_mcap)
WHERE close_mcap IS NOT NULL;
```

Por que ajuda:

- filtra fora rows sem `close_mcap`
- cobre colunas usadas pela query
- reduz leitura de heap quando Postgres consegue usar index-only scan
- melhora principalmente requests de muitos tokens e janela longa

Cuidados:

- `CREATE INDEX CONCURRENTLY` nao deve rodar dentro de transaction.
- Em ambiente pequeno pode demorar e consumir IO.
- Precisa validar com `EXPLAIN (ANALYZE, BUFFERS)` antes/depois.
- Na validacao local, o stage 11 levou cerca de `45s` para criar/verificar o indice; em producao, rodar fora de horario de pico.

## Bloco 4 - Tabela agregada por granularidade

Objetivo: reduzir drasticamente o numero de linhas lidas no request.

Status: implementado no schema como `token_market_buckets_agg`. Escrita, backfill e leitura ficam para os blocos seguintes.

Opcao recomendada: tabela unica com granularidade.

```sql
CREATE TABLE token_market_buckets_agg (
  token_address VARCHAR(64) NOT NULL,
  granularity_minutes INTEGER NOT NULL,
  bucket_ts TIMESTAMPTZ NOT NULL,
  pair_address VARCHAR(64),
  open_mcap NUMERIC(20, 2),
  high_mcap NUMERIC(20, 2),
  low_mcap NUMERIC(20, 2),
  close_mcap NUMERIC(20, 2),
  open_price NUMERIC(20, 12),
  high_price NUMERIC(20, 12),
  low_price NUMERIC(20, 12),
  close_price NUMERIC(20, 12),
  sample_count INTEGER NOT NULL DEFAULT 1,
  source VARCHAR(32) NOT NULL DEFAULT 'aggregate',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token_address, granularity_minutes, bucket_ts)
);
```

Indices:

```sql
CREATE INDEX idx_token_market_buckets_agg_lookup
ON token_market_buckets_agg (token_address, granularity_minutes, bucket_ts DESC)
WHERE close_mcap IS NOT NULL;

CREATE INDEX idx_token_market_buckets_agg_bucket_ts
ON token_market_buckets_agg (granularity_minutes, bucket_ts DESC);
```

Granularidades iniciais:

- `5`
- `15`
- `30`

Manter `1m` como fonte base em `token_market_buckets_1m`.

## Bloco 5 - Escrita dos agregados

Objetivo: manter a tabela agregada atualizada sem recalcular tudo no request.

Status: implementado em `src/models/token-market-bucket-1m.js`.

Ponto de integracao:

- `src/models/token-market-bucket-1m.js`
- depois de `upsertSnapshotBucket()`

Ao inserir/atualizar um bucket `1m`, calcular os buckets agregados correspondentes:

- `5m`: floor do timestamp para janela de 5 minutos
- `15m`: floor para 15 minutos
- `30m`: floor para 30 minutos

Upsert agregado:

- `open_*`: preservar primeiro valor do bucket agregado
- `high_*`: maior valor
- `low_*`: menor valor
- `close_*`: ultimo valor
- `sample_count`: soma/incremento
- `pair_address`: manter ultimo nao nulo ou primeiro confiavel

Cuidados:

- bucket atual ainda esta aberto e pode mudar a cada minuto
- dados atrasados podem chegar fora de ordem
- se dado antigo chegar, precisa recomputar o bucket agregado daquela janela ou aceitar aproximacao

Abordagem V1 segura:

- para bucket agregado aberto/recente, recomputar a janela a partir dos `1m` daquela janela
- para buckets antigos, upsert incremental e aceitar que raro dado atrasado sera corrigido por job de repair/backfill

Implementacao aplicada:

- cada `upsertSnapshotBucket()` continua gravando `token_market_buckets_1m`
- quando nasce um novo bucket `1m`, recalcula os buckets agregados `5m`, `15m` e `30m` afetados pelo timestamp daquele minuto
- para reduzir CPU/IO, escritas repetidas dentro do mesmo minuto nao recalculam agregados
- no nascimento de um novo minuto, tambem recalcula as janelas do minuto anterior para finalizar `close`, `high`, `low` e `sample_count` do minuto que acabou
- o recalculo usa os buckets `1m` da janela agregada, entao uma chegada fora de ordem dentro da mesma janela tende a ser corrigida no proximo refresh daquela janela ou pelo backfill/repair
- o upsert dos agregados afetados acontece em uma query unica
- `deleteByAddresses()` tambem remove os registros correspondentes em `token_market_buckets_agg`

Tradeoff assumido:

- o custo sai do request de sparkline e passa para a escrita de snapshots
- a query adicional de agregacao roda apenas quando o upsert cria um novo bucket `1m`, nao a cada avaliacao do mesmo minuto
- a escrita nao esta encapsulada em uma transaction unica com o bucket `1m`; em concorrencia extrema, um agregado pode ficar momentaneamente atrasado ate a proxima escrita ou backfill

## Bloco 6 - Backfill

Objetivo: popular `token_market_buckets_agg` para historico existente.

Status: implementado em `src/utils/backfill-market-buckets-agg.js`.

Script novo:

- `src/utils/backfill-market-buckets-agg.js`

Comportamento:

- processar por granularidade
- processar por janela de tempo ou por token
- limitar batch size para nao travar a VPS
- permitir resume
- logar progresso

Exemplo de agregacao:

```sql
INSERT INTO token_market_buckets_agg (...)
SELECT
  token_address,
  $1 AS granularity_minutes,
  date_trunc('hour', bucket_ts)
    + (
      FLOOR(EXTRACT(MINUTE FROM bucket_ts) / $1::numeric)
      * ($1::int * INTERVAL '1 minute')
    ) AS bucket_ts,
  ...
FROM token_market_buckets_1m
WHERE bucket_ts >= $2
  AND bucket_ts < $3
GROUP BY token_address, aggregate_bucket_ts;
```

Cuidados:

- usar batches pequenos no comeco
- medir IO e lock pressure
- nao rodar em horario de pico

Implementacao aplicada:

- script `npm run market-buckets-agg:backfill -- ...`
- fonte: `token_market_buckets_1m`
- destino: `token_market_buckets_agg`
- default conservador: ultimos `14d`, granularidades `5,15,30`, batch de `250` addresses
- `--all` precisa ser explicito para historico completo
- `--afterAddress <address>` permite continuar a partir do ultimo cursor logado
- `--limitAddresses <n>` limita o total de addresses processados
- `--batchSize <n>` ajusta o tamanho do lote
- `--granularity 5,15,30` permite rodar granularidades especificas
- `--dryRun` conta e pagina candidates sem escrever agregados
- `--resetRange` limpa agregados do escopo antes de regravar cada batch

Exemplos:

```bash
npm run market-buckets-agg:backfill -- --days 14 --batchSize 100 --dryRun
npm run market-buckets-agg:backfill -- --days 14 --batchSize 100
npm run market-buckets-agg:backfill -- --all --batchSize 100 --afterAddress So11111111111111111111111111111111111111112
```

## Bloco 7 - Leitura usando agregados

Objetivo: trocar a leitura de sparkline para a tabela agregada quando a granularidade for maior que `1m`.

Status: implementado em `src/models/token-market-bucket-1m.js`.

Regra:

- `granularityMinutes === 1`: usar `token_market_buckets_1m`
- `granularityMinutes in (5, 15, 30)`: usar `token_market_buckets_agg`
- fallback: se agregado tiver cobertura baixa, cair para query antiga em `1m`

Implementacao aplicada:

- `5m`, `15m` e `30m` leem primeiro de `token_market_buckets_agg`
- outras granularidades continuam usando a query antiga baseada em `token_market_buckets_1m`
- se a serie agregada vier vazia ou com janela efetiva curta demais para uma janela de 24h+, o backend faz fallback apenas dos addresses afetados para `token_market_buckets_1m`
- metricas de `/api/catalog/sparklines` passam a incluir `source`, `aggregateRows`, `fallbackRows` e `fallbackAddresses`

Cuidados:

- enquanto o backfill nao estiver completo, requests podem cair parcialmente no fallback `1m`
- depois do backfill, `fallbackAddresses` deve tender a `0` nas janelas longas
- se `fallbackAddresses` continuar alto para Old tokens, a tabela agregada ainda esta incompleta ou a janela efetiva dos dados esta curta demais

Beneficio estimado para Old tokens:

- 14 dias em `1m`: ate `20160` pontos por token
- 14 dias em `30m`: ate `672` pontos por token
- reducao aproximada: `30x` menos linhas antes do downsample

## Bloco 8 - Cache opcional curto

Objetivo: evitar requests repetidos identicos em janelas curtas.

Status: implementado em `src/models/token-market-bucket-1m.js`.

Depois da tabela agregada, um TTL simples passa a ser mais util, porque o fallback ja ficou barato.

Opcoes:

- cache em memoria por processo: simples, mas perde em restart e nao compartilha entre replicas
- cache em Postgres: mais persistente, mas adiciona schema
- cache em Redis: melhor operacionalmente, mas adiciona dependencia

Para V1:

- cache em memoria por `address + granularity + hours + points`
- TTL `30s`
- limite maximo de entradas

Implementacao aplicada:

- cache em memoria no processo Node
- chave por lista de addresses normalizada na ordem do request, `hours`, `points` e `granularityMinutes`
- TTL padrao de `30s`
- limite padrao de `500` entradas
- cache hit reportado em `modelMetrics.cacheHit`
- entries afetadas sao invalidadas quando `upsertSnapshotBucket()` grava novo bucket para um address
- entries afetadas tambem sao invalidadas em `deleteByAddresses()`

Cuidados:

- cache em memoria nao compartilha entre processos/restart/redeploy
- uma sparkline pode ficar ate `30s` atrasada se nao houver escrita para aquele address invalidando a entrada
- para diagnostico, `listSparklineByAddresses()` aceita `disableCache: true`

## Bloco 9 - Validacao

Backend:

- testes de agregacao de buckets
- teste de fallback para `1m`
- teste de leitura usando `token_market_buckets_agg`
- teste de backfill em dataset pequeno
- teste de cache hit para request repetido
- teste de invalidacao do cache por address

Frontend:

- render parcial nao apaga batch anterior
- loading state limpa por address
- expanded sparkline continua abrindo
- Recent e Old continuam respeitando active wallet markers

Comandos esperados:

```bash
npm run lint
node --test tests/token-market-bucket-1m.test.js
node --test tests/catalog.test.js
npm --prefix frontend run build
npm run db:schema-check
```

Status de validacao aplicada:

- testes unitarios cobrem escrita agregada, fallback seletivo, cache hit, invalidacao por address e backfill
- endpoint `/api/catalog/sparklines` foi validado por `tests/catalog.test.js`
- schema runtime validado por `npm run db:schema-check`
- `npm --prefix frontend run build` valida que o render parcial continua compilando

## Pontos importantes

- Pre-agregacao troca custo de request por custo de armazenamento e escrita no banco.
- Nao e principalmente memoria; o principal custo novo e DB storage, indices e write amplification.
- `TTL + recomputacao completa` sozinho nao resolve o problema estrutural.
- Incremental final com `series_json` e mais rapido, mas e mais arriscado por bucket aberto, dados atrasados, janela movel e downsampling.
- Tabela agregada por granularidade e o meio-termo mais seguro: reduz muito leitura/CPU sem exigir cache final perfeito.
- O rollout ideal e em blocos: render parcial, indice, tabela agregada, backfill, leitura agregada, cache curto opcional.

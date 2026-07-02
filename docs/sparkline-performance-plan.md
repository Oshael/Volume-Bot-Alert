# Sparkline performance plan

## Replanejamento - expanded chart com candles

Objetivo atualizado:

- suportar janelas/resolucoes de chart ampliado em `5m`, `15m`, `30m`, `1h`, `4h` e `24h`
- manter candles a partir de `open/high/low/close` ja persistidos em `token_market_buckets_agg`
- parar de depender de backfill/manual SQL periodico para manter agregados basicos em dia
- separar claramente duas coisas diferentes:
  - agregacao/rollup para leitura de chart
  - retencao/limpeza para economizar espaco na VPS

Estado real do codigo hoje:

- `token_market_buckets_agg` existe, mas o schema de stage 38 limita `granularity_minutes IN (5, 15, 30)`
- `AGGREGATE_GRANULARITY_MINUTES` em `src/models/token-market-bucket-1m.js` tambem esta limitado a `[5, 15, 30]`
- `src/utils/backfill-market-buckets-agg.js` tambem so aceita `5,15,30`
- o frontend agrupa sparklines em `[1, 5, 15, 30]`
- o endpoint `/api/catalog/sparklines` aceita no maximo `60` minutos, entao `4h` e `24h` ainda seriam rejeitados
- existe cleanup automatico de tokens arquivados/bloqueados, mas nao existe hoje um job automatico que faca:
  - preencher agregados faltantes por janela
  - compactar `1m` antigo em `1h/4h/24h`
  - apagar `1m` antigo so depois de garantir cobertura agregada

Conclusao sobre o "resumo manual" usado para economizar espaco:

- se o resumo manual era rodar `npm run market-buckets-agg:backfill`, ele esta diretamente ligado aos agregados de chart
- se o resumo manual tambem apagava dados antigos de `token_market_buckets_1m`, isso nao esta automatizado no codigo atual
- o cleanup automatico atual economiza espaco apenas ao arquivar/bloquear tokens e apagar artefatos desses tokens; ele nao faz retencao temporal generica de buckets `1m`

Diagnostico operacional de `5m/15m/30m` em 2026-07-01:

- o ultimo backfill manual registrado em `token_market_buckets_agg` foi em `2026-05-26 00:18 UTC`
- isso nao significa que os agregados estejam atrasados, porque o on-write continuou gerando `source = aggregate`
- `latest_agg_bucket_ts` estava recente em `2026-07-01` para `5m/15m/30m`
- a auditoria resumida por dia mostrou buckets completos do inicio ao fim do dia nas granularidades existentes
- a queda de rows em `2026-06-17` e `2026-06-18` foi validada comparando `5m -> 15m` e `5m -> 30m`; ambos deram `missing = 0`
- decisao: nao rodar backfill amplo para `5m/15m/30m` agora; so investigar/backfillar essas granularidades se houver sinal concreto de buraco

Plano novo:

1. Expandir granularidades suportadas.
   - criar um stage novo para trocar o check constraint de `token_market_buckets_agg`
   - nova lista: `5, 15, 30, 60, 240, 1440`
   - atualizar `AGGREGATE_GRANULARITY_MINUTES`
   - atualizar `SUPPORTED_GRANULARITIES` do backfill
   - atualizar validacao de `/api/catalog/sparklines` para aceitar ate `1440`

2. Centralizar configuracao de granularidades.
   - evitar listas duplicadas em model, route, backfill e frontend
   - expor helper backend para validacao de granularidade
   - no frontend, trocar listas hardcoded `[1, 5, 15, 30]` por `1,5,15,30,60,240,1440`

3. Atualizar escolha de resolucao no frontend.
   - manter tokens muito novos em `1m` quando fizer sentido
   - usar `5m` para janela curta
   - usar `15m/30m` para varios dias
   - usar `1h/4h/24h` para chart ampliado e historico longo
   - o modal de expanded chart deve ter controles explicitos de resolucao: `5m`, `15m`, `30m`, `1h`, `4h`, `24h`

4. Atualizar leitura de candles.
   - `/api/catalog/sparklines/expanded` deve aceitar `granularityMinutes`
   - para `5/15/30/60/240/1440`, ler `token_market_buckets_agg`
   - retornar candles com:
     - `openMcap`, `highMcap`, `lowMcap`, `closeMcap`
     - `openPrice`, `highPrice`, `lowPrice`, `closePrice`
     - `sampleCount`, `bucketTs`, `granularityMinutes`
   - fallback para `1m` so deve existir quando for seguro e explicitamente permitido

5. Automatizar manutencao dos agregados.
   - criar worker/job pequeno para reparar janelas recentes continuamente
   - exemplo inicial:
     - a cada `5m`, reparar ultimas `2h` de `5m/15m/30m`
     - a cada `30m`, reparar ultimas `24h` de `1h`
     - a cada `4h`, reparar ultimos `7d` de `4h`
     - a cada `24h`, reparar ultimos `60d+` de `24h`
   - usar locks/estado em `worker_runtime_state` para nao duplicar trabalho entre processos
   - rodar com batches pequenos e `statementTimeoutMs`

6. Automatizar retencao de `1m`.
   - regra operacional desejada:
     - manter sempre `14d` completos de `token_market_buckets_1m`
     - apagar automaticamente buckets `1m` a partir do 15o dia
     - antes de apagar o 15o dia, garantir que os agregados/candles desse periodo ja foram preenchidos
   - substituir o fluxo manual atual:
     - hoje o operador roda resumo/backfill para popular `token_market_buckets_agg`
     - hoje o operador apaga `1m` antigo para economizar espaco
     - alvo: o bot fazer os dois passos automaticamente, em ordem segura
   - o worker de retencao deve:
     - selecionar uma janela antiga pequena, por exemplo `15d` ate `15d + 1h`
     - reparar/backfill os agregados necessarios para essa janela
     - validar cobertura minima em `5m/15m/30m/1h/4h/24h`
     - deletar apenas os buckets `1m` daquela janela validada
     - repetir em chunks pequenos ate manter somente os ultimos `14d`
   - nunca rodar um `DELETE` temporal grande sem limite
   - se a cobertura agregada falhar, nao apagar `1m` daquela janela
   - registrar progresso em `worker_runtime_state` para continuar apos restart

7. Backfill inicial.
   - rodar `dryRun` por granularidade
   - depois de expandir schema/codigo, fazer backfill inicial apenas das novas granularidades: `60`, `240`, `1440`
   - nao reparar `5/15/30` por padrao; antes, validar com auditoria leve e so rodar em janelas com buraco comprovado
   - usar `--windowHours` ou janela explicita para evitar travar a VPS
   - adicionar resume via `worker_runtime_state` ou cursor persistido, nao depender apenas do terminal aberto

8. Validacao.
   - testes unitarios para:
     - bucket floor de `60/240/1440`
     - backfill aceitando novas granularidades
     - leitura agregada sem fallback indevido
     - candles OHLC corretos em janela agregada
   - testes de rota para granularidade `240` e `1440`
   - build frontend validando os controles do modal
   - `npm run db:schema-check` validando novo check constraint/schema

Status de implementacao local em 2026-07-01:

- feito: schema stage 47 para aceitar `60/240/1440` em `token_market_buckets_agg`
- feito: granularidades centralizadas no backend em `src/utils/market-bucket-granularities.js`
- feito: backfill aceita `60/240/1440`
- feito: backfill de `60/240/1440` usa `token_market_buckets_agg` em `5m` como fonte, porque a tabela `1m` pode ter apenas os ultimos 14 dias
- feito: leitura expanded aceita `granularityMinutes` e `allowOneMinuteFallback`
- feito: leitura expanded retorna `candles` OHLC e preserva `series`
- feito: fallback para `1m` no expanded agora e apenas explicito
- feito: frontend normaliza e guarda `candles`, e o client HTTP ja aceita enviar `granularityMinutes`
- feito: backfill inicial de `60/240/1440` executado na VPS a partir do `5m`
- feito: cobertura de `4h` e `24h` validada contra `5m` com `0` divergencias
- feito: modal expanded renderiza candles quando o payload traz OHLC valido, com fallback para `series`
- feito: controles visiveis de resolucao no modal expanded chamam o backend com `granularityMinutes`
- feito: default do modal expanded e `5m`, a menor granularidade agregada disponivel
- feito: candle chart tem labels de preco/tempo e crosshair livre com market cap no eixo Y, horario no eixo X e tooltip OHLC do candle mais proximo
- feito: candle chart tem linha de market cap atual com cor baseada no ultimo candle
- feito: candle chart suporta zoom horizontal por scroll/pinch, pan por arraste e reset da janela
- feito: eixos adaptativos mostram mais niveis de market cap e alternam horas/dias conforme o zoom
- feito: eixo de market cap aceita zoom vertical por arraste/scroll e reset por duplo clique
- feito: chart aceita pan vertical livre no corpo depois de ajustar a escala Y
- feito: eixo X aceita overscroll para posicionar candles alem das bordas esquerda/direita
- feito: renderer do expanded chart migrado para `lightweight-charts`; zoom, pan, crosshair e escalas agora usam o motor nativo da biblioteca
- feito: price scale do Lightweight Charts inicia em modo manual com range OHLC calculado, liberando ajuste isolado do eixo Y
- feito: wheel sobre a faixa direita ajusta somente o range do eixo Y, ancorado na altura do cursor
- feito: `low_mcap` com wick inferior extremo agora e normalizado na leitura dos candles expandidos e no calculo/backfill de agregados, evitando samples GMGN isolados como `0.01` ou quedas artificiais contaminarem o chart
- pendente: worker de reparo/retencao

Gate operacional antes de expor `1h/4h/24h` na UI:

- aplicar `node src/utils/db-init-stage47.js` na VPS
- rodar `npm run db:schema-check` na VPS
- fazer backfill inicial somente das novas granularidades (`60`, `240`, `1440`) em janelas pequenas/resumiveis
- para janelas mais antigas que a retencao de `1m`, gerar `60/240/1440` a partir dos buckets `5m` ja existentes
- validar cobertura antes de habilitar controles do modal para essas resolucoes
- manter `5/15/30` sem backfill amplo enquanto auditorias leves nao mostrarem buracos reais

Proximos blocos de frontend, em ordem:

1. Renderizar candles no modal expanded. Status: implementado.
   - trocar a visualizacao principal do modal de sparkline simples para candle chart
   - consumir `candles` do payload expanded
   - manter fallback para `series` quando `candles` vier vazio
   - nao adicionar ferramentas de desenho neste bloco

2. Adicionar controle explicito de resolucao. Status: implementado.
   - opcoes: `5m`, `15m`, `30m`, `1h`, `4h`, `24h`
   - chamar `/api/catalog/sparklines/expanded` com `granularityMinutes`
   - cachear por `address + granularityMinutes`
   - mostrar loading apenas da resolucao solicitada

3. Adicionar informacoes complementares do chart.
   - status: labels de preco/tempo e hover/crosshair implementados
   - status: linha de market cap atual implementada; verde no ultimo candle positivo e vermelha no negativo
   - volume so entra depois de ampliar o contrato backend, porque o payload atual tem OHLC e `sampleCount`, nao volume real
   - marcadores do bot entram depois dos candles e da escala tempo/preco estarem estaveis
   - linhas de referencia entram como camada propria, nao misturadas com candle rendering

4. Adicionar ferramentas manuais minimas.
   - status: zoom horizontal, pan e reset de enquadramento implementados
   - comecar por linha horizontal e trendline
   - texto, regua, brush e outras ferramentas estilo Axion/TradingView ficam para fases posteriores
   - cada ferramenta precisa de estado, eventos de mouse/touch, conversao pixel-tempo-preco, renderizacao e persistencia se for necessario manter ao reabrir

Pontos importantes:

- adicionar `1h/4h/24h` aumenta write amplification: cada novo bucket `1m` pode recalcular mais agregados.
- para VPS pequena, talvez seja melhor o on-write manter `5/15/30` e o worker assinar `60/240/1440` em lote.
- `5/15/30` nao devem ser backfillados em massa so porque o ultimo backfill manual e antigo; o on-write pode ter mantido a tabela em dia.
- apagar `1m` antigo e gerar candles sao problemas relacionados, mas nao devem ser acoplados no mesmo primeiro deploy.
- o rollout seguro e: schema + backfill + leitura + worker de reparo; retencao automatica de `1m` entra depois, mantendo sempre `14d` e apagando o 15o dia em chunks validados.
- se `1m` for apagado antes de validar cobertura agregada, o chart ampliado pode ficar com buracos permanentes.

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
- default tecnico do script: ultimos `14d`, granularidades `5,15,30`, batch de `250` addresses
- regra operacional: nao usar o default de `14d` automaticamente em producao; descobrir a janela real por auditoria antes de escrever
- `--all` precisa ser explicito para historico completo
- `--afterAddress <address>` permite continuar a partir do ultimo cursor logado
- `--limitAddresses <n>` limita o total de addresses processados
- `--batchSize <n>` ajusta o tamanho do lote
- `--granularity 5,15,30` permite rodar granularidades especificas
- `--startDate <timestamp> --endDate <timestamp> --windowHours <n>` permite rodar por janelas temporais pequenas
- `--dryRun` conta e pagina candidates sem escrever agregados
- `--resetRange` limpa agregados do escopo antes de regravar cada batch

Auditoria resumida antes de qualquer backfill de `5/15/30`:

```sql
SELECT
  date_trunc('day', bucket_ts) AS day,
  granularity_minutes,
  COUNT(*) AS agg_rows,
  COUNT(DISTINCT token_address) AS tokens,
  MIN(bucket_ts) AS first_bucket_ts,
  MAX(bucket_ts) AS latest_bucket_ts,
  COUNT(*) FILTER (WHERE source IN ('aggregate_backfill', 'aggregate_window_backfill')) AS backfill_rows,
  COUNT(*) FILTER (WHERE source = 'aggregate') AS onwrite_rows
FROM token_market_buckets_agg
WHERE bucket_ts >= '2026-05-26T00:00:00Z'
  AND bucket_ts < NOW()
  AND granularity_minutes IN (5, 15, 30)
GROUP BY 1, 2
ORDER BY 1, 2;
```

Comparacao barata para confirmar se `15m` ou `30m` esta faltando em relacao a `5m` numa janela suspeita:

```sql
WITH expected AS (
  SELECT DISTINCT
    token_address,
    date_trunc('hour', bucket_ts)
      + FLOOR(EXTRACT(MINUTE FROM bucket_ts) / 15)::int * INTERVAL '15 minutes' AS bucket_ts
  FROM token_market_buckets_agg
  WHERE granularity_minutes = 5
    AND bucket_ts >= '2026-06-17T00:00:00Z'
    AND bucket_ts <  '2026-06-19T00:00:00Z'
),
actual AS (
  SELECT token_address, bucket_ts
  FROM token_market_buckets_agg
  WHERE granularity_minutes = 15
    AND bucket_ts >= '2026-06-17T00:00:00Z'
    AND bucket_ts <  '2026-06-19T00:00:00Z'
)
SELECT
  date_trunc('day', e.bucket_ts) AS day,
  COUNT(*) AS expected_from_5m,
  COUNT(a.*) AS actual_15m,
  COUNT(*) - COUNT(a.*) AS missing_15m
FROM expected e
LEFT JOIN actual a
  ON a.token_address = e.token_address
 AND a.bucket_ts = e.bucket_ts
GROUP BY 1
ORDER BY 1;
```

Para validar `30m`, trocar divisor/intervalo para `30`, `granularity_minutes = 30` e aliases `actual_30m`/`missing_30m`.

Exemplos operacionais:

```bash
npm run market-buckets-agg:backfill -- --startDate "2026-06-17T00:00:00.000Z" --endDate "2026-06-19T00:00:00.000Z" --windowHours 1 --granularity 15,30 --statementTimeoutMs 30000 --dryRun
npm run market-buckets-agg:backfill -- --startDate "2026-06-17T00:00:00.000Z" --endDate "2026-06-19T00:00:00.000Z" --windowHours 1 --granularity 15,30 --statementTimeoutMs 30000
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

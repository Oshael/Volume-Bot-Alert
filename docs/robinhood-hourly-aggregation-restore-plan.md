# Plano: restaurar a agregação horária Robinhood (pós-cutover)

Status: proposto, aguardando autorização
Prioridade: crítica (liquidez apagada + VOL 6H/24H degradando por hora)
Origem: incidente pós-cutover de 2026-08-06
Relacionado: `docs/robinhood-live-head-isolation-urgent-plan.md`,
`docs/robinhood-discovery-processing-consumer-plan.md`

## 1. Sintoma e evidência

- **TOTAL LIQ = "-"** para todos os tokens; **VOL 6H/24H** aparentemente ok mas
  degradando.
- `robinhood_market_buckets_1h` e `robinhood_market_buckets_agg` (g=60)
  **congelados em `2026-08-05 23:51:22`** (mesmo carimbo do desligamento do
  monólito):

```
tbl            | latest_bucket          | latest_obs             | n_total
buckets_1h     | 2026-08-05 23:00:00-03 | 2026-08-05 23:51:22-03 | 1791551
buckets_agg_60 | 2026-08-05 23:00:00-03 | 2026-08-05 23:51:22-03 | 1579542
```

- `robinhood_market_buckets_1m` estão **vivos** e com `close_liquidity_usd` em
  todos os protocolos (o processing escreve o 1m normalmente). Só o rollup 1h→
  morreu.

## 2. Por que liquidez quebra na hora e volume só degrada

A leitura de liquidez (`robinhood-workspace-window-read.js`,
`latest_pool_liquidity`) exige o bucket **1h da hora corrente** com
`last_observed_at > now - 15min`. Assim que o rollup 1h para, esse filtro falha
imediatamente → `liquidity_usd` nulo → "-".

O volume das janelas lê `robinhood_market_buckets_1h` para as **horas completas**
e `robinhood_market_buckets_1m` para a hora corrente/bordas. Enquanto o rollup 1h
tinha as horas até 23:00, VOL 24H ainda somava a maior parte da janela — por isso
parecia saudável. A cada hora que passa, mais horas completas ficam sem bucket 1h
→ VOL 6H/24H encolhem e eventualmente quebram.

## 3. Causa raiz (CONFIRMADA)

**`robinhood_market_buckets_1h` não tem escritor no caminho split.**

Verificado em prod (2026-08-06): mesmo com `ROBINHOOD_DERIVED_LIVE_SINKS_ENABLED=true`,
o derived rodando e o outbox produzindo, `buckets_1h` seguiu parado em
`2026-08-05 23:00` (staleness > 3h). Flag/restart/alertas não mudam isso.

A escrita de `buckets_1h`:

- No monólito: `commitMarketRange` → `refreshHourlyBuckets` (persistence, inline na
  transação de cada faixa). **Desligado no cutover.**
- No caminho split: `commitHeadProcessingBatch` escreve `buckets_1m` mas **não**
  faz o rollup horário.
- O `robinhood-market-aggregate-worker` **não escreve `buckets_1h`**: seu
  `processTask` (linha 116-121) só chama `repository.refreshBucket`, que escreve
  `robinhood_market_buckets_agg` — e para granularidade 60/240/1440 **lê**
  `buckets_1h` como fonte (`GRANULARITY_SOURCE`). Com `buckets_1h` parado, o
  `buckets_agg` 60/240/1440 também parou (query confirmou ambos em 23:00).
- O model tem `refreshHourlyRange` (roda `HOURLY_REFRESH_SQL`, escreve
  `buckets_1h`), mas **só o util de backfill o chama** — nenhum worker live.

Ou seja: ninguém faz o rollup `1m → buckets_1h` ao vivo pós-cutover. O flag dos
live-sinks e o overflow de alerta (seção 5.1) são elos SEPARADOS; nenhum deles
escreve `buckets_1h`.

## 4. Cadeia completa que precisa estar no ar (checklist de verificação)

Para o 1h voltar a ser mantido, os três elos precisam estar ativos no processo
`robinhood-derived` (e o produtor no `robinhood-processing`):

1. **Produtor de outbox ligado**: o `robinhood-processing` emite `market:bucket`
   para `robinhood_derived_outbox` (`emitOutbox` /
   `ROBINHOOD_DERIVED_OUTBOX_ENABLED`). Sem isso, o derived não tem o que
   entregar e o aggregate nunca é alimentado.
2. **Derived em modo de entrega** (não `shadowAuditOnly`): só assim o
   `deliveryFanout` roda e chama `marketAggregateWorker.enqueue`.
3. **Live sinks + aggregate habilitados**: `liveSinksEnabled = true` e
   `marketAggregateOptions.enabled = true`, para que `liveSinks.start()` execute
   `aggregates.start(...)` e o worker fique `running`.

Verificar em prod (telemetria/status do worker ou env):

```
# status do processo derived (porta 3008) — checar mode e aggregates.running
curl -s localhost:3008/status | jq '.robinhoodDerivedWorker'
# e o processing (porta 3007) — checar se emite outbox
curl -s localhost:3007/status | jq '.robinhoodProcessingWorker'
# fila do outbox: deve estar sendo drenada, não parada
SELECT count(*) FROM robinhood_derived_outbox;
```

## 5. Conserto — parte A (pra frente) — é CÓDIGO

Adicionar o rollup horário ao caminho de processing, fiel ao que o monólito fazia:

- Em `commitHeadProcessingBatch` (`robinhood-persistence.js`), dentro da mesma
  transação, chamar `await refreshHourlyBuckets(client, observations)` — as
  `observations` e o `client` já existem ali. `refreshHourlyBuckets(client, rows)`
  agrega os `buckets_1m` tocados em `buckets_1h` por (protocol, market_key, hora).
- Espelha `commitMarketRange` (persistence:1755-1757). Avaliar reusar o
  `shouldDeferHourlyRefresh` (opção de perf que adia a hora corrente); no
  processing pode não haver `cursor`, então tratar o defer ou refazer a hora
  corrente direto.
- Escopo: 1 função hub (`commitHeadProcessingBatch`), ~10-20 linhas + teste que
  prove que `commitHeadProcessingBatch` passa a escrever `buckets_1h`. Deploy:
  `robinhood-processing` (VPS2). Sem schema.

Alternativa (se não quiser peso na tx de processing): um worker chamar
`refreshHourlyRange` (HOURLY_REFRESH_SQL) event-driven/periódico. Mais peças; a
opção inline é a mais simples e idêntica ao comportamento antigo.

### 5.1 Segundo bug independente: overflow numérico nos standard alerts — RESOLVIDO

**Corrigido (2026-08-06):** clamp aplicado no único ponto de escrita
(`upsertState` em `src/models/user-alert-rule-state.js`, chain-agnóstico), limitando
`last_alerted_value` a `±9e15` (`NUMERIC(20,4)`) e `last_alerted_pct` a `±99.999.999`
(`NUMERIC(10,2)`). Cobre solana e robinhood e ambas as colunas numéricas — nenhum caller mudou,
sem schema/migration. Teste em `tests/user-alert-rule-state.test.js` reproduz o overflow
(`3.4e53` / `-9.9e40`) e prova o clamp. Deploy: reiniciar os processos que gravam
`user_alert_rule_state` (derived p/ standard alerts; web/worker p/ estado solana); depois os flags
de alerta podem voltar sem entupir a outbox. O texto abaixo é o diagnóstico original.



Ao ligar `ROBINHOOD_DERIVED_STANDARD_ALERTS_ENABLED=true` +
`REALTIME_ALERTS_ENABLED=true`, o `standardAlertSink.consume` (await no
`deliveryWithAlerts`) lança `numeric field overflow` de forma persistente
(`[robinhood-derived] fan-out failed, retrying row numeric field overflow`). Isso
NÃO congela `buckets_1h` (o aggregate é outro caminho), mas **entope a entrega do
outbox** (re-tentativa → dead-letter) e quebra os alertas.

Coluna culpada: `last_alerted_pct NUMERIC(10, 2)` (db-init-stage29, escrita por
`user-alert-rule-state.js`), máx ~99.999.999,99. Tokens micro-cap (ex.: preço
3e-7) geram variação % astronômica → estoura. (Suspeito secundário:
`token_catalog.last_price_change_* NUMERIC(20, 2)`.)

- **Mitigação imediata**: desligar os alertas no env do derived até corrigir —
  `ROBINHOOD_DERIVED_STANDARD_ALERTS_ENABLED=false` e
  `ROBINHOOD_DERIVED_REALTIME_ALERTS_ENABLED=false` + restart. Tira o
  `standardAlertSink` do fanout, o outbox drena limpo.
- **Fix permanente**: ampliar a coluna (ex.: `NUMERIC(20, 4)`) OU clampar/rejeitar
  a % na origem antes de gravar (um alerta de +1e12% não é informativo; clampar em
  um teto é aceitável). Escopo próprio, com schema migration se ampliar a coluna.

## 6. Conserto — parte B (backfill do buraco 23:00 → agora)

O `recover()` do startup cobre só ≤180min de lookback; o buraco já passa disso e
cresce. Reconstruir `buckets_1h`/`agg` a partir do 1m (intacto) com o util:

```bash
# 1) dry-run primeiro (não escreve), confirmar contagem/alvos
node src/utils/backfill-robinhood-market-aggregates.js \
  --mode dry-run --from 2026-08-05T23:00:00Z --to <agora>

# 2) write, com checkpoint para retomar
node src/utils/backfill-robinhood-market-aggregates.js \
  --mode write --checkpoint /tmp/robinhood-agg-backfill.json \
  --from 2026-08-05T23:00:00Z --to <agora> \
  --tokenLimit 50 --statementTimeoutMs 30000 --sleepMs 250
```

- Idempotente (upsert por identidade); seguro rodar em paralelo à ingestão.
- `--from` = último bucket bom (`2026-08-05 23:00Z`); `--to` = agora.
- Depois de A no ar, o backfill vira one-shot; sem A, precisaria re-rodar.

## 7. Ordem de execução (urgência)

1. **Verificar a seção 4** (qual elo está desligado) — 5 min, sem risco.
2. **Ligar a parte A** (flags/redeploy) — estanca a degradação futura e restaura
   a liquidez em minutos (o startup `recover` já preenche até 180min).
3. **Rodar a parte B** (backfill) se o buraco exceder 180min ou se A demorar.
4. Confirmar aceite (seção 9).

Se A não puder subir já, rodar B como paliativo imediato — mas sem A o 1h volta a
congelar em ~15min, então B sozinho é só um respiro.

## 8. Testes / validação

- Após A: `robinhood_market_buckets_1h` volta a avançar (query da seção 1 com
  `latest_bucket` na hora corrente e `latest_obs` < 1min).
- `robinhood_derived_outbox` sendo drenado (count estável/baixo, não crescente).
- Liquidez volta no board; VOL 6H/24H param de encolher.
- Se houver mudança de código no wiring do derived: teste que prove que um
  `market:bucket` entregue chama `marketAggregateWorker.enqueue` e que o worker
  sobe com o co-start (unit, sem DB) — estender o teste existente do derived
  worker em vez de duplicar.

## 9. Critérios de aceite

- `buckets_1h`/`agg` avançando continuamente (last_observed_at fresco < 15min).
- TOTAL LIQ preenchido para tokens com pool valorado.
- VOL 6H/24H estáveis, sem degradação horária.
- Outbox drenando; aggregate worker `running` no status do derived.
- Backfill do intervalo 23:00→retomada aplicado e idempotente.

## 10. Nota de contexto (meta)

Este é o terceiro elo do monólito exposto pelo cutover, junto com a descoberta de
pool (`docs/robinhood-discovery-processing-consumer-plan.md`) e o bug de cobertura
por `blocked` (já corrigido, commits `23b8bf31` + `8dbfbcf7`) — todos com carimbo
`23:51`. Antes de qualquer novo desligamento do monólito, mapear tudo que só
`commitMarketRange`/`emitMarketBucketUpdate` faz e garantir consumidor no split
(agregação, discovery/upsertPool, sinks in-memory de catálogo/alerta).

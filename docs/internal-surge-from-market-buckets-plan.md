# Internal surge from market buckets plan

## Objetivo

Fazer os alertas `recent-surge-1h`, `recent-surge-6h`, `old-week-surge-1h` e `old-week-surge-6h` detectarem pumps usando os buckets internos de market cap em `token_market_buckets_1m`, priorizando `close_mcap` local em vez de depender primeiro de `token_catalog.last_price_change_1h` e `token_catalog.last_price_change_6h`.

O objetivo e corrigir casos em que o banco ja viu o movimento, por exemplo `800k -> 1.9M`, mas o matcher nao alertou porque o `priceChange1h` externo chegou atrasado, nulo, ou ja acima do threshold no primeiro ciclo avaliado.

## Contexto atual

Hoje o caminho principal de surge usa:

- `src/services/user-alert-matcher.js`
- `src/services/token-alert-signal-builder.js`
- `src/models/token-market-bucket-1m.js`
- `user_alert_rule_state`
- `user_alert_events`

O matcher monta os sinais assim:

- `currentPriceChange1h` vem de `tokenAfter.last_price_change_1h`.
- `prevPriceChange1h` vem de `tokenBefore.last_price_change_1h`.
- `currentPriceChange6h` vem de `tokenAfter.last_price_change_6h`.
- `prevPriceChange6h` vem de `tokenBefore.last_price_change_6h`.

Isso significa que o cruzamento do threshold depende do snapshot externo salvo no catalogo. Mesmo que `token_market_buckets_1m` mostre o pump, a regra `surge` atual nao usa essa serie para decidir o cruzamento 1h/6h.

## Problema observado

Token exemplo:

`5yC9BM8KUsJTPbWPLfA2N8qH1s9V8DQ3Vcw1G6Jdpump`

Sintoma:

- O chart/buckets indicavam movimento forte de market cap em poucos minutos.
- O token era `old-week`, nao `recent`, porque tinha mais de 7 dias.
- `old-week-surge-6h` alertou.
- `old-week-surge-1h` ficou em `primed-hot`.

Interpretacao:

- O matcher viu o 1h ja quente.
- Ele nao viu um `prevPriceChange1h < threshold` seguido de `currentPriceChange1h >= threshold`.
- A informacao local de buckets nao foi usada para formar esse cruzamento.

## Decisao proposta

Priorizar `close_mcap` dos buckets internos para calcular o surge:

```txt
internalChange1h = ((currentCloseMcap / baselineCloseMcap1h) - 1) * 100
internalChange6h = ((currentCloseMcap / baselineCloseMcap6h) - 1) * 100
```

Definicoes:

- `currentCloseMcap`: `close_mcap` do bucket 1m mais recente do token.
- `baselineCloseMcap1h`: `close_mcap` mais recente com `bucket_ts <= current_ts - interval '60 minutes'`.
- `baselineCloseMcap6h`: `close_mcap` mais recente com `bucket_ts <= current_ts - interval '360 minutes'`.
- Fallback: se a baseline interna nao existir, usar os campos atuais do catalogo (`last_price_change_1h/6h`) como fallback.

Nao usar `high_mcap` na primeira versao. `close_mcap` reduz sensibilidade a wick.

## Pontos importantes

- Isso muda comportamento real de alerta e deve aumentar a chance de alertas quando o banco viu o pump antes do agregador externo.
- Tambem pode aumentar falsos positivos se os buckets locais tiverem dados ruins, saltos espurios ou gaps.
- O `surge` continuara respeitando idade, threshold do usuario, mcap minimo, estado de rearm, dedupe e cross-block entre 1h/6h.
- Nao devemos remover o fallback externo imediatamente; ele ainda cobre tokens sem baseline interna suficiente.
- O payload do alerta deve deixar claro quando o valor veio de bucket interno, para auditoria posterior.

## Bloco 1 - Model de buckets

Arquivo principal:

- `src/models/token-market-bucket-1m.js`

Status: implementado.

Funcao adicionada:

```txt
listCurrentAndWindowBaselinesByAddresses(addresses, windowsMinutes)
```

Entrada:

- `addresses`: lista de token addresses.
- `windowsMinutes`: lista limitada, inicialmente `[60, 360]`.

Saida esperada por token:

```js
{
  token_address,
  current_ts,
  current_mcap,
  baseline_60m_ts,
  baseline_60m_mcap,
  baseline_360m_ts,
  baseline_360m_mcap
}
```

Regras:

- Usar o bucket mais recente com `close_mcap IS NOT NULL` como current.
- Para cada janela, buscar o bucket mais recente com `bucket_ts <= current_ts - window`.
- Nao usar fallback para o primeiro bucket antigo quando nao existe baseline real da janela; para surge, sem baseline real deve cair no fallback externo.
- Limitar janelas aceitas para evitar SQL dinamico amplo.

## Bloco 2 - Sinais internos de surge

Arquivos:

- `src/services/user-alert-matcher.js`
- `src/services/token-alert-signal-builder.js`

Status: implementado.

Carregamento de sinais:

- Buscar baselines internas apenas se algum perfil ativo tiver regra de surge ligada.
- Calcular `internalPriceChange1h` e `internalPriceChange6h` a partir de `current_mcap` e baseline interna.
- Passar tambem os baselines internos para o signal builder.

Prioridade proposta:

```txt
currentPriceChange1h = internalChange1h ?? catalogLastPriceChange1h
prevPriceChange1h = catalogPreviousPriceChange1h
```

O ponto mais importante e o primeiro alerta. Para nao depender de `previousInternalChange1h`, o matcher usa a baseline interna como prova temporal suficiente para evitar `primed-hot` no primeiro ciclo quando existe baseline valida:

```txt
internalChange1h >= threshold
internalSurge1hAvailable = true
```

Decisao aplicada:

- No signal builder, expor `internalSurge1hAvailable`, `internalSurge6hAvailable`, `internalPriceChange1h`, `internalPriceChange6h`.
- Evitar `primeOnFirstSeen` para candidato interno com baseline valida, porque o bucket ja prova a comparacao temporal.
- Nao marcar `crossedThreshold = true` apenas porque a fonte interna existe. Isso preserva a regra de repeticao/rearm, especialmente no surge 6h, que ainda exige evidencia de novo cruzamento quando ja existe estado anterior.

## Bloco 3 - Payload e auditoria

Arquivo:

- `src/services/user-alert-matcher.js`

Status: implementado junto do Bloco 2.

Campos adicionados ao payload de surge quando fonte interna for usada:

```js
{
  surgeMetricSource: 'market-buckets-1m',
  surgeBaselineMcap: baselineMcap,
  surgeBaselineTs: baselineTs,
  surgeCurrentMcap: currentMcap,
  surgeCurrentTs: currentTs
}
```

Quando cair no caminho antigo:

```js
{
  surgeMetricSource: 'catalog-price-change'
}
```

Manter `priceChange1h` e `priceChange6h` no payload como hoje, preenchidos com o valor efetivamente usado.

## Bloco 4 - Testes unitarios

Arquivo principal:

- `tests/user-alert-matcher.test.js`

Status: implementado.

Regressoes a proteger:

1. Token `old-week` com catalogo sem cruzamento util, mas bucket interno `1h` calculando `>= threshold`, deve emitir `old-week-surge-1h`.
2. Token com baseline interna ausente deve manter comportamento antigo e usar fallback externo.
3. Token com baseline interna abaixo do threshold nao deve emitir.
4. Token com `current_mcap < 45000` no 1h ou `< 40000` no 6h nao deve emitir mesmo com percentual interno alto.
5. Payload deve registrar `surgeMetricSource = 'market-buckets-1m'` quando a fonte interna foi usada.

Camada:

- Unitario, porque a regra de negocio pode ser protegida mockando o model de buckets.

Comando esperado:

```bash
node --test tests/user-alert-matcher.test.js
```

## Bloco 5 - Validacao manual no PSQL

Antes de ligar em producao, validar o token exemplo e mais alguns tokens conhecidos:

```sql
WITH current_row AS (
  SELECT bucket_ts, close_mcap
  FROM token_market_buckets_1m
  WHERE token_address = '<TOKEN>'
    AND close_mcap IS NOT NULL
  ORDER BY bucket_ts DESC
  LIMIT 1
),
baseline_1h AS (
  SELECT b.bucket_ts, b.close_mcap
  FROM token_market_buckets_1m b
  CROSS JOIN current_row c
  WHERE b.token_address = '<TOKEN>'
    AND b.close_mcap IS NOT NULL
    AND b.bucket_ts <= c.bucket_ts - interval '60 minutes'
  ORDER BY b.bucket_ts DESC
  LIMIT 1
)
SELECT
  c.bucket_ts AS current_ts,
  c.close_mcap AS current_mcap,
  b.bucket_ts AS baseline_1h_ts,
  b.close_mcap AS baseline_1h_mcap,
  ROUND(((c.close_mcap / NULLIF(b.close_mcap, 0)) - 1) * 100, 2) AS internal_change_1h_pct
FROM current_row c
LEFT JOIN baseline_1h b ON true;
```

O resultado esperado para um pump real deve mostrar `internal_change_1h_pct` acima do threshold configurado.

## Bloco 6 - Rollout

Recomendacao:

1. Implementar com payload de auditoria.
2. Rodar testes unitarios afetados.
3. Rodar lint.
4. Fazer dry-run local ou staging com logs de decisao por alguns tokens.
5. Deployar sem remover fallback externo.
6. Monitorar volume de alertas `old-week-surge-1h` e `recent-surge-1h` nas primeiras horas.

Comandos minimos depois de mudar codigo:

```bash
npm run lint
node --test tests/user-alert-matcher.test.js
```

Se houver alteracao de schema/init:

```bash
npm run db:schema-check
```

Nao ha necessidade prevista de schema novo para a primeira versao.

## Fora de escopo nesta primeira versao

- Usar `high_mcap` para detectar wick.
- Criar tabela nova para `internal_price_change`.
- Alterar thresholds de usuario.
- Alterar UI de configuracao.
- Remover `primed-hot` globalmente.
- Reescrever os alertas de `monitored-mcap`.

## Criterio de pronto

A mudanca esta pronta quando:

- O matcher consegue emitir surge 1h/6h com base em `token_market_buckets_1m`.
- O fallback externo continua funcionando sem baseline interna.
- O payload identifica a fonte do calculo.
- Os testes unitarios cobrem o caso de regressao do pump visto nos buckets.
- `npm run lint` e `node --test tests/user-alert-matcher.test.js` passam.

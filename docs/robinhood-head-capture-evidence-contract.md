# Contrato de evidência da captura de head Robinhood

Status: contrato implementado; payload atual v2
Origem: gate §14/§16.6 de `robinhood-live-head-isolation-urgent-plan.md`
Confiança: ancorado no código da branch `Robinhood-Implementation` (`0f089c78`)

## 0. Para que serve este documento

O plano de isolamento (`docs/robinhood-live-head-isolation-urgent-plan.md`) proíbe
iniciar o Corte 1 (schema da fila de captura) antes de existir um contrato
aprovado que descreva **exatamente qual evidência precisa ser persistida no head,
por protocolo, antes de o cursor de captura avançar**.

Este documento é esse contrato. Ele não altera código nem schema. Ele define o
payload de evidência versionado que o `robinhood-head` deverá gravar de forma
atômica com o avanço do `capture_cursor`, de modo que o `robinhood-processing`
consiga reconstruir observações e alertas **sem nenhum `eth_call` histórico**
depois que a janela de estado do node podado já tiver expirado. Liquidez V3 só é
reconstruída quando os saldos foram observados no range live; ranges de catch-up
preservam preço/FDV/volume e registram a liquidez como indisponível.

Regra de confiança: onde este documento divergir do código, o código vence e este
contrato deve ser corrigido antes do Corte 1.

## 1. O que morre e o que sobrevive no node podado

O plano (§4) distingue dois tipos de dado com retenções diferentes. O código
confirma a distinção nas chamadas feitas por observação em
`src/services/robinhood-onchain-pipeline.js:234` (`buildObservation`):

| Evidência | Como é obtida hoje | Sobrevive à poda? |
|---|---|---|
| Log bruto do swap/discovery | `eth_getLogs` (topics/data/blockHash/logIndex) | Sim — blocos/receipts/logs têm retenção longa |
| Reservas V2 | log `Sync` (`swap.quoteReserveRaw`) | Sim — está no próprio log |
| Preço/liquidez ativa V4 | evento de swap (`sqrtPriceX96`, `liquidityRaw`) | Sim — está no próprio log |
| Deltas de ticks V4 | log `ModifyLiquidity` (ledger idempotente stage 99) | Sim — está no próprio log, já persistido atômico |
| **Saldos V3 da pool** | `getBalanceOf(token, pool, {blockTag: swapBlock})` e `getBalanceOf(quote, pool, {blockTag: swapBlock})` — `robinhood-onchain-pipeline.js:261-270` | **NÃO** — `eth_call` ancorado no bloco do swap; some com a poda |
| Metadata ERC-20 (name/symbol/decimals) | `metadataReader.getMetadata(address)` em `latest` | Parcial — legível enquanto o contrato existir, mas o valor `latest` muda |
| `totalSupply` | idem, proveniência `token_supply_status='latest_call'` (`robinhood-onchain-pipeline.js:225-229`) | Parcial — `latest`, muda ao longo do tempo |
| Quote USD (WETH/USD) | `quoteReader.getCurrent()` → `{priceUsd, source}` em `latest` (`robinhood-weth-usd-quote.js`) | Parcial — `latest`, muda a cada bloco |

Consequência central: metadata, supply e quote precisam ser congelados como
evidência. No range live, os saldos V3 também são congelados. Durante catch-up,
o node podado não possui esses saldos históricos: a captura não repete uma
consulta impossível nem rejeita o swap; grava explicitamente
`balanceStatus='unavailable_backfill'`, e o processamento publica a observação
sem TVL.

## 2. Invariantes do contrato

1. **Idempotência de identidade**: `(chain, transaction_hash, log_index)`. Mesma
   identidade capturada duas vezes é a mesma captura, nunca duas.
2. **Reorg por bloco/hash**: invalidação usa `(block_number, block_hash)`, nunca
   apenas o número. Compatível com `robinhood_processed_logs`.
3. **Atomicidade captura↔cursor**: gravar evidência e avançar `capture_cursor`
   ocorrem na mesma transação curta. Nenhuma outra responsabilidade entra nessa
   transação (é exatamente o acoplamento que estourou em `commitMarketRange`,
   `src/models/robinhood-persistence.js:1652`).
4. **Sem `NOW()`/`latest` fingindo histórico**: todo valor `latest` capturado
   carrega proveniência explícita (source + block tag de ancoragem) para que o
   processamento saiba que aquilo foi observado no head, não recalculado depois.
5. **Erro nunca vira zero silencioso**: uma leitura state-dependent que falha é
   registrada como `retryable` ou `terminal`. A ausência esperada de saldo V3
   histórico no catch-up usa status explícito e `null`, que significa
   desconhecido — nunca saldo zero.
6. **Reprocessamento determinístico**: dada a mesma evidência, o processamento
   produz a mesma observação/liquidez, ou falha explicitamente. Nenhuma decisão
   depende do relógio ou do estado atual do node.
7. **Versão do payload**: todo payload carrega `evidence_version`; mudança de
   formato é aditiva e o processamento rejeita versão desconhecida em vez de
   adivinhar.

## 3. Estrutura da captura (nível de linha)

Campos de identidade/roteamento fora do JSONB (candidatos a coluna no Corte 1):

- `chain` (`'robinhood'`);
- `stream` (`'market'` | `'discovery'`);
- `block_number`, `block_hash`;
- `transaction_hash`, `log_index`, `transaction_index`;
- `address`, `topics` (JSONB array), `data`;
- `protocol` (`uniswap-v2|v3|v4` ou nulo em discovery);
- `market_key` / `pool_id` quando resolvidos;
- `evidence_version` (int);
- `evidence` (JSONB — seção 4);
- `capture_status` (`captured|superseded`);
- `processing_status` (`pending|leased|processed|rejected|blocked`);
- `attempt_count`, `next_attempt_at`, `last_error`;
- `created_at`, `claimed_at`, `finalized_at`.

Observação: este é o **contrato**, não o DDL. Nomes/tipos finais, índices de claim
e migração online (`NOT VALID` + `VALIDATE`) são decisão do Corte 1.

## 4. Payload de evidência (`evidence`, versionado)

### 4.1 Bloco comum a todo swap de mercado

```jsonc
{
  "evidenceVersion": 2,
  "timestampMs": 0,                 // timestamp do bloco (não NOW())
  "tokenAddress": "0x…",
  "quoteAddress": "0x…",
  "quoteIndex": 0,                  // swap.quoteIndex
  "eligibility": { "eligible": true, "reason": null },

  "tokenMetadata": {
    "name": "…", "symbol": "…", "decimals": 18,
    "totalSupplyRaw": "…",
    "tokenSupplyStatus": "latest_call",   // proveniência stage 96/79
    "tokenSupplyBlockTag": "0x…"          // bloco do swap usado como âncora
  },
  "quoteMetadata": { "decimals": 18 },

  "quoteUsd": {
    "priceUsd": "…",
    "source": "canonical-uniswap-v3-weth-usdg-<fee> | usdg-peg-assumption",
    "status": "observed | assumed",
    "blockTag": "latest | 0x…"     // como o preço foi lido no head
  }
}
```

Fonte no código: `buildObservation` monta `tokenMetadata`/`quoteMetadata` via
`resolveTokenMetadata`/`getMetadata`; `quoteUsd` via `getCurrent()` e
`buildMarketObservation` (`src/services/evm-market-metrics.js:75-92`), onde o
`source`/`status` do quote já existem (`observed`/`assumed`).

### 4.2 V2 (`protocol = uniswap-v2`)

Nenhuma leitura state-dependent adicional. Reservas vêm do log `Sync`.

```jsonc
{ "v2": { "quoteReserveRaw": "…" } }   // swap.quoteReserveRaw
```

### 4.3 V3 (`protocol = uniswap-v3`) — evidência crítica

No range live, os dois `getBalanceOf` ancorados no bloco do swap são congelados.
Em range de catch-up (`context.backfill=true`), essas chamadas históricas são
omitidas porque o node podado não pode respondê-las.

```jsonc
{
  "v3": {
    "poolAddress": "0x…",
    "blockTag": "0x…",              // bloco do swap
    "balanceStatus": "observed | unavailable_backfill",
    "tokenBalanceRaw": "…",        // getBalanceOf(token, pool, blockTag)
    "quoteBalanceRaw": "…",        // getBalanceOf(quote, pool, blockTag)
    "sqrtPriceX96": "…"            // se presente no evento
  }
}
```

Com `balanceStatus='observed'`, os dois saldos são obrigatórios. Com
`balanceStatus='unavailable_backfill'`, ambos são `null`; preço, FDV e volume
continuam determinísticos e `buildLiquidityAssessment` produz
`requires_tick_liquidity_distribution` com `liquidityUsd=null`. Falha transitória
no range live continua segurando o cursor para retry; retorno nulo no range live
continua sendo rejeição terminal, nunca zero.

### 4.4 V4 (`protocol = uniswap-v4`)

O preço e a liquidez ativa vêm do evento de swap; a distribuição por ticks vem do
log `ModifyLiquidity`, já persistido atomicamente no ledger idempotente (stage 99,
`insertV4LiquidityDeltas`, `robinhood-persistence.js:906`). A evidência a congelar
é o que veio do log:

```jsonc
{
  "v4": {
    "poolId": "0x…",
    "sqrtPriceX96": "…",           // swap.sqrtPriceX96
    "liquidityRaw": "…",           // swap.liquidityRaw
    "modifyLiquidity": [           // deltas do mesmo range de blocos
      { "tickLower": -887220, "tickUpper": 887220, "liquidityDelta": "-123" }
    ]
  }
}
```

Ponto de projeto a decidir no Corte 4, não aqui: a **materialização** das faixas
(`robinhood_v4_liquidity_ranges`) é derivada e foi exatamente o que estourou a
constraint no incidente. No head, capturamos apenas os deltas do log (evidência
durável). A materialização/TVL passa a ser responsabilidade do
`robinhood-processing`, e uma constraint negativa lá **não pode** reverter o
`capture_cursor`.

### 4.5 Discovery (`stream = discovery`)

Discovery não precisa de saldos. A evidência é o log decodificado + validação NOXA
quando aplicável (`validateOnchain` ainda faz `eth_call`/`eth_getCode` no bloco do
evento — `robinhood-onchain-pipeline.js:343`). Se mantida no head, essa validação
também precisa congelar seu resultado como evidência ou ser movida para
processamento. **Questão aberta Q4** (seção 7).

## 5. Classificação de erro (obrigatória)

Toda leitura state-dependent no head resolve para um de três estados, nunca para
um zero silencioso:

- `ok`: valor capturado com proveniência.
- `retryable`: falha transitória (timeout, 429, RPC indisponível, `error.retryable
  === true` como já tratado para o quote em `robinhood-onchain-pipeline.js:245`).
  A captura permanece `pending`/reenfileirada; o cursor **não avança sobre ela**.
- `terminal`: evidência comprovadamente impossível de obter naquele bloco (ex.:
  estado já podado antes de conseguir ler). Marca `blocked`/`rejected` auditável e
  dispara o alerta crítico de "estado podado" (§10 do plano). Nunca é mascarada.

Consequência: o `capture_cursor` só ultrapassa um bloco quando toda evidência
state-dependent elegível daquele bloco está `ok` e persistida, ou explicitamente
classificada como `terminal` com trilha de auditoria.

## 6. Fronteira: o que este contrato deliberadamente NÃO captura

Para não repetir o acoplamento do incidente, a captura de head **não** inclui:

- TVL/liquidez final materializada (V3 `spot_tvl`, V4 faixas) — derivado;
- buckets de 1m/1h/agg — derivado;
- projeção de catálogo, staging, agregados por token — derivado;
- metadata social/imagens (DexScreener/Blockscout/IPFS) — derivado;
- alerts e publicação Socket/relay — derivado.

Tudo isso é reconstruível a partir da evidência da seção 4 pelo
`robinhood-processing`/`robinhood-derived`, e sua falha não pode tocar o
`capture_cursor`.

## 7. Decisões do contrato

Decididas com o dono do produto em 2026-08-02:

- **Q1 — Tabela dedicada. DECIDIDO.** A fila live é uma **tabela nova dedicada**,
  não reuso de `robinhood_market_log_staging` (que tem `range_id NOT NULL` com FK a
  `robinhood_backfill_ranges` e nenhuma coluna de evidência JSONB). Alinha com o §6
  do plano.
- **Q4 — Validação NOXA no head, congelando o resultado. DECIDIDO.** As chamadas
  `eth_call getLaunchedToken`/`getPool` + `eth_getCode` de
  `noxa-launch-validator.js:29` são ancoradas no bloco do lançamento (mesma classe
  dos saldos V3) e morrem com a poda. Rodam no head e o resultado
  (`accepted/rejected` + `launchedToken`, `canonicalPoolAddress`, `tokenCodeBytes`,
  `poolCodeBytes`) é gravado no payload de evidência do discovery (§4.5).
- **Q5 — Aceitar quote `assumed`. DECIDIDO.** Quote WETH/USD com
  `status:'assumed'` (USDG peg) é evidência válida — é determinístico e a
  proveniência fica registrada. Mantém o comportamento de
  `buildMarketObservation`.

Pendente (não trava o desenho, trava só um valor do schema):

- **Q2 — `evidence_version` inicial = 1**, aditivo, processamento rejeita versão
  desconhecida. Recomendado e assumido como aceito salvo objeção.
- **Q3 — Retenção da fila live após `processed` = 1 dia. DECIDIDO.** A fila é
  corredor de passagem; observações/buckets permanentes vivem em outras tabelas.
  `retention_eligible_at = terminal_at + INTERVAL '1 day'`. A poda em si é
  responsabilidade de worker (Corte posterior); o schema do Corte 1 só cria a
  coluna e a constraint.

## 8. Critério de "contrato aprovado"

Estado: Q1, Q4, Q5 decididos; payload (§4) e classificação de erro (§5) aceitos;
nenhuma evidência "não sobrevive" da §1 ficou de fora. Falta apenas o valor de
retenção (Q3) para fechar o DDL.

O Corte 1 (schema aditivo da fila + cursor de captura + índices de claim/reorg +
runtime schema check + testes de idempotência + migração online) está autorizado a
começar assim que Q3 tiver um número e o corte receber autorização própria de
fatia, conforme o limite de 500 linhas do CLAUDE.md.

Enquanto isso, nenhuma migração é escrita e nenhuma tabela quente é tocada.

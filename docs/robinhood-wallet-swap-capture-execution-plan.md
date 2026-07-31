# Plano de execução — captura de swaps por carteira (Robinhood, estilo AXION)

Data: 2026-07-31.

Este documento é o **plano de execução no nível de código** para ativar o wallet
monitor da Robinhood Chain e o feed de swaps por carteira (estilo AXION: chart no
centro, lista de transações com valor, carteira e direção compra/venda).

Ele **não reabre** as decisões estratégicas já registradas em:

- `docs/hetzner-multichain-wallet-roadmap.md` — sequência e infraestrutura;
- `docs/normalized-swap-retention-capacity-plan.md` — store normalizado de 30
  dias, particionamento, índices e capacidade.

Este documento conecta essas decisões ao código atual e ao que a auditoria de
`2026-07-31` (branch `Robinhood-Implementation`) mediu no PostgreSQL de produção
(VPS2) e no node.

Ordem de confiança: código e schema da branch implantada acima deste documento.

## 1. Estado real do código (evidência auditada)

Ao contrário da premissa "só falta salvar e mostrar os swaps", o código atual
**não guarda identidade de carteira**. Evidências:

1. `robinhood_market_observations` (`src/utils/db-init-stage64.js`) guarda
   `transaction_hash`, `log_index`, `side`, amounts e preços, mas **nenhuma
   coluna de carteira** (`sender`, `recipient`, `trader`, `tx_from`).
2. O único `origin_address` fica em `robinhood_pool_registry`
   (`src/utils/db-init-stage63.js`) e é o **criador do pool**, não o swapper.
3. Os decoders extraem `sender`/`recipient`
   (`src/services/uniswap-v3-decoder.js:186-187`, topics[1]/[2]), mas o
   enrichment (`src/services/robinhood-backfill-enrichment-adapter.js`) e a
   persistência **descartam** esses campos antes de gravar.
4. `sender`/`recipient` do log **não são a carteira do trader**: em Uniswap
   V3/V4 são o router/aggregator ou o PoolManager. A EOA que assinou é
   `transaction.from`.
5. O backfill **nunca buscou transações**:
   `src/services/robinhood-backfill-market-scanner.js:251` usa `eth_getLogs`, e
   `eth_getBlockByNumber` (linha 280) é chamado com `false` (sem transações).
   Portanto `transaction.from` **nunca foi capturado**.
6. Não há superfície de produto de wallets: nenhuma seção em
   `frontend/src/ui/sections/`, nenhuma rota de produto além de
   `src/routes/wallet-auth.js` (login). O chart de candles já existe
   (`lightweight-charts` em `frontend/src/ui/sections/layout-sections.ts`) e o
   Robinhood já alimenta candles via buckets — o "chart no meio" se reaproveita;
   falta o **feed de swaps atribuídos**.

### Decisão de identidade (2026-07-31)

A carteira exibida no feed é **`transaction.from` (EOA que assinou)**. Isso
implica um caminho de **re-fetch de transações** — não é um `SELECT` sobre o que
já está salvo.

Correção importante sobre archive: obter `tx.from` **não exige archive node**. O
`from` vem da assinatura da transação, que está no **corpo do bloco**; um node
*pruned* mantém isso (pruning remove **estado**, não transações). Archive só
importa para consultas de estado (saldos, supply histórico), não para atribuir a
carteira.

## 2. Auditoria de cobertura — EXECUTADA (2026-07-31)

Resultados medidos na VPS2 (`robinhood_backfill_ranges` + amostragem leve):

### Cobertura

- `discovery` e `market`: **100% capturados, sem buracos** (0 ranges fora de
  `captured`).
- janela coberta: bloco **981.041 → 24.401.995** (~23,41M blocos).
- `market` rastreou **81.015.257 logs de swap** (raw 94,7M).

### Idade e ritmo da chain

Da `robinhood_backfill_ranges` (checkpoints):

- min: bloco 991.040 em 2026-07-02 03:33 (+02);
- max: bloco 24.401.995 em 2026-07-31 20:43 (+02);
- Δ = 23.410.955 blocos em ~2.567.402 s;
- **tempo de bloco ≈ 0,11 s (~9 blocos/s)**;
- gênesis estimado por volta de **1º de julho de 2026**.

**Consequência central:** a Robinhood Chain tem **~30 dias de vida**. Portanto
"janela de 30 dias" e "todo o histórico" são **a mesma coisa hoje**. A escolha de
produto (30 dias + live) captura 100% do que existe agora; a distinção só passa a
valer conforme os blocos mais velhos saem da janela.

### Dados ainda vivos (janela de tempo em aberto)

Contagens aproximadas (planner) e tamanhos:

| Tabela | Linhas aprox. | Tamanho |
|---|---:|---:|
| `robinhood_market_log_staging` | 80,5M | 91 GB |
| `robinhood_market_observations` | 71,2M | 77 GB |
| `robinhood_processed_logs` | — | 56 GB |
| `robinhood_backfill_aggregation_outbox` | — | 30 GB |

As 71M observações têm expiração de **3 dias** por design
(`OBSERVATION_RETENTION_DAYS`), mas continuam vivas — sinal de que a retenção
**está desligada ou atrasada**. Isso é uma oportunidade e um risco: os swaps já
decodificados (side, amounts, token, `transaction_hash`, `log_index`) estão
disponíveis agora, mas somem se a retenção voltar a rodar. **Confirmar e segurar
a retenção antes do seed é pré-requisito.**

### Amostra de densidade

`TABLESAMPLE SYSTEM (1)`: 739.401 swaps / 698.834 tx distintas →
**~1,06 swaps por transação**. Extrapolando: **~67,3M transações distintas** e
~3,5 swaps por bloco (quase todo bloco tem swap).

## 3. Reenquadramento do custo

Como a chain tem ~30 dias, o **seed de 30 dias ≈ re-fetch do range inteiro**:

- **~23,4M blocos** a buscar por `eth_getBlockByNumber(n, true)` (1 chamada
  devolve o `from` de todos os swaps do bloco);
- equivalente a **~67M transações distintas**;
- não é uma fatia pequena — é o histórico completo de hoje.

Não reduzimos muito buscando "só blocos com swap": com ~3,5 swaps/bloco, quase
todo bloco tem swap. O driver é o range completo.

### Topologia do worker de atribuição

O node está UP no **WSL do PC**; o túnel para a VPS2 pode estar down. Para ~23M
chamadas, o worker de atribuição deve rodar **no WSL contra `localhost:8547`**
(como o enrichment do backfill original, ref. `docs/bot-reference.md` §3.3),
escrevendo **em lote** no Postgres da VPS2 (só os writes atravessam o túnel).
Passar 23M chamadas RPC por túnel é frágil e lento.

Estimativa de tempo: ~200–1000 blocos/s em lote contra `localhost` →
**~6,5 h a ~32 h** para os 23,4M blocos. É um job de "deixar rodando".

### Correção de dimensionamento de disco

A taxa real de swaps é **~28–32/s** (81M logs / ~30 dias), não os 5–11/s que o
`normalized-swap-retention-capacity-plan.md` assumiu para Robinhood. O store
durável de 30 dias fica em **~71–81M linhas ≈ ~80–130 GB** (as observações já
ocupam 77 GB para volume parecido). Cabe nos 2 TB da VPS2 (footprint Robinhood
atual ~277 GB), mas o plano de retenção **subestima Robinhood em ~3–6x** e deve
ser revisado nesse ponto.

## 4. Modelo de dados alvo

Segue o schema conceitual já decidido em
`docs/normalized-swap-retention-capacity-plan.md` (particionado por dia, carteira
obrigatória, índices mínimos). Concretização para EVM/Robinhood:

Uma linha = uma ação econômica atribuída a uma carteira:

```text
chain            'robinhood'
wallet_address   tx.from normalizado (EOA) — NOT NULL
transaction_hash
action_index     (log_index do swap, para unicidade dentro da tx)
block_number
block_time       timestamp onchain (chave de particionamento diário)
token_address
quote_address
side             'buy' | 'sell'
token_amount_raw / quote_amount_raw + decimals
price_usd / volume_usd
protocol         'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4'
router_address   sender do log (opcional, contexto)
recipient_address recipient do log (opcional, contexto)
parser_version
```

Regras herdadas do plano de retenção (não redecidir aqui):

- particionamento diário por `block_time`; manter 30 dias + partição corrente;
- índice UNIQUE `(chain, wallet_address, transaction_hash, action_index)`;
- índices `(chain, wallet_address, block_time DESC)`,
  `(chain, token_address, block_time DESC)`, `(chain, block_time DESC)`;
- **não** persistir bloco completo, account list nem RPC bruto; payload bruto
  temporário (se preciso) fica em store separado com expiração de 24–72h;
- `DELETE` linha a linha proibido para expiração — usar drop de partição.

Numeração de stage: o próximo `db-init` livre é **stage 90** (o repositório vai
até `db-init-stage89.js`). Registrar o contrato em
`src/utils/runtime-schema.js` e validar com `npm run db:schema-check`.

## 5. Pipeline de captura de `tx.from`

`transaction.from` não está no log. O caminho reaproveita o que já existe:

1. ler as observações já decodificadas (71M; têm `transaction_hash`,
   `log_index`, side, amounts, token) — **não** é preciso redecodificar logs;
2. buscar os blocos do range por `eth_getBlockByNumber(n, true)` no node local
   e indexar `transaction.from` por `transaction_hash`;
3. juntar e gravar uma linha atribuída no store durável (seção 4).

Notas de risco:

- o `from` é a EOA que **assinou**, não necessariamente o beneficiário econômico
  (smart wallet, multisig, meta-tx). Para o MVP AXION, `tx.from` é aceitável e é
  o que a maioria dos exploradores mostra; router/recipient ficam persistidos
  como contexto.
- este re-fetch é um backfill isolado, com ranges/watermarks próprios; não
  misturar com o backfill de logs (concluído) nem reiniciar workers live por
  conveniência.
- depende do node vivo com os blocos do range; hoje isso existe no WSL.

## 6. Fatias (cada uma ≤500 linhas, aprovação individual)

Conforme CLAUDE.md, este é um **architecture checkpoint** (>12 arquivos de
produção, schema novo, subsistema novo). Nenhuma fatia começa sem aprovação
explícita. Ordem proposta:

1. **Auditoria de cobertura** — CONCLUÍDA (seção 2). Pendência operacional:
   confirmar/segurar a retenção das observações antes do seed.
2. **Schema durável** — CONCLUÍDA (2026-07-31). Entregue:
   - `src/utils/db-init-stage90.js`: tabela `robinhood_wallet_swaps` particionada
     por dia (`PARTITION BY RANGE (block_time)`), `wallet_address` NOT NULL com
     check de EOA normalizada (`^0x[0-9a-f]{40}$`), amounts/decimals/preços no
     mesmo rigor das observações, e os 3 índices mínimos do plano de retenção;
   - registro do grupo `stage90-robinhood-wallet-swaps` em
     `src/utils/runtime-schema.js` (profile `runtime`; deixado fora do profile
     `test` para não exigir a tabela no banco de teste);
   - teste unit em `tests/robinhood-chain-schema.test.js` (SQL + registro).
   - **Decisão de PK**: o Postgres exige a chave de partição dentro de qualquer
     PK/UNIQUE, então a identidade é `(chain, transaction_hash, action_index,
     block_time)` — dedup natural do swap; `wallet_address` é coluna NOT NULL
     (funcionalmente determinada), não entra na chave. Isso substitui o UNIQUE
     conceitual `(chain, wallet, tx, action_index)` do plano de retenção sem
     perder o contrato de dedup.
   - **Escopo**: só o parent. Não cria partições, não habilita writer — isso é
     das fatias de worker (4) e retenção (7). Uma tabela particionada sem
     partições é inerte e só aceita inserts quando as partições diárias forem
     criadas.
   - **Validação**: lint limpo; teste unit passa (31/31); a DDL foi aplicada num
     banco local de restore e `npm run db:schema-check` (profile runtime) passa,
     provando que o particionamento/checks/índices são válidos e que a
     introspecção casa com o contrato.
3. **Adapter de captura de `tx.from`** — CONCLUÍDA (2026-07-31). Entregue:
   - `src/services/robinhood-transaction-sender-adapter.js`: adapter **puro**
     (sem rede) que transforma um bloco completo (`eth_getBlockByNumber(n,
     true)`) em `{ blockNumber, blockTime, senders }`, indexando o signer
     (`transaction.from`) normalizado por `transaction_hash`, e deriva o
     `block_time` onchain (chave de partição da fatia 2). Expõe `resolveSenders`
     para o worker resolver os hashes de swap e receber os `missing`.
   - Guards testados: rejeita bloco buscado sem `true` (array de hashes),
     transação malformada, mismatch de bloco (`expectedBlockNumber`, guarda de
     reorg) e signer conflitante; normaliza hash/endereço para lowercase
     (alinha com o check `^0x[0-9a-f]{40}$` da tabela).
   - Teste unit `tests/robinhood-transaction-sender-adapter.test.js` (7 casos).
   - **Escopo**: só a extração pura. O RPC (buscar o bloco no node local) e a
     montagem da linha durável ficam na fatia 4 (worker).
   - **Validação**: lint limpo; unit 7/7. Sem schema, sem hub.
4. **Worker de seed + live** — dividida em sub-blocos:
   - **4a — Persistência + partições** — CONCLUÍDA (2026-07-31). Entregue:
     - `src/models/robinhood-wallet-swap-persistence.js`: factory
       `createRobinhoodWalletSwapRepository` com `ensurePartitionForDay` /
       `ensurePartitionsForDays` (CREATE TABLE IF NOT EXISTS ... PARTITION OF,
       idempotente) e `insertWalletSwaps` (bulk upsert via
       `jsonb_to_recordset`, `ON CONFLICT (chain, transaction_hash,
       action_index, block_time) DO NOTHING`). O insert garante as partições
       dos dias do batch antes de escrever (a tabela não tem default partition).
       `normalizeSwapRow` valida endereços/hashes/amounts/enum e deriva o dia
       de partição.
     - Teste unit `tests/robinhood-wallet-swap-persistence.test.js` (5 casos,
       com `database` fake verificando ordem partição→insert e o `ON CONFLICT`).
     - **Validação**: lint limpo; unit 5/5; e um smoke real contra o banco
       local de restore provou partição-diária + insert + dedup idempotente
       (insert#1=2, insert#2=0), com cleanup da partição de teste.
   - **4b-i — Motor de atribuição** — CONCLUÍDA (2026-07-31). Entregue:
     - `src/services/robinhood-wallet-swap-attributor.js`:
       `createRobinhoodWalletSwapAttributor({ repository, fetchBlock })` com
       `attributeBlock(blockNumber, observations)` e `attributeGroups(groups)`.
       Resolve `tx.from` via adapter (fatia 3), mapeia observação → linha e
       grava via 4a. Observação cuja tx não está no bloco fica **unresolved**
       (nunca gravada com wallet nula); propaga o guard de reorg
       (`expectedBlockNumber`). Todo I/O é injetado (puro/testável).
     - Teste unit `tests/robinhood-wallet-swap-attributor.test.js` (5 casos,
       com repositório fake, `fetchBlock` fake e o adapter real).
     - **Validação**: lint limpo; unit 5/5. Sem schema, sem hub.
   - **4b-ii — Runner + reader + watermark + wiring** — subdividida:
     - **4b-ii-a — Schema do cursor (stage 91)** — CONCLUÍDA (2026-07-31).
       Decisão: tabela dedicada (Opção A), espelhando `robinhood_ingestion_cursors`.
       Entregue: `src/utils/db-init-stage91.js` (`robinhood_wallet_swap_cursors`
       com PK `(chain, stream)`, `stream IN ('seed','live')`, checkpoint pair
       check), registro do grupo `stage91-robinhood-wallet-swap-cursors` em
       `runtime-schema.js` (profile runtime, fora do test), e teste unit no
       `tests/robinhood-chain-schema.test.js`. Validação: lint limpo; unit 32/32;
       stage aplicada no banco local de restore + `db:schema-check` (runtime)
       passa.
     - **4b-ii-b — Repositório do cursor** — CONCLUÍDA (2026-07-31). Entregue:
       - `src/models/robinhood-wallet-swap-cursor.js`:
         `createRobinhoodWalletSwapCursorRepository` com `loadCursor`,
         `initCursor` (idempotente, `ON CONFLICT DO NOTHING`, nunca reseta) e
         `advanceCursor` (update otimista com guard de `version`, retorna null em
         conflito).
       - Teste unit `tests/robinhood-wallet-swap-cursor.test.js` (6 casos).
       - **Validação**: lint limpo; unit 6/6; smoke real no banco local provou
         init idempotente, advance v0→1 com checkpoint e rejeição de versão
         velha (null), com cleanup.
     - **4b-ii-b2a — Índice de atribuição (stage 92)** — CONCLUÍDA (2026-07-31).
       Auditoria mostrou que `robinhood_market_observations` (71M/77GB em prod)
       **não tinha índice por `block_number`** (só `market_time`, `token_time` e
       a PK), então um reader por bloco varreria a tabela inteira. Entregue:
       `src/utils/db-init-stage92.js` com
       `CREATE INDEX CONCURRENTLY IF NOT EXISTS
       idx_robinhood_market_observations_attribution (chain, status,
       block_number, log_index)` + `removeInvalidIndex` (recupera build
       interrompido), registro em `runtime-schema.js`, e testes no
       `robinhood-chain-schema.test.js`. Validação: lint limpo; unit 34/34;
       aplicado no local (tabela vazia, instantâneo) + `db:schema-check` passa.
       **Produção**: na VPS2 esse build leva minutos e consome ~GBs — rodar
       `node src/utils/db-init-stage92.js` com o node/postgres saudáveis e
       monitorar (é `CONCURRENTLY`, sem lock de escrita).
     - **4b-ii-b2b — Reader das observações-fonte** — CONCLUÍDA (2026-07-31).
       Entregue: `src/models/robinhood-wallet-swap-source-reader.js` com
       `readAcceptedBlockGroups({ fromBlock, toBlock, maxBlocks })` — seleciona
       os próximos blocos distintos com observações `accepted` no range
       (usando o índice da stage 92) e devolve as observações agrupadas por
       bloco em ordem ascendente (`{ groups: [[blockNumber, obs[]]], blockNumbers }`),
       prontas para o `attributeGroups` da 4b-i. `maxBlocks` com default 200 e
       cap 2000. Teste unit `tests/robinhood-wallet-swap-source-reader.test.js`
       (5 casos). Validação: lint limpo; unit 5/5; smoke real confirmou que a
       SQL executa (0 grupos na tabela local vazia).
     - **4b-ii-c — Runner (seed standalone)** — CONCLUÍDA (2026-07-31).
       Decisão: rodar o seed como **script standalone no WSL**, não registrado no
       grupo de workers, para minimizar acoplamento ao fork divergente do node
       host. Entregue:
       - inline do `parseQuantity` em
         `src/services/robinhood-transaction-sender-adapter.js` — o adapter
         deixou de depender de `evm-log-poller`, então toda a cadeia de
         atribuição depende só dos arquivos novos.
       - `src/services/robinhood-wallet-swap-seed-runner.js`: orquestração pura
         `runSeedBatch`/`runSeed` (load cursor → read → attribute → advance),
         deps injetadas; erro deixa o cursor intacto (retomável); para em
         conflito de versão. Teste unit
         `tests/robinhood-wallet-swap-seed-runner.test.js` (7 casos).
       - `src/utils/robinhood-wallet-swap-seed.js`: entrypoint standalone que
         cria o **próprio pool `pg`** (via `DATABASE_URL`) e faz **JSON-RPC cru**
         (`http`/`https` nativo), sem usar `db.js` nem o RPC client do host.
         Preflight: valida node (`eth_getBlockByNumber(head, true)` com
         `transactions[].from`), valida schema (stages 90/91/92) e inicializa o
         cursor com MIN/MAX de blocos `accepted` (rápido pelo índice da 92). Env:
         `RH_NODE_RPC_URL`, `DATABASE_URL`, `RH_SEED_FROM_BLOCK/TO_BLOCK/
         MAX_BLOCKS/BATCH_LIMIT`.
       - **Validação**: lint limpo; unit 14/14 (adapter pós-inline + runner);
         smoke local dos helpers (`toHex`, `assertSchema` contra o banco com as
         stages aplicadas).
       - **Pendente (fora desta fatia)**: o caminho **live** registrado no grupo
         de workers Robinhood fica para depois de reconciliar o fork do host.
5. **Read model + rota**: leitura paginada de swaps por token e por carteira,
   usando os índices definidos.
6. **UI AXION**: seção nova reaproveitando `lightweight-charts`; feed de
   transações com carteira, valor e direção; markers de swap no chart apontando
   para eventos persistidos.
7. **Retenção**: job de drop de partição (30 dias) e métricas de tamanho
   (`pg_total_relation_size`), conforme plano de retenção — só depois do seed.

Testes por fatia seguem a disciplina da CLAUDE.md: a camada mais barata que
detecta a regressão (unit para atribuição/dedupe; integração para
schema/persistência/rota; smoke só para o fluxo visível final).

## 7. Riscos e premissas

- **Node**: sem node vivo com os blocos do range, nenhum re-fetch é possível.
  Hoje o node está no WSL; o worker de seed deve rodar lá.
- **Retenção viva**: as 71M observações expiram em 3 dias por design e hoje
  parecem não ser purgadas; se a retenção voltar antes do seed, perde-se a fonte
  barata dos swaps recentes. Segurar a retenção é pré-requisito do seed.
- **Custo do seed**: ~23,4M blocos (~67M tx) = job de horas; medir throughput
  real do node antes de comprometer prazo.
- **Identidade**: `tx.from` ≠ beneficiário em alguns casos; aceito no MVP.
- **Disco**: ~80–130 GB para o store de 30 dias; o plano de retenção subestima
  Robinhood em ~3–6x e deve ser corrigido.
- **Isolamento**: seed é backfill isolado; não reiniciar ingestão live nem o
  backfill de logs por conveniência.

## Pontos importantes

- Para esta chain, **"30 dias" = "histórico completo" hoje**: ela tem ~30 dias
  de vida (~0,11s/bloco). O seed de 30 dias é, na prática, o range inteiro
  (~23,4M blocos / ~67M tx).
- O pedido "salvar os swaps das wallets do histórico" **não é salvar — é
  capturar de novo**: `tx.from` nunca foi coletado (só logs). Mas os swaps já
  decodificados estão vivos (71M observações), então o re-fetch só precisa
  anexar o `from`, sem redecodificar.
- `tx.from` **não depende de archive**; um node pruned com os blocos basta.
- Há **janela de tempo**: a retenção de 3 dias pode apagar as observações;
  segurar a retenção antes do seed é obrigatório.
- Este plano é execução; respeita o limite de 500 linhas por fatia com aprovação
  individual, e não substitui os docs de roadmap e retenção.

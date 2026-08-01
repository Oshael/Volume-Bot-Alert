# Plano — Enrichment live event-driven (estilo terminal) para remover dependência de archive

> Documento operacional/planejamento. A **implementação** é fatiada e cada fatia
> (≤500 linhas) exige aprovação explícita antes de editar, conforme CLAUDE.md.
> Este arquivo só descreve o alvo, o fan-out, as fatias, os testes e os riscos.

## 1. Motivação / problema

Objetivo final: **desligar o node do PC** e rodar a ingestão/enrichment da Robinhood
Chain na VPS2 contra um node **podado/full** (economia de espaço), sem archive.

Bloqueio atual: o enrichment reconstrói métricas lendo **estado histórico no bloco
do swap** (`eth_call` com `blockTag = bloco do swap`), o que **exige node archive**.
Num node podado, o estado histórico só existe por ~128 blocos (`pathdb-max-diff-layers`,
~13 s a 10 blk/s). Fora dessa janela → `historical state ... is not available`, e a
perda é **silenciosa e permanente** (estado podado não se recomputa).

Situação de fato (2026-08-01):
- **Backfill histórico: 100% concluído.** Não há mais trabalho que precise de archive
  para blocos antigos.
- O **backfill roda no PC** (perto do node archive do PC) e atualiza os buckets. A VPS2
  roda só as 2 partes DB-side + PSQL. O worker **live (`@robinhood`) está desligado.**
- O node da VPS2 está **podado/full**, no head, ocioso (sem consumidor), com
  `--execution.caching.state-scheme=path` e `--execution.caching.state-history=1000000`
  (obs.: `state-history` **não** faz o node servir leitura histórica — só guarda diffs
  para sync/rollback; comprovado empiricamente que head-5000 não é servido).
- **RPC público está inutilizável** (não aguenta) → não serve como fallback archive.
- A chave dRPC que temos é **L1 (ethereum+beacon)**, não da Robinhood Chain → rejeitada
  na validação de chainId (4663). Não serve como provider de enrichment.

Conclusão: enquanto o enrichment depender de estado histórico, o PC (archive) é
insubstituível. **A saída correta não é archive na VPS2, é tornar o enrichment live
event-driven — como os terminais (DexScreener/GMGN) fazem — e aí o node podado basta.**

## 2. Como os terminais evitam archive (o alvo)

- Preço/volume do swap: **direto do payload do evento** (amounts na pool).
- Conversão para USD: mantêm o **preço das pools de referência vivo em memória**,
  atualizado a cada evento; no bloco N já sabem a cotação, sem consultar estado.
- Metadata (decimals/symbol): buscam **uma vez** e cacheiam (imutável).
- `totalSupply`: leem em `latest` (a visão de mercado usa supply atual).

Resultado: **zero query de estado histórico** → node podado serve, latência de ms.

## 3. Arquitetura atual (evidência no código)

- **Hub live:** `src/services/robinhood-onchain-pipeline.js`
  - `getWethQuote(swap.blockNumber)` → `quoteReader.getSnapshot({ blockTag })` lê
    WETH/USD **no bloco do swap** (linhas ~221-231, 349-351). ← leitura histórica
  - `metadataReader.getTotalSupply(addr, { blockTag })` (linhas ~265, 286). ← histórica
  - `metadataReader.getMetadata(addr, { blockTag })` (linha ~298). ← histórica
  - Já tem cache de WETH quote por blockTag (`wethQuoteCache`, linhas ~167-232).
- **Reader WETH/USD:** `src/services/robinhood-weth-usd-quote.js`
  - Lê `slot0`/`liquidity` da pool canônica WETH/USDG via `eth_call` no `resolvedBlockTag`
    (`readPoolStateSnapshot`, ~linha 190-206).
  - Já suporta `'latest'` (linha ~171) e um **scan de Swap logs** para derivar preço
    (linhas ~240-264). `sqrtPriceX96` está no snapshot e **vem no Swap event V3**.
- **Métricas:** `src/services/evm-market-metrics.js` — `buildMarketObservation`
  - `priceQuote` (do swap) × `quoteUsd.price` (=WETH/USD) → `priceUsd`, `volumeUsd`.
  - `supply` (=`totalSupplyRaw`) → `fdvUsd`.
  - **Só WETH/USD e totalSupply são os inputs históricos.** Decimals são imutáveis.
  - Atenção: a conversão USD via `wethUsdPrice` só se aplica quando
    `quoteAddress === ROBINHOOD_WETH` (linha ~90). **Verificar** como quotes não-WETH
    são precificadas no caminho live (ver Riscos / Perguntas abertas).
- **Backfill (não muda):** `src/services/robinhood-backfill-enrichment-adapter.js`
  faz a reconstrução histórica (correta para reprocessar passado). **Fica como está.**

## 4. Alvo do redesenho (somente caminho LIVE)

1. **WETH/USD vivo:** manter em memória o `sqrtPriceX96`/preço corrente da pool canônica
   WETH/USDG, atualizado pelo **stream de Swap** dessa pool (sqrtPriceX96 vem no evento).
   No enrichment, usar o preço **corrente/near-head**, não o preço no bloco exato do swap.
   - Cold start / staleness: se ainda não houver evento observado (boot) ou o preço estiver
     velho além de um limite, **fallback para `eth_call ... 'latest'`** (o node podado serve
     `latest` sem problema). Nunca ler `blockTag` histórico.
2. **totalSupply em `latest` + cache** por token, com refresh periódico (TTL) e/ou
   invalidação. FDV/mcap passam a refletir supply atual (comportamento de terminal).
3. **decimals/metadata em `latest` + cache** (imutável; buscar uma vez).
4. **Preço/volume do swap:** já vêm do evento — sem mudança.

Efeito: o caminho live deixa de emitir qualquer `eth_call` com `blockTag` histórico →
**node podado basta** → PC (archive) pode ser desligado.

### Mudança semântica (precisa de OK do produto)
O valor live passa a usar **WETH/USD near-head**, não o do bloco exato do swap. A
diferença é ínfima (poucos blocos, ~sub-segundo de deriva) e é **exatamente o que os
terminais fazem**. Os testes de paridade devem assertar dentro de uma tolerância, não
igualdade exata. Documentar como comportamento aceito.

## 5. Fan-out (arquitetura checkpoint)

Produção (3 arquivos + possivelmente 1 do reader de metadata):
- `src/services/robinhood-weth-usd-quote.js` — adicionar modo "preço vivo" (mantido pelo
  stream de Swap da pool WETH/USDG) + `getCurrent()`; manter `'latest'` como fallback.
- `src/services/<metadata-reader>.js` — caminho `latest`+cache+TTL para `getTotalSupply`
  e `getMetadata` (localizar o módulo exato; o glob `onchain-metadata*` não achou —
  confirmar o nome na fatia 1).
- `src/services/robinhood-onchain-pipeline.js` (**hub**) — trocar as 3 leituras
  históricas pelas fontes vivas/latest; manter só wiring/composição, sem inchar o hub.
- **Não tocar** `robinhood-backfill-enrichment-adapter.js` (backfill continua archive).

Testes:
- `tests/` unit: manutenção do preço WETH vivo a partir de Swap events; supply cache+TTL;
  paridade de `buildMarketObservation` (live vs histórico) dentro de tolerância; cold-start
  fallback para `latest`.

## 6. Fatias (cada uma ≤500 linhas, aprovação por fatia)

- **Fatia 1 — WETH/USD vivo** em `robinhood-weth-usd-quote.js`: `getCurrent()`. **✔ FEITA
  (2026-08-01).** Decisão de design (validada contra o código, com o usuário): **não** manter
  preço em memória por stream de Swap; `getCurrent()` = `getSnapshot({blockTag:'latest'})` com
  **cache TTL curto** (`currentTtlMs`, default 1000ms) + dedupe de concorrentes. Motivo: os
  readers já cacheiam por `blockTag` e já servem `'latest'`; o bloqueio era só o hub passar
  `blockTag` histórico. O stream-em-memória seria over-engineering contra um node **local**
  (fiação no hub + rewind de reorg do preço) para poupar ~1 RPC/bloco. `latest`+TTL remove 100%
  a dependência de archive, é reorg-agnóstico (sempre lê head), latência de ms no node local.
  Testes: lê só `latest`, serve do TTL, refetch pós-expiração, colapsa concorrentes (14/14 pass,
  lint clean). **Metadata reader confirmado:** `src/services/evm-erc20-metadata.js`
  (`createErc20MetadataReader`) — já com TTL por `address:blockTag` e suporte a `'latest'`.
- **Fatia 2 — metadata `latest`+cache**: `getTotalSupply`/`getMetadata` em `latest` com
  TTL/invalideção. + unit tests.
- **Fatia 3 — wiring no hub**: `onchain-pipeline` passa a usar preço vivo + supply latest;
  remover as leituras `blockTag` do caminho live. + testes de paridade.
- **Fatia 4 — cutover/ops** (fora do código-fonte, majoritariamente): apontar
  `ROBINHOOD_RPC_URL` da VPS2 para `http://127.0.0.1:8547`; ligar o worker live/backfill na
  VPS2; validar buckets/cursor avançando; desligar os componentes do PC; desligar o node
  do PC **após** o seed de wallet-swaps terminar.

## 7. Riscos / casos de borda

- **Quotes não-WETH:** confirmar todos os tipos de quote no caminho live. Se for stable,
  `quoteUsd = 1` (sem histórico). Se for outro token, precisa de referência própria (mesmo
  padrão vivo). **Bloqueante para a fatia 3** se existir.
- **Staleness do preço vivo:** pool WETH sem swaps recentes → preço velho. Política de TTL +
  fallback `latest`.
- **Reorg:** o preço vivo mantido por eventos precisa acompanhar o rewind do pipeline
  (o pipeline já tem lógica de reorg; no mínimo re-semear via `latest` após rewind).
- **Cold start:** primeiro boot sem evento observado → semear com um `eth_call latest`.
- **Paridade:** valores live podem diferir infinitesimalmente do recompute exato-no-bloco;
  testes com tolerância + decisão de produto registrada (§4).
- **Não regredir o backfill:** o adapter histórico não muda; garantir que a refatoração do
  reader/metadata não quebre o caminho archive do backfill (interfaces compartilhadas).

## 8. Sequenciamento com a migração

1. Enquanto a opção 2 não fica pronta: **PC segue rodando o backfill (archive)**; não subir
   archive na VPS2; node da VPS2 fica ocioso/podado no head. Sem perda (PC cobre).
2. Fatias 1-3 implementadas e validadas (paridade).
3. Fatia 4: cutover para a VPS2 podada; desligar componentes do PC; desligar node do PC
   **após** o seed de wallet-swaps terminar.

## 9. Perguntas abertas (responder antes da fatia 3)

- OK do produto para preço/mcap live usarem **WETH/USD near-head** em vez do bloco exato?
- Existem **quotes não-WETH** no caminho live? Como são precificadas hoje?
- Confirmar o **módulo exato do metadata reader** (nome do arquivo) na fatia 1.
- **Wallet tracking:** ✔ RESOLVIDO (fatia 1). Seed lê só `eth_getBlockByNumber(n,true)`
  (chain data); `robinhood-wallet-swap-attributor.js` só decodifica o bloco já buscado (0 RPC de
  estado); `user-alert-matcher` lê preço do catálogo no DB (0 RPC). **Nenhum `eth_call` de estado
  histórico escondido** → núcleo do wallet tracking fora da opção 2, como a §11 previa.

## 11. Wallet tracking — escopo (não deve precisar mudar)

Separar persistência de enrichment (§ persistência ≠ pricing):

- **Núcleo do wallet tracking** — atribuição por `tx.from`, token/quantidade, matching com
  as wallets acompanhadas pelos usuários (`user-alert-matcher`) e disparo de alerta — vem de
  **dado de transação/evento**. `tx.from` e os txs do bloco são **chain data**, servidos pelo
  node **full/podado para toda a história** (o seed lê `eth_getBlockByNumber(n, true)`). **Não
  precisa de archive e não é tocado pela opção 2.**
- **Cruzamento (só se exibir USD):** valor em USD do swap da wallet ("comprou $X") sai da
  **mesma camada de pricing** que a opção 2 reescreve → **se beneficia**, sem mudança própria.
- **A verificar na Fatia 1:** garantir que o caminho de captura do wallet-swap não faz nenhum
  `eth_call` de **estado** histórico escondido. Pela arquitetura não deve (é tx/chain data),
  mas confirmar antes de cravar. Se aparecer estado, entra no escopo da opção 2.

Referência de código do wallet-swap: `docs/robinhood-wallet-swap-capture-execution-plan.md`
(slices 1-4 done: stage 90 `robinhood_wallet_swaps`, cursors, atribuição, seed em
`src/utils/robinhood-wallet-swap-seed.js`; "bloco 5" = read model + rota, pendente).

## 10. Estado deixado (para retomar após compactação)

- Node VPS2: podado/full, path scheme, `state-history=1000000`, no head, RPC em
  `127.0.0.1:8547`, **ocioso** (sem consumidor). Não mexer.
- PC: node archive + 3 componentes RPC-heavy do backfill + seed de wallet-swaps. Segue ligado.
- VPS2 já roda 2 componentes DB-side do backfill + PSQL. Worker `@robinhood` (live) desligado.
Execução real (renumerada ao descobrir o conflito de schema — ver abaixo):

- **Fatia "getCurrent" FEITA (2026-08-01):** `getCurrent()` (latest+TTL) em
  `robinhood-weth-usd-quote.js` + 3 unit tests. §9 (wallet tracking) e metadata reader resolvidos.
- **Fatia 1 — schema + persistência FEITA (2026-08-01):** descoberto que supply em `latest`
  **quebrava o contrato** `tokenSupplyStatus`/`token_supply_anchor_block_number` (persistência +
  DB CHECK da stage 79: status fechado + âncora `<= block_number`). Decisão **B** (migração de 1
  status), não tabela nova. Entregue: `db-init-stage96.js` (novo status **`latest_call`** no
  CHECK, âncora presa ao bloco do swap), registro em `runtime-schema.js`, `latest_call` no
  `SUPPLY_STATUSES` da persistência, 3 unit tests (30/30 pass, lint). **Migração ainda não
  aplicada no banco** — `db:schema-check` acusa pendência; rodar `node src/utils/db-init-stage96.js`
  no banco do worker live antes do cutover.
- **Fatia 2 — hub FEITA (2026-08-01):** `robinhood-onchain-pipeline.js`: WETH → `getCurrent()`;
  supply/metadata via `getMetadata` em `latest` (uma chamada — o reader já traz `totalSupplyRaw`),
  status `latest_call`, âncora = bloco do swap; **removida** a máquina de reconstrução histórica
  (delta reader, checkpoints, `reconstructSupplyBetweenAnchors`, ordenação por-endereço) — no novo
  modelo o live nunca lê estado histórico, então o fallback deixa de ter função. −222 linhas.
  Testes do hub reescritos p/ o contrato `latest_call` (21/21; suites relacionados 65/65, lint).
  Backfill inalterado. **Nada em produção muda até ligar o worker live (hoje desligado).**
- Módulo `evm-erc20-supply-delta.js` ficou órfão em produção (só o hub usava) — utilitário testado,
  mantido; limpeza opcional futura.
- Próximo passo: **cutover (ops)** — aplicar a migração stage96, apontar `ROBINHOOD_RPC_URL` da
  VPS2 p/ `127.0.0.1:8547`, ligar o worker live, conferir cursor/buckets, desligar componentes do
  PC e o node do PC **após** o seed de wallet-swaps.

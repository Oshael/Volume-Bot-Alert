# Solana Yellowstone gRPC firehose plan

Documento de decisao e execucao para migrar a ingestao onchain Solana de
WebSocket JSON (QuickNode, descartado) para Yellowstone gRPC (Geyser) em plano
flat/unmetered, cobrindo PumpSwap, Raydium e Meteora com descoberta e
atualizacao de catalogo no mesmo stream.

Este documento e a fonte de verdade para continuar o trabalho sem depender do
contexto da conversa.

Data inicial: 2026-07-23.

## Status

- Nenhum bloco iniciado. Decisao de arquitetura e provedor registrada em
  2026-07-23.
- Nenhuma conta de provedor gRPC contratada ainda.
- Nenhum codigo gRPC existe no repositorio.

## Contexto e decisao

Os dry-runs de `docs/quicknode-onchain-alert-plan.md` (2026-07-04) provaram que
WebSocket JSON cobrado por credito nao sustenta firehose de DEX:

- `transactionSubscribe` full: ~47 MB e ~7k creditos em 5 segundos;
  extrapolacao de ~42,5 GB / 6,38M creditos em 75 minutos.
- `logsSubscribe + getTransaction`: 429 no WS, reconnect sem recuperacao,
  milhares de fetches dropados; PumpSwap sozinho gera ~1,5 MB/s de logs.

Conclusao: o problema e o transporte, nao o provedor. A pipeline de decodificacao
(delta de balances -> volume -> gates -> janelas -> preco executado) permanece
valida e e agnostica de transporte.

Decisao de provedor (2026-07-23):

- Producao alvo: **Shyft Build, $199/mes**, gRPC unmetered + RPC HTTP staked
  (100 req/s) + gPA acelerado + slot replay. Regioes NY/Ashburn/Miami/Londres/
  Amsterdam/Frankfurt/Singapura.
- Piloto opcional mais barato: **Chainstack Geyser add-on (~$49-100/mes)** para
  validar a integracao antes de assinar Shyft. O codigo cliente e identico
  (Yellowstone e protocolo aberto; trocar provedor = trocar URL/token no env).
- Descartados: QuickNode gRPC (so no Scale $499), Helius LaserStream ($499+,
  protocolo proprietario, lock-in), Triton dedicado ($2.900+), Solana Tracker
  (€200, Shredstream e 25 conexoes nao agregam para janelas de 1m; sem slot
  replay anunciado e sem RPC HTTP incluido).

Arquitetura alvo completa (inclui o lado Robinhood, ja implementado):

- VPS de ingestao dedicada (~$20-40/mes, 4 vCPU / 8 GB) rodando dois workers:
  - Solana: firehose gRPC deste plano (sub-segundo, stream).
  - Robinhood: polling HTTP com cursor via dRPC (~$80-100/mes), ja existente em
    `src/services/robinhood-ingestion-worker.js` (fallback `drpc,alchemy`),
    delay 1-2s, lossless. Nada muda nesse lado.
- Total estimado: ~$300-340/mes. Usuario ciente de que passa do teto inicial
  de ~$200.

## Objetivo

Substituir o laboratorio QuickNode por um consumer Yellowstone gRPC que:

```text
Yellowstone subscribe (transactions, account_include = program IDs)
  -> converter protobuf para o shape ja consumido pela pipeline
  -> filtrar mention-only (hasProgramInvoke)
  -> aplicar admin_blocked_tokens e gates de volume
  -> agregar janelas 1m/5m em memoria
  -> persistir buckets consolidados (nunca swap a swap)
  -> descoberta: token desconhecido que passa gates entra no catalogo
  -> atualizar charts/alerta pela infra realtime existente
```

## Decisoes confirmadas

- Modo firehose, nao catalogo: filtro por program IDs, todos os tokens. O
  catalogo e decisao de roteamento no backend (superset), nao um filtro no
  provedor.
- Programas: reutilizar o registry de `src/utils/quicknode-transaction-probe.js`
  (pumpswap, meteora-dlmm, raydium-amm-v4, raydium-clmm, raydium-cpmm).
  jupiter-v6 fica fora do filtro: rotas Jupiter executam nos AMMs monitorados.
- Filtros server-side: `vote: false`, `failed: false`.
- Commitment: `confirmed` como default (chart nao pode regredir por rollback de
  `processed`). Reavaliar `processed` apenas se latencia virar requisito.
- Lib cliente: `@triton-one/yellowstone-grpc` (oficial do protocolo, funciona em
  qualquer provedor Yellowstone).
- O transporte novo e um servico irmao de
  `src/services/quicknode-onchain-transaction-stream.js`, produzindo o mesmo
  shape de `buildFetchedValue` (`signature`, `slot`, `blockTime`, `error`,
  `transaction.meta`, `transaction.transaction`) para reutilizar a pipeline de
  dry-run existente sem mudanca.
- Nenhum alerta real e publicado antes de soak aprovado.
- Nenhum worker permanente e ligado por default; ativacao via env explicito.

## Fora de escopo (decisao registrada, nao esquecimento)

- Orca (mesma decisao do plano QuickNode).
- Pump.fun bonding curve: hoje coberto por `pumpfun-ws.js`. Candidato natural a
  entrar no filtro gRPC depois, como bloco proprio.
- Eventos de LP add/remove (rug detection): chegam no stream mas exigem decoder
  proprio; bloco futuro.
- Holders: snapshot sob demanda via gPA acelerado do Shyft + sinais
  incrementais do stream de swaps; nunca firehose do token program. Bloco
  futuro.
- Desligamento das fontes de polling atuais (DexScreener/GMGN/Jupiter): so
  depois de soak longo com cobertura comprovada; conviver em paralelo ate la.

## Blocos de execucao

Cada bloco respeita o limite de 500 linhas alteradas e exige aprovacao
individual antes de comecar.

### Bloco 0 - Conta, env e probe de conexao

- Contratar o provedor do piloto (Chainstack ou direto Shyft; decisao do
  usuario no momento da compra).
- Adicionar dependencia `@triton-one/yellowstone-grpc` (e `bs58` se ainda nao
  houver) ao `package.json`.
- Criar `src/utils/solana-grpc-probe.js` (read-only, irmao de
  `robinhood-rpc-probe.js`): conecta, faz subscribe de 1 programa por N
  segundos, imprime slots/assinaturas/contagem e encerra limpo. Nunca escreve
  em banco.
- Env vars:

```text
SOLANA_GRPC_ENDPOINT
SOLANA_GRPC_X_TOKEN
SOLANA_GRPC_COMMITMENT (default confirmed)
SOLANA_GRPC_PROGRAMS (default pumpswap,meteora-dlmm,raydium-amm-v4,raydium-clmm,raydium-cpmm)
```

- Validacao: rodar o probe 30-60s; criterio de saida e receber transacoes dos
  programas com assinatura base58 valida e exit code 0.
- Estimativa: ~150-250 linhas (probe + package.json + doc).

### Bloco 1 - Servico de transporte gRPC

- Criar `src/services/solana-grpc-transaction-stream.js`:
  - subscribe unico com `transactions` filter (accountInclude = programas,
    vote/failed false), commitment configuravel;
  - keepalive ping (Yellowstone exige ping periodico para manter o stream);
  - reconnect com backoff exponencial e retomada via `fromSlot` (slot replay)
    quando o provedor suportar; registrar ultimo slot processado em memoria;
  - conversao protobuf -> shape `buildFetchedValue`: assinaturas e pubkeys
    chegam como bytes e precisam de base58; `meta.preTokenBalances`/
    `postTokenBalances` chegam prontos;
  - dedup de assinaturas com TTL (mesma estrategia do stream QuickNode);
  - callbacks `onSummary`/`onStatus`/`onError` com a mesma interface do stream
    QuickNode para plugar na pipeline existente.
- Teste unitario com cliente fake: conversao de shape, dedup, reconnect com
  fromSlot, mention-only continua sendo responsabilidade do consumidor.
- Camada de teste: unitario (regra de conversao e maquina de estado de
  reconnect; sem rede).
- Estimativa: ~400-500 linhas (servico + teste). Se estourar, cortar teste de
  reconnect para bloco seguinte.

### Bloco 2 - Dry-run continuo pela pipeline existente

- Criar `src/utils/solana-grpc-dry-run.js` reutilizando a pipeline do dry-run
  QuickNode (blocklist, gates de $1.5, janelas 1m/5m, preco executado):
  troca-se apenas o transporte.
- Script npm `grpc:dry-run` com duracao configuravel; nunca publica alertas.
- Metricas por minuto: eventos/s, matches vs mention-only, CPU (user/system),
  bytes estimados, swaps aceitos, tokens distintos, drops.
- Validacao: rodada de 60s local; criterio de saida e paridade de aceitos com
  a pipeline QuickNode em amostra equivalente.
- Estimativa: ~250-400 linhas.

### Bloco 3 - Soak e medicao

- Rodadas de 10-15 min e depois 1h fora de pico, os 5 programas ativos.
- Medir: taxa de mention-only, CPU sustentada, memoria, buracos de slot em
  reconnect forcado, comportamento do slot replay real do provedor.
- Sem codigo novo relevante; ajustes finos e registro de resultados neste doc.
- Criterio para sair do dry-run (herdado do plano QuickNode, adaptado):
  - rodadas estaveis com os 5 programas sem perda nao explicada;
  - CPU compativel com a VPS alvo (4 vCPU);
  - estrategia definida para mention-only;
  - blocklist aplicada antes de qualquer swap aceito;
  - decisao Chainstack -> Shyft tomada com numero real de eventos/s.

### Bloco 4 - Worker permanente (desligado por default)

- Runner persistente irmao de `robinhood-continuous-runner.js`, ativado por
  `SOLANA_GRPC_WORKER_ENABLED` (default false).
- Persistencia: agregar em memoria e escrever apenas buckets 1m consolidados
  nas tabelas chain-aware existentes (`token_market_bucket_1m` e volume),
  reutilizando `market-bucket-realtime` para o push aos charts.
- Descoberta: token desconhecido que passa gates entra pelo fluxo de admissao
  ao catalogo com gate de volume minimo (politica anti-lixo antes de criar
  registro).
- Este bloco exige plano proprio de persistencia/admissao antes de comecar;
  provavelmente se subdivide.

### Blocos futuros (sem ordem definida)

- Deploy na VPS de ingestao dedicada (ver
  `docs/robinhood-vps-history-rollout-plan.md` para o padrao).
- Pump.fun bonding curve no filtro (substituir/absorver `pumpfun-ws.js`).
- Decoder de LP add/remove.
- Holders via gPA acelerado sob demanda.
- Aposentadoria gradual das fontes de polling redundantes.

## Pontos importantes

- Unmetered nao significa custo zero: o gargalo migra para CPU/banda da nossa
  infra. Firehose dos 5 programas e da ordem de centenas de eventos/s em pico.
- `accountInclude` tambem entrega mention-only; o filtro `hasProgramInvoke`
  continua obrigatorio no consumidor — agora sem custo de creditos.
- Protobuf usa bytes crus para pubkeys/assinaturas; toda comparacao com o
  pipeline existente exige conversao base58 consistente (fonte classica de bug
  silencioso de dedup/blocklist).
- Reconnect sem `fromSlot` = buraco no candle. Validar o slot replay real do
  provedor no Bloco 3 antes de confiar nele para producao.
- Nunca persistir swap a swap; apenas buckets consolidados. Writes remotos por
  evento afogam o Postgres.
- O RPC nao conhece nossos banidos; blocklist e responsabilidade do backend,
  aplicada antes de qualquer aceitacao.
- Charts chain-driven precisam de SOL/USD (`sol-price.js`) para rotas WSOL e de
  backfill historico (infra CoinGecko) — o stream so cobre "daqui pra frente".
- Nao ligar alerta real antes de agregacao por janela validada em soak.

# Robinhood Chain onchain monitoring plan

Documento de decisao e execucao para adicionar Robinhood Chain como a primeira
chain adicional do TrendScope sem depender do contexto da conversa.

Data inicial: 2026-07-11.

## Status

- Bloco 0 concluido em 2026-07-11.
- Bloco 1 concluido em 2026-07-11.
- Bloco 2 concluido em 2026-07-12.
- Bloco 3 concluido em 2026-07-12.
- Bloco 4 concluido em 2026-07-12.
- Bloco 4A concluido em 2026-07-12.
- Bloco 5 concluido em 2026-07-12.
- Bloco 6 concluido em 2026-07-12.
- Bloco 7 concluido em 2026-07-12 apos soak final de 30 minutos com cursores
  alinhados, zero erros e Alchemy desligada.
- Bloco 8 concluido em 2026-07-12 com fila social DexScreener opt-in; a entrega
  de persistencia do cache foi movida para os Blocos 9-10 por depender de
  identidade chain-aware.
- Bloco 9A concluido em 2026-07-12 com inventario address-only e primitives
  estritas de identidade; nenhum schema foi alterado.
- Bloco 9B concluido em 2026-07-12; stages 51/52 aplicados no banco local e
  runtime schema check aprovado.
- Bloco 9C concluido estruturalmente em 2026-07-12, sem ativar regras ou entrega
  Robinhood.
- Bloco 9D em andamento; o sub-bloco 9D.1 promoveu os buckets de volume de um
  minuto para a identidade fisica `(chain, token_address, bucket_ts)`.
- O sub-bloco 9D.2a promoveu a identidade fisica dos buckets OHLC de um minuto;
  seus readers e rotinas administrativas continuam explicitamente Solana-only.
- O sub-bloco 9D.2b substituiu o indice de cobertura OHLC address-only e tornou
  explicito o contrato Solana-only nos readers, cleanups e caches legados.
- O sub-bloco 9D.3 foi concluido: a Stage 62 promoveu os buckets agregados para
  identidade e indices chain-aware; aplicacao local e runtime schema check
  passaram em 2026-07-13.
- O sub-bloco 9D.4 conteve `token_market_snapshots` como legado Solana-only sem
  migration ou drop; o Bloco 9 esta estruturalmente concluido.
- O Bloco 10 esta em andamento: 10A-10F.3 criaram registry, cursores, ledger,
  observacoes exatas, candles, cleanup e o contrato de processo Robinhood
  isolado nas Stages 63-66.
- Probe read-only criado em `src/utils/robinhood-rpc-probe.js`.
- Cliente HTTP provider-agnostic criado em
  `src/services/evm-json-rpc-client.js`.
- Poller HTTP com cursor em memoria criado em `src/services/evm-log-poller.js`.
- Decoder/registry Uniswap v2 criado em
  `src/services/uniswap-v2-decoder.js`.
- Decoder/registry Uniswap v3 criado em
  `src/services/uniswap-v3-decoder.js`.
- Decoder/validador NOXA Fun criado em
  `src/services/noxa-launch-decoder.js`.
- Decoder/registry Uniswap v4 criado em
  `src/services/uniswap-v4-decoder.js`.
- Metadata ERC-20, metricas exatas, quote WETH/USD e politica de elegibilidade
  criados em servicos EVM/Robinhood isolados.
- Agregador de janelas, pipeline unificado e runner persistente criados, com o
  worker ainda desabilitado por default.
- RPC publico Robinhood validado na chain ID 4663.
- Alchemy validada na chain ID 4663; range de 10 blocos funciona e range de
  250 blocos retornou HTTP 400.
- O Bloco 10F.3 foi concluido estruturalmente; a ativacao e o soak controlado
  continuam pendentes de decisao operacional.
- O worker Robinhood permanece desabilitado por default, mas foi ativado
  explicitamente no processo isolado para o rollout V2; discovery e market
  estao persistindo dados live sob lease propria.
- O schema Robinhood das Stages 63-68 existe no banco local; registry e cursor
  discovery/market, observacoes e buckets possuem dados reais do rollout V2.
- O Bloco 11 foi concluido em 2026-07-14 com gates calibrados em amostra live,
  rollout explicitamente V2-only e publicacao invariavelmente desligada.
- O Bloco 12 foi concluido em 2026-07-14 com aceite visual confirmado e smoke
  Chromium isolado para o seletor SOL-only em desktop e abaixo de 980 px.
- O Bloco 13 esta em andamento; os sub-blocos 13A/13B concluiram o control
  plane fail-closed, o runbook de desligamento e a telemetria bounded da lease;
  o 13C concluiu o dry-run operacional V2-only apos o market atingir lag zero,
  o 13D adicionou kill switches de transporte/persistencia, o 13E validou o
  restart/recovery e o 13F fechou o caminho V2 de staging, matcher, persistencia
  idempotente, feed chain-aware e seletor condicionado ao kill switch. A
  ativacao live continua pendente e fail-closed.
- Nenhum alerta Robinhood e publicado.

## Objetivo

Monitorar memes negociados na Robinhood Chain usando dados brutos da propria
blockchain para:

- descobrir pools novos;
- identificar os tokens negociados;
- calcular preco, volume, liquidez, compras, vendas e quantidade de swaps;
- manter janelas proprias de mercado;
- calcular FDV quando houver supply confiavel;
- futuramente alimentar catalogo, radar e alertas do bot.

DexScreener fica restrito a metadata que nao existe onchain:

- imagem;
- site;
- Twitter/X;
- Telegram.

DexScreener nao sera fonte de descoberta, preco, volume, liquidez, market cap,
idade, transacoes ou alertas Robinhood.

## Decisoes confirmadas

### Fontes e prioridade

1. O RPC publico oficial da Robinhood e a fonte HTTP primaria.
2. O plano aceita que o RPC publico tem rate limit desconhecido e sem SLA.
3. Alchemy Free sera suporte opcional:
   - WebSocket para baixa latencia, quando habilitado;
   - fallback HTTP quando o RPC publico falhar;
   - nunca sera uma dependencia de API proprietaria.
4. Todo acesso deve usar JSON-RPC EVM padrao.
5. O coletor precisa continuar funcionando por polling do RPC publico quando a
   Alchemy estiver ausente, indisponivel ou desabilitada.
6. WebSocket e apenas transporte de baixa latencia; cursor e backfill HTTP sao
   a garantia de completude.
7. NOXA Fun sera uma fonte complementar onchain para descobrir launches do
   launchpad antes, mas nunca substitui a descoberta geral da Uniswap.
8. O indexador da NOXA nao sera fonte de verdade para preco, volume, cursor ou
   alertas. Pode ser usado apenas em comparacao de dry-run e metadata opcional.

### Protocolo monitorado

- Uniswap v2, v3 e v4 entram no escopo obrigatorio.
- v2 e v3 serao implementadas antes da v4 porque o modelo de pool e diferente.
- Nenhuma integracao real com catalogo/alertas sera liberada antes de v2, v3 e
  v4 passarem pelo dry-run.
- A primeira fase aceita apenas pools com quote canonico WETH ou USDG.
- Pares com outro meme como quote ficam fora ate existir grafo de precificacao.
- Tokens NOXA na Robinhood usam pools Uniswap v3 oficiais; nao exigem parser de
  bonding curve nem parser de uma DEX adicional.

### Hard coded permitido

Hard coded significa somente constantes estaveis e verificadas:

- chain ID;
- contratos oficiais da rede e da Uniswap;
- event topics/ABIs;
- WETH e USDG canonicos;
- denylist de Stock Tokens oficiais;
- limites e gates iniciais configuraveis.

Nunca hard code:

- token descoberto;
- endereco de pool criado dinamicamente;
- preco;
- volume;
- liquidez;
- supply observado;
- bloco/cursor atual.

## Fatos da rede

```text
Network: Robinhood Chain
Chain ID: 4663
Gas token: ETH
Public RPC: https://rpc.mainnet.chain.robinhood.com
Public sequencer feed: wss://feed.mainnet.chain.robinhood.com
Explorer: https://robinhoodchain.blockscout.com
```

O sequencer feed nao substitui o RPC. Ele pode ser avaliado futuramente para
latencia, mas estado, receipts, `eth_call` e recuperacao historica continuam
dependendo de um no/RPC.

## Contratos canonicos iniciais

### Quote assets

```text
WETH  0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG  0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
```

Normalizar todos os enderecos EVM para lowercase antes de comparar, cachear,
deduplicar ou persistir.

### Uniswap v2

```text
Factory   0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f
Router02  0x89e5db8b5aa49aa85ac63f691524311aeb649eba
```

Eventos principais:

- `PairCreated(token0, token1, pair, ...)` na Factory;
- `Swap(...)` em cada contrato de pair;
- `Sync(reserve0, reserve1)` para reservas confirmadas.

### Uniswap v3

```text
Factory       0x1f7d7550b1b028f7571e69a784071f0205fd2efa
SwapRouter02  0xcaf681a66d020601342297493863e78c959e5cb2
```

Eventos principais:

- `PoolCreated(token0, token1, fee, tickSpacing, pool)` na Factory;
- `Initialize(...)` no pool;
- `Swap(...)` em cada contrato de pool.

### Uniswap v4

```text
PoolManager       0x8366a39cc670b4001a1121b8f6a443a643e40951
StateView         0xf3334192d15450cdd385c8b70e03f9a6bd9e673b
Universal Router  0x8876789976decbfcbbbe364623c63652db8c0904
```

Eventos principais:

- `Initialize(...)` no PoolManager;
- `Swap(...)` no PoolManager.

Na v4, `poolId` e a identidade do mercado. Nao modelar v4 como se cada pool
fosse um contrato independente.

### NOXA Fun Robinhood

Contratos publicados pela NOXA e observados em 2026-07-11:

```text
Launch Factory  0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB
Launch Locker   0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85
Multicall3      0xcA11bde05977b3631167028862bE2a173976CA11
WETH            0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
```

O Blockscout confirma que a Launch Factory contem bytecode e logs, mas o
codigo-fonte nao esta verificado. Logo, `TokenLaunched` e um hint de descoberta
que precisa ser confrontado com a Uniswap oficial, nao uma garantia de
autenticidade ou seguranca.

Evento documentado:

```solidity
event TokenLaunched(
  address indexed token,
  address indexed deployer,
  address indexed dexFactory,
  address pairToken,
  address pool,
  uint256 dexId,
  uint256 launchConfigId,
  uint256 positionId,
  uint256 restrictionsEndBlock,
  uint256 initialBuyAmount
);
```

Validacao obrigatoria antes de aceitar um launch NOXA:

1. emissor do log e a Launch Factory configurada;
2. `dexFactory` e a Uniswap v3 Factory oficial;
3. `pairToken` e o WETH canonico;
4. `pool` coincide com `getPool(token, WETH, poolFee)` na Factory oficial;
5. token e pool contem bytecode;
6. quando disponivel, `getLaunchedToken(token).exists == true`;
7. o mesmo pool descoberto por `PoolCreated` e deduplicado, nao contado de novo.

Configuracao observada no indexador da NOXA em 2026-07-11:

```text
dex: Uniswap v3 oficial
pool fee: 10000 (1%)
tick spacing: 200
pair token: WETH canonico
restriction blocks: 366
max wallet: 200 bps
```

Esses valores sao observacoes atuais, nao constantes eternas. O contrato e a
configuracao onchain devem ser consultados para cada launch/config ID.

## Fontes primarias para rever antes de codificar

- Robinhood connect/RPC: https://docs.robinhood.com/chain/connecting/
- Robinhood token contracts: https://docs.robinhood.com/chain/contracts/
- Robinhood full node: https://docs.robinhood.com/chain/run-a-full-node/
- Uniswap v2 deployments: https://developers.uniswap.org/docs/protocols/v2/deployments
- Uniswap v2 Factory Robinhood logs: https://robinhoodchain.blockscout.com/api/v2/addresses/0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f/logs
- Uniswap v3 Robinhood: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
- Pool v3 da fixture no Blockscout: https://robinhoodchain.blockscout.com/api/v2/addresses/0xefd703d89b7febc0ae43fdd72edd257819366272/logs
- Uniswap v4 deployments: https://developers.uniswap.org/docs/protocols/v4/deployments
- NOXA Fun contracts: https://docs.noxa.fi/contracts/noxa-fun/
- NOXA integration for bots: https://docs.noxa.fi/integrations/launchpad/

Antes de cada implementacao, reconfirmar enderecos nas fontes oficiais e no
Blockscout. Nao copiar endereco de blog, rede social ou agregador.

## Arquitetura alvo

```text
RPC publico Robinhood (HTTP, primario)
  -> eth_blockNumber / eth_getLogs / eth_call
  -> polling adaptativo por blocos

Alchemy Free (opcional)
  -> newHeads/logs por WebSocket para baixa latencia
  -> HTTP fallback sob falha do RPC publico

NOXA LauncherFactory (onchain, complementar)
  -> TokenLaunched antecipa token/pool/config/restricoes
  -> validacao obrigatoria contra Uniswap v3 oficial
  -> mesmo pool segue pelo parser Uniswap v3 comum

Ambos
  -> cursor canonico por bloco
  -> deduplicacao por chain + blockHash + transactionHash + logIndex
  -> backfill de qualquer lacuna
  -> decoders v2/v3/v4
  -> pool registry em memoria/dry-run
  -> quote resolver WETH/USDG
  -> evento de swap normalizado
  -> janelas e gates
  -> persistencia somente depois da validacao
  -> sinais/alertas somente depois da persistencia validada

DexScreener metadata queue (baixa prioridade)
  -> uma busca por token novo
  -> cache persistente
  -> nunca bloqueia ingestao onchain

NOXA indexer (experimental e dispensavel)
  -> comparar descoberta/preco/volume no dry-run
  -> metadata opcional apenas para token NOXA
  -> nunca controlar cursor, calculo ou alerta
```

## Contrato interno do evento normalizado

Formato alvo conceitual, ainda nao definitivo:

```js
{
  chain: 'robinhood',
  protocol: 'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4',
  blockNumber,
  blockHash,
  transactionHash,
  logIndex,
  timestampMs,
  poolAddress: null | '0x...',
  poolId: null | '0x...',
  tokenAddress: '0x...',
  quoteAddress: '0x...',
  side: 'buy' | 'sell',
  tokenAmountRaw,
  tokenAmount,
  quoteAmountRaw,
  quoteAmount,
  priceQuote,
  priceUsd,
  volumeUsd,
  liquidityUsd,
  source: 'robinhood-onchain'
}
```

Regras:

- valores raw permanecem `bigint` ou string decimal; nunca `Number`;
- converter para `Number` apenas na borda de metricas quando o intervalo for
  comprovadamente seguro;
- `side` e sempre da perspectiva do meme/token candidato;
- um swap sem quote USD confiavel pode ser observado, mas nao entra em alerta;
- idempotencia nao depende de timestamp.

## Dados calculaveis e limites

### Calculaveis onchain

- descoberta de pool;
- token0/token1 e quote;
- nome, simbolo, decimals e total supply via `eth_call`;
- idade pelo bloco/timestamp de criacao;
- swaps, buys, sells e volume em quote;
- preco executado e preco atual do pool;
- liquidez/reservas, respeitando a versao do AMM;
- FDV aproximado: `precoUsd * totalSupply`;
- variacoes rolling produzidas por nossas janelas.
- origem NOXA, launch config e janela de restricoes quando comprovadas onchain.

### Nao assumir

- `totalSupply` nao e circulating supply;
- FDV nao e market cap circulante;
- liquidez v3/v4 nao pode ser calculada como reserva v2;
- todo ERC-20 responde corretamente a `name/symbol/decimals/totalSupply`;
- todo pool com WETH/USDG e meme;
- evento recebido por WebSocket esta finalizado para sempre;
- ausencia de 429 significa RPC sem limite.
- `restrictionsEndBlock` NOXA nao pode ser comparado diretamente ao numero de
  bloco L2. Em Robinhood/Arbitrum Orbit, o `block.number` usado pelo contrato
  segue a altura L1; a verificacao deve ser feita por leitura do
  contrato/contexto L1.

## Estrategia de provedores

### RPC publico Robinhood

Uso primario:

- polling de head;
- `eth_getLogs` em ranges pequenos/adaptativos;
- `eth_call` para metadata e estado;
- backfill quando responder de forma saudavel.

Protecoes:

- timeout;
- retry com jitter;
- backoff em 429/5xx;
- range adaptativo de blocos;
- concorrencia baixa;
- circuit breaker;
- metricas por metodo, status, latencia e bytes.

### Alchemy Free

Uso complementar:

- WebSocket opcional para reduzir atraso;
- fallback HTTP quando o publico estiver indisponivel;
- comparacao amostral para detectar divergencia/atraso do RPC publico.

Regras de custo:

- nenhum endpoint proprietario necessario;
- usar apenas JSON-RPC EVM padrao;
- filtros de logs estreitos;
- medir bytes e consumo reportado;
- permitir desligar Alchemy sem interromper o polling publico;
- nao habilitar fallback ilimitado que consuma franquia silenciosamente.

### Completude

O cursor HTTP e a fonte de completude. WebSocket apenas antecipa eventos.

Ao reconectar:

1. ler ultimo bloco processado confirmado;
2. consultar head atual;
3. executar `eth_getLogs` do cursor+1 ate o head seguro;
4. deduplicar logs ja vistos por WebSocket;
5. atualizar cursor somente depois de processar o bloco inteiro;
6. retomar fluxo normal.

## Plano por blocos

Cada bloco de implementacao deve manter aproximadamente ate 300 linhas de
codigo de producao alterado/adicionado. Testes e fixtures podem ficar em commit
separado quando isso deixar o escopo mais claro. Nunca juntar blocos apenas para
ganhar velocidade.

Estimativa inicial do trabalho completo: 1.900 a 3.000 linhas entre codigo,
schema, testes e frontend. A maior incerteza e migrar a identidade atual de
token, hoje centrada apenas em `address`, para `(chain, address)`.

### Bloco 0 - Probe dos endpoints e custo operacional

Status: concluido em 2026-07-11.

Objetivo:

- provar o RPC publico com chamadas reais;
- provar Alchemy somente se as URLs forem fornecidas;
- medir latencia, erros, 429, range aceito e bytes;
- confirmar logs reais dos contratos oficiais;
- confirmar bytecode e amostras de `TokenLaunched` da NOXA Factory.

Entregas:

- script standalone de probe;
- `eth_chainId` deve retornar `4663`;
- `eth_blockNumber` e `eth_getBlockByNumber`;
- pequenos ranges de `eth_getLogs` para v2/v3/v4;
- pequeno range de `eth_getLogs` para NOXA `TokenLaunched`;
- relatorio comparativo publico vs Alchemy;
- nenhuma escrita no banco.

Saida obrigatoria:

- pelo menos um endpoint funcional;
- chain ID correto;
- limites observados documentados;
- nenhum segredo impresso em log.

Resultados observados:

```text
RPC publico:
  chainId=4663
  requests=14
  errors=0
  429=0

Bytecode observado:
  WETH=2202 bytes
  USDG=170 bytes
  Uniswap v2 Factory=13859 bytes
  Uniswap v3 Factory=24535 bytes
  Uniswap v4 PoolManager=24009 bytes
  NOXA Launch Factory=22811 bytes
  NOXA Multicall3=3808 bytes
```

Probe recente de 250 blocos:

```text
Uniswap v2 Factory: 0 logs
Uniswap v3 Factory: 0 logs
Uniswap v4 PoolManager: 204 logs
NOXA Launch Factory: 0 logs
responseBytes total=376975
elapsedMs somado=11294
```

Leitura:

- RPC publico respondeu todas as chamadas sem 429;
- range de 250 blocos e aceito;
- v4 gera volume alto mesmo em range curto, logo os blocos seguintes devem
  usar topics estreitos e medir bytes;
- ausencia de criacao v2/v3/NOXA no range recente nao e falha.

Probe historico no bloco L2 `6880646` (`0x68fd86`):

```text
Uniswap v3 Factory:
  logs=1
  PoolCreated topic0=0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118

NOXA Launch Factory:
  logs=2
  topic0=0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a
  TokenLaunched topic0=0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a

traffic:
  requests=14
  errors=0
  responseBytes=188337
  elapsedMs somado=5442
```

Conclusao do bloco:

- endpoint publico funcional e chain correta;
- todos os contratos configurados possuem bytecode;
- logs reais v3, v4 e NOXA foram observados;
- v2 ficou validada por bytecode, mas ainda sem fixture de evento real;
- nenhuma chave apareceu no output; redaction e protegida por teste;
- limite real do RPC continua desconhecido; uma execucao sem 429 nao prova uso
  ilimitado;
- Alchemy permanece opcional e pendente de medicao.

### Bloco 1 - Cliente EVM HTTP provider-agnostic

Status: concluido em 2026-07-11.

Objetivo:

- criar a fundacao RPC sem SDK proprietario.

Entregas:

- JSON-RPC request IDs;
- timeout/abort;
- retry e backoff classificados;
- provider primario/fallback;
- metricas por provider/metodo;
- normalizacao de erros;
- testes unitarios de retry, timeout, 429 e fallback.

Fora:

- parsers Uniswap;
- WebSocket;
- banco.

Implementado:

- cliente sem SDK proprietario e sem acoplamento a Robinhood ou Alchemy;
- IDs JSON-RPC monotonicos por instancia;
- timeout por tentativa e cancelamento por `AbortSignal` do chamador;
- retry limitado para timeout, transporte, HTTP 408/429/5xx e erros RPC
  transientes conhecidos (`-32005` e `-32603`);
- `Retry-After`, backoff exponencial e jitter;
- fallback somente depois de esgotar retries do provider anterior;
- erros normalizados sem URL, chave, corpo HTTP ou mensagem RPC externa;
- metricas por provider/metodo para requests, sucesso, erro, retry, fallback,
  status HTTP, codigo de erro, bytes e latencia p50/p95/p99;
- amostras de latencia limitadas a 256 por provider/metodo para impedir
  crescimento continuo de memoria;
- oito testes unitarios cobrindo IDs, 429, retry, fallback, timeout, abort,
  erro nao repetivel, envelope invalido, percentis e `Retry-After`.

Validacao real do cliente contra o RPC publico:

```text
method=eth_chainId
result=0x1237 (4663)
requests=1
successes=1
retries=0
fallbacks=0
http2xx=1
requestBytes=59
responseBytes=43
latencyMs=2005
```

Limites desta conclusao:

- Alchemy foi exercitada posteriormente e funciona como provider JSON-RPC;
  ranges grandes de `eth_getLogs` exigem adaptacao;
- uma chamada real confirma compatibilidade, nao capacidade ou ausencia de
  rate limit;
- ao fim do Bloco 1 o cliente ainda nao estava ligado a cursor/polling; o
  Bloco 2 fez essa ligacao, mas continua fora do servidor e de workers reais;
- parsers, WebSocket e persistencia permanecem fora deste bloco.

### Bloco 2 - Cursor, polling e recuperacao de lacunas

Status: concluido em 2026-07-12.

Objetivo:

- processar blocos uma unica vez e recuperar interrupcoes.

Entregas:

- polling adaptativo do head;
- range adaptativo de `eth_getLogs`;
- cursor inicialmente em arquivo/dry-run ou memoria controlada;
- deduplicacao por identidade de log;
- tratamento de `removed`/reorg;
- metricas de head, cursor, lag e backfill;
- testes unitarios de lacuna, duplicata e reorg.

Implementado:

- `pollOnce` e scheduler `start`/`stop` sem ligacao ao servidor;
- cursor `nextBlock` em memoria controlada, usando `BigInt` sem perda de
  precisao;
- head seguro configuravel por confirmacoes;
- ranges contiguos e limitados por rodada para recuperar lacunas sem pular
  blocos;
- range inicial de 10 blocos, reducao em timeout/429/HTTP 400/408/413 e
  crescimento somente apos respostas esparsas consecutivas;
- RPC publico e fallback permanecem responsabilidade do cliente do Bloco 1;
- identidade de log por `blockHash + transactionHash + logIndex`;
- deduplicacao limitada em memoria e retencao do overlap necessario para
  reorg;
- cursor e dedupe so avancam depois que o consumidor aceita o batch;
- checkpoint de hash no ultimo bloco processado;
- rewind e callback de remocao quando o hash muda ou o safe head regride;
- suporte ao flag RPC `removed`;
- polling rapido durante backlog e backoff progressivo quando o head fica
  ocioso ou ocorre erro;
- metricas de head, safe head, cursor, lag, ranges, blocos de backfill, logs,
  duplicatas, remocoes, resize de range, reorg e erros.

Validacao deterministica:

```text
suites=2
tests=15
passed=15
failed=0
```

Os testes do poller protegem:

- drenagem contigua de lacunas;
- nao avancar cursor quando o consumidor falha;
- deduplicacao dentro do range;
- reducao de range sem pular bloco;
- reorg por mudanca de checkpoint;
- regressao do head abaixo do checkpoint;
- polling adaptativo ocioso e quantidades acima de Number.MAX_SAFE_INTEGER.

Validacao real read-only na Alchemy:

```text
head=7476633
nextBlock=7476634
lagBlocks=0
ranges=3
blocksProcessed=28
backfillBlocks=20
rangeSize=10
rangeShrinks=0
errors=0
429=0
```

Foram processados 28 blocos porque a chain avancou entre a leitura usada para
definir o inicio e a leitura feita pelo poller. Isso validou recuperacao real de
lacuna em tres ranges contiguos. Nao houve evento `PoolCreated` v3 nesse trecho.

Limites desta conclusao:

- cursor reinicia com o processo; persistencia pertence ao Bloco 10, depois da
  fundacao multi-chain e schema;
- profundidade inicial de reorg (12) e confirmacoes iniciais (2) sao
  configuraveis e ainda precisam de soak test;
- nenhuma formula ou evento Uniswap e interpretado neste bloco;
- nenhum worker de producao, banco, frontend ou alerta foi ativado;
- o RPC publico apresentou pelo menos uma resposta acima do timeout de 3
  segundos durante a validacao; Alchemy concluiu a rodada real.

### Bloco 3 - Descoberta e parser Uniswap v2

Status: concluido em 2026-07-12.

Objetivo:

- descobrir pairs v2 e traduzir swaps/reservas.

Entregas:

- decoder `PairCreated`;
- decoder `Swap` e `Sync`;
- identificacao WETH/USDG;
- direcao buy/sell;
- fixture de logs reais anonimizada/estavel;
- relatorio dry-run v2.

Saida:

- valores raw preservados;
- volume do quote confere com a fixture;
- mention/log estranho nao vira swap.

Implementado:

- decoders ABI sem SDK para `PairCreated`, `Swap` e `Sync`;
- validacao estrita de emitter, topic count, topic0, addresses e tamanho dos
  dados ABI;
- registry v2 em memoria que aceita somente pairs emitidos pela Factory
  oficial;
- tracking somente quando exatamente um dos tokens e WETH ou USDG canonico;
- enderecos normalizados para lowercase inclusive em chamadas diretas com
  checksum/casing diferente;
- buy/sell sempre da perspectiva do token nao-quote;
- volume quote e quantidade do token preservados como strings decimais, sem
  conversao para `Number`;
- swaps com fluxo de entrada/saida ambiguo sao observados como rejeitados e nao
  recebem side/volume inventado;
- emitter desconhecido e topic nao relacionado nao viram swap;
- fixture RPC real sanitizada em
  `data/fixtures/robinhood-uniswap-v2.json`;
- relatorio deterministico executavel com
  `npm run robinhood:v2-dry-run`.

Fixture confirmada primeiro no Blockscout e depois diretamente por JSON-RPC
Alchemy:

```text
Factory=0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f
PairCreated block=7474208 logIndex=34
token0=WETH 0x0bd7d308f8e1639fab988df18a8011f41eacad73
token1=0xec8904855c76dc2716236d0dce33a83c30932874
pair=0x981c11d0aa347bd2e729bafc655b4c279e726680
pairIndex=5368
pairCodeBytes=11293

Sync/Swap block=7475507
reserve0Raw=10001000000000000
reserve1Raw=99990030993909907182253929284
amount0In=1000000000000
amount1Out=9969006090092817746070716
side=buy
quoteAmountRaw=1000000000000
```

O dry-run reproduziu:

```text
trackedPairs=1
swapsAccepted=1
buys=1
sells=0
quoteVolumeRaw=1000000000000
```

Validacao deterministica do bloco:

```text
tests=10
passed=10
failed=0
```

Os testes protegem discovery real, reservas reais, buy real, sell com quote em
token1, USDG, casing, pairs sem quote/duplo quote, fluxo ambiguo, emitter/topic
estranho, ABI malformada e inteiros acima de `Number.MAX_SAFE_INTEGER`.

Limites desta conclusao:

- decimals, valores humanizados, preco, USD, liquidez USD e FDV pertencem ao
  Bloco 6;
- registry continua em memoria e nao sobrevive restart;
- tracker e dry-run ainda nao estao ligados ao poller ou servidor;
- swaps exoticos/flash com fluxo ambiguo sao descartados de buy/sell por
  seguranca ate existir uma regra comprovada;
- a fixture preserva enderecos e hashes publicos necessarios para provar o log
  real, mas nao contem chave, endpoint privado ou dado offchain pessoal;
- nenhum schema, worker de producao, frontend ou alerta foi alterado.

### Bloco 4 - Descoberta e parser Uniswap v3

Status: concluido em 2026-07-12.

Objetivo:

- descobrir pools v3 e traduzir swaps concentrados.

Entregas:

- decoder `PoolCreated`;
- decoder `Initialize` e `Swap`;
- tratamento de fee tier;
- calculo a partir de `sqrtPriceX96` sem perda prematura de precisao;
- direcao e volume em quote;
- fixture e relatorio dry-run v3.

Nao reutilizar formula de reserva v2 para liquidez v3.

Implementado:

- decoders ABI sem SDK para `PoolCreated`, `Initialize` e `Swap`;
- validacao de Factory/pool emitter, topics, tamanho ABI, addresses e limites
  `uint24`, `int24`, `uint160`, `uint128` e `int256`;
- two's complement correto para deltas negativos e ticks sign-extended;
- registry v3 em memoria com fee tier e tick spacing por pool;
- tracking somente quando exatamente um token e WETH ou USDG canonico;
- buy/sell pela perspectiva do token nao-quote usando o sinal dos deltas do
  pool;
- `sqrtPriceX96`, liquidez e amounts preservados como strings raw;
- preco raw quote/token preservado como fracao exata derivada de
  `sqrtPriceX96 ** 2 / 2 ** 192`, invertida somente conforme a posicao do
  quote;
- `sqrtPriceX96 <= 0` rejeitado para impedir fracao invalida;
- fixture RPC real em `data/fixtures/robinhood-uniswap-v3.json`;
- relatorio deterministico em `npm run robinhood:v3-dry-run`.

Fixture confirmada pelo Blockscout e diretamente por JSON-RPC Alchemy:

```text
Factory=0x1f7d7550b1b028f7571e69a784071f0205fd2efa
block=6880646
transaction=0xc62997c2607d579233b552fad71faae7e392a4c13bc92b9d20c57425b9ffe418
token0=WETH 0x0bd7d308f8e1639fab988df18a8011f41eacad73
token1=0x955b339944cbd4834156366d766c260c80956b44
pool=0xefd703d89b7febc0ae43fdd72edd257819366272
fee=10000
tickSpacing=200
poolCodeBytes=22142

Initialize sqrtPriceX96=134488320080963056925758726536634
Initialize tick=204200

Swap amount0=50000000000000000
Swap amount1=-35227361211893808519261776
Swap sqrtPriceX96=2076010423211042875975338409715219
Swap liquidity=36819258015569838458222
Swap tick=203482
side=buy
quoteAmountRaw=50000000000000000
tokenAmountRaw=35227361211893808519261776
```

O dry-run reproduziu:

```text
trackedPools=1
swapsAccepted=1
buys=1
sells=0
quoteVolumeRaw=50000000000000000
```

Validacao deterministica do bloco:

```text
tests=10
passed=10
failed=0
```

Os testes protegem fixture real, fee/tick spacing, Initialize, sinais
`int256`, buy real, sell com quote em token1, USDG, casing, pools sem/duplo
quote, deltas ambiguos, inversao exata do preco, limites ABI, emitter/topic
estranho e `sqrtPriceX96` zero.

Limites desta conclusao:

- a fracao e preco em unidades raw; decimals e preco humanizado pertencem ao
  Bloco 6;
- `liquidityRaw` v3 nao e reserva nem liquidez USD e nao pode usar formula v2;
- registry continua em memoria e nao esta ligado ao poller/servidor;
- a fixture coincide com um launch observado no bloco historico, mas a origem
  NOXA ainda nao e aceita sem as validacoes especificas do Bloco 4A;
- swaps com deltas ambiguos nao recebem side/volume;
- nenhum schema, worker de producao, frontend ou alerta foi alterado.

#### Bloco 4A - Descoberta complementar NOXA Fun

Status: concluido em 2026-07-12.

Objetivo:

- descobrir tokens NOXA diretamente no launch sem criar um segundo parser de
  mercado.

Entregas:

- decoder `TokenLaunched`;
- validacao de emitter, Factory v3, WETH e pool canonicos;
- consulta `getLaunchedToken` quando suportada;
- deduplicacao com o mesmo `PoolCreated` da Uniswap v3;
- captura de deployer, config ID, position ID, initial buy e restricoes;
- classificacao `launchSource: 'noxa-fun'` sem alterar o parser de swaps;
- fixture real e teste para evento falso/inconsistente.

Gate:

- nenhum launch entra no registry apenas porque a Factory NOXA o anunciou;
- pool e quote precisam ser comprovados na Uniswap oficial.

Implementado:

- decoder ABI estrito de `TokenLaunched` para a Factory NOXA oficial;
- decoder dos 13 campos retornados por `getLaunchedToken(address)`;
- builders deterministas para `getLaunchedToken` e
  `UniswapV3Factory.getPool(token, pairToken, fee)`;
- validacao redundante da Factory NOXA mesmo quando o validador recebe um
  objeto ja decodificado;
- validacao de `exists`, token, deployer, paired token, position ID, dex ID,
  config ID, restriction end, initial buy, pool fee e ordenacao token0;
- cruzamento obrigatorio com `PoolCreated` da Factory v3 oficial;
- comprovacao do pool por `getPool(token, WETH, 10000)`;
- exigencia de bytecode no token e no pool;
- `restrictionsEndBlockL1` nomeado explicitamente para impedir comparacao com
  altura L2;
- o mesmo pool usa `marketDiscoveryKey` v3, `isNewMarket=false` e
  `deduplicatedWith='uniswap-v3'` apenas depois de todos os gates passarem;
- launch rejeitado nao recebe chave de deduplicacao validada;
- fixture em `data/fixtures/robinhood-noxa-launch.json`;
- relatorio deterministico em `npm run robinhood:noxa-dry-run`.

Fixture e leituras confirmadas diretamente por JSON-RPC Alchemy no bloco
historico:

```text
block=6880646
NOXA Factory=0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb
token=0x955b339944cbd4834156366d766c260c80956b44
deployer=0x4ba04830e5f615dc0e7d80a7dc4352c241ccbdc2
dexFactory=0x1f7d7550b1b028f7571e69a784071f0205fd2efa
pairToken=WETH 0x0bd7d308f8e1639fab988df18a8011f41eacad73
pool=0xefd703d89b7febc0ae43fdd72edd257819366272
dexId=0
launchConfigId=0
positionId=78750
restrictionsEndBlockL1=25509217
initialBuyAmountRaw=50000000000000000

getLaunchedToken.exists=true
getLaunchedToken.poolFee=10000
getLaunchedToken.supplyRaw=1000000000000000000000000000
getPool result=0xefd703d89b7febc0ae43fdd72edd257819366272
tokenCodeBytes=4830
poolCodeBytes=22142
```

O dry-run cruzando a fixture NOXA com a fixture v3 reproduziu:

```text
launchesSeen=1
launchesAccepted=1
newMarkets=0
deduplicatedV3Pools=1
validationErrors=[]
```

Validacao deterministica do bloco:

```text
tests=9
passed=9
failed=0
```

Os testes protegem evento real, struct real, todos os gates, calldata,
lookalike de Factory/DEX/quote, divergencia de PoolCreated/getPool, ausencia de
bytecode, `exists=false`, campos divergentes, ABI malformada, bool invalido e
fee acima de `uint24`.

Limites desta conclusao:

- o helper constroi e decodifica as chamadas, mas o fluxo continuo ainda nao
  esta ligado ao poller/servidor;
- `restrictionsEndBlockL1` nao pode ser comparado com o cursor L2;
- origem NOXA adiciona metadata de launch, nao um parser de mercado novo;
- o mesmo pool continua sendo negociado e calculado exclusivamente pelo parser
  Uniswap v3;
- source da Factory no explorer continua sem verificacao completa; os gates
  onchain e o endereco publicado oficialmente sao obrigatorios;
- nenhum schema, worker de producao, frontend ou alerta foi alterado.

### Bloco 5 - Descoberta e parser Uniswap v4

Status: concluido em 2026-07-12.

Objetivo:

- suportar o PoolManager e identidade por `poolId`.

Entregas:

- decoder `Initialize`;
- registry `poolId -> PoolKey`;
- decoder `Swap`;
- moedas nativas/wrapped tratadas explicitamente;
- hooks registrados como contexto, sem executar logica externa;
- fixture e relatorio dry-run v4.

Gate:

- nao avancar para persistencia se v4 estiver gerando volume/preco ambiguo.

Implementado:

- decoder estrito dos ABIs oficiais `Initialize` e `Swap` do `PoolManager`;
- registry em memoria por `poolId`, sem inventar endereco de contrato por pool;
- `marketKey` no formato `robinhood:uniswap-v4:<poolId>`;
- `PoolKey` observado preservado como `currency0`, `currency1`, `fee`,
  `tickSpacing` e `hooksAddress`;
- hooks tratados apenas como contexto; nenhum log ou retorno de hook altera
  classificacao, preco ou volume neste bloco;
- ETH nativo (`address(0)`) mantido em `quoteCurrencyAddress`, com WETH apenas
  como identidade canonica em `quoteAddress` e `quoteKind=native`;
- WETH e USDG ERC-20 suportados como quotes canonicos;
- deltas `int128` classificados da perspectiva do token e rejeitados quando
  ambos possuem sinais ambiguos;
- preco mantido como razao inteira exata de `sqrtPriceX96`, sem conversao para
  ponto flutuante;
- fee emitida em cada swap preservada separadamente da fee inicial do pool.

Fixture real capturada via RPC publico em 2026-07-12:

```text
poolId=0x1a88cf4f3efb1487b80b75797e3fbde55a3778b2ff7dfa88860f8d8f115bf0
Initialize block=7510901
Swap block=7511248
token=0x2ae83bcfa4cc59caa95e08f0df46797f1313cb07
quote=USDG
fee=870000
tickSpacing=10000
hooks=address(0)
side=sell
quoteAmountRaw=798800
tokenAmountRaw=1182155306209100178711666
```

Dry-run deterministico:

```text
trackedPools=1
swapsAccepted=1
buys=0
sells=1
quoteVolumeRaw=798800
```

Validacao do bloco:

```text
tests=9
passed=9
failed=0
```

Os testes protegem fixture real, identidade por `poolId`, emitter singleton,
quote USDG, ETH nativo versus WETH, hooks sem execucao, dynamic fee, sinais de
buy/sell, quotes ambiguos, pool desconhecido, ABI malformada, contexto
divergente e limites `int128`/`uint`.

Limites desta conclusao:

- o registry ainda vive apenas em memoria e nao esta ligado ao poller;
- `sqrtPriceX96` esta correto em unidades raw, mas decimals e preco USD pertencem
  ao Bloco 6;
- liquidez v4 nao foi convertida em reservas ou USD;
- hooks podem alterar o comportamento economico da pool; neste bloco eles sao
  apenas sinalizados, nunca interpretados como fonte confiavel;
- fee alta ou pool tecnicamente valido nao implica meme elegivel para alerta;
- nenhum schema, worker, frontend ou alerta foi alterado.

### Bloco 6 - ERC-20 metadata, quote e metricas de mercado

Status: concluido em 2026-07-12.

Objetivo:

- transformar swaps validos em observacoes de mercado comparaveis.

Entregas:

- `name`, `symbol`, `decimals`, `totalSupply` com cache;
- suporte a ERC-20s que retornam bytes32 ou revertem;
- Multicall3 opcional para agrupar leituras read-only e economizar RPC;
- fallback para chamadas individuais se o Multicall3 falhar ou nao tiver
  bytecode esperado;
- WETH/USD via USDG/pool canonico inicialmente;
- price USD;
- volume USD;
- FDV identificado como FDV, nunca market cap confirmado;
- liquidez por versao com `confidence/status`;
- exclusao dos contratos canonicos e Stock Tokens.

Implementado:

- leitor ERC-20 provider-agnostic para `name`, `symbol`, `decimals` e
  `totalSupply` via `eth_call`;
- suporte a strings ABI dinamicas e retornos legados `bytes32`;
- falhas por campo produzem metadata `partial`/`unusable`, sem inventar valores;
- cache TTL em memoria e coalescencia de leituras simultaneas por token/bloco;
- Multicall3 `aggregate3` opcional, validado por bytecode, com fallback para
  quatro chamadas individuais;
- falha transitoria na verificacao do Multicall3 nao o desativa para sempre;
- valores raw e calculos mantidos em `BigInt`/racionais exatos;
- preco em quote, preco USD, volume USD e FDV formatados como strings decimais;
- `marketCapUsd` permanece `null` e `valuationType=fdv`;
- USDG/USD usa peg 1:1 explicitamente marcado como `assumed`, nunca como oracle;
- WETH/USD vem de pool WETH/USDG fee 100 descoberto por `getPool` na Factory v3
  oficial, validado por bytecode e consultado por `slot0`;
- endereco do pool WETH/USDG nao foi hardcoded;
- denylist por endereco para contratos canonicos e 25 Stock Tokens/ETFs
  publicados oficialmente pela Robinhood;
- observacao de mercado exige resultado explicito do gate de elegibilidade;
  token negado ou gate ausente falha antes de qualquer metrica;
- simbolo/nome parecido com acao nao bloqueia sozinho um token nao oficial;
- liquidez v2 estimada como duas vezes a reserva de quote ao spot, com
  `confidence=medium` e aviso de manipulacao;
- v3/v4 nao convertem o escalar `liquidity` em USD: sem distribuicao por ticks,
  retornam `liquidityUsd=null`, `confidence=none`.

Dry-run real read-only em 2026-07-12:

```text
RPC usado: robinhood-public
eth_call: 5 success / 0 errors / 0 fallback
eth_getCode: 2 success / 0 errors / 0 fallback
metadata token: HOME, 18 decimals, complete, Multicall3
metadata quote: USDG, 6 decimals, complete, Multicall3
WETH/USD observado: 1805.127762184379
WETH/USD pool fee: 100
fixture swap: sell
priceUsd: 0.00000067571493847248179217432
volumeUsd: 0.7988
fdvUsd: 67571.493847248179
marketCapUsd: null
liquidity v4: requires_tick_liquidity_distribution
```

O pool WETH/USDG fee 100 observado foi
`0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca`, mas esse endereco e resultado de
`getPool` e nao constante do codigo. Os tiers 100, 500, 3000 e 10000 continham
pools no momento da verificacao; fee 100 possuia a maior liquidez ativa
observada entre eles.

Validacao deterministica especifica do bloco:

```text
suites=4
tests=30
passed=30
failed=0
```

Os testes protegem codec `aggregate3`, fallback, cache, falhas/reverts ERC-20,
strings `bytes32`, inteiros grandes, formulas exatas, USDG assumido, WETH/USD
observado, FDV versus market cap, descoberta do pool pela Factory, denylist
oficial e status de liquidez por versao.

Limites desta conclusao:

- cache e snapshot de quote ainda vivem em memoria e nao estao ligados a worker;
- o peg de USDG pode divergir de USD; o status `assumed` precisa chegar ao alerta;
- um unico pool onchain pode ser manipulado; WETH/USD tem confidence `medium`;
- fee 100 tinha maior liquidez ativa na verificacao, mas isso pode mudar e deve
  ser monitorado no soak test;
- a lista oficial de Stock Tokens/ETFs pode crescer e precisa ser revisada
  contra a documentacao Robinhood antes de releases;
- metadata `name`/`symbol` nunca decide autenticidade ou elegibilidade;
- liquidez concentrada real exige leitura de ticks/posicoes, fora deste bloco;
- nenhum schema, frontend, worker ou alerta foi alterado.

### Bloco 7 - Agregacao e dry-run continuo unificado

Status: implementado em 2026-07-12; gate operacional de soak pendente.

Objetivo:

- validar o comportamento completo sem banco e sem alertas.

Entregas:

- janelas 1m/5m/1h/6h/24h;
- buys/sells/txns;
- rolling price change;
- relatorio por v2/v3/v4;
- taxa de eventos sem quote;
- atraso head->processamento;
- requests/bytes/429 por provider;
- reconnect e backfill observaveis;
- soak test definido, inicialmente 30-60 minutos e depois 24 horas.
- comparacao amostral com o indexador NOXA para launches, preco e volume, sem
  transformar divergencia em escrita automatica.

Gate:

- zero lacuna nao explicada;
- duplicata nao altera volume;
- public RPC sustenta carga observada ou degradacao e documentada;
- Alchemy pode ser desligada sem parar o coletor.

Implementado:

- agregador EVM exato para janelas 1m, 5m, 1h, 6h e 24h;
- contagem de swaps, buys, sells e transacoes unicas;
- soma de volume USD com racionais/BigInt, sem acumulacao em ponto flutuante;
- variacao rolling entre primeiro e ultimo preco de cada janela;
- deduplicacao por `chain + transactionHash + logIndex`;
- remocao de observacoes e volume quando o poller sinaliza reorg;
- `marketKey` uniforme nos decoders v2, v3 e v4;
- filtros de endereco dinamicos no poller, sem permitir que o callback altere
  `fromBlock` ou `toBlock`;
- pipeline unificado para discovery, swaps, timestamps, metadata,
  elegibilidade, WETH/USD, metricas e janelas;
- timestamp de bloco cacheado quando `eth_getLogs` nao fornece valor util;
- timestamps ausentes buscados por bloco unico com concorrencia limitada e
  ordem original preservada;
- metadata/observacoes independentes enriquecidas com concorrencia limitada,
  aplicadas ao agregador somente depois de o lote inteiro ser construido;
- cotacao WETH/USD concorrente deduplicada por uma unica promise em voo;
- dois cursores coordenados: discovery sempre processa antes de market;
- head do cursor de market limitado ao ultimo bloco concluido por discovery;
- remocao de pairs/pools descobertos quando o evento de criacao sofre reorg;
- relatorio por v2/v3/v4, taxa sem quote, atraso head->processamento, backfill,
  requests, bytes, erros, 429 e fallback por provider;
- runner HTTP publico por padrao; Alchemy entra somente com
  `ROBINHOOD_CONTINUOUS_USE_ALCHEMY=true`;
- recuperacao apos erro HTTP observavel; reconnect WebSocket marcado como nao
  aplicavel porque nenhum WebSocket foi habilitado neste runner;
- cobertura declarada por `coverageStartBlock`; nao alega conhecer pools
  anteriores sem registry persistente;
- fixtures verificadas seedam um mercado v2, v3 e v4; novos pools dentro da
  cobertura entram pelo discovery onchain;
- CLI `npm run robinhood:continuous-dry-run`, sem banco nem alertas.

Correcao encontrada pelo primeiro smoke:

- inicialmente o market poller podia observar um head mais novo que discovery
  enquanto a chain avancava rapidamente;
- isso criava risco de perder pools inicializados entre os dois heads;
- o market head agora e capado no frontier concluido de discovery;
- teste dedicado impede regressao desse contrato.

Validacao publica curta, Alchemy desligada:

```text
lookback=20 blocos
duracao real da primeira rodada=6.641s
coverage=complete_within_declared_range
discoveryCursor=7890075
marketCursor=7890075
unexplainedGaps=0
headProcessingDelayMs=7543
requests=28
responseBytes=77002
errors=0
429=0
fallbacks=0
swapsDecoded=0
```

Amostra publica ampliada:

```text
lookback=250 blocos
duracao real da primeira rodada=51.113s
coverage=complete_within_declared_range
discoveryCursor=7888345
marketCursor=7888345
unexplainedGaps=0
tracked v2/v3/v4=1/3/3
requests=210
responseBytes=987336
errors=0
429=0
fallbacks=0
swapsDecoded=0
```

Leitura operacional:

- o RPC publico sustentou as amostras sem Alchemy e sem 429;
- 250 blocos custaram aproximadamente 1 MB e 51 segundos, portanto backfill
  amplo nao deve ser repetido agressivamente;
- nenhuma das duas coberturas continha swap dos mercados conhecidos, logo
  percentis reais de volume/txns ainda nao podem definir gates;
- seed local torna a cobertura util para smoke, mas nao equivale a registry
  historico completo; persistencia pertence ao Bloco 10.

Primeiro soak publico, executado externamente por 31 minutos:

```text
duracao=31m02s
coverage=backfilling
discoveryCursor=7968515
marketCursor=7958668
gap discovery-market=9847 blocos
headProcessingDelayMs=114288
cycles=30
runner errors=10
recoveries=1
tracked v2/v3/v4=14/84/161
swaps decoded/accepted/rejected=4701/4701/0
processing delay p50/p95=1089315/1100725 ms
backfill discovery/market=16670/7850 blocos
RPC requests/errors/429=6888/23/0
RPC responseBytes=23162669
Alchemy=false
```

Resultado critico do soak:

- integridade observada permaneceu boa (`unexplainedGaps=0`, rejeicoes e taxa
  sem quote iguais a zero), mas isso nao satisfaz o gate de tempo real;
- discovery processou aproximadamente 9 blocos/s e market aproximadamente
  4,2 blocos/s, deixando 9.847 blocos de diferenca enquanto a chain avancava;
- o gargalo comprovado estava no pipeline: timestamp por bloco e construcao de
  observacao eram aguardados serialmente para cada log;
- o relatorio final nao preservou as mensagens individuais dos 10 erros, logo
  a causa exata deles nao pode ser afirmada apenas pelo snapshot;
- existe ainda uma amostra v2 extrema de preco sobre volume muito pequeno;
  gates de qualidade/outlier continuam necessarios antes de alertas reais.

Otimizacao aplicada apos o soak:

- `ROBINHOOD_CONTINUOUS_TIMESTAMP_CONCURRENCY`, padrao 16 e maximo 32;
- `ROBINHOOD_CONTINUOUS_OBSERVATION_CONCURRENCY`, padrao 4 e maximo 16;
- metricas `enrichment.timestamps` registram blocos requisitados, tamanho
  maximo do lote e concorrencia efetiva;
- falha de qualquer timestamp ou observacao ainda rejeita o lote e impede o
  poller de avancar o cursor;
- nenhum limite foi removido e Alchemy continua opt-in.

Smokes publicos depois da otimizacao:

```text
timestamp concurrency=8
duracao=24.09s
market backfill=200 blocos (~8.3 blocos/s)
gap final=55 blocos
swaps=29
RPC requests/errors/429=211/0/0

timestamp concurrency=16
duracao=21.22s
market backfill=230 blocos (~10.8 blocos/s)
coverage=complete_within_declared_range
swaps=11
RPC requests/errors/429=200/0/0
concorrencia efetiva maxima=13
```

O segundo smoke justifica o padrao 16: concluiu a cobertura publica sem erro e
com margem sobre o throughput observado da chain. A amostra curta nao substitui
o novo soak de 30-60 minutos.

Segundo soak publico, apos a otimizacao, executado por 30 minutos:

```text
duracao=30m00s
coverage=backfilling
discoveryCursor=8015189
marketCursor=8013492
gap discovery-market=1697 blocos
headProcessingDelayMs=22984
cycles=133
runner errors/recoveries=61/3
tracked v2/v3/v4=32/100/264
swaps decoded/accepted=13161/13160
processing delay p50/p95=199608/205436 ms
backfill discovery/market=14670/15800 blocos
RPC requests/errors/429=13958/147/0
Alchemy=false
```

Comparacao com o primeiro soak:

- o gap caiu de 9.847 para 1.697 blocos, reducao de aproximadamente 82,8%;
- throughput de market subiu de aproximadamente 4,2 para 8,8 blocos/s;
- atraso p50 caiu de aproximadamente 18,2 para 3,3 minutos;
- apesar da melhora, o gate continua reprovado porque o cursor market nao
  alcancou discovery e ocorreram 61 ciclos com erro;
- o formato antigo nao preservou os tipos desses erros; o runner agora inclui
  `errorKinds`, `lastError`, `consecutiveErrors` e `rpc.errorCodes`.

Compactacao do relatorio:

- o array completo `windows` foi removido apenas da saida operacional;
- o pipeline continua mantendo todas as janelas em memoria normalmente;
- `windowSummary` preserva quantidade de mercados, contagem por janela, top 5
  por swaps na menor janela e top 5 mercados por variacao absoluta;
- aplicado ao segundo soak, o snapshot cairia de 236.041 para cerca de 4.300
  bytes, reducao de aproximadamente 98,2%.

Validacao da otimizacao:

```text
testes afetados=24
passed=24
failed=0
lint errors=0
lint warnings novos=0
```

Os testes novos protegem concorrencia limitada, deduplicacao por bloco, ordem
dos resultados, falha atomica do lote e cotacao WETH unica enquanto concorrente.

Comparacao NOXA:

- a pagina publica exibia 84 launches e 16.81 ETH de volume 24h na amostra;
- nao houve launch NOXA nem swap comparavel dentro das coberturas curtas;
- nao foi encontrado contrato publico/versionado para a API do indexador;
- o runner registra `not_automated/no_public_versioned_indexer_api_contract`;
- nenhum dado NOXA controla cursor, volume, preco ou escrita.

Validacao deterministica nova do bloco:

```text
cenarios novos=29
passed=29
failed=0
```

Validacao acumulada Robinhood/EVM apos o bloco:

```text
suites=15
tests=117
passed=117
failed=0
lint errors=0
lint warnings novos=0
```

Os testes protegem janelas, volume exato, rolling change, duplicata, reorg,
filtro dinamico, ordem discovery->market, cap de frontier, fallback/recovery,
metricas RPC, Alchemy opt-in, cobertura limitada, timestamps e CLI bounded.

Repeticao do soak obrigatoria apos a otimizacao:

```bash
ROBINHOOD_CONTINUOUS_DURATION_SECONDS=1800 \
ROBINHOOD_CONTINUOUS_REPORT_INTERVAL_SECONDS=60 \
ROBINHOOD_CONTINUOUS_LOOKBACK_BLOCKS=250 \
ROBINHOOD_CONTINUOUS_POLL_INTERVAL_MS=5000 \
ROBINHOOD_CONTINUOUS_TIMESTAMP_CONCURRENCY=16 \
ROBINHOOD_CONTINUOUS_OBSERVATION_CONCURRENCY=4 \
ROBINHOOD_CONTINUOUS_USE_ALCHEMY=false \
npm run robinhood:continuous-dry-run
```

Gate para encerrar o bloco:

- executar 30-60 minutos primeiro e guardar relatorio final;
- zero cursor divergente, lacuna inexplicada ou volume alterado por duplicata;
- medir swaps reais, taxa sem quote, atraso e custo por minuto;
- depois executar 24h em ambiente apropriado antes de persistencia/alertas;
- se o RPC publico nao acompanhar, documentar degradacao antes de testar
  Alchemy; nao habilitar fallback silenciosamente.

Soak final aprovado:

```text
duracao=30m07s
coverage=complete_within_declared_range
discoveryCursor=8090442
marketCursor=8090442
unexplainedGaps=0
runner errors/recoveries=0/0
swaps decoded/accepted=19747/19747
processing delay p50/p95=14441/18650 ms
backfill discovery/market=12370/16980 blocos
RPC requests/errors/429=16988/0/0
Alchemy=false
```

O gate operacional do Bloco 7 foi aprovado. O RPC publico sustentou a carga,
os cursores terminaram alinhados e nenhuma falha ou rate limit foi observado.

Correcao de qualidade V2 apos o soak:

- os precos extremos nao eram erro aritmetico: DexScreener e reservas onchain
  confirmaram pools drenados com liquidez praticamente zero;
- o tracker V2 agora anexa as reservas do `Sync` pos-swap ao evento `Swap`;
- observacoes sao rejeitadas com `v2_token_reserve_depleted` quando resta menos
  de um token inteiro no pool;
- `v2ReserveDepleted` tornou a rejeicao observavel no relatorio compacto;
- a formula exata de preco/volume nao foi alterada.

### Bloco 8 - Metadata social DexScreener isolada

Status: concluido em 2026-07-12; persistencia real do cache delegada aos Blocos
9-10 porque a identidade atual e address-only.

Objetivo:

- preencher apenas imagem e links sem competir de forma relevante com Solana.

Entregas:

- fila de baixa prioridade para tokens novos;
- cache persistente/TTL longo;
- limite conservador de chamadas;
- uma tentativa inicial e retries lentos;
- extracao somente de imagem/site/Twitter/Telegram;
- 429 pausa a fila Robinhood primeiro;
- falha nunca bloqueia onchain nem alerta.

Para token comprovadamente lancado pela NOXA, o indexador publico usado pelo
frontend pode ser avaliado como fonte de metadata anterior ao DexScreener. Esse
uso so pode ser ativado depois de documentar formato, timeout, cache e fallback;
a API nao possui contrato publico/SLA conhecido e continua dispensavel.

Ponto importante:

- separar o cliente no codigo nao separa o rate limit externo por IP. O baixo
  volume e o cache sao as protecoes reais para nao afetar Solana.

Implementado:

- fila deduplicada com no maximo 5 tokens por batch e 1.000 pendentes;
- endpoint batch chamado explicitamente com `chain=robinhood`;
- cache TTL de 24 horas e contrato de store injetavel;
- store padrao em memoria; nenhuma tabela address-only foi reutilizada;
- retries lentos em 5 minutos, 30 minutos e 6 horas;
- pausa antes de requests quando o throttle Dex pede suspensao de discovery;
- falhas externas contidas em status/metricas, sem throw para o pipeline;
- extracao sanitizada somente de imagem, site, Twitter e Telegram;
- nenhum preco, volume ou market cap da Dex entra no pipeline onchain;
- descobertas onchain apenas enfileiram enderecos, sem aguardar a DEX;
- drenagem fire-and-forget, opt-in por
  `ROBINHOOD_CONTINUOUS_SOCIAL_METADATA=true`;
- smoke real confirmou o endpoint Robinhood; o token amostrado nao tinha
  metadata social e foi mantido para retry lento como esperado.

Decisao de arquitetura:

- cache persistente nao pode usar `token_catalog` antes do Bloco 9 porque a
  identidade ainda e address-only e Robinhood poderia ser tratada como Solana;
- o contrato `store.get/set` permite conectar persistencia depois da migracao
  chain-aware sem reescrever a fila.

### Bloco 9 - Fundacao multi-chain de identidade

Objetivo:

- impedir que Robinhood seja tratada silenciosamente como Solana.

Problemas atuais que precisam ser resolvidos:

- `normalizeChain` nao reconhece Robinhood e faz fallback para Solana;
- discovery e catalog worker usam `solana` hard coded;
- `token_catalog.address` e `UNIQUE` sem chain;
- varias tabelas e caches usam apenas address como identidade;
- regras GMGN/Meteora/PumpFun/Helius nao podem rodar em token EVM.

Execucao obrigatoriamente quebrada em sub-blocos:

#### Bloco 9A - Inventario e primitives

Status: concluido em 2026-07-12.

- mapear tabelas, modelos, caches, sockets e rotas por address;
- criar `chain + normalizedAddress` como identidade logica;
- adicionar Robinhood a normalizacao sem fallback silencioso;
- testes unitarios de casing e chain.

Implementado:

- inventario versionado em `docs/robinhood-chain-identity-inventory.md`;
- chains canonicas e aliases explicitos em `src/utils/token-identity.js`;
- EVM normalizado para lowercase e Solana case-sensitive;
- chave logica estavel `<chain>:<normalizedAddress>`;
- chain ausente/desconhecida e endereco incompatível falham sem fallback;
- fila social Robinhood passou a reutilizar a primitive nova;
- `normalizeChain` legado nao foi aberto para Robinhood, pois isso habilitaria
  rotas de catalogo address-only antes do schema seguro;
- 15 testes afetados passaram; lint sem erros ou warnings novos;
- nenhum schema, frontend, worker persistente ou alerta foi alterado.

#### Bloco 9B - Schema aditivo

Status: concluido em 2026-07-12.

- adicionar colunas/indexes sem remover contratos antigos imediatamente;
- criar constraints compostas quando seguro;
- preparar rollback;
- rodar `npm run db:schema-check`.

Implementado:

- stage 51 para `token_catalog` e buckets genericos de mercado;
- stage 52 para identidades de usuario, risco, blocklist e alertas;
- colunas `chain VARCHAR(16) NOT NULL DEFAULT 'solana'` aditivas;
- backfill Solana de reparo apenas quando uma coluna preexistente for nullable;
- indexes compostos `chain + address/token_address` criados em paralelo aos
  contratos antigos;
- buckets historicos usam indexes parciais `chain <> 'solana'`, evitando
  duplicar mais de 70 milhoes de rows Solana;
- indexes usam `CREATE INDEX CONCURRENTLY` para reduzir bloqueio;
- nenhuma PK, FK, unique, coluna ou tabela legada e removida;
- guard de runtime exige stages 51/52 e aponta os comandos de reparo;
- rollback documentado em `docs/robinhood-chain-schema-rollback.md`;
- 14 testes afetados passaram e lint nao ganhou erros/warnings.

Comandos aplicados:

```bash
node src/utils/db-init-stage51.js
node src/utils/db-init-stage52.js
npm run db:schema-check
```

Resultado operacional:

- a falha inicial nao era ausencia do banco: PostgreSQL 17 vazio havia tomado a
  porta 5432 enquanto o cluster PostgreSQL 16 com os bancos falhava ao iniciar;
- PostgreSQL 17 foi parado e PostgreSQL 16 restaurado na porta 5432;
- `volume_bot_vps_restore` foi confirmado no cluster 16;
- a primeira estrategia de indexes completos foi cancelada ao detectar apenas
  3,5 GiB livres e tabelas de 31M/31M/7,8M rows;
- dois indexes temporarios de 2,5 GB e um invalido foram removidos, recuperando
  o espaco sem deixar artefatos invalidos;
- estrategia final parcial criou cada index de bucket com apenas 8 KB;
- auditoria final encontrou zero `chain IS NULL` e zero rows nao-Solana em todas
  as 20 tabelas migradas;
- `npm run db:schema-check` passou no perfil runtime;
- espaco final observado: aproximadamente 20 GiB livres.

#### Bloco 9C - Modelos e consultas por dominio

Status: em andamento desde 2026-07-12.

- migrar um dominio por commit;
- impedir joins cross-chain por address;
- manter Solana com comportamento identico;
- testes de integracao no banco de teste.

Sub-bloco catalogo concluido:

- `token_catalog` normaliza chain/endereco antes da escrita e da leitura;
- `upsert` usa `ON CONFLICT (chain, address)` e nao pode mais relabelar uma row
  de outra chain;
- stage 53 promoveu a identidade composta a constraint e removeu somente a
  unique legada `token_catalog_address_key`;
- o mesmo texto de endereco pode existir em chains EVM diferentes;
- selecao/claim de avaliacao e consultas Meteora continuam explicitamente
  restritas a `chain='solana'`;
- claim distribuido atualiza por `id`, evitando ambiguidade por address;
- 25 testes de catalogo/workers passaram e o schema runtime foi validado.

Sub-bloco buckets/snapshots concluido:

- writers legados 1m/volume/aggregados gravam `chain='solana'` explicitamente;
- historico, sparklines, baselines, bid-zone e rollups filtram Solana;
- cleanup por address nao pode apagar buckets de outra chain;
- Meteora permanece Solana-only e e alcancada apenas pelo catalog worker
  filtrado no sub-bloco anterior;
- nao houve writer Robinhood antecipado: o schema legado limita preco a 12
  casas e `pair_address` a 64 caracteres, enquanto o pipeline usa preco de ate
  30 casas e pool id v4 de 66 caracteres;
- a persistencia Robinhood exata continua no Bloco 10, com idempotencia e
  recovery transacional;
- ferramentas historicas CoinGecko/backfill continuam Solana-only e nao devem
  ser apontadas para storage Robinhood;
- 56 testes de bucket, analytics, worker e cleanup passaram sem alterar frontend.

Sub-bloco preferencias/folders concluido:

- stage 54 promoveu manual, starred, pinned e bootstrap para
  `(user_id, chain, address)`;
- folder items usam PK `(user_id, folder_id, chain, address)` e FK composta
  para o token manual exato;
- sincronizacoes e remocoes sao escopadas por chain e nao apagam preferencias
  da outra rede;
- o mesmo usuario/endereco foi validado em `ethereum` e `robinhood`, inclusive
  na mesma folder, dentro de transacao revertida;
- rotas legadas de config permanecem explicitamente Solana; endereco EVM sem
  chain deixou de ser persistido falsamente como Solana;
- stage 54 e autocontido para seu dominio e passou teste de idempotencia;
- 29 testes unitarios afetados e 18 testes de integracao
  de config passaram; dashboard legado tambem permaneceu verde.

Sub-blocos pendentes:

- risco, blocklist e alertas;
- rotas, payloads e integracao.

Progresso do sub-bloco risco/blocklist/alertas:

- 9C.4a blocklists/evidencias concluido em 2026-07-12;
- stage 55 promoveu `user_blocklist` para `(user_id,chain,address)`;
- `admin_blocked_tokens` usa PK `(chain,address)`, eliminando ban global por
  texto de endereco;
- evidencias administrativas persistem chain obrigatoria;
- joins com catalogo/risk e cleanup de buckets usam chain explicita;
- cleanup de artefatos/Meteora permanece restrito a Solana;
- full-sync legado de config altera somente blocklist Solana;
- mesmo endereco foi validado em Ethereum/Robinhood nas duas blocklists, com
  evidencia Robinhood, dentro de transacao revertida;
- 24 testes unitarios afetados e 18 testes de integracao de config passaram.

Partes pendentes do 9C.4:

- nenhuma; 9C.4 concluido estruturalmente.

9C.4b risk storage estrutural concluido em 2026-07-12:

- stage 56 promoveu risk enrichment/reviews para PK `(chain,token_address)`;
- junk evidence usa unique `(chain,token_address,assessment_fingerprint)`;
- leituras, escritas e remocoes dos tres modelos exigem identidade por chain;
- manual review e enrichment estrutural foram validados em Ethereum/Robinhood
  dentro de transacao revertida;
- `upsertAutoReview` rejeita non-Solana com
  `NON_SOLANA_AUTO_RISK_DISABLED` antes do banco;
- junk evidence rejeita non-Solana com
  `NON_SOLANA_JUNK_EVIDENCE_DISABLED` antes do banco;
- workers Helius, auto-review e junk capture passam `chain='solana'`
  explicitamente;
- nenhuma regra, score, threshold ou classificacao Robinhood foi criada;
- 47 testes afetados passaram antes da migracao e 24 testes focados dos
  writers passaram depois dos guards explicitos.

9C.4c.1 estado e eventos de alerta concluido em 2026-07-12:

- stage 57 promoveu o estado para PK
  `(user_id,rule_key,chain,token_address)`;
- dedupe de eventos usa unique `(user_id,chain,dedupe_key)`, permitindo a
  mesma chave logica em redes diferentes sem colisao;
- modelos de estado e evento normalizam identidade por chain e as leituras
  filtram `chain`, com fallback legado explicito para Solana;
- criacao automatica de estado/evento non-Solana continua bloqueada com
  `NON_SOLANA_ALERT_TRIGGER_DISABLED`;
- transacao revertida comprovou duas linhas simultaneas para a mesma chave em
  Solana/Robinhood, tanto no estado quanto nos eventos;
- stage 57 passou aplicacao idempotente, schema check e 123 testes afetados;
- nenhum matcher, trigger, socket ou entrega Robinhood foi ativado.

9C.4c.2 regras customizadas, alertas admin e exits concluido em 2026-07-12:

- stage 58 substituiu os indices address-only restantes desses tres dominios
  por indices com `chain`;
- regras customizadas genericas (`price` e `mcap`) podem ser armazenadas para
  Robinhood, com endereco EVM normalizado;
- `listRules` e `listActiveByTokenAddress` filtram chain, usando Solana como
  fallback legado explicito;
- a rota atual do dashboard sobrescreve qualquer chain recebida para
  `solana`, evitando baseline address-only incorreto antes da ativacao;
- `markTriggered` rejeita Robinhood com
  `NON_SOLANA_CUSTOM_ALERT_TRIGGER_DISABLED`;
- review administrativo automatico rejeita Robinhood com
  `NON_SOLANA_ADMIN_REVIEW_ALERT_DISABLED` e o writer atual passa Solana
  explicitamente;
- deteccao de exit Robinhood rejeita com `NON_SOLANA_EXIT_EVENT_DISABLED` ate
  existirem criterios de elegibilidade proprios;
- transacao revertida comprovou duas linhas simultaneas, uma por chain, nos
  tres dominios e confirmou zero indices address-only legados restantes;
- stage 58 passou aplicacao idempotente, schema check, 144 testes unitarios
  afetados, 19 testes de integracao do dashboard e 58 testes administrativos;
- build do frontend passou; nenhum matcher ou entrega Robinhood foi ativado.

9C.4d.1 writers automaticos e guards concluido em 2026-07-12:

- o boundary de `user-alert-matcher` rejeita qualquer chain diferente de
  Solana antes de carregar regras, profiles, sinais ou estado;
- todas as escritas de evento, rule state e custom trigger dentro do matcher
  declaram `chain='solana'` explicitamente;
- o writer de exit do catalogo declara Solana antes de chamar o modelo;
- resolucoes administrativas propagam a chain para blocklist, catalogo e risk
  review, mas retornam `409` para non-Solana enquanto o fluxo address-only de
  avaliacao do catalogo nao for promovido;
- teste de integracao inseriu review Robinhood diretamente, confirmou `409` e
  comprovou que o status continuou `open`;
- um input Robinhood no matcher retorna summary vazio e nao consulta regras,
  profiles ou writers;
- 126 testes focados e 58 testes administrativos passaram;
- nenhuma regra, threshold, matcher ou entrega Robinhood foi ativada.

9C.4d.2 readers, joins e rotas concluido em 2026-07-12:

- feeds, replay e chart events `user-token` declaram `chain='solana'`; sinais
  globais permanecem sem filtro indevido de chain;
- rotas legadas de dashboard, admin e catalogo passam Solana explicitamente
  para custom rules, review, enrichment, exits e remocoes;
- baseline de regra customizada consulta `token_catalog` por
  `(chain,address)`, eliminando o reader address-only;
- readers de monitored, pinned, history, top performers, metadata e risk
  candidates filtram `tc.chain='solana'`;
- joins de catalogo com risk review, enrichment, user/admin blocklist e pins
  comparam chain e endereco;
- fixtures de integracao antigos foram atualizados para o contrato multi-chain;
- 40 testes de contrato/SQL, 19 integracoes de dashboard, 58 administrativas
  e 22 de catalogo passaram;
- cleanup generico e buckets de mercado address-only continuam fora do dominio
  de alertas/risk e seguem para o 9D/Bloco 10;
- mock trading permanece exclusivamente Solana e esta explicitamente fora de
  qualquer migracao Robinhood; seus stores, rotas e UI nao devem ser tocados;
- nenhuma regra ou entrega Robinhood foi ativada.

#### Bloco 9D - Remocao das garantias address-only restantes

- somente depois de todas as consultas estarem chain-aware;
- remover unique/index legado quando comprovadamente seguro;
- revisar plano de rollback e dados existentes.

9D.1 buckets de volume de um minuto concluido em 2026-07-12:

- a primary key de `token_market_volume_buckets_1m` agora e
  `(chain, token_address, bucket_ts)`; os indices address-only e preparatorio
  parcial redundante foram removidos;
- upsert, baseline e cleanup aceitam identidade de chain; todos os writers e
  rotinas legados declaram `chain='solana'` explicitamente;
- a Stage 59 serializa invocacoes com advisory lock e cria os indices com
  `CONCURRENTLY`, evitando bloquear os writers durante a varredura da tabela;
- a migracao local processou aproximadamente 31 milhoes de buckets, passou no
  runtime schema check e foi reaplicada com sucesso para provar idempotencia;
- transacao revertida comprovou duas linhas para o mesmo endereco/minuto em
  Solana e Robinhood;
- 126 testes afetados passaram; lint ficou sem erros ou warnings novos;
- nenhum writer ou alerta Robinhood foi ativado neste sub-bloco.

9D.2a identidade dos buckets OHLC de um minuto concluido em 2026-07-12:

- a primary key de `token_market_buckets_1m` agora e
  `(chain, token_address, bucket_ts)`; o indice address-only e o indice parcial
  preparatorio foram removidos;
- writer ao vivo, backfill historico e replace/restore CoinGecko usam conflito
  composto e declaram Solana explicitamente;
- readers, cleanup, importador e fonte de agregados foram auditados e mantidos
  com `chain='solana'`, impedindo mistura silenciosa entre chains;
- writes Robinhood nesse storage legado falham com
  `NON_SOLANA_LEGACY_MARKET_BUCKET_DISABLED`: `NUMERIC(20,12)` nao preserva
  todo preco EVM e `pair_address VARCHAR(64)` nao comporta todo pool id v4;
- a Stage 60 usou indice unico concorrente sobre 31.189.252 linhas/16 GB,
  concluiu em aproximadamente 9m56s, passou no runtime schema check e foi
  reaplicada com sucesso para provar idempotencia;
- transacao revertida comprovou duas linhas para o mesmo endereco/minuto em
  Solana e Robinhood;
- 174 testes afetados passaram; lint ficou sem erros ou warnings novos;
- o indice de cobertura de sparkline existente permanece address-only ate o
  9D.2b; consultas continuam corretas pelo filtro de chain, mas o indice sera
  substituido para evitar leitura extra quando houver dados multi-chain;
- nenhum writer ou alerta Robinhood foi ativado neste sub-bloco.

9D.2b indice, readers e cache OHLC concluido em 2026-07-13:

- o indice address-only `idx_token_market_buckets_1m_sparkline_cover`, que ja
  nao era escolhido pelo planner apos a PK composta, foi substituido por
  `idx_token_market_buckets_1m_chain_sparkline_cover` em
  `(chain, token_address, bucket_ts DESC)` com o mesmo covering payload;
- a Stage 61 construiu o indice concorrentemente em aproximadamente 14m03s e
  removeu o legado em aproximadamente 9s; reaplicacao confirmou idempotencia;
- o indice novo ocupa aproximadamente 4.479 MB, contra 4.609 MB do legado;
- `EXPLAIN` com token de 44.925 candles escolheu `Index Only Scan` no indice
  chain-aware; tokens esparsos continuam usando a PK, que e o plano mais barato;
- readers, bid zones e cleanups publicos rejeitam chain nao-Solana com
  `NON_SOLANA_LEGACY_MARKET_BUCKET_DISABLED` antes de consultar o banco;
- cache keys compactas e expandidas incluem `chain='solana'`, impedindo colisao
  silenciosa caso um caller tente introduzir outra chain no mesmo cache;
- 274 testes ampliados passaram; lint e diff check ficaram sem erro ou warning
  novo; runtime schema check permaneceu aprovado;
- nenhum reader, writer ou alerta Robinhood foi ativado neste sub-bloco.

9D.3 buckets OHLC agregados concluido em 2026-07-13:

- a Stage 62 promove a primary key para
  `(chain, token_address, granularity_minutes, bucket_ts)` e substitui os dois
  indices address-only por equivalentes chain-aware, usando criacao
  concorrente;
- writers ao vivo e CoinGecko, rollups e backfills usam conflito composto e
  declaram `chain='solana'` explicitamente;
- resets por endereco e por janela, alem das inspecoes seletivas, agora filtram
  Solana e nao podem apagar ou classificar buckets de outra chain;
- o schema de instalacao nova ja nasce com a identidade composta;
- 73 testes focados passaram e o lint ficou sem erros; os 26 warnings exibidos
  sao preexistentes e fora deste sub-bloco;
- a Stage 62 foi aplicada no banco local e o runtime schema check passou; a
  migration tambem remove indices invalidos deixados por uma eventual
  interrupcao antes de tentar reconstrui-los;
- esse storage continua Solana-only: a mudanca estrutural nao habilita buckets
  Robinhood com precisao EVM inadequada.

9D.4 snapshots brutos legados concluido estruturalmente em 2026-07-13:

- `token_market_snapshots` nao possui import no runtime atual; apenas os dois
  backfills manuais de buckets ainda a usam como fonte historica;
- todas as operacoes publicas do modelo rejeitam Robinhood antes de consultar o
  banco com `NON_SOLANA_LEGACY_MARKET_SNAPSHOT_DISABLED`;
- o default legado sem `chain` permanece Solana para nao quebrar ferramentas
  historicas, e a Stage 7 documenta explicitamente esse limite;
- nenhuma coluna, indice ou tabela foi criada, migrada ou removida;
- a aposentadoria fisica continua opcional e exige auditoria de dados e
  autorizacao destrutiva separada; ela nao bloqueia a persistencia Robinhood;
- 2 testes unitarios protegem o guard e a compatibilidade Solana; lint focado
  passou sem erros ou warnings.

### Bloco 10 - Persistencia Robinhood

Objetivo:

- persistir registry, cursor e buckets depois da fundacao multi-chain.

Entregas:

- pool registry v2/v3/v4;
- cursor transacional;
- idempotencia de log;
- buckets de mercado com chain;
- retencao/cleanup;
- restart sem duplicar volume;
- schema check e testes de integracao.

Status: 10A/10B/10C/10D/10E.1/10E.2/10F.1/10F.2/10F.3 implementados em 2026-07-13;
Stages 63-66 e schema check precisam estar aplicados antes de qualquer
execucao real.

10A control plane persistente:

- `robinhood_pool_registry` preserva identidades diferentes para v2/v3 por
  endereco e v4 por `pool_id`, sem forcar o id v4 em `VARCHAR(64)`;
- `robinhood_ingestion_cursors` separa discovery/market e guarda next block,
  safe head, checkpoint hash/timestamp e versao para atualizacao transacional;
- `robinhood_processed_logs` usa identidade global
  `(chain,transaction_hash,log_index)` e retencao de 3 dias;
- o ledger nao armazena payload RPC bruto; guarda apenas campos normalizados
  necessarios para dedupe, reorg, diagnostico e cleanup;
- registry e cursores nao expiram; a retencao de observacoes/candles e
  implementada separadamente nas Stages 64/65;
- nenhum writer ou worker foi conectado neste sub-bloco;
- 17 testes de schema passaram e o lint focado ficou sem erros ou warnings.

10B repository transacional:

- discovery grava identidade compacta do log, registry e cursor na mesma
  transacao; falha em qualquer pool executa rollback antes do cursor;
- replay usa `(chain,transaction_hash,log_index)` e nao reescreve o registry;
- cursor so atualiza para frente e incrementa versao em cada commit valido;
- v2/v3 persistem `pool_address`; v4 persiste `pool_id` e o Pool Manager como
  `origin_address`, sem criar endereco de pool ficticio;
- payload RPC bruto nao entra nos parametros de persistencia;
- a Stage 63 aceita tanto instalacao nova quanto sua primeira versao com
  `manager_address`, copiando-a para `origin_address` de forma idempotente;
- 22 testes focados passaram; o runner continua read-only e desconectado desse
  repository ate observacoes/candles terem o mesmo boundary transacional.

10C observacoes exatas e market commit:

- `robinhood_market_observations` preserva por 3 dias os `uint256` brutos,
  decimais ERC-20, supply e metricas derivadas em `NUMERIC` sem typemod que
  arredonde precos EVM;
- a tabela referencia o ledger de logs com `ON DELETE CASCADE`, permitindo que
  o cleanup da retencao remova ambos na ordem correta;
- market logs e observacoes usam inserts em lote por `jsonb_to_recordset`, sem
  executar duas queries por swap e sem armazenar o JSON RPC bruto;
- dedupe, observacoes e cursor sao confirmados na mesma transacao; falha do
  batch de observacoes executa rollback antes do cursor;
- todo swap decodificado com direcao valida preserva raw amounts mesmo quando
  metadata/cotacao falha; status `pending` permite enriquecimento posterior sem
  perder o evento on-chain;
- resultados enriquecidos sao conferidos contra identidade, mercado, token,
  quote e raw amounts do swap antes da escrita, evitando pareamento incorreto
  sob concorrencia;
- 37 testes focados passaram; o runner continua desconectado.

10D candles persistentes de 1 minuto:

- `robinhood_market_buckets_1m` guarda OHLC de preco/FDV, volume USD,
  swaps, buys, sells e transacoes por protocolo/mercado/minuto por 14 dias,
  igual ao contrato de retencao detalhada da Solana;
- apenas observacoes `accepted` entram no candle; swaps `pending/rejected`
  permanecem na tabela exata sem gerar metricas incompletas;
- observacao, candle, ledger de dedupe e cursor compartilham a mesma transacao,
  portanto uma falha no upsert do candle reverte o range inteiro;
- replay nao soma volume novamente porque somente observacoes realmente
  inseridas pelo ledger alimentam a agregacao;
- open/close usam ordem EVM deterministica por `(block_number,log_index)`, nao
  apenas timestamp; high/low e contadores sao mesclados entre batches;
- o banco bloqueia conflito de token/quote para o mesmo market bucket e o
  repository converte isso em rollback antes do cursor;
- `transactions` e exato sob o contrato atual de batches fechados em limites
  de bloco: uma transacao EVM nunca e dividida entre dois commits;
- a Stage 65 foi aplicada no banco local, o runtime schema check e 30 testes
  focados passaram; o SQL completo tambem foi executado com ledger, observacao,
  candle e cursor dentro de uma transacao forcada a rollback, confirmando zero
  rows ficticias persistidas;
- cleanup e conexao do runner continuam para os proximos sub-blocos.

10E.1 rollup horario permanente:

- `robinhood_market_buckets_1h` preserva permanentemente OHLC de preco/FDV,
  volume, swaps, buys, sells, transacoes e quantidade de minutos-fonte;
- cada hora tocada e reconstruida a partir dos candles de 1 minuto na mesma
  transacao do ledger, observacao e cursor; nao existe soma cega de deltas;
- retries e replays sao idempotentes, e falha ou conflito de dimensoes no
  rollup executa rollback antes do cursor;
- buckets usam fronteiras UTC explicitas, sem depender do timezone da sessao
  PostgreSQL;
- o rollup em escrita elimina uma varredura recorrente de 14 dias e garante que
  o candle horario exista antes do futuro cleanup apagar sua fonte de 1 minuto;
- a Stage 66 foi aplicada no banco local, 33 testes focados e runtime schema
  check passaram; uma transacao PostgreSQL real confirmou o fluxo completo e
  zero rows ficticias depois do rollback;
- a tabela horaria nao possui `expires_at`: seu crescimento e permanente e
  devera ser acompanhado operacionalmente;
- o runner continua desconectado.

10E.2 cleanup em lotes:

- `robinhood-retention-worker` roda somente no grupo `maintenance`, e pode ser
  desligado por `ROBINHOOD_RETENTION_ENABLED=false`;
- o default executa ate 5 lotes de 2.000 rows a cada 60 segundos, com
  `statement_timeout` de 10 segundos e `SKIP LOCKED` para limitar contencao;
- logs processados expirados sao removidos depois de 3 dias; a FK da Stage 64
  remove as observacoes correspondentes por cascade;
- candles de 1 minuto recebem `expires_at` de 14 dias e so sao apagados se o
  candle horario correspondente existir, cobrir seus blocos e estiver tao
  atualizado quanto a fonte;
- candles horarios nunca entram no `DELETE` do worker;
- candles de 1 minuto expirados sem rollup confirmado sao preservados e
  expostos como `protectedMinuteBuckets`, evitando perda silenciosa;
- status e contadores do worker ficam disponiveis no status administrativo;
- 43 testes afetados passaram e um lote real no PostgreSQL local retornou zero
  rows, como esperado antes da ativacao do writer;
- nenhum schema novo foi necessario alem das Stages 63-66.

10F.1 isolamento hibrido de processos:

- ingestao Robinhood pertence ao grupo reservado `robinhood`; cleanup continua
  no grupo compartilhado `maintenance`;
- `BACKGROUND_WORKER_GROUPS=all` continua significando apenas os grupos
  compartilhados `core,market,maintenance`, portanto nao inicia Robinhood por
  acidente no runtime combinado/legado;
- `BACKGROUND_WORKER_GROUPS=robinhood` e aceito sozinho; combinar Robinhood com
  `market`, qualquer outro grupo ou `all` falha no carregamento da config;
- o isolamento adiciona overhead de um processo Node e pool DB apenas quando o
  processo dedicado for ativado; a carga RPC/decoding existiria de qualquer
  forma e deixa de competir diretamente com os workers Solana;
- neste sub-bloco ainda nao havia script `start:worker:robinhood` ou branch de
  startup: expor o comando antes dos boundaries persistentes criaria uma falsa
  aparencia de cobertura;
- 140 testes de config, retencao, auth e admin passaram; o runner permanece
  read-only e nenhuma chamada RPC nova foi iniciada.

10F.2 boundaries transacionais e restart:

- todo range discovery/market, inclusive vazio, chama o commit antes do cursor
  em memoria avancar; falha no banco repete exatamente o mesmo range;
- o pipeline entrega ao repository o log enriquecido, evento decodificado e a
  observacao aceita, pendente ou rejeitada, sem depender do agregador em memoria;
- discovery e market retomam seus cursores de banco independentemente e o
  registro de pools ativos restaura os trackers v2/v3/v4 no restart;
- checkpoints persistidos sao validados contra a chain; divergencia/reorg para
  o writer persistente para em modo fail-closed, sem rollback parcial;
- quando algum dos cursores ainda nao existe, o bootstrap persistente exige
  `ROBINHOOD_START_BLOCK`, evitando alegar cobertura total com lookback curto;
- o modo read-only preserva rewind/replay em memoria e a API legada dos batches.

10F.3 worker dedicado:

- `robinhood-ingestion-worker` usa RPC publico como provider primario, Alchemy
  apenas como fallback opcional, repository persistente e runner continuo;
- erros transitorios usam backoff; `persistent_reorg` e bootstrap sem boundary
  param o loop e ficam visiveis no status administrativo;
- `start:worker:robinhood`/`dev:worker:robinhood` usam porta 3004, grupo isolado,
  lease `robinhood-ingestion-worker` e ativacao explicita;
- `ROBINHOOD_INGESTION_ENABLED` permanece `false` na configuracao padrao, e
  `BACKGROUND_WORKER_GROUPS=all` continua sem iniciar Robinhood;
- cleanup generico de sessoes fica somente no grupo `core`; retencao Robinhood
  continua no grupo `maintenance`, mantendo o desenho hibrido aceito;
- nenhum RPC live nem writer foi ativado durante a implementacao; a primeira
  execucao continua sendo uma decisao operacional do rollout.

10F.3a validacao de chain e propagacao fatal/lease:

- antes de construir o repository, o worker consulta `eth_chainId` diretamente
  em cada provider configurado e exige `4663`; fallback nao pode esconder um
  endpoint Alchemy ou publico apontado para outra chain;
- `configuration_error`, `bootstrap_start_required` e `persistent_reorg` param
  o loop e persistem `state=halted` no metadata da lease antes de cancelar o
  heartbeat;
- se a escrita fatal falhar transitoriamente, a lease permanece renovada em
  `halt-pending` e repete o tombstone, evitando takeover durante a falha;
- a lease fatal vira tombstone expirado que nao pode ser retomado
  automaticamente, inclusive depois do TTL;
- `GET /api/admin/ws-status` combina o status local do worker com `sharedLease`,
  permitindo que o processo web enxergue o fatal persistido pelo processo
  Robinhood;
- a recuperacao exige diagnostico, remocao explicita do tombstone e restart do
  processo dedicado; o runbook documenta essa operacao fail-closed.

10F.3b particionamento de enderecos:

- filtros `eth_getLogs` com muitos mercados sao divididos em lotes configurados
  por `ROBINHOOD_MAX_ADDRESSES_PER_LOG_REQUEST`, com default 100;
- todos os shards usam o mesmo `fromBlock/toBlock`, e o range so chega ao
  consumer/repository depois que todos respondem;
- falha de qualquer shard mantem o cursor no inicio do range; erros adaptativos
  ainda reduzem a largura em blocos sem transformar shards em cursores separados;
- enderecos repetidos sao removidos antes da divisao e logs combinados passam
  pela deduplicacao normal do poller;
- metricas distinguem ranges logicos, requests de logs e ranges particionados.

10F.3c descoberta NOXA persistente:

- Factory e topic NOXA entraram no stream discovery, sem criar stream/cursor
  paralelo;
- cada `TokenLaunched` consulta `getLaunchedToken`, `getPool` e bytecode do
  token/pool no bloco historico do evento, nunca em `latest`;
- erros RPC de estado historico podem seguir explicitamente para o provider de
  fallback sem transformar todos os erros JSON-RPC em retry generico;
- o pipeline semeia primeiro todos os eventos Uniswap do range e depois valida
  NOXA, portanto nao depende da ordem em que o RPC devolve os logs;
- launch aceito continua com `isNewMarket=false` e a mesma identidade
  `robinhood:uniswap-v3:<pool>`; NOXA nao cria um segundo mercado;
- metadata de deployer, config, position, initial buy, restriction L1 e supply
  e anexada ao pool v3 na mesma transacao do ledger e cursor;
- se o pool v3 ativo nao existir, a transacao faz rollback e o cursor nao
  avanca; launches rejeitados entram apenas no ledger compacto e nas metricas;
- o status compacto do worker expoe contadores NOXA `seen/accepted/rejected`.

### Bloco 11 - Catalogo, gates e sinais

Status: concluido em 2026-07-14, sem integracao com catalogo, matcher ou
entrega.

Objetivo:

- promover observacoes validadas para o comportamento do produto.

Entregas:

- elegibilidade Robinhood separada de regras Solana;
- gates iniciais configuraveis de liquidez/volume/txns/idade;
- admin blocklist chain-aware;
- sinais sem publicacao real inicialmente;
- comparacao dry-run vs sinal esperado;
- nenhum GMGN/Meteora/PumpFun/Helius em Robinhood.

Implementado no sub-bloco 11A:

- avaliador Robinhood isolado das regras Solana e sempre `dry-run`;
- configuracao explicita de janela, liquidez, volume, transacoes e idade, sem
  thresholds default inventados;
- decisao fail-closed quando um gate ou sua configuracao estiver ausente;
- consulta da blocklist administrativa com identidade `robinhood:<address>`;
- denylist oficial/canonica e quote WETH/USDG aplicadas antes dos gates;
- resultado `expectedSignal` comparavel, mas `publishable=false` invariavel.

Limites do sub-bloco 11A:

- o avaliador isolado recebe candidatos prontos; a leitura/aggregacao foi
  adicionada separadamente no 11B;
- os buckets persistidos nao guardam `liquidityUsd` para nenhuma versao e
  v3/v4 tambem nao possuem calculo USD confiavel sem distribuicao por ticks;
- catalogo, matcher e entrega permanecem desligados.

Implementado no sub-bloco 11B:

- leitura SQL read-only por `market_key`, limitada a pools ativos e dimensoes
  token/quote coincidentes com o registry;
- janela obrigatoriamente multipla de um minuto, com apenas buckets fechados e
  limite maximo igual a retencao de 14 dias;
- blocklist administrativa consultada no mesmo `SELECT` com
  `chain='robinhood'`, sem executar `ensureTable`/DDL;
- agregacao de volume, swaps, buys, sells e transacoes por mercado;
- relatorio por protocolo, motivo, status de liquidez e decisao esperada;
- comando manual `npm run robinhood:signal-dry-run`, com
  `publishable=false` e `publicationAttempts=0` invariantes.

Limites do sub-bloco 11B resolvidos pelo 11C:

- `liquidityUsd` passou a ser persistida para V2, em vez de o leitor reportar
  invariavelmente `liquidityStatus=not_persisted`;
- thresholds continuam sem defaults e o comando nao consulta candidatos
  enquanto estiver desabilitado ou incompleto;
- nao existe agendamento recorrente, escrita no catalogo, matcher ou entrega.

Implementado no sub-bloco 11C:

- a Stage 67 adiciona a observacao exata de liquidez sem alterar dados antigos;
- V2 usa duas vezes a reserva de quote ao preco spot, com confianca `medium` e
  aviso explicito de manipulabilidade;
- V3/V4 preservam apenas `liquidityRaw` e o status
  `requires_tick_liquidity_distribution`, sem inventar valor USD;
- a Stage 68 propaga o snapshot da ultima observacao aos buckets de 1 minuto e
  1 hora; buckets antigos nulos continuam fail-closed;
- o reader escolhe o snapshot do ultimo bloco/log da janela fechada e entrega
  o valor ao gate dry-run;
- as Stages 67/68 e o SQL transacional completo foram validados no PostgreSQL
  local, com rollback da observacao de prova.

Limites finais do Bloco 11:

- apenas V2 pode ultrapassar o gate de liquidez; V3/V4 permanecem fail-closed
  ate existir leitura confiavel da distribuicao de ticks/posicoes;
- a estimativa V2 e evidência spot manipulavel, nao TVL auditada;
- a calibracao inicial serve para dry-run e nao autoriza promover catalogo,
  matcher ou entrega sem soak longitudinal e decisao operacional separada.

Implementado no sub-bloco 11D.1:

- comando `npm run robinhood:discovery-bootstrap` processa somente eventos de
  criacao de pools V2/V3/V4;
- o primeiro lote exige `ROBINHOOD_DISCOVERY_BOOTSTRAP_START_BLOCK` explicito;
- lotes posteriores ignoram o valor inicial e retomam do cursor `discovery`;
- cada range, inclusive vazio, grava pools/ledger/cursor na mesma transacao;
- ranges rejeitados pelo provider encolhem sem pular blocos;
- cada execucao e limitada por `ROBINHOOD_DISCOVERY_BOOTSTRAP_MAX_RANGES` e
  informa blocos restantes, trafego RPC e pools rastreados;
- o bootstrap mantem `marketWriterEnabled=false` e `publishable=false`.

Estado operacional do 11D.1:

- bootstrap historico concluido em 2026-07-13 com `status=caught-up`, cursor
  discovery em `next_block=8961698` e target processado `8961697`;
- registry ativo acumulado: 2.988 mercados V2, 77.433 V3 e 38.099 V4;
- a execucao final teve zero erros/429 e validou RPC publico e Alchemy na chain
  ID 4663;
- o cursor `market` ainda nao existe e observacoes/buckets continuam vazios;
- depois do discovery completo, o market writer deve iniciar com uma fronteira
  recente separada (`8961698`), sem alegar cobertura historica de swaps.
- launches NOXA historicos nao sao revalidados pelo bootstrap: seus pools ja
  entram pelo `PoolCreated` V3, enquanto metadata NOXA continua complementar;
  launches novos voltam a ser validados pelo runner continuo depois do corte.

Otimizacao operacional hibrida do bootstrap:

- quando `ROBINHOOD_DISCOVERY_BOOTSTRAP_USE_ALCHEMY=true`, os dois providers
  continuam sendo validados explicitamente como chain ID 4663;
- `eth_getLogs` permanece fixado no RPC publico, que aceita os ranges historicos
  grandes usados pelo bootstrap;
- `eth_blockNumber` e `eth_getBlockByNumber` sao enviados diretamente ao
  Alchemy, removendo do RPC publico a rajada de leituras de timestamp por bloco;
- as chamadas Alchemy sao globalmente espacadas por
  `ROBINHOOD_DISCOVERY_BOOTSTRAP_ALCHEMY_MIN_INTERVAL_MS` (default 50 ms),
  mantendo `eth_getBlockByNumber` perto de 400 CU/s e abaixo do throughput base
  de 500 CU/s do plano Free;
- o roteamento nao usa fallback silencioso entre metodos: uma falha de
  `eth_getLogs` continua fail-closed e nunca avanca o cursor;
- essa separacao permite usar Alchemy Free para as leituras individuais sem
  violar seu limite de 10 blocos por chamada `eth_getLogs`;
- worker continuo, market writer e publicacao nao foram alterados.

Implementado no sub-bloco 11D.2:

- o writer persistente aceita `ROBINHOOD_MARKET_LOG_FILTER_MODE=topics-only`,
  evitando expandir o registry em centenas de shards `eth_getLogs` por range;
- medicao live em 10 blocos recentes retornou 53 logs em uma unica request de
  128 ms, sem erro ou 429; o filtro por enderecos exigiria aproximadamente 805
  requests por range somente para os enderecos V2/V3 atuais;
- logs que casam pelo topic mas pertencem a mercados ausentes do registry sao
  ignorados antes do ledger/persistencia;
- `tracked-addresses` permanece disponivel como modo explicito de rollback;
- o modo altera apenas transporte/coleta; market writer, catalogo, matcher e
  publicacao continuam desligados ate o soak controlado.
- o soak encontrou swaps positivos abaixo de `1e-30` que eram arredondados para
  string `"0"` e faziam a persistencia repetir indefinidamente o mesmo range;
- precos Robinhood agora preservam ate 80 casas, coerente com o schema `NUMERIC`
  sem precisao limitada, e valores ainda menores viram rejeicao explicita
  `price_below_persisted_precision` em vez de interromper o cursor;
- a regressao foi protegida na camada unitaria de aritmetica/pipeline, sem
  alterar publicacao ou regras de sinal.
- o soak posterior mostrou que o cursor market processava cerca de 107
  blocos/minuto enquanto a chain avancava perto de 333, fazendo o lag crescer;
- no modo `topics-only`, emitters ausentes do registry agora sao descartados
  antes de qualquer leitura de timestamp ou metadata;
- timestamps de ate 10 blocos passam por um unico batch JSON-RPC, com respostas
  reordenadas por ID, retry/fallback atomico por provider e fallback para
  requests individuais quando o endpoint nao suporta batch;
- qualquer item ausente/invalido/falho rejeita o batch inteiro, preservando a
  regra de que o cursor nunca avanca sobre enriquecimento parcial;
- o status compacto do worker expoe as metricas de batching/fallback do
  enriquecimento para validar throughput sem consultas agregadas no banco.
- um soak persistente de cerca de 3h32 encerrou por heap OOM porque o pipeline
  mantinha todas as observacoes aceitas para rollback e recalculava janelas
  analiticas de ate 24h a cada ciclo, embora reorg persistente ja seja fatal;
- o writer persistente e o bootstrap agora desativam esses mapas de rollback e
  o agregador de janelas, sem alterar entradas persistidas, commits de cursor,
  filtro antecipado de emitters ou batching de timestamps;
- o runner read-only preserva janelas e rollback, mas limita cada mapa a 10.000
  entradas, alinhado ao teto de logs vistos do poller;
- o registry inicial seleciona somente as colunas usadas para reconstruir os
  trackers, e contagens de pools deixaram de criar arrays completos por ciclo;
- `lastSnapshot.inMemoryState` permite confirmar no admin que observacoes,
  discoveries e eventos de janela permanecem zerados no writer persistente.

Implementado no sub-bloco 11E:

- a amostra live cobriu 19h41 de buckets, de `2026-07-13T20:39:00Z` a
  `2026-07-14T16:20:00Z`, com 45.347 buckets e 694 mercados V2 observados;
- nas janelas fechadas de cinco minutos, a amostra de calibracao encontrou
  entre 89 e 98 mercados V2 ativos conforme o minuto de corte;
- os gates aprovados para o dry-run inicial sao janela de 5 minutos, liquidez
  minima de USD 3.000, volume minimo de USD 1.000, 10 transacoes e idade maxima
  de 24 horas;
- o corte de liquidez em USD 3.000 deixou 22 mercados adicionais passarem pelo
  gate de liquidez quando comparado a USD 10.000, embora os outros gates tenham
  mantido 10 sinais esperados no retrato comparativo;
- `ROBINHOOD_SIGNAL_PROTOCOLS=uniswap-v2` torna o rollout V2-only explicito e
  fail-closed; V3/V4 nao passam automaticamente quando ganharem nova metrica;
- o reader filtra os protocolos autorizados no SQL, impedindo que milhares de
  candidatos V3/V4 consumam o limite antes dos mercados V2;
- o limite de candidatos foi elevado a 5.000, acima dos 2.823 candidatos
  totais vistos no retrato de cinco minutos anterior ao filtro V2-only;
- o aceite operacional de `2026-07-14T16:34:21Z` leu 79 mercados V2 e 77
  tokens unicos, produziu 8 sinais esperados, nao truncou candidatos e
  confirmou `publishable=false`/`publicationAttempts=0`;
- V3/V4 continuam ingeridos e persistidos; apenas a elegibilidade para sinal
  fica bloqueada ate haver calculo USD por ticks/posicoes e autorizacao
  explicita de rollout;
- o comando permanece manual, read-only, `publishable=false` e com
  `publicationAttempts=0`.

### Bloco 12 - Frontend e alertas

Status: concluido em 2026-07-14. A fundacao preparatoria ate o 12C.2e, o
seletor SOL-only do 12C.3, o aceite visual e o smoke/E2E isolado estao
aprovados. A ativacao real de Robinhood pertence ao rollout do Bloco 13 e nao
reabre o Bloco 12.

Objetivo:

- expor Robinhood sem misturar identidades ou links de explorador.

Exclusao explicita de escopo:

- ignorar completamente mock trading durante os Blocos 12 e 13 e em qualquer
  trabalho Robinhood relacionado;
- nao migrar `mockTradingPositionsByAddress`, `mockTradingTradesByAddress`,
  wallets, ordens, quick buy, historico, PnL, APIs ou componentes de mock
  trading para `<chain>:<address>`;
- mock trading continua Solana-only e nao deve reagir ao filtro multi-chain do
  header;
- esta exclusao so pode ser revista mediante um pedido futuro explicito do
  usuario. Nao gastar implementacao, testes ou tokens tentando preparar mock
  trading para Robinhood.

Entregas:

- badge/filtro de chain;
- endereco e explorer corretos;
- cards toleram metadata ausente;
- alertas carregam chain;
- links de compra/terminal definidos separadamente;
- build obrigatorio: `npm --prefix frontend run build`.

Smoke test e obrigatorio se o fluxo visivel central for alterado.

Estado do sub-bloco 12A.1:

- payloads de tokens monitorados agora carregam `chain` desde o select do
  catalogo ate o contrato TypeScript;
- eventos de alerta carregam `chain`, inclusive snapshots persistidos e sinais
  GMGN explicitamente Solana;
- alertas no frontend exigem chain e sua deduplicacao usa
  `<chain>:<kind>:<address>`;
- a primitive frontend `token-chain.ts` centraliza chain canonica, identidade,
  explorer e URL de mercado;
- explorer Robinhood usa o Blockscout oficial da mainnet; explorer Solana usa
  Solscan;
- terminais configurados atuais permanecem Solana-only e falham fechados para
  qualquer outra chain.

Pendencias registradas depois do 12A.1, resolvidas pelos sub-blocos 12C:

- migrar stores/listas do frontend ainda indexados somente por address antes de
  misturar chains no mesmo feed, excluindo integralmente os stores de mock
  trading: o store compartilhado, o feed e as listas Recent/Old Week usam
  identidade chain-aware; dominios que continuam Solana-only possuem guards;
- adicionar o filtro visivel sem apresentar uma opcao vazia como suporte ativo:
  o seletor usa exclusivamente `availableChains` e, por isso, exibe somente SOL
  enquanto Robinhood permanecer `publishable=false`.

Estado do sub-bloco 12B.1:

- cards monitorados e alertas exibem a identidade no formato visual
  `OG / <simbolo da chain>` quando existe peer OG, ou somente o simbolo da
  chain quando nao existe;
- o badge da blockchain e semanticamente separado do badge OG e aponta para o
  explorer correto da identidade;
- links primarios usam o mercado quando ha par conhecido e fazem fallback para
  o explorer; terminais continuam restritos as chains suportadas;
- cards e alertas toleram symbol/name ausentes sem inventar metadata;
- a consulta de peers OG agora e isolada por chain e aceita identidade EVM da
  Robinhood, impedindo que tickers iguais em chains diferentes sejam tratados
  como o mesmo grupo;
- validacao frontend foi feita com build e inspecao visual local; o comando
  `test:smoke` do repositorio ainda precisa de configuracao Playwright propria,
  pois hoje coleta suites Node que nao sao smoke/E2E.

Especificacao confirmada para o filtro multi-chain do 12C:

- no desktop, o seletor deve ficar dentro de `.workspace-topbar-inner`, no
  espaco horizontal entre `.workspace-brand` (logo/nome TrendScope) e
  `.workspace-route-group` (controle `ALERTS / RADAR` e reset de layout);
- o seletor nao faz parte do controle `ALERTS / RADAR`: e um grupo proprio no
  header, visualmente centralizado no espaco livre indicado no mockup de
  2026-07-13;
- cada chain deve ser representada pelo seu simbolo, usando a mesma identidade
  visual dos badges dos cards, com nome completo em tooltip/aria-label;
- a selecao e multipla: o usuario pode manter uma chain ou combinar duas ou
  mais chains ao mesmo tempo; o estado sem nenhuma chain selecionada nao faz
  parte do comportamento pedido;
- abaixo de 980 px, o grupo usa a decisao confirmada no 12C.2b: largura total e
  scroll horizontal dos simbolos das chains;
- o alcance foi definido no 12C.2b: `enabledChains` e o filtro mestre;
  `radarChains`, `alertFeedChains` e `browserNotificationChains` sao selecoes
  independentes e persistidas;
- mock trading nao faz parte do alcance do filtro em nenhuma hipotese deste
  plano.

Ordem obrigatoria antes de habilitar o filtro:

1. migrar os stores, mapas, deduplicacao e acoes multi-chain ainda indexados
   somente por `address` para identidade `<chain>:<address>`, ignorando todos
   os stores e fluxos de mock trading;
2. definir um contrato confiavel de chains publicaveis/disponiveis, sem
   anunciar Ethereum, BSC, Base ou Robinhood apenas porque seus badges existem;
3. garantir que consultas, contagens e paginacao usem a mesma selecao de chain;
4. implementar e validar o seletor multi-chain no local confirmado do header.

Estado do sub-bloco 12C.1a:

- a primitive frontend de identidade agora valida enderecos Solana/EVM,
  normaliza casing EVM e constroi/parseia chaves `<chain>:<address>`;
- aliases legados aceitos sao somente `sol` e `eth`, alinhados ao contrato do
  backend;
- payload legado sem `chain` possui helper explicito com fallback Solana;
  chain desconhecida presente nunca cai silenciosamente em Solana;
- nenhum store central foi migrado neste sub-bloco; a primitive e seus testes
  sao a fundacao para migrar os consumidores em lotes pequenos.

Estado do sub-bloco 12C.1b:

- o store compartilhado principal foi migrado de
  `trackedTokensByAddress[address]` para
  `trackedTokensByIdentity[<chain>:<address>]`;
- leituras e escritas passam pelo contrato de identidade; enderecos EVM sao
  normalizados e o fallback Solana continua restrito aos consumidores legados
  que ainda sao explicitamente Solana-only;
- rebuild, deduplicacao e restauracao do store preservam identidades
  non-Solana, mas os payloads atuais de monitored/history/pinned continuam
  filtrados para Solana porque suas listas e APIs ainda usam somente address;
- a limpeza baseada nas listas address-only remove apenas entradas Solana; ela
  nao pode apagar silenciosamente uma futura entrada Robinhood;
- o cache Meteora recebe somente os enderecos extraidos de entradas Solana e
  nunca recebe a chave composta ou uma identidade Robinhood;
- chart alert history, expanded charts, sparklines, starred/pinned/manual e
  demais listas address-only ainda nao foram declarados multi-chain. Cada
  dominio deve ser migrado ou protegido como Solana-only em lote posterior;
- mock trading nao foi migrado nem generalizado: seus stores, rotas, ordens,
  quick buy, historico e componentes permanecem fora do alcance;
- validacao: lint sem erros ou warnings novos, build frontend aprovado e 8
  testes unitarios de identidade aprovados.

Estado do sub-bloco 12C.1c:

- chart alert history, markers e expanded sparklines continuam explicitamente
  Solana-only porque suas rotas, caches e navegacao ainda recebem somente
  `address`;
- eventos realtime Robinhood sao rejeitados antes de entrar no cache
  address-only de chart alerts; payload legado sem `chain` continua assumindo
  Solana apenas nesse contrato legado;
- cards de alerta Robinhood nao exibem Chart, Star, Block ou Admin Block,
  porque essas acoes ainda enviam apenas address e poderiam atingir estado
  Solana ambiguamente;
- Copy, Market/Explorer, links sociais e resolucao do admin review por
  `reviewAlertId` continuam disponiveis para Robinhood; o menu de terminal ja
  permanece vazio fora de Solana;
- a ordem visual das acoes Solana existentes foi preservada;
- mock trading nao foi tocado e permanece explicitamente fora do escopo;
- validacao: lint sem erros ou warnings novos (27 warnings preexistentes),
  build frontend aprovado e 15 testes direcionados de chart/identity aprovados;
  `npm run test:smoke` permanece bloqueado pela configuracao existente, que
  coleta suites Node como Playwright e termina com `No tests found`.

Estado do sub-bloco 12C.2a:

- `/api/config` e a resposta do full sync agora expoem `availableChains`, que
  e a unica fonte permitida para o futuro seletor do header;
- o contrato anuncia somente `solana` neste momento: existencia de badge,
  ingestion ativa ou dados persistidos nao torna uma chain publicavel;
- Robinhood so pode entrar nessa lista depois que o gate de publicacao deixar
  de ser invariavelmente `publishable=false` e o rollout do Bloco 13 autorizar
  alertas reais;
- o frontend normaliza aliases/chains desconhecidas, remove duplicatas e
  garante fallback Solana para payload legado ou lista vazia;
- o estado apenas armazena a disponibilidade; o seletor visual e a selecao do
  usuario ainda nao foram implementados;
- mock trading permanece fora do alcance e nao participa desse contrato;
- validacao: 18 testes de integracao da rota config e 5 testes unitarios da
  primitive frontend aprovados, build frontend aprovado e lint sem erros ou
  warnings novos (27 warnings preexistentes).

Estado do sub-bloco 12C.2b:

- o modelo confirmado foi persistido atomicamente em `uiPrefs.chainFilters`,
  com `enabledChains` como filtro mestre e selecoes independentes para
  `radarChains`, `alertFeedChains` e `browserNotificationChains`;
- nenhuma lista pode ficar vazia, cada selecao especifica deve ser subconjunto
  do filtro mestre e somente chains presentes em `availableChains` sao aceitas;
- payload legado ou preferencia ausente recebe Solana em todas as listas;
  disponibilizar uma nova chain no futuro nao inscreve automaticamente contas
  antigas nela;
- as preferencias usam o `prefs_json` existente, portanto nao houve mudanca de
  schema; o frontend ja normaliza e armazena o contrato, mas consultas, feed,
  notificacoes e header ainda nao o aplicam neste sub-bloco;
- o comportamento mobile confirmado para a futura UI e scroll horizontal dos
  simbolos das chains;
- workers/ingestion continuam globais e nao sao ligados/desligados por usuario;
- mock trading nao foi tocado e nao participa dos filtros;
- validacao: 21 testes unitarios das invariantes/normalizacao e 18 testes de
  integracao da rota config aprovados, build frontend aprovado e lint sem
  erros; o refactor removeu os 2 warnings de complexidade de
  `user-ui-pref.js`, reduzindo o baseline total de 27 para 25 warnings.

Estado do sub-bloco 12C.2c:

- feed, busca, contagem e paginacao de alertas agora usam a intersecao entre
  `enabledChains` e `alertFeedChains`;
- admin review cards tambem respeitam o filtro do feed pela chain do review;
- audio de alertas segue `alertFeedChains`, enquanto notificacoes nativas do
  navegador seguem a selecao independente `browserNotificationChains`;
- eventos filtrados continuam em `state.data.alerts`; reativar uma chain pode
  faze-los reaparecer no feed sem novo fetch, mas audio/notificacao os marcam
  como tratados para nao disparar backlog antigo;
- a primitive de selecao e pura, exige o filtro mestre e nao muta a colecao de
  origem;
- o Radar ainda nao aplica `radarChains`: suas linhas atuais incorporam acoes,
  posicoes e PnL de mock trading, portanto esconder a linha faria mock trading
  reagir indiretamente ao filtro, em conflito com a exclusao explicita;
- com `availableChains=['solana']`, esse sub-bloco nao altera a saida visual
  atual; ele prepara o comportamento para uma segunda chain publicavel;
- validacao: 12 testes unitarios direcionados aprovados, build frontend
  aprovado e lint sem erros ou warnings novos (baseline 25). O smoke nao foi
  repetido porque nao existe segunda chain selecionavel e a infraestrutura
  Playwright continua bloqueada conforme registrado no 12B.1/12C.1c.

Estado do sub-bloco 12C.2d:

- o painel Bid Zone foi ocultado integralmente do workspace Radar para todos os
  usuarios, conforme decisao de produto;
- o slot e removido da prioridade de render, mas componente, controller,
  modelos, worker e persistencia foram preservados para uma remocao futura
  separada e auditavel;
- o alcance visual do futuro `radarChains` fica restrito a Recent e Old Week;
- nenhuma logica ou estado de mock trading foi alterado.
- validacao: build frontend aprovado e lint completo aprovado com 0 erros e os
  mesmos 25 warnings preexistentes;
- o smoke foi executado, mas continua bloqueado pela infraestrutura Playwright
  que coleta suites Node e termina com `No tests found`, conforme ja registrado
  nos sub-blocos anteriores.

Estado do sub-bloco 12C.2e:

- `radarChains` agora limita Recent e Old Week tanto no cache renderizado quanto
  no request paginado de `history-bootstrap`;
- busca, contagem, ordenacao e paginacao usam a mesma lista de chains no backend,
  evitando pagina vazia ou total calculado fora do filtro selecionado;
- a rota aceita somente chains presentes no contrato central
  `availableChains`; um request manual com `robinhood` recebe erro enquanto a
  chain nao for publicavel;
- identidades, listas fixadas, dismiss e metadata complementar do bootstrap
  usam `<chain>:<address>` e sao recortados para as chains solicitadas;
- cards non-Solana de Recent/Old Week mantem somente acoes chain-safe: dismiss,
  copy, explorer/mercado e links sociais. Star, manual quick-add, Admin Block,
  sparkline e mock trading continuam Solana-only;
- mock trading nao participa do filtro: seus stores e efeitos permanecem
  indexados por address e nenhum filtro de chain os liga ou desliga;
- validacao em 2026-07-14: 30 testes direcionados de identidade e dashboard
  passaram, o build frontend passou e o lint completo terminou com 0 erros e os
  mesmos 25 warnings preexistentes.

Estado do sub-bloco 12C.3:

- o seletor multi-chain esta montado dentro de `.workspace-topbar-inner`, entre
  `.workspace-brand` e `.workspace-route-group`, sem fazer parte do controle
  `ALERTS / RADAR`;
- cada opcao usa o simbolo visual da chain e nome completo em tooltip/
  `aria-label`; a selecao e multipla e nunca pode ficar vazia;
- o seletor renderiza exclusivamente `availableChains`. Como o contrato atual
  anuncia apenas `solana`, a interface mostra somente SOL e desabilita sua
  remocao por ser a ultima chain selecionada;
- o clique no filtro mestre reconcilia as selecoes por superficie, persiste
  `uiPrefs.chainFilters`, zera as paginacoes afetadas e atualiza feed e Radar;
- as selecoes especificas de Radar, feed e notificacoes tambem podem ser
  ajustadas nas configuracoes do bot sem alterar workers ou mock trading;
- o CSS desktop posiciona e estiliza o grupo no espaco confirmado do header;
  abaixo de 980 px, o grupo ocupa a largura disponivel e permite scroll
  horizontal. O aceite visual desse posicionamento foi confirmado pelo usuario
  em 2026-07-14;
- `playwright.config.js` agora limita a coleta a `tests/smoke/**/*.spec.js`,
  sobe somente o Vite em porta isolada e nao inicia backend, socket worker ou
  processo Robinhood;
- o smoke intercepta os contratos minimos da API, bloqueia o WebSocket e valida
  no Chromium a ordem brand/seletor/rotas/userbar, o contrato SOL-only, o
  dropdown de chains no Bot Settings e o layout abaixo de 980 px;
- validacao final em 2026-07-14: `npm run test:smoke` passou 2/2 cenarios,
  28 testes direcionados de config/identidade passaram, o build frontend passou
  e o lint terminou com 0 erros e os mesmos 25 warnings preexistentes.

Fechamento do Bloco 12:

1. aceite visual do seletor confirmado;
2. coleta Playwright isolada de suites Node;
3. smoke real do fluxo visivel aprovado em desktop e viewport abaixo de 980 px.

Gates transferidos ao Bloco 13, sem reabrir o Bloco 12:

1. manter `availableChains=['solana']` enquanto a publicacao Robinhood for
   invariavelmente `publishable=false` e ate o Bloco 13 autorizar o rollout;
2. quando Robinhood for publicavel, validar com payload real a combinacao
   SOL-only, Robinhood-only e SOL+Robinhood em feed, notificacoes, Recent e Old
   Week, incluindo busca, contagem, paginacao, restart e restauracao de prefs;
3. somente depois desse gate, adicionar `robinhood` ao contrato de
   disponibilidade. A existencia de ingestion, registry, badge ou dados no
   banco nao autoriza essa mudanca isoladamente.

### Bloco 13 - Rollout operacional

Status: em andamento. Os sub-blocos 13A e 13D foram concluidos estruturalmente
em 2026-07-14; o 13B tambem teve sua telemetria validada live. O conjunto agora
possui control plane fail-closed, runbook de desligamento e kill switches de
transporte/persistencia na orquestracao. O 13C foi concluido com duas amostras
V2-only fail-closed e ambos os cursores em lag zero. O 13E executou o primeiro
drill controlado de restart com as flags explicitas e comprovou troca de owner,
retomada do heartbeat e recuperacao a partir dos cursores persistidos. O
primeiro recorte do 13F criou o contrato fail-closed de staging no catalogo,
e os recortes seguintes fecharam matcher, delivery, runtime, feed, E2E e
disponibilidade condicionada ao kill switch. Nenhum alerta Robinhood live foi
habilitado; `ROBINHOOD_ALERTS_ENABLED=false` continua mantendo somente SOL
visivel e toda publicacao bloqueada.

Objetivo:

- ativar com possibilidade de desligamento imediato.

Entregas:

- feature flags por transporte, protocolo, persistencia e alertas;
- worker lease propria;
- status admin com head/cursor/lag/provider/429/reconnect;
- limites de memoria/fila;
- runbook de desligamento;
- dry-run em producao antes de qualquer alerta real;
- ativacao gradual v2, v3 e v4, mas sem considerar a chain completa enquanto
  qualquer protocolo obrigatorio estiver desabilitado.

Implementado no sub-bloco 13A:

- `robinhoodRollout` foi adicionado ao status administrativo para consolidar
  transporte, protocolos, persistencia, alertas, lease e blockers;
- o status continua invariavelmente `publishable=false` e declara que o caminho
  de publicacao ainda nao existe;
- a allowlist atual aparece como V2-only e V3/V4 aparecem explicitamente em
  `missingMandatory`, impedindo que a chain seja tratada como completa;
- transporte e persistencia aparecem honestamente como acoplados pelo kill
  switch existente `ROBINHOOD_INGESTION_ENABLED`; eles nao foram apresentados
  como flags independentes porque isso exigiria alterar o runner/writer;
- lease remota ativa e worker local sao distinguidos. Quando o admin web enxerga
  somente a lease do processo isolado, o blocker `worker_metrics_process_local`
  registra que head/cursor/provider detalhados nao estao compartilhados;
- o runbook agora registra a ordem de parada, a natureza startup-only do kill
  switch, a verificacao da lease e o desligamento opcional da retencao;
- testes unitarios protegem estado default fail-closed, dry-run remoto V2-only e
  tombstone fatal; o contrato admin protege publicacao desligada.

Validacao do sub-bloco 13A em 2026-07-14:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
testes unitarios direcionados: 17/17 passaram
integracao admin: 59/59 passaram
```

Implementado no sub-bloco 13B:

- o heartbeat de leases passou a aceitar metadata dinamica na mesma escrita ja
  existente, sem query ou tabela adicional;
- somente a lease Robinhood fornece o snapshot dinamico; os demais workers
  preservam o contrato anterior;
- a telemetria compartilhada inclui head derivado, safe head, cursor, lag,
  atraso de processamento, recoveries, contadores do runner, requests/bytes/429
  agregados por provider e estado bounded de memoria;
- o payload exclui pools, tokens, observacoes, janelas e mapas arbitrarios de
  erros; o contrato e versionado como `version=1`;
- antes do primeiro poll, o estado e `warming-up` e nao afirma que head/cursor
  estao disponiveis;
- falha no metadata provider nao perde nem invalida a lease: o heartbeat grava
  `metadataProviderError` e continua protegendo contra worker duplicado;
- o admin web consome a telemetria da lease ativa em
  `robinhoodRollout.telemetry`; processos antigos continuam identificados pelo
  blocker `worker_metrics_process_local` ate deploy/restart;
- nenhum runner/writer Robinhood, schema, frontend ou flag de publicacao foi
  alterado.

Validacao deterministica do sub-bloco 13B em 2026-07-14:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
testes direcionados de lease/rollout/ingestion: 25/25 passaram
integracao admin: 59/59 passaram
```

Verificacao live pos-restart do 13B em 2026-07-14:

- `17:21:57Z`: primeiro heartbeat com `version=1`, `status=warming-up`, worker
  rodando e primeiro poll em andamento;
- `17:23:57Z`: heartbeat avancou, `status=available`, discovery lag zero,
  market lag 1.098, runner com 6 ciclos, zero erro e zero 429;
- `17:28:57Z`: lease continuou renovando sem `metadataProviderError`, discovery
  permaneceu com lag zero, runner chegou a 21 ciclos e continuou com zero erro
  e zero 429;
- o estado bounded permaneceu com rollback, observacoes e janelas em memoria
  desligados/zerados, conforme o contrato do writer persistente;
- a telemetria compartilhada e a continuidade do heartbeat foram aprovadas;
- naquele instante o throughput ainda nao estava aprovado: entre as duas
  amostras disponiveis, o
  cursor market avancou 3.000 blocos, mas o head avancou 3.051, elevando o lag
  de 1.098 para 1.149 (+51). Uma janela curta nao atribui causalidade ao
  dry-run, mas tambem nao permitia declarar catch-up sustentavel; o gate foi
  reavaliado no fechamento do 13C abaixo.

Sub-bloco 13C iniciado em 2026-07-14 com dry-run operacional V2-only:

```text
generatedAt=2026-07-14T17:27:52.929Z
protocols=uniswap-v2
windowMs=300000
minLiquidityUsd=3000
minVolumeUsd=1000
minTransactions=10
maxAgeMs=86400000
candidates=68
uniqueTokens=67
expectedSignals=10
suppressed=58
candidateLimitReached=false
publishable=false
publicationAttempts=0
```

Supressoes observadas: 45 por transacoes abaixo do gate, 43 por idade, 43 por
volume e 9 por liquidez; um candidato pode acumular mais de um motivo. Todas as
68 observacoes usaram a estimativa V2
`spot_estimate_from_double_quote_reserve`. A amostra confirma o contrato
fail-closed e que o limite de 5.000 nao truncou candidatos, mas uma unica janela
nao autoriza publicacao nem valida longitudinalmente os gates.

Fechamento operacional do sub-bloco 13C em 2026-07-14:

- as oscilacoes intermediarias do market lag convergiram de 1.149 para 410 e
  finalmente zero as `17:40:57Z`;
- no fechamento, discovery e market estavam em
  `complete_within_declared_range`, sem lacunas, erro consecutivo ou 429;
- o restart recuperou os cursores persistentes, saiu de `warming-up`, processou
  o backlog e chegou a `caughtUp=true` sem trocar a ownership observada;
- rollback, observacoes e janelas analiticas permaneceram zerados/desligados no
  estado em memoria compartilhado;
- uma segunda amostra independente foi executada as `17:41:27Z` com os mesmos
  gates V2-only.

```text
segunda amostra:
candidates=95
uniqueTokens=94
expectedSignals=18
suppressed=77
candidateLimitReached=false
publishable=false
publicationAttempts=0
```

Na segunda janela, 48 supressoes envolveram idade, 62 volume, 59 transacoes e
24 liquidez; motivos podem se acumular. As 95 observacoes continuaram usando
`spot_estimate_from_double_quote_reserve`. As duas amostras variaram conforme a
atividade real, mas preservaram allowlist V2-only, gates completos, ausencia de
truncamento e publicacao invariavelmente desligada. O dry-run operacional do
13C esta concluido; ele nao autoriza catalogo, matcher ou entrega real.

Implementado no sub-bloco 13D:

- `ROBINHOOD_INGESTION_ENABLED` permanece como master kill switch legado;
- `ROBINHOOD_TRANSPORT_ENABLED` e `ROBINHOOD_PERSISTENCE_ENABLED` passam a
  controlar o bootstrap de forma independente: master e ambos os eixos precisam
  estar abertos para o worker iniciar;
- quando ausentes, as duas novas flags herdam o valor do master, preservando o
  comportamento dos ambientes atuais; o status informa `explicit=false`;
- fechar qualquer eixo impede o worker inteiro de iniciar no proximo restart,
  porque transporte sem persistencia nao existe na arquitetura atual;
- `ROBINHOOD_ALERTS_ENABLED` registra somente intencao operacional. Mesmo com
  `requested=true`, o status permanece `effective=false`, `publishable=false` e
  adiciona `alert_publication_unavailable` aos blockers;
- o admin expoe requested/effective/explicit, kill switch e master switch para
  transporte e persistencia;
- o runbook de start/shutdown passou a declarar os quatro controles sem alterar
  `.env` ou `.env.example`;
- nenhum runner/writer Robinhood, frontend, schema, catalogo, matcher ou entrega
  de alertas foi alterado.

Validacao do sub-bloco 13D em 2026-07-14:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
testes direcionados de config/rollout/ingestion: 24/24 passaram
integracao admin: 59/59 passou
```

Drill operacional do sub-bloco 13E em 2026-07-14:

- o processo antigo manteve o owner
  `Ezequiels-MacBook-Air.local:44800:e063...` ate a parada real, evitando um
  falso positivo baseado apenas em editar `.env` ou reiniciar outro processo;
- depois do restart efetivo, a lease foi adquirida pelo novo owner
  `Ezequiels-MacBook-Air.local:51862:70325a2b-c2f4-42b2-8d12-0782d0b03199`;
- o primeiro heartbeat do novo processo foi observado as `17:45:30Z`; as
  `17:47:00Z`, a telemetria ja estava `available`, discovery estava em lag zero
  e market retomava o backlog persistido com lag 1.152;
- as `17:50:00Z`, o mesmo owner continuava renovando a lease, discovery seguia
  em lag zero e market havia reduzido o lag para 761 blocos;
- as `18:31:30Z`, depois da aplicacao da Stage 69, o mesmo owner permanecia
  ativo e ambos os streams estavam em lag zero com
  `complete_within_declared_range`;
- nao houve `metadataProviderError`, lacuna inexplicada, erro consecutivo,
  fallback ou 429; um erro transitorio do runner foi recuperado;
- as flags explicitas usadas no drill mantiveram alertas desligados:
  transporte e persistencia ligados, `ROBINHOOD_ALERTS_ENABLED=false`;
- o drill aprova parada, nova ownership e retomada persistente. O monitoramento
  de throughput continua ate market retornar a lag zero e permanece um gate
  separado para qualquer publicacao.

Implementado no primeiro recorte do sub-bloco 13F em 2026-07-14:

- foi criado um contrato isolado de staging no catalogo para candidatos
  Robinhood V2 com janela exata de cinco minutos;
- qualquer escrita exige simultaneamente pedido explicito de alertas, rollout
  publicavel, decisao publicavel e `expectedSignal=true`; como o rollout e as
  decisoes atuais continuam `publishable=false`, o caminho live permanece
  invariavelmente bloqueado;
- linhas novas entram com `is_active_monitor_candidate=false`,
  `eligible_for_monitoring=false`, estado `robinhood-staged` e motivo
  `robinhood-alerts-disabled`; o staging nao ativa o catalog worker Solana;
- naquele recorte, o snapshot persistia apenas preco USD, volume USD de 5
  minutos, liquidez USD e identidade do par/protocolo. Embora a ingestao tambem
  produzisse FDV, ele nao era gravado em `last_mcap`, porque FDV e market cap
  nao sao metricas equivalentes;
- updates atrasados nao substituem as metricas mais novas e o staging nao
  rebaixa uma linha Robinhood que venha a ser ativada futuramente;
- o matcher continua rejeitando Robinhood antes de carregar regras/perfis e
  nenhuma entrega, runtime worker ou `availableChains` foi alterado;
- nenhum runner/writer Robinhood, schema, frontend, `.env` ou `.env.example`
  foi alterado neste recorte.

Validacao do primeiro recorte do sub-bloco 13F:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
testes direcionados de staging/catalog identity/matcher: 83/83 passaram
```

Segundo recorte do sub-bloco 13F em 2026-07-14:

- um coordenador em lote reutiliza a consulta persistente de candidatos e a
  politica calibrada do dry-run, sem duplicar os gates de mercado;
- o lote retorna antes de consultar o banco quando alertas estao desligados,
  quando o rollout nao e publicavel ou quando os gates estao incompletos;
- somente depois das duas autorizacoes globais uma decisao
  `expectedSignal=true` pode ser promovida internamente para staging;
- candidatos suprimidos continuam nao publicaveis e nao geram escrita;
- a promocao vale apenas para o limite de staging do catalogo: nao chama
  matcher, delivery ou WebSocket e nao altera o contrato publico;
- o coordenador ainda nao possui scheduler nem esta conectado ao bootstrap do
  processo Robinhood; portanto continua sem efeito live.

Validacao do segundo recorte do sub-bloco 13F:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
testes direcionados de staging batch/projector/signal policy: 13/13 passaram
```

Terceiro recorte do sub-bloco 13F em 2026-07-14:

- o staging recebeu scheduler proprio com execucao unica, intervalo limitado,
  backoff exponencial limitado, recuperacao apos erro e parada limpa;
- o scheduler consulta um provider de rollout em todo ciclo; nao reutiliza uma
  autorizacao antiga e o lote continua retornando antes do banco enquanto
  `publishable=false`;
- o bootstrap do grupo isolado Robinhood registra uma lease exclusiva
  `robinhood-catalog-staging-worker` somente quando ingestao, transporte,
  persistencia, intencao de alertas e gates de sinal estao configurados;
- ligar apenas `ROBINHOOD_ALERTS_ENABLED` nao torna o lote publicavel: o worker
  pode aguardar sob lease, mas cada ciclo continua bloqueado pelo status global;
- a lease publica telemetria compacta versionada com runs, erros e contagens do
  ultimo lote, sem copiar candidatos, amostras ou configuracao de sinal;
- `/api/admin/ws-status` expoe o status local e a lease compartilhada do
  staging, permitindo observacao a partir do processo web separado;
- matcher, delivery, WebSocket, frontend e `availableChains` continuam
  inalterados.

Validacao do terceiro recorte do sub-bloco 13F:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
testes unitarios de staging/rollout/runtime config: 30/30 passaram
integracao admin: 59/59 passou
```

Quarto recorte do sub-bloco 13F em 2026-07-14:

- a Stage 69 adicionou `token_catalog.last_fdv` como coluna nullable e aditiva,
  sem backfill ou alteracao de `last_mcap`;
- o staging V2 agora persiste `lastFdvUsd` somente em `last_fdv`; updates
  atrasados continuam sem substituir a avaliacao mais recente;
- o runtime schema guard exige a nova coluna e indica
  `node src/utils/db-init-stage69.js` como reparo;
- a migration foi aplicada ao banco local e o schema runtime completo passou;
- o rollback funcional preserva a coluna; um drop destrutivo exige staging
  desligado e backup, conforme o runbook de rollback;
- API, matcher e frontend ainda nao consomem `last_fdv`, e regras dependentes de
  market cap continuam indisponiveis para Robinhood.

Validacao do quarto recorte do sub-bloco 13F:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
testes de schema/staging: 29/29 passaram
db:schema-check runtime: passou
```

Quinto recorte do sub-bloco 13F em 2026-07-14:

- os selects chain-aware do dashboard passaram a carregar `last_fdv` junto de
  `last_mcap`, sem mudar os filtros/rankings Solana baseados em market cap;
- payloads monitorados e eventos do feed agora distinguem `mcap`, `fdv` e
  `valuationType`; market cap real e prioritario quando ambos existem, e um
  token somente com FDV retorna `mcap=null` e `valuationType='fdv'`;
- foi corrigida uma normalizacao preexistente em que `null`/string vazia eram
  convertidos para zero no feed, impedindo fallback honesto para dados do
  catalogo; zero explicito continua preservado;
- o frontend ainda nao renderiza `fdv` e Robinhood continua fora de
  `availableChains`;
- regras de market cap continuam sem autorizacao para usar FDV.

Validacao do quinto recorte do sub-bloco 13F:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
testes unitarios de valuation/feed/staging: 18/18 passaram
integracao dashboard: 20/20 passou
```

Sexto recorte do sub-bloco 13F em 2026-07-14:

- os contratos TypeScript de tokens monitorados e eventos de alerta agora
  transportam `fdv` e `valuationType` sem preencher `mcap` artificialmente;
- o merge de estado aplica FDV e seu tipo com a mesma regra de freshness das
  demais metricas, evitando que uma resposta atrasada substitua valuation mais
  recente;
- cards monitorados, tabelas Recent/Old Week e os trechos genericos do feed
  exibem `FDV` quando market cap circulante nao existe; tabelas mistas usam o
  cabecalho `MCAP / FDV`;
- market cap real continua prioritario quando ambas as metricas existem;
- controles, filtros, ordenacao e regras de `mcap` continuam lendo somente
  `mcap`, portanto FDV isolado nao torna nenhum alerta de market cap elegivel;
- Robinhood continua fora de `availableChains` e este recorte nao publica
  tokens nem alertas.

Validacao do sexto recorte do sub-bloco 13F:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
build frontend de producao: passou
testes direcionados de chain/valuation/backend: 15/15 passaram
```

Setimo recorte do sub-bloco 13F em 2026-07-14:

- foi criado um matcher Robinhood isolado, V2-only e limitado a janela exata de
  cinco minutos; ele so produz intents quando alertas foram pedidos, o rollout
  esta publicavel, a decisao individual esta publicavel e o sinal esperado foi
  aprovado;
- a categoria publica continua sendo HVNC, com rule key propria
  `robinhood-hvnc-v2`, sem atravessar o matcher Solana existente;
- a persistencia usa autorizacao efemera emitida pelo rollout e
  `ON CONFLICT DO NOTHING`, preservando idempotencia por usuario, chain e
  dedupe key;
- somente eventos realmente inseridos seguem ao publisher; duplicatas nao
  geram nova notificacao;
- o coordenador de publicacao reutiliza o candidato ja aprovado pelo staging,
  sem uma segunda consulta ou uma segunda implementacao dos gates;
- o scheduler Robinhood passou a executar esse coordenador, mas permanece sem
  qualquer escrita enquanto `ROBINHOOD_ALERTS_ENABLED=false`;
- o rollout deixou de ser invariavelmente falso: V2 pode ficar publicavel
  quando intencao, worker, cobertura sem gaps, telemetria e gates estiverem
  simultaneamente prontos. V3/V4 ausentes continuam impedindo declarar
  cobertura completa da chain, mas nao impedem rollout gradual V2.

Validacao do setimo recorte do sub-bloco 13F:

```text
lint: 0 erros; os mesmos 25 warnings preexistentes
matcher + delivery + publication + runtime: suites direcionadas passaram
rollout/admin: 25/25 unitarios e 59/59 de integracao passaram
```

Oitavo recorte do sub-bloco 13F em 2026-07-14:

- `robinhood-hvnc-v2` foi registrado no feed como regra `user-token` da chain
  Robinhood;
- feed, cursor, clear e replay agora derivam a chain da regra, eliminando o
  fallback incorreto que consultava somente eventos Solana;
- lookup de metadata do catalogo passou a aceitar chain e normalizar endereco
  EVM; FDV e preco fazem parte do snapshot lido;
- enriquecimento Meteora permanece estritamente Solana, evitando marcar um
  token Robinhood como sem pool por ausencia de estado Meteora;
- o payload do card Robinhood preserva FDV sem fabricar market cap e carrega
  preco USD, liquidez USD, transacoes e volume de cinco minutos;
- foi adicionado E2E de banco de teste: Solana e Robinhood persistem uma unica
  vez apesar da repeticao, e o feed combinado devolve as duas chains com as
  metricas corretas;
- o Stage 30 foi tornado importavel com `init({ closePool: false })`, sem mudar
  seu SQL, para que o E2E inicialize apenas a tabela necessaria no perfil de
  banco de teste minimo.

Validacao do oitavo recorte do sub-bloco 13F:

```text
feed/replay/catalog/valuation: 29/29 passaram
E2E PostgreSQL de publicacao e feed combinado: 1/1 passou
db:schema-check runtime: passou
```

Nono recorte do sub-bloco 13F em 2026-07-14:

- Robinhood foi adicionada ao contrato de disponibilidade de forma
  condicionada: continua invisivel com `ROBINHOOD_ALERTS_ENABLED=false` e so e
  retornada junto de Solana quando a intencao de alertas esta ligada;
- validacao e normalizacao server-side de preferencias usam o mesmo contrato,
  portanto o backend nao rejeita Robinhood depois da ativacao;
- contas legadas continuam com defaults SOL-only; habilitar a rede no ambiente
  nao muda silenciosamente o filtro salvo de usuarios existentes;
- o smoke Chromium cobre SOL-only, layout responsivo, feed combinado e a
  transicao para Robinhood-only pelo seletor master e pelo filtro do feed;
- o card E2E confirma `5m vol` e `FDV` para o alerta V2 Robinhood;
- ligar o kill switch apenas expoe a opcao. A escrita real continua protegida
  pelo status `publishable`, cobertura sem gaps e autorizacao efemera.

Validacao do nono recorte do sub-bloco 13F:

```text
chain availability + prefs + frontend chain: 27/27 passaram
integracao config: 18/18 passou
build frontend de producao: passou
smoke Chromium do seletor: 3/3 passou
lint: 0 erros; os mesmos 25 warnings preexistentes
```

Snapshot pre-ativacao as `19:15:39Z`:

- lease ativa no mesmo owner do drill, heartbeat com nove segundos de idade e
  validade ate `19:17:30Z`;
- discovery e market em lag zero, `caughtUp=true`, zero gaps inexplicados e
  zero rate limits acumulados;
- fase `dry-run-ready`, `publishable=false` e unico publication blocker
  `alerts_disabled`, coerente com `ROBINHOOD_ALERTS_ENABLED=false` explicito.

Partes restantes do Bloco 13:

1. manter monitoramento de lag/429 durante o rollout; uma nova tendencia
   sustentada de alta reabre o gate de throughput;
2. expor ocupacao/limite da fila social no snapshot compacto; ela nao esta
   disponivel fora do runner/writer atualmente e permaneceu fora deste recorte;
3. se transporte read-only independente de persistencia continuar sendo um
   requisito, ele exigira um novo processo/adaptador; as flags atuais oferecem
   kill switches independentes, mas a ativacao permanece acoplada;
4. ativar V2 live explicitamente e observar persistencia, notificacao,
   heartbeat, lag, gaps e 429 durante a primeira janela; essa e uma mudanca de
   comportamento externo e nao deve ser inferida apenas pela conclusao do E2E;
5. V3/V4 permanecem bloqueados ate existir liquidez USD
   confiavel por ticks/posicoes e autorizacao explicita por protocolo.

## Gates iniciais propostos para validar, nao confirmados

Esses numeros nao devem ser implementados sem uma rodada de dados reais:

```text
quote permitido: WETH ou USDG
liquidez minima: medir antes de decidir
volume minimo por swap: medir antes de decidir
idade maxima para feed de novos: medir antes de decidir
confirmacoes: definir apos observar reorg/finalidade
```

O Bloco 7 deve produzir percentis e distribuicoes para escolher gates. Nao
copiar automaticamente os limites da Solana porque gas, liquidez e atividade
da Robinhood sao diferentes.

## Disciplina de testes

### Unitarios

Usar para:

- decoders ABI;
- aritmetica bigint;
- sqrtPriceX96;
- direcao buy/sell;
- quote selection;
- deduplicacao;
- cursor/reorg;
- retry/backoff;
- agregacao de janelas.

Cada teste deve proteger uma regressao concreta. Preferir casos tabelados para
v2/v3/v4 e ampliar suites do mesmo contrato em vez de duplicar cenarios.

### Integracao

Usar para:

- schema multi-chain;
- cursor transacional;
- idempotencia apos restart;
- joins isolados por chain;
- publicacao de sinal/alerta;
- persistencia de metadata.

Nunca rodar integracao contra banco real/producao.

### Live probes

Live probe nao substitui teste deterministico. Serve para:

- confirmar endpoint/contrato;
- capturar fixture sanitizada;
- medir limites e latencia;
- verificar que a rede ainda corresponde a documentacao.

## Validacao obrigatoria por tipo de bloco

Para qualquer codigo:

```bash
npm run lint
node --test <testes afetados>
```

Ao mexer em schema/init:

```bash
npm run db:schema-check
```

Ao mexer em frontend:

```bash
npm --prefix frontend run build
```

Ao mexer em fluxo visivel/central, avaliar e executar:

```bash
npm run test:smoke
```

Antes de encerrar bloco maior:

- rodar lint do repo inteiro;
- revisar `git diff`;
- informar riscos cobertos e camada de teste;
- informar por que nenhum teste novo foi necessario, quando aplicavel;
- nao aceitar warnings novos sem justificativa.

## Estrategia de commits

Separar por escopo. Exemplos:

1. `docs: add Robinhood onchain monitoring plan`
2. `feat: add Robinhood RPC probe`
3. `feat: add provider-agnostic EVM RPC client`
4. `feat: add Robinhood cursor and log polling`
5. `feat: decode Uniswap v2 Robinhood events`
6. `feat: decode Uniswap v3 Robinhood events`
7. `feat: discover NOXA Fun Robinhood launches`
8. `feat: decode Uniswap v4 Robinhood events`
9. `feat: add Robinhood dry-run aggregation`
10. commits separados para cada sub-bloco de schema/multi-chain
11. commits separados para persistencia, sinais e frontend

Nao misturar refactor generico, schema, frontend e protocolo no mesmo commit.

## Metricas obrigatorias

Por provider:

- requests por metodo;
- respostas 2xx/429/5xx/timeout;
- latencia p50/p95/p99;
- bytes enviados/recebidos;
- retries e circuit breaker;
- uso do fallback Alchemy.

Por ingestao:

- head, cursor e lag em blocos/segundos;
- logs recebidos/aceitos/duplicados/removidos;
- gaps e blocos recuperados;
- pools descobertos por versao;
- launches NOXA vistos/validados/rejeitados/deduplicados;
- swaps por versao;
- swaps sem quote/preco;
- fila e memoria;
- tempo evento->observacao.

Por token:

- swaps/buys/sells;
- volume quote/USD;
- preco e variacao;
- liquidez com metodo/confidence;
- FDV e supply usados;
- metadata pendente/disponivel.
- launch source/config e restricao NOXA, quando aplicavel.

## Falhas e comportamento esperado

### RPC publico retorna 429

- reduzir concorrencia/range/frequencia;
- aplicar backoff com jitter;
- preservar cursor;
- usar Alchemy fallback dentro de budget configurado;
- nunca pular range silenciosamente.

### Alchemy acaba a franquia ou e desligada

- fechar WebSocket;
- continuar polling publico;
- aumentar metrica de degradacao/lag;
- nao alterar calculos ou formato dos eventos.

### WebSocket desconecta

- nao confiar no ultimo evento visto como cursor completo;
- reconectar;
- backfill HTTP desde ultimo bloco confirmado;
- deduplicar o overlap.

### Token reverte metadata

- manter endereco e pool;
- simbolo/nome ficam nulos ou fallback seguro;
- nao descartar swap valido;
- impedir chamadas repetidas agressivas.

### Reorg/log removido

- desfazer efeito ainda nao finalizado ou reconstruir bloco;
- nunca persistir volume duplicado;
- alertas so usam nivel de confirmacao definido no dry-run.

## Pontos importantes

- Nao existe RPC hospedado simultaneamente gratuito, ilimitado e com SLA. O
  plano otimiza o gratuito e usa fallback; nao presume ausencia de limite.
- O RPC publico e a prioridade economica, mas nao pode virar single point of
  failure invisivel.
- Alchemy nao produz a verdade de mercado; apenas oferece acesso a nos e
  transporte. Todo parser permanece portavel.
- O rate limit do DexScreener pode ser compartilhado por IP mesmo com clientes
  separados. Metadata Robinhood deve ser rara, cacheada e dispensavel.
- A API do indexador NOXA foi identificada no bundle publico do frontend, mas
  nao possui documentacao de estabilidade, rate limit ou SLA. Nao usa-la no
  caminho critico.
- A NOXA Factory tem bytecode e logs no Blockscout, mas source nao verificado.
  Validar cada pool contra a Factory oficial da Uniswap v3.
- `restrictionsEndBlock` da NOXA usa semantica de `block.number` L1 em Arbitrum
  Orbit; nao comparar diretamente com altura L2.
- NOXA cobre apenas launches feitos por ela. Manter `PoolCreated` da Uniswap
  como descoberta geral de Robinhood.
- O schema atual nao e multi-chain de verdade. Inserir Robinhood antes do Bloco
  9 pode rotular dados como Solana ou colidir identidades.
- FDV e market cap nao sao sinonimos.
- v2, v3 e v4 exigem formulas e identidades diferentes.
- Logs WebSocket sem cursor/backfill nao garantem completude.
- Nao copiar gates Solana para Robinhood sem distribuicoes reais.
- Nenhum alerta real antes de soak test, idempotencia e restart recovery.

## Checklist para retomar sem contexto

1. Ler este documento inteiro.
2. Verificar `git status` e preservar mudancas do usuario.
3. Identificar o ultimo bloco marcado como concluido neste `Status`.
4. Reconfirmar contratos nas fontes oficiais.
5. Revisar o codigo real antes de aceitar qualquer premissa do plano.
6. Implementar somente o proximo bloco incompleto.
7. Manter aproximadamente ate 300 linhas de codigo de producao por bloco.
8. Rodar validacoes obrigatorias do bloco.
9. Revisar `git diff`.
10. Atualizar `Status`, decisoes e resultados observados neste documento.
11. Separar commit por escopo.

## Proximo passo autorizado pelo plano

Os Blocos 11 e 12 estao concluidos. O caminho funcional V2 do Bloco 13 esta
implementado e validado ate o E2E, mas a ativacao live ainda nao foi executada.
O proximo passo e obter autorizacao operacional explicita, ligar
`ROBINHOOD_ALERTS_ENABLED=true`, reiniciar os processos que leem flags no
startup e observar a primeira janela live. V3/V4 nao devem ser promovidos
enquanto ticks/posicoes nao produzirem liquidez USD confiavel e seus protocolos
nao forem adicionados explicitamente a allowlist.

A estrategia futura de baixa latencia foi separada em
`docs/robinhood-low-latency-fast-lane-plan.md`. Ela nao altera a sequencia dos
blocos atuais e nao autoriza ativar WebSocket antes da conclusao funcional do
bot Robinhood.

O worker de ingestao pode permanecer ativo para manter os buckets atuais.
Catalogo, matcher e entrega continuam sem efeito live enquanto o kill switch de
alertas estiver falso. O E2E nao substitui a autorizacao para publicar alertas.

# QuickNode onchain alert plan

## Status

Planejamento e probes iniciais em andamento em 2026-07-04.

Este documento e a fonte de verdade para continuar a migracao/teste de dados onchain via QuickNode sem depender do contexto da conversa.

Status atual:

- Depois dos probes da Jupiter, QuickNode JSON-RPC/WebSocket nao e mais o caminho primario recomendado para refresh de preco/volume.
- Jupiter passa a ser a fonte principal candidata para preco/volume por token. Ver `docs/jupiter-refresh-alert-integration-plan.md`.
- QuickNode continua como laboratorio/fallback para validacao onchain, volume1m real e comparacao de custo.
- Endpoint QuickNode HTTP e WebSocket validado.
- `transactionSubscribe` validado como caminho principal para eventos realtime.
- Probes locais criados para medir eventos, bytes e creditos estimados.
- PumpSwap, Meteora DLMM e Raydium entram obrigatoriamente nos dry-runs principais.
- Bloco 1 implementado: volume por WSOL, USDC e USDT no candidato/dry-run.
- Bloco 2 implementado: relatorio agregado por token no dry-run.
- Bloco 3 implementado: janela 1m/5m em memoria no dry-run.
- Bloco 4 corrigido: preco executado por swap e `priceChange1h` rolling em dry-run.
- Bloco 5 implementado em dry-run: stream concorrente continuo com reconnect e tracker compartilhado.
- Bloco 5.1 implementado em dry-run: transporte alternativo `logsSubscribe + getTransaction` em batch.
- Pump.fun bonding curve fica fora do escopo.
- Orca fica fora do escopo por enquanto.
- Nenhum alerta real e publicado ainda.
- Nenhum worker onchain esta ativo em producao.

## Objetivo

Criar uma pipeline onchain realtime para detectar swaps relevantes e, depois de validada, gerar sinais de alerta/surge usando dados proprios em vez de depender somente de agregadores externos.

O fluxo alvo:

```text
QuickNode transactionSubscribe
  -> filtrar programa invocado
  -> traduzir balances para token/volume
  -> aplicar admin_blocked_tokens
  -> aplicar gates de volume
  -> agregar janelas por token
  -> gerar sinal
  -> publicar alerta
```

## Decisoes confirmadas

- Usar QuickNode como RPC/WebSocket inicial.
- Usar modelo event-driven por WebSocket, nao polling por token.
- Trabalhar com PumpSwap, Meteora e Raydium nos testes principais.
- Nao monitorar Pump.fun bonding curve.
- Nao tratar evento bruto como alerta.
- Banidos do bot sao filtrados na nossa camada, nao no RPC.
- Antes de alerta real, todos os testes onchain devem rodar em dry-run.
- Medir custo por bytes recebidos, nao somente numero de eventos.
- Aplicar gate inicial de volume antes de considerar candidato.
- Usar gate simples de `$1.5` para rotas USDC/USDT nesta fase, sem conversao dinamica SOL/USD.

## Fora de escopo agora

- Pump.fun bonding curve/pre-bonding.
- Orca.
- Publicar alerta real.
- Escrever volume onchain nas tabelas de mercado existentes.
- Criar schema novo antes de validar a forma final dos dados.
- Assumir que todo swap com programa incluido e swap util.
- Assumir que `transactionDetails: full` e formato final de producao.

## Fontes monitoradas

### PumpSwap

Programa:

```text
pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
```

Uso esperado:

- Fonte pos-migracao.
- Nao inclui bonding curve.
- Alta prioridade para testes.
- Deve ter gates fortes porque captura token pequeno cedo.

### Meteora DLMM

Programa:

```text
LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
```

Uso esperado:

- Fonte relevante para pools onchain.
- Pode vir com rotas sem WSOL direto.
- Precisa suporte a stablecoin para nao descartar trade valido.

### Raydium

Programas:

```text
raydium-cpmm   CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
raydium-clmm   CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
raydium-amm-v4 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
```

Uso esperado:

- CPMM e CLMM parecem mais limpos em amostras curtas.
- AMM v4 pode ser muito ruidoso por `mention-only`.
- Manter no teste, mas medir custo separado.

## O que chega do RPC

O RPC nao entrega "trade pronto". O `transactionSubscribe` entrega uma transacao Solana com:

- `signature`
- `slot`
- `transaction.message.instructions`
- `transaction.meta.innerInstructions`
- `transaction.meta.preTokenBalances`
- `transaction.meta.postTokenBalances`

A traducao atual:

1. confirma se o programa foi realmente invocado;
2. calcula deltas entre `preTokenBalances` e `postTokenBalances`;
3. escolhe maior delta que nao seja quote asset como `tokenMint`;
4. usa delta WSOL absoluto como `estimatedSolVolume`;
5. usa maior delta USDC/USDT absoluto como `estimatedUsdVolume`;
6. aplica blocklist/admin ban;
7. aplica gates `minSolVolume` e/ou `minUsdVolume`.

## Limitacoes conhecidas

### Volume sem quote conhecido

Hoje o gate usa WSOL, USDC e USDT para estimar volume. Quando a rota usa outro intermediario, `estimatedSolVolume` e `estimatedUsdVolume` podem ficar `null`.

Consequencia:

- com gates de volume ativos, esses eventos caem como `low_volume`;
- isso reduz ruido, mas pode perder trades relevantes, especialmente em Meteora.

Proximo ajuste possivel:

- adicionar outros quote assets se aparecerem com frequencia;
- avaliar conversao para SOL equivalente usando preco SOL/USD.

### Mention-only

`accounts.include` pode retornar transacao que menciona o programa sem executar aquele programa.

Regra obrigatoria:

- descartar quando o `programId` nao aparece em instructions ou inner instructions.

### Custo

QuickNode cobra `transactionSubscribe` por dados trafegados. A regra observada na documentacao em 2026-07-04:

```text
0.1 MB = 15 API credits
```

Logo:

- evento realtime ainda custa se o filtro for amplo;
- `transactionDetails: full` e caro, mas necessario nos testes para balances;
- AMM v4 e Meteora podem oscilar bastante em bytes uteis vs ruido.

## Filtros e custo

Nem todo filtro economiza RPC. Separar isso e importante para nao criar uma falsa sensacao de economia.

### Filtros que podem economizar RPC

Sao filtros enviados dentro do `transactionSubscribe`:

- `vote: false`;
- `failed: false`;
- `accounts.include`;
- `accounts.exclude`;
- `accounts.required`.

Esses filtros reduzem o que o QuickNode envia pelo WebSocket. Logo, podem reduzir bytes e creditos.

Uso atual:

- `accounts.include`: programa monitorado, por exemplo PumpSwap, Meteora DLMM ou Raydium;
- `accounts.exclude`: opcional por env, ainda sem lista padrao;
- `accounts.required`: opcional por env, util para probes direcionados, mas perigoso como default porque pode perder swaps validos.

### Filtros que nao economizam RPC

Esses filtros rodam depois que a transacao ja chegou no backend:

- admin blocklist/token banido;
- `minSolVolume`;
- `minUsdVolume`;
- descarte de `mention-only`;
- agregacao por token;
- futuro criterio de surge/cooldown.

Eles melhoram qualidade do sinal e evitam alerta ruim, mas nao reduzem bytes recebidos.

### Regra de volume atual

Enquanto nao houver preco SOL/USD dinamico no fluxo onchain:

```text
WSOL       aceitar se volume >= 0.01 SOL
USDC/USDT  aceitar se volume >= 1.5 USD
outros     sem quote conhecido; tende a cair como low_volume quando gate esta ativo
```

Essa regra e deliberadamente simples. O objetivo agora e cortar micro-transacao obvia sem adicionar dependencia de preco externo.

### Como medir economia real

Toda mudanca de filtro deve comparar, por programa:

- `seen`;
- `matches`;
- `accepted`;
- `lowVolume`;
- `skippedMentionOnly`;
- `receivedBytes`;
- `mentionOnlyBytes`;
- `matchBytes`;
- `estimatedCredits`.

Se `accepted` fica parecido e `receivedBytes` cai, o filtro economizou RPC. Se apenas `lowVolume` sobe, a qualidade melhorou, mas o custo de RPC nao caiu.

## Artefatos criados

### Scripts

- `src/utils/quicknode-rpc-smoke.js`
  - valida HTTP RPC, WS slotSubscribe e logsSubscribe opcional.
- `src/utils/quicknode-transaction-probe.js`
  - testa `transactionSubscribe`, extrai deltas e mede bytes/creditos.
- `src/utils/quicknode-onchain-dry-run.js`
  - roda PumpSwap + Meteora + Raydium em dry-run, aplica blocklist/gates e resume custo/sinal.

### Servicos puros

- `src/services/quicknode-onchain-event.js`
  - transforma summary de transacao em candidato onchain.
- `src/services/quicknode-onchain-ingestion.js`
  - aplica batch, blocklist e gates antes de aceitar candidato.
- `src/services/quicknode-onchain-window-aggregator.js`
  - agrega candidatos aceitos em janelas 1m/5m em memoria, com dedupe por assinatura.
- `src/services/quicknode-onchain-price-observation.js`
  - traduz deltas aceitos em preco executado com quote SOL ou USD e rejeita rotas ambiguas.
- `src/services/quicknode-onchain-price-change-tracker.js`
  - mantem historico rolling e calcula variacao percentual de preco em 1h.

### Scripts npm

```bash
npm run quicknode:smoke
npm run quicknode:probe
npm run quicknode:probe:raydium
npm run quicknode:dry-run
npm run quicknode:continuous-dry-run
npm run quicknode:logs-dry-run
```

## Comando padrao de dry-run

Usar sempre PumpSwap + Meteora + Raydium, sem bonding curve:

```bash
QUICKNODE_SOLANA_WS_URL='<wss endpoint>' \
QUICKNODE_DRY_RUN_SECONDS=35 \
QUICKNODE_DRY_RUN_MATCHES=2 \
QUICKNODE_DRY_RUN_MAX_SEEN=180 \
QUICKNODE_DRY_RUN_MIN_SOL_VOLUME=0.01 \
QUICKNODE_DRY_RUN_MIN_USD_VOLUME=1.5 \
QUICKNODE_DRY_RUN_TOKEN_REPORT_LIMIT=10 \
npm run quicknode:dry-run
```

Defaults atuais do dry-run:

```text
pumpswap
meteora-dlmm
raydium-cpmm
raydium-clmm
raydium-amm-v4
```

## Rodadas recomendadas

### Rodada principal curta

Usar para comparar comportamento geral entre fontes:

```bash
QUICKNODE_SOLANA_WS_URL='<wss endpoint>' \
QUICKNODE_DRY_RUN_SECONDS=35 \
QUICKNODE_DRY_RUN_MATCHES=2 \
QUICKNODE_DRY_RUN_MAX_SEEN=180 \
QUICKNODE_DRY_RUN_MIN_SOL_VOLUME=0.01 \
QUICKNODE_DRY_RUN_MIN_USD_VOLUME=1.5 \
npm run quicknode:dry-run
```

### Rodada por programa caro

Usar quando uma fonte estiver consumindo muitos bytes:

```bash
QUICKNODE_SOLANA_WS_URL='<wss endpoint>' \
QUICKNODE_DRY_RUN_PROGRAMS='raydium-amm-v4' \
QUICKNODE_DRY_RUN_SECONDS=35 \
QUICKNODE_DRY_RUN_MATCHES=2 \
QUICKNODE_DRY_RUN_MAX_SEEN=180 \
QUICKNODE_DRY_RUN_MIN_SOL_VOLUME=0.01 \
QUICKNODE_DRY_RUN_MIN_USD_VOLUME=1.5 \
npm run quicknode:dry-run
```

Trocar `raydium-amm-v4` por `meteora-dlmm`, `pumpswap`, `raydium-cpmm` ou `raydium-clmm` conforme a investigacao.

### Rodada com filtro required

Usar apenas como probe, nao como default:

```bash
QUICKNODE_SOLANA_WS_URL='<wss endpoint>' \
QUICKNODE_DRY_RUN_REQUIRED='So11111111111111111111111111111111111111112' \
QUICKNODE_DRY_RUN_SECONDS=35 \
QUICKNODE_DRY_RUN_MATCHES=2 \
QUICKNODE_DRY_RUN_MAX_SEEN=180 \
QUICKNODE_DRY_RUN_MIN_SOL_VOLUME=0.01 \
QUICKNODE_DRY_RUN_MIN_USD_VOLUME=1.5 \
npm run quicknode:dry-run
```

Objetivo:

- medir se exigir WSOL reduz `receivedBytes`;
- comparar perda de candidatos com rotas USDC/USDT;
- decidir se algum `required` vale a pena por fonte.

Nao usar `required=WSOL` como regra global, porque isso pode descartar rotas validas sem WSOL direto.

## Resultados observados ate agora

### PumpSwap

Amostra curta:

- bom sinal/custo;
- nao e bonding curve;
- trouxe eventos pequenos, entao precisa gate;
- com `minSolVolume=0.01`, parte dos matches cai como `lowVolume`.

### Meteora

Amostras curtas variaram:

- uma rodada veio cara/ruidosa;
- outra veio barata/limpa;
- problema mais importante: rotas sem WSOL direto.

Conclusao:

- manter nos testes;
- adicionar stablecoin volume antes de tirar conclusao final.

### Raydium

Amostras curtas:

- CPMM e CLMM geralmente bons;
- AMM v4 pode consumir muitos bytes em mention-only;
- manter os tres programas por enquanto, medindo separado.

### Dry-run com relatorio por token

Amostra curta depois do Bloco 2:

- programas: PumpSwap, Meteora DLMM, Raydium CPMM, Raydium CLMM, Raydium AMM v4;
- `seen=39`;
- `matches=10`;
- `accepted=7`;
- `lowVolume=2`;
- `skippedMentionOnly=29`;
- `receivedBytes=952327`;
- `estimatedCredits=142.86`;
- `tokenReport count=9`.

Leitura:

- o agregado por token funciona;
- PumpSwap gerou candidatos pequenos que foram descartados pelo gate;
- Raydium e Meteora geraram candidatos aceitos;
- ainda nao ha criterio de surge, apenas candidatos por token.

### Dry-run com janela em memoria

Amostra curta depois do Bloco 3, usando `minSolVolume=0.01` e `minUsdVolume=1.5`:

- programas: PumpSwap, Meteora DLMM, Raydium CPMM, Raydium CLMM, Raydium AMM v4;
- `seen=44`;
- `matches=10`;
- `accepted=9`;
- `lowVolume=1`;
- `skippedMentionOnly=34`;
- `receivedBytes=883421`;
- `estimatedCredits=132.52`;
- `tokenReport count=8`;
- `windowReport count=14`.

Leitura:

- o relatorio 1m/5m funcionou no dry-run real;
- houve token com 2 swaps em Raydium CLMM e cerca de `$106.53` em USDC na janela;
- houve token com 2 swaps em Raydium AMM v4 e cerca de `0.384462062 SOL` na janela;
- PumpSwap, Meteora e Raydium apareceram no mesmo dry-run;
- ainda nao ha publish de alerta, apenas relatorio de janela.

### Experimento de volume incorretamente chamado de surge

Status: invalidado e removido do caminho executavel.

Amostra curta depois do Bloco 4, usando:

```text
minSolVolume=0.01
minUsdVolume=1.5
surge window=5m
surge minSwaps=3
surge minSolVolume=0.05
surge minUsdVolume=7.5
```

Resultado:

- `seen=35`;
- `matches=10`;
- `accepted=6`;
- `blocked=1`;
- `lowVolume=3`;
- `skippedMentionOnly=25`;
- `receivedBytes=906046`;
- `estimatedCredits=135.91`;
- `windowReport count=12`;
- `surgeCandidate empty`.

Leitura corrigida:

- esse experimento media atividade, nao surge;
- `swaps_5m` e volume nao representam `priceChange1h`;
- o detector correspondente foi removido antes de qualquer integracao com alertas.

## Proximos blocos

### Bloco 1 - Stablecoin volume

Status: implementado no candidato, ingestao e dry-run.

Suporte atual:

- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- USDT: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`

Saida esperada:

- `estimatedSolVolume`
- `estimatedUsdVolume`
- `volumeSource`: `wsol`, `usdc`, `usdt`, `none`

Gates:

- `QUICKNODE_DRY_RUN_MIN_SOL_VOLUME`
- `QUICKNODE_DRY_RUN_MIN_USD_VOLUME`

Regra experimental atual:

- WSOL: filtrar abaixo de `0.01 SOL`;
- USDC/USDT: filtrar abaixo de `$1.5`;
- sem conversao dinamica SOL/USD nesta fase.

Teste minimo:

- WSOL passa por SOL;
- USDC/USDT passa por USD;
- sem quote conhecido cai como `low_volume`;
- admin-blocked continua tendo prioridade sobre gate.

### Bloco 2 - Relatorio de tokens

Status: implementado no dry-run.

Dry-run deve agregar por token:

- swaps aceitos;
- volume total;
- volume por fonte;
- programas onde apareceu;
- signatures de exemplo;
- blocked/low volume.

Objetivo:

- saber se os sinais parecem token real ou ruido antes de persistir.

Saida atual:

- `tokenMint`
- `accepted`
- `blocked`
- `lowVolume`
- `estimatedSolVolume`
- `estimatedUsdVolume`
- `programs`
- `volumeSources`
- `sampleSignatures`

Configuracao:

- `QUICKNODE_DRY_RUN_TOKEN_REPORT_LIMIT`

### Bloco 3 - Janela em memoria

Status: implementado no dry-run.

Criar agregador em memoria:

- janela 1m;
- janela 5m;
- volume total;
- quantidade de swaps;
- ultima assinatura;
- programas envolvidos.

Ainda sem alerta real.

Entrada:

- candidatos aceitos pelo dry-run;
- `tokenMint`;
- `signature`;
- `program`;
- `estimatedSolVolume`;
- `estimatedUsdVolume`;
- `volumeSource`;
- timestamp local ou `blockTime` quando existir.

Saida esperada:

- relatorio por token com janela 1m;
- relatorio por token com janela 5m;
- total de swaps por janela;
- volume SOL por janela;
- volume USD por janela;
- programas distintos por janela;
- assinatura mais recente.

Regra de implementacao:

- manter tudo em memoria;
- nao criar schema ainda;
- deduplicar por `signature`;
- remover eventos expirados da janela;
- imprimir no dry-run, sem publicar alerta.

Teste minimo:

- agrega dois swaps do mesmo token na mesma janela;
- ignora assinatura duplicada;
- expira evento fora da janela;
- separa tokens diferentes;
- soma SOL e USD separadamente.

Saida atual:

- `window`;
- `tokenMint`;
- `swaps`;
- `estimatedSolVolume`;
- `estimatedUsdVolume`;
- `programs`;
- `volumeSources`;
- `latestSignature`;
- `sampleSignatures`.

### Bloco 4 - Preco e variacao acumulada em 1h

Status: implementado em memoria e dry-run, sem publicar alertas.

Regra correta:

```text
execution_price = quote_amount / token_amount
price_change_1h = ((current_price / baseline_price_1h) - 1) * 100
surge quando price_change_1h >= threshold configurado
```

Comportamento atual:

- aceita PumpSwap, Meteora DLMM e Raydium CPMM/CLMM/AMM v4;
- prefere USDC/USDT quando a rota tambem contem WSOL intermediario;
- mantem series SOL e USD separadas;
- usa o ultimo preco observado no limite ou antes de 1h;
- rejeita baseline mais de 15 minutos anterior ao limite;
- deduplica por assinatura e remove historico expirado;
- nao chama o `user-alert-matcher` ainda.

Validacao real curta:

- PumpSwap forneceu pares token/WSOL validos, embora amostras abaixo do gate sejam descartadas;
- Meteora produziu observacao SOL utilizavel e uma rota multi-token foi rejeitada;
- Raydium CLMM confirmou que stablecoin final deve ter prioridade sobre WSOL residual;
- uma rodada produziu 2 observacoes utilizaveis e rejeitou 1 rota ambigua.

Limitacao atual:

- series em SOL ainda nao equivalem a preco USD sem uma referencia SOL/USD;
- o processo precisa permanecer ativo por 1h ou carregar historico persistido antes de produzir o primeiro `priceChange1h`.

### Bloco 5 - Integracao com alertas

Status: worker continuo implementado apenas em dry-run; integracao com alertas continua pendente.

O comando `npm run quicknode:continuous-dry-run`:

- abre uma conexao WebSocket;
- registra PumpSwap, Meteora e todas as variantes Raydium simultaneamente;
- restaura as subscriptions apos reconnect;
- mantem um unico tracker por toda a execucao;
- aplica blocklist e gates antes do preco;
- reporta trafego/creditos por programa a cada minuto;
- roda 60 segundos por default; uma janela de 1h exige configuracao explicita;
- nunca publica alertas.

Smoke concorrente de 5 segundos em 2026-07-04:

- cinco subscriptions confirmadas na mesma conexao;
- `2.076` notifications recebidas;
- `909` summaries processados;
- `589` swaps aceitos apos gates/blocklist;
- `558` observacoes de preco;
- `47.277.341` bytes recebidos;
- `7.091,6` creditos estimados;
- encerramento limpo com exit code `0`.

Conclusao de custo:

- `transactionSubscribe` com `transactionDetails: full` e caro demais para deixar 1h sem otimizar;
- a extrapolacao linear dessa amostra para 75 minutos seria aproximadamente `42,5 GB` e `6,38 milhoes` de creditos estimados;
- nao rodar 1h continua com transporte `full` sem filtros adicionais.

### Bloco 5.1 - Transporte leve por logs + fetch em batch

Status: implementado em dry-run; ainda nao aprovado para producao.

O comando `npm run quicknode:logs-dry-run`:

- abre uma conexao WebSocket;
- registra `logsSubscribe` para PumpSwap, Meteora e todas as variantes Raydium;
- aceita apenas logs com prefixo real `Program <address> invoke [`;
- deduplica assinaturas vistas em multiplas subscriptions;
- busca `getTransaction` via HTTP RPC em batch;
- processa a transacao completa pela mesma pipeline de blocklist, gates e preco;
- nunca publica alertas.

Configuracoes do fetch HTTP:

```text
QUICKNODE_CONTINUOUS_FETCH_CONCURRENCY
QUICKNODE_CONTINUOUS_FETCH_BATCH_SIZE
QUICKNODE_CONTINUOUS_FETCH_BATCH_WAIT_MS
QUICKNODE_CONTINUOUS_FETCH_AVAILABILITY_DELAY_MS
QUICKNODE_CONTINUOUS_FETCH_ATTEMPTS
QUICKNODE_CONTINUOUS_FETCH_RETRY_MS
QUICKNODE_CONTINUOUS_FETCH_MAX_QUEUE_SIZE
```

Default atual:

```text
concurrency=2
batchSize=50
batchWaitMs=50
availabilityDelayMs=500
attempts=4
retryMs=250
maxQueue=2000
```

Smoke `logs` default de 5 segundos em 2026-07-04:

- `1.962` log notifications recebidas;
- `1.032` matches reais por `Program invoke`;
- `53` summaries processados antes do shutdown;
- `34` swaps aceitos apos gates/blocklist;
- `33` observacoes de preco;
- `6.217.231` bytes recebidos no WS;
- `1.371.228` bytes de resposta HTTP;
- `30` requests HTTP em batch;
- `1.346` method calls `getTransaction`;
- `2` batches rate-limited;
- `36` fetches esgotados;
- exit code `0`.

Smoke `logs` conservador de 5 segundos em 2026-07-04:

```text
concurrency=1
batchSize=100
batchWaitMs=200
availabilityDelayMs=1500
attempts=2
retryMs=750
```

Resultado:

- `4.322` log notifications recebidas;
- `1.476` matches reais por `Program invoke`;
- `38` summaries processados antes do shutdown;
- `13` swaps aceitos apos gates/blocklist;
- `13` observacoes de preco;
- `10.119.466` bytes recebidos no WS;
- `1.044.450` bytes de resposta HTTP;
- `10` requests HTTP em batch;
- `717` method calls `getTransaction`;
- `0` batches rate-limited;
- `155` fetches esgotados;
- exit code `0`.

Smoke `logs` com backpressure agressivo de 5 segundos em 2026-07-04:

```text
maxQueue=25
demais configuracoes em default
```

Resultado:

- `1.817` log notifications recebidas;
- `1.073` matches reais por `Program invoke`;
- `19` summaries processados antes do shutdown;
- `10` swaps aceitos apos gates/blocklist;
- `10` observacoes de preco;
- `6.363.449` bytes recebidos no WS;
- `430.229` bytes de resposta HTTP;
- `3` requests HTTP em batch;
- `29` method calls `getTransaction`;
- `0` batches rate-limited;
- `895` fetches dropados por limite de fila;
- exit code `0`.

Leitura:

- backpressure limita custo HTTP e impede fila infinita;
- limite baixo demais perde cobertura de trades rapidamente;
- `maxQueue=25` serve como teste de mecanismo, nao como configuracao recomendada.

Rodada `logs` conservadora de 90 segundos em 2026-07-04:

```text
concurrency=1
batchSize=100
batchWaitMs=200
availabilityDelayMs=1500
attempts=2
retryMs=750
maxQueue=2000
```

Resultado:

- PumpSwap, Meteora e Raydium ativos na mesma execucao;
- `14.829` notifications PumpSwap, `9.050` Meteora, `2.145` Raydium somando variantes;
- `7.262` matches PumpSwap, `1.328` Meteora, `530` Raydium somando variantes;
- `384` summaries processados;
- `190` swaps aceitos apos gates/blocklist;
- `186` observacoes de preco;
- `63.014.618` bytes recebidos via WS;
- `11.551.733` bytes de resposta HTTP;
- `162` requests HTTP em batch;
- `15.946` method calls `getTransaction`;
- `7.682` erros HTTP/fetch;
- `257` fetches dropados por fila;
- `0` batches rate-limited no HTTP;
- o WebSocket recebeu `Unexpected server response: 429` por volta de 30 segundos e entrou em reconnect;
- depois do 429, a execucao nao voltou a receber dados uteis antes de encerrar.

Rodada seguinte com `maxQueue=25`, logo apos o 429:

- nao conseguiu reassinar/receber dados uteis;
- ficou em reconnect;
- `0` bytes WS;
- `0` requests HTTP;
- `0` summaries.

Rodada PumpSwap-only controlada de 30 segundos em 2026-07-04:

```text
programs=pumpswap
concurrency=1
batchSize=1
batchWaitMs=1000
availabilityDelayMs=1500
attempts=2
retryMs=750
maxQueue=25
```

Resultado:

- `13.495` log notifications recebidas;
- `7.292` matches reais por `Program invoke`;
- `6.203` mention-only;
- `45.902.082` bytes recebidos via WS;
- `0` requests HTTP;
- `0` method calls `getTransaction`;
- `7.267` fetches dropados por limite de fila;
- `0` summaries processados;
- `0` swaps aceitos;
- `0` rate-limits observados nessa janela.

Leitura:

- PumpSwap sozinho ja gera volume muito alto de logs;
- limitar para aproximadamente `1 getTransaction/sec` protege HTTP, mas perde praticamente toda a cobertura;
- o custo estimado do WS continua alto mesmo sem fetch HTTP;
- para PumpSwap, o problema nao e so `getTransaction`: o stream de logs em si ja e barulhento.

Leitura adicional:

- reduzir a fila HTTP nao resolveu o problema quando o endpoint ja estava limitado;
- o primeiro gargalo visivel nessa rodada foi o limite/pressao do endpoint WS/plano geral, nao apenas `getTransaction`;
- uma estrategia sem gRPC precisa assumir perda, cooldown/backoff agressivo e janelas curtas de coleta;
- rodadas longas com todos os programas ativos nao devem ser feitas sem confirmar reset de limite/creditos no painel.

Leitura:

- `logsSubscribe` reduz muito o payload do WebSocket em comparacao com `transactionSubscribe full`;
- o custo total nao e so WS: tambem entram requests/metodos HTTP de `getTransaction`;
- batch reduz requests, mas o numero de method calls continua alto quando PumpSwap esta ativo;
- configuracao conservadora removeu 429 nessa amostra, mas atrasou processamento e aumentou fetch esgotado;
- fila sem limite nao serve para worker permanente;
- existe agora limite configuravel de fila, com drop do item mais antigo quando `maxQueue` e excedido;
- o transporte leve e promissor, mas precisa medir a taxa de `dropped` antes de qualquer worker permanente.

Proximo experimento recomendado:

- rodar `logs` por 10-15 minutos fora de horario de pico;
- manter PumpSwap, Meteora e Raydium ativos;
- medir `matches` vs `fetched` vs `errors`;
- medir `dropped` com `QUICKNODE_CONTINUOUS_FETCH_MAX_QUEUE_SIZE`;
- decidir o limite aceitavel de perda em pico;
- comparar custo real do plano QuickNode para WS bytes + chamadas HTTP.

Somente depois de validar uma execucao completa:

- decidir se pluga no `user-alert-matcher`;
- ou criar regra separada `onchain-surge`;
- definir payload persistido;
- definir cooldown/rearm;
- definir UI.

Criterio para sair do dry-run:

- pelo menos algumas rodadas com PumpSwap, Meteora e Raydium ativos;
- custo por minuto estimado aceitavel no plano QuickNode escolhido;
- baixa taxa de `mention-only` ou estrategia definida para conviver com ela;
- exemplos reais de tokens que cruzariam o threshold de `priceChange1h`;
- confirmacao de que blocklist/admin ban esta sendo aplicada antes de qualquer publish.

## Pontos importantes

- O RPC nao sabe nossos banidos; a protecao fica no backend.
- Event-driven nao significa custo zero; bytes recebidos importam.
- `transactionDetails: full` e util para teste, mas talvez caro para producao.
- PumpSwap deve entrar, mas com gates.
- Meteora deve entrar, mas precisa volume por stablecoin.
- Raydium AMM v4 deve ser monitorado com atencao por custo/ruido.
- Nao ligar alerta real antes de termos agregacao por janela.
- Nao misturar bonding curve com PumpSwap.
- O transporte `logs` economiza WS, mas troca parte do custo por HTTP `getTransaction`.
- A fila do transporte `logs` agora tem limite configuravel e drop controlado.
- Drop de fetch pode perder trades e afetar `priceChange1h`; por isso `dropped` precisa ficar visivel nos dry-runs longos.

## Validacao obrigatoria ao mexer nesta area

Rodar testes afetados:

```bash
node --test \
  tests/quicknode-onchain-dry-run.test.js \
  tests/quicknode-onchain-continuous-dry-run.test.js \
  tests/quicknode-onchain-log-transaction-stream.test.js \
  tests/quicknode-onchain-price-worker.test.js \
  tests/quicknode-onchain-price-observation.test.js \
  tests/quicknode-onchain-price-change-tracker.test.js \
  tests/quicknode-onchain-ingestion.test.js \
  tests/quicknode-onchain-event.test.js \
  tests/quicknode-onchain-transaction-stream.test.js \
  tests/quicknode-onchain-window-aggregator.test.js \
  tests/quicknode-transaction-probe.test.js
```

Rodar lint:

```bash
npm run lint
```

Quando mexer em schema/init:

```bash
npm run db:schema-check
```

Nao precisa build frontend se nao houver mudanca em frontend.

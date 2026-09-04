# Plano — arquitetura realtime Robinhood sem `eth_getLogs` no caminho live

Status: em implementação; journal/capturador shadow e auditoria de cobertura concluídos

Prioridade: crítica

Escopo: captura on-chain, discovery, market, liquidez, holders, creators,
wallet-swaps, publicação e freshness da interface

## 1. Decisão executiva

O runtime live da Robinhood terá uma única entrada canônica da cadeia. Essa
entrada será acionada por novos blocos e lerá bloco + receipts uma única vez.
Nenhum worker live poderá executar `eth_getLogs`.

Os eventos capturados serão persistidos antes de qualquer processamento de
domínio e distribuídos por filas duráveis no PostgreSQL. Discovery, market,
liquidez, holders, creators e wallet-swaps reagirão a essas filas por
`LISTEN/NOTIFY`, com polling apenas como fallback de recuperação.

O objetivo de latência em regime saudável é:

- p95 de até 500 ms entre o receipt estar disponível no node e a projeção
  correspondente ser publicada;
- p99 de até 1 segundo;
- nenhuma espera artificial no hot path;
- nenhum dado atrasado apresentado silenciosamente como atual.

Zero milissegundo absoluto não é uma garantia possível: o bloco precisa ser
produzido, propagado e disponibilizado pelo node, e banco/processos podem falhar.
O contrato garantido pela arquitetura é ausência de atraso intencional,
isolamento de falhas, medição ponta a ponta e fail-closed quando o SLO não puder
ser cumprido.

## 2. Evidência e problema atual

O node local pode ser compartilhado por vários processos. O incidente não é
causado simplesmente pelo número de clientes RPC, mas pela concorrência no
índice caro de logs do Nitro.

Medições feitas na VPS2 durante o incidente:

- `eth_getLogs` para um único bloco: aproximadamente 13,45 s;
- `eth_getBlockReceipts` para o mesmo bloco: aproximadamente 22 ms.

O código atual ainda possui leitores live independentes:

- `robinhood-head` usa um poller `eth_getLogs` para discovery;
- `robinhood-head` usa outro poller `eth_getLogs` para market;
- `robinhood-liquidity` usa `eth_getLogs` por tópicos;
- holder-transfer ainda possui caminhos por `eth_getLogs`;
- cada leitor mantém range, cursor, retry e interpretação de reorg próprios.

O repositório já possui a base para o redesenho: capturas duráveis,
processamento por lease, outboxes, `LISTEN/NOTIFY` e publicação derivada. A
mudança deve evoluir essa base, sem introduzir Kafka ou Redis.

## 3. Definição de realtime

Neste plano, realtime significa:

1. receber o novo head sem intervalo periódico normal;
2. capturar o bloco assim que seus receipts estiverem disponíveis;
3. tornar o evento durável antes de consumi-lo;
4. acordar consumidores no commit, sem aguardar o próximo tick;
5. publicar cada projeção assim que sua transação terminar;
6. expor a idade e a fronteira de cada dado para impedir falsa atualidade.

O SLO é contado a partir de `receiptAvailableAt`, e não do timestamp nominal do
bloco. A telemetria também registra o tempo desde `newHeadObservedAt` para medir
se o node demora a disponibilizar receipts.

Dados externos, como imagens, redes sociais ou APIs de terceiros, não fazem
parte do SLO on-chain. Eles continuam assíncronos e nunca podem bloquear preço,
volume, liquidez, holders ou swaps live.

## 4. Topologia alvo

```text
Nitro local
  |
  | WebSocket newHeads
  | fallback eth_blockNumber (100–250 ms)
  |
  v
robinhood-chain-capture
  |
  | eth_getBlockByNumber + eth_getBlockReceipts
  | validação canônica + commit atômico
  |
  v
PostgreSQL: block journal + event journal + domain outboxes
  |
  | COMMIT + pg_notify
  |
  +--> discovery projection
  +--> market projection
  +--> liquidity projection
  +--> holder-transfer projection
  +--> creator projection
  +--> wallet-swap projection
           |
           v
      derived outbox
           |
           v
      relay/WebSocket
           |
           v
        interface
```

PostgreSQL é a fonte durável. `NOTIFY` é apenas o sinal de wake-up: perder uma
notificação não perde o evento, porque o consumidor retoma pela fila/cursor.

## 5. Componentes e responsabilidades

### 5.1 Captura canônica

Responsabilidade única: copiar a cadeia relevante para uma fronteira durável.

O capturador:

- recebe `newHeads` por WebSocket;
- usa polling curto somente quando a assinatura estiver indisponível;
- percorre blocos em ordem, sem saltar gaps;
- lê bloco e receipts em paralelo;
- em catch-up, busca receipts em batches limitados e persiste em ordem;
- valida chain ID, número, hash, parent hash, transações, receipts e logs;
- extrai `tx.from`, `tx.to`, `receipt.contractAddress` e logs relevantes;
- grava bloco, eventos, fan-out e cursor na mesma transação;
- dispara `pg_notify` somente após a durabilidade estar garantida;
- nunca espera valuation, metadata externa, alertas ou consumidores.

O capturador não calcula projeções finais e não executa chamadas históricas que
possam travar seu cursor.

### 5.2 Journal canônico

O journal não precisa guardar receipts completos indefinidamente. O contrato
mínimo contém:

- bloco: número, hash, parent hash, timestamp e estado canônico;
- transação relevante: hash, índice, `from`, `to`, status e
  `contractAddress` quando aplicável;
- log relevante: endereço, topics, data, índice global, transaction hash,
  transaction index, block number e block hash;
- tempos monotônicos de observação, disponibilidade, commit e publicação;
- versão do roteador/decoder.

Identidades incluem block hash. Um mesmo número de bloco em duas ramificações
não pode ser tratado como o mesmo evento.

O armazenamento será limitado aos tópicos e transações necessários ao bot. O
volume de `Transfer` será medido antes de definir retenção e particionamento. As
projeções permanentes sobrevivem à poda do journal.

### 5.3 Fan-out durável

Na mesma transação que avança o cursor de captura, o roteador cria trabalho para
os domínios aplicáveis. Cada domínio possui status, tentativas, lease, próximo
retry e dead-letter independentes.

Uma falha de liquidez não impede market. Uma falha de holders não impede
discovery. Nenhum consumidor altera o cursor da captura.

### 5.4 Projeções

Cada projeção usa o evento durável como gatilho primário:

- discovery registra factories, pools e tokens;
- market decodifica swaps e atualiza observações/buckets;
- liquidity mantém estado por eventos e atualiza somente pools afetadas;
- holder-transfer aplica `Transfer` aos tokens acompanhados;
- creator usa `tx.from`, `contractAddress` e eventos de launchpads;
- wallet-swap combina a observação com `tx.from`, sem reler o bloco.

Quando houver dependência causal, ela será explícita. Um swap de uma pool criada
no mesmo bloco só pode ser projetado depois do evento de discovery anterior na
ordem on-chain. Não serão introduzidos sleeps para tentar resolver essa ordem.

## 6. Liquidez realtime

O worker atual reage ao evento, mas depois relê o estado de todas as pools
afetadas e mantém um scan próprio de logs. O alvo é diferente:

- V2: reservas atualizadas diretamente por `Sync`;
- V3: estado incremental por `Initialize`, `Mint`, `Burn`, `Collect`, `Swap` e
  `Flash`;
- V4: estado incremental por `Initialize`, `ModifyLiquidity`, `Swap` e
  `Donate`;
- chamadas `eth_call latest` ficam restritas a cold start, validação ou dado que
  não possa ser derivado do evento;
- reconciliação completa roda fora do hot path e nunca move seu cursor.

A projeção grava o snapshot e sua outbox de publicação na mesma transação. Uma
liquidez que falhar fica marcada como indisponível/stale para aquela pool, sem
congelar os demais mercados.

## 7. Dados observados e finalizados

Esperar confirmações sempre adiciona blocos de atraso. Portanto existirão duas
fronteiras:

- `observed`: bloco mais recente recebido e projetado, ainda sujeito a reorg;
- `finalized`: bloco que atingiu a profundidade de confirmação configurada.

A interface realtime usa `observed` por padrão e recebe correções de reorg. A
fronteira `finalized` fica disponível para regras que exigem maior certeza.

Cada payload público inclui no mínimo:

- `asOfBlock`;
- `asOfBlockHash`;
- `observedAt`;
- `publishedAt`;
- `ageMs`;
- `finality` (`observed` ou `finalized`).

## 8. Reorg centralizado

Reorg é responsabilidade da captura, não de cada worker RPC.

Antes de anexar um bloco, o capturador valida `parentHash` contra o checkpoint.
Ao detectar divergência:

1. encontra o último ancestral comum dentro da profundidade suportada;
2. marca blocos/eventos antigos como não canônicos;
3. cria tombstones/reversões nas filas dos domínios;
4. reaplica a nova ramificação em ordem;
5. publica correções idempotentes para a interface.

Se a divergência ultrapassar a janela automática, o runtime entra em estado
`recovery_required`; nunca avança o cursor por skip.

Regressão temporária de safe head sem mudança de hash resulta em espera, não em
halt permanente.

## 9. Política RPC

### Permitido no live

- `eth_chainId` com cache;
- `eth_blockNumber` como fallback;
- `eth_getBlockByNumber`;
- `eth_getBlockReceipts`;
- `eth_call latest` limitado e cacheado quando estritamente necessário.

### Proibido no live

- `eth_getLogs`;
- scans históricos abertos;
- traces ou repairs concorrendo com captura;
- chamadas por evento que possam ser satisfeitas pelo bloco/receipt já lido.

O cliente RPC terá uma role explícita. Uma tentativa de `eth_getLogs` por role
live falha imediatamente e incrementa uma métrica crítica.

Backfill, auditoria e repair podem possuir uma role de manutenção, mas precisam:

- adquirir uma lease RPC exclusiva de baixa prioridade;
- começar somente com capture lag zero;
- pausar automaticamente se o lag live reaparecer;
- respeitar limites de range, batch, concorrência e timeout;
- nunca compartilhar a unit do capturador.

## 10. Ordem, paralelismo e backpressure

- captura é estritamente ordenada por bloco;
- fetch de catch-up pode ser paralelo, mas commit permanece ordenado;
- logs dentro do bloco seguem `(transactionIndex, logIndex)`;
- projeções podem paralelizar chaves diferentes;
- a mesma pool, token ou wallet preserva ordem causal;
- filas possuem limites, retry e dead-letter por domínio;
- consumidores lentos não reduzem a velocidade da captura;
- publicação acontece somente depois do commit da projeção.

O capturador possui conexões PostgreSQL e orçamento de recursos reservados. Jobs
de manutenção e queries pesadas não podem usar essa reserva.

## 11. Latência e observabilidade

Orçamento inicial em regime saudável:

| Etapa | p95 alvo |
|---|---:|
| `newHeads` até início do fetch | 50 ms |
| bloco + receipts disponíveis | 100 ms |
| validação + commit do journal | 50 ms |
| `NOTIFY` + claim do consumidor | 50 ms |
| decode + projeção principal | 200 ms |
| outbox + relay/WebSocket | 50 ms |
| total após receipt disponível | 500 ms |

Métricas obrigatórias:

- `captureLagBlocks` e `captureAgeMs`;
- `receiptAvailabilityMs`;
- `journalCommitMs`;
- `notifyToClaimMs` por domínio;
- `eventToProjectionMs` por domínio;
- `projectionToPublishMs`;
- `endToEndMs` p50/p95/p99;
- backlog, idade mais antiga, retries e dead-letters por fila;
- contagem de tentativas proibidas de `eth_getLogs`;
- estado do WebSocket e uso do fallback.

Heartbeat não substitui progresso: um processo vivo com cursor parado continua
não saudável.

## 12. Contrato de freshness da interface

Toda rota que apresenta dados live deve retornar a fronteira usada. O frontend
não pode assumir que uma resposta HTTP 200 significa dado atual.

Estados mínimos:

- `live`: projeção dentro do SLO e alinhada ao capture frontier aplicável;
- `degraded`: evento atual existe, mas um enriquecimento secundário está stale;
- `syncing`: projeção principal ultrapassou o limite de idade;
- `unavailable`: fonte ou invariantes canônicos falharam.

Quando `syncing` ou `unavailable`, a interface não apresenta dado antigo como se
fosse atual. Pode exibir o último valor somente se estiver explicitamente
marcado com bloco e idade.

O initial load lê a projeção materializada e, antes de responder `live`, compara
seu watermark com a captura. Atualizações posteriores chegam pelo relay/WebSocket.

## 13. Recuperação e catch-up

Após reinício:

1. a captura retoma do último bloco commitado;
2. busca receipts em batches limitados;
3. valida e persiste em ordem;
4. consumidores drenam suas filas independentemente;
5. readiness só volta a `live` quando as projeções obrigatórias entram no SLO.

O objetivo de catch-up é processar muito mais rápido que a produção da cadeia.
O batch será ajustado com métricas da VPS2; não haverá range adaptativo baseado
em `eth_getLogs`.

## 14. Rollout incremental

Esta arquitetura ultrapassa 12 arquivos de produção e exige schema. Estimativa
inicial: 20–30 arquivos e 2.500–3.500 linhas, sempre divididas em fatias menores
que 500 linhas.

### Fatia 1 — contrato e schema canônico

- tabelas de blocos/eventos e cursor único;
- identidades e invariantes de canonicalidade;
- timestamps necessários ao SLO;
- repositório transacional e testes de schema/persistência;
- nenhuma mudança no runtime ativo.

### Fatia 2 — capturador por receipts

- listener `newHeads` com fallback curto;
- fetch/validação de bloco + receipts;
- commit ordenado e telemetria;
- worker e lease próprios, atrás de flag;
- shadow sem publicar projeções.

### Fatia 3 — discovery e market

- roteamento dos eventos capturados (3A concluída em shadow com outbox atômica);
- claim/lease e comparação com o legado (3B concluída, ainda sem processo runtime);
- consumo por `LISTEN/NOTIFY` (3C concluída como processo shadow isolado);
- preservação da evidência e idempotência atuais;
- comparação com `robinhood_head_captures` existente;
- cutover dos dois pollers `eth_getLogs` do head.

Pré-requisito concluído na Fatia 2B: auditoria de todos os workers, contexto de
transação v2 (`nonce`/`value`) e enforcement de RPC local sem throttle.

### Fatia 4 — liquidez event-sourced

- outbox de atividade de pool;
- projeção incremental V2/V3/V4;
- cold-start/reconciliação isolados;
- remoção do scan `eth_getLogs` do liquidity;
- publicação de snapshot e freshness.

### Fatia 5 — transfers, creators e wallet-swaps

- holder-transfer passa a consumir eventos capturados;
- creator recebe contexto de transação/receipt;
- wallet-swap recebe `tx.from` sem reler blocos;
- cursores antigos preservados para rollback operacional.

### Fatia 6 — enforcement, interface e cutover final

- bloqueio de `eth_getLogs` por role live;
- gate de backfill/repair baseado no capture lag;
- readiness e freshness por projeção;
- observed/finalized e correções de reorg no relay;
- remoção dos caminhos live legados após canário.

Cada fatia possui aprovação, validação e commit próprios. Nenhuma fatia pode
exceder 500 linhas sem autorização explícita.

## 15. Estratégia de canário e cutover

1. Capturador por receipts roda em shadow, com cursor próprio.
2. Eventos do shadow são comparados por identidade com as capturas já gravadas,
   sem emitir um novo `eth_getLogs` de auditoria.
3. Divergências são resolvidas antes do cutover.
4. Discovery/market mudam para a nova fonte primeiro.
5. Liquidity muda em seguida e seu serviço antigo permanece parado.
6. Holder-transfer, creator e wallet-swap migram separadamente.
7. O bloqueio global de `eth_getLogs` live é ativado por último.
8. Cursores/tabelas legados permanecem durante a janela de rollback.

Não haverá dual-write não idempotente nem dois publicadores ativos para a mesma
projeção.

## 16. Critérios de aceite

A arquitetura só está concluída quando:

- nenhuma unit live executa `eth_getLogs`;
- cada bloco é lido por receipts uma única vez pelo capturador canônico;
- captura continua avançando quando qualquer consumidor é pausado;
- pausar liquidity não altera capture/market lag;
- pausar holders não altera os demais fluxos;
- wallet-swap não relê bloco para descobrir `tx.from`;
- reorg de teste reverte e reaplica todas as projeções afetadas;
- perda de `NOTIFY` recupera pela fila sem perda;
- reinício no meio do commit não cria skip nem duplicação;
- initial load nunca reporta `live` com watermark stale;
- p95 e p99 cumprem o SLO durante canário sustentado;
- catch-up converge enquanto a cadeia continua produzindo blocos;
- backfill/repair pausa automaticamente diante de capture lag;
- métricas permitem localizar atraso em uma etapa específica.

## 17. Validação por camada

- unit: validação de bloco/receipt, roteamento, ordenação, finality e políticas
  de RPC;
- integração PostgreSQL: commit atômico, cursor, outbox, claims, retries,
  idempotência e reorg;
- integração de workers: captura independente de consumidores e recuperação de
  notificação perdida;
- smoke: evento do node simulado até relay/frontend com medição ponta a ponta;
- canário VPS2: SLO, carga do node, backlog e comparação com o caminho atual.

## 18. Estado operacional durante a implementação

Até o cutover:

- manter `robinhood-liquidity` parado enquanto ele depender de `eth_getLogs`;
- não executar repairs/scans concorrentes durante recuperação do head;
- implantar o direct-creator baseado em receipts antes de reativar seu grupo;
- manter monitoramento separado dos cursores discovery, market e wallet;
- não apagar cursores ou filas existentes para acelerar catch-up.

## 19. Decisões que serão confirmadas na Fatia 2

- endpoint WebSocket e comportamento real de `newHeads` no Nitro local;
- disponibilidade de receipts imediatamente após o anúncio do header;
- batch/concurrency sustentáveis durante catch-up;
- volume de logs `Transfer` e retenção necessária;
- profundidade de reorg automática;
- limites finais de p95/p99 após baseline medido na VPS2.

Essas medições calibram limites; não alteram a decisão de eliminar
`eth_getLogs` do runtime live.

## 20. Relação com documentos existentes

Este plano evolui `docs/robinhood-live-head-isolation-urgent-plan.md` e preserva
seus princípios de isolamento, evidência durável e consumidores independentes.
Para o novo alvo, substitui a captura live por `eth_getLogs` e a duplicação de
leitores RPC por uma entrada única baseada em receipts.

`docs/robinhood-head-capture-evidence-contract.md` continua sendo a referência
do conteúdo necessário à reconstrução das observações até que uma fatia altere
explicitamente esse contrato.

`docs/bot-reference.md` descreve o runtime efetivamente implantado e só deve ser
atualizado conforme cada mudança entrar em produção; este documento não muda o
estado operacional sozinho.

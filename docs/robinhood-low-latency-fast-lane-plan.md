# Robinhood low-latency fast lane plan

Documento de decisao e execucao para reduzir a latencia entre um swap entrar em
um bloco da Robinhood Chain e o bot avaliar esse swap.

Data inicial: 2026-07-14.

## Status

Planejamento concluido e probe WebSocket validado. Implementacao adiada ate o
bot Robinhood terminar os blocos funcionais definidos em
`docs/robinhood-chain-onchain-monitoring-plan.md`.

Este documento nao autoriza ativar WebSocket, alterar cursores, publicar
alertas ou substituir o worker persistente atual.

## Objetivo

Adicionar uma fast lane event-driven que receba logs V2 em menos de poucos
segundos depois do bloco, calcule observacoes e avalie os gates em memoria.

O worker HTTP atual continua sendo a fonte duravel que:

- garante cobertura por cursor;
- confirma blocos antes de persistir;
- recupera gaps e reinicios;
- detecta reorgs;
- grava ledger, observacoes, buckets e cursor atomicamente.

O objetivo nao e tornar o WebSocket a fonte de verdade. O objetivo e separar
baixa latencia de durabilidade.

## Evidencia medida

Probe read-only executado em `2026-07-14` contra o endpoint Alchemy WebSocket
Robinhood mainnet ja configurado:

```text
chainId: 4663
duracao: 11,491 segundos
logs V2: 200
blocos: 52
Sync: 100
Swap: 100
removed: 0

delay contra timestamp do bloco:
min: 106 ms
p50: 588 ms
p90: 995 ms
max: 1.095 ms
```

O timestamp EVM possui precisao de segundos. Esses numeros servem para comparar
ordem de grandeza, nao como SLA de milissegundos.

A medicao confirma que o atraso de aproximadamente 7-13 segundos observado no
worker nao e uma limitacao inevitavel da Robinhood Chain. Ele vem principalmente
do caminho HTTP sequencial, confirmacoes, polling, enriquecimento e persistencia.

## Estado atual do codigo

O runner Robinhood declara explicitamente:

```text
transport.kind=http-polling
```

O ciclo atual:

```text
poll discovery
  -> processar e persistir discovery
  -> poll market
  -> enriquecer timestamps/metadata
  -> persistir logs, observacoes, buckets e cursor
  -> esperar o proximo ciclo
```

Controles relevantes:

- `ROBINHOOD_POLL_INTERVAL_MS=2000`;
- `ROBINHOOD_CONFIRMATIONS=2`;
- discovery executa antes de market;
- qualquer falha impede o avanco do range inteiro;
- o sinal do Bloco 11 usa buckets de minuto fechado e comando manual.

Reduzir somente polling ou confirmacoes nao resolve o problema estrutural e
aumenta 429/reorg sem criar entrega event-driven.

## Arquitetura alvo

```text
                       Robinhood Chain
                              |
             +----------------+----------------+
             |                                 |
     Alchemy WebSocket                  HTTP JSON-RPC atual
       sem confirmacao                   duas confirmacoes
             |                                 |
       FAST LANE                         DURABLE LANE
             |                                 |
  ordenar bloco/logIndex               cursor persistente
             |                         reorg + gap recovery
  decode + enrich minimo               commit transacional
             |                                 |
  janela rolling em memoria            observacoes + buckets
             |                                 |
  expected signal dry-run         reconciliacao/idempotencia
             +----------------+----------------+
                              |
                     status administrativo
```

## Decisoes arquiteturais

### 1. Usar Alchemy WebSocket na fast lane

A documentacao Robinhood recomenda Alchemy para infraestrutura de producao e
publica o endpoint mainnet:

```text
wss://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}
```

O RPC publico permanece rate-limited e nao e indicado pela propria Robinhood
para aplicacoes sensiveis a latencia.

A URL WebSocket deve ser configurada explicitamente. Nao derivar ou imprimir a
API key em logs/status.

### 2. Preservar o worker HTTP

A fast lane nunca deve:

- gravar `robinhood_ingestion_cursors`;
- declarar cobertura historica;
- substituir `robinhood_processed_logs` como ledger duravel;
- reduzir `ROBINHOOD_CONFIRMATIONS` do writer;
- impedir o worker HTTP de reprocessar o mesmo evento;
- transformar queda WebSocket em perda silenciosa.

### 3. Comecar V2-only

O rollout de sinais do Bloco 11 esta explicitamente limitado a
`uniswap-v2`. A primeira fast lane acompanha:

- `PairCreated` no factory V2;
- `Sync` nos pares;
- `Swap` nos pares.

V3/V4 continuam fora da avaliacao de sinais enquanto nao houver liquidez USD
confiavel por ticks/posicoes e autorizacao explicita.

### 4. Preservar ordem dos logs V2

O tracker V2 usa `Sync` para atualizar reservas e `Swap` para construir a
observacao. Mensagens WebSocket nao devem ser processadas cegamente na ordem de
chegada.

Regra:

1. agrupar por bloco e transacao durante um buffer curto e limitado;
2. ordenar por `blockNumber`, `transactionIndex` e `logIndex`;
3. processar `Sync` antes do `Swap` conforme a ordem canonica do receipt;
4. rejeitar log incompleto em vez de inventar reservas;
5. medir quanto o buffer adiciona a latencia.

Buffer inicial sugerido: entre 25 e 100 ms, sujeito a probe.

### 5. Deduplicar fast e durable lanes

Identidade canonica de evento:

```text
chain + transactionHash + logIndex
```

Estados conceituais:

```text
previewed -> durable-confirmed
previewed -> removed/reorged
durable-only
```

A fast lane mantem dedupe em memoria com TTL e limite. A durable lane continua
usando o ledger PostgreSQL. A reconciliacao compara as duas sem impedir o commit
HTTP.

### 6. Tratar reconnect e gaps

O cliente WebSocket precisa de:

- validacao `eth_chainId=4663` antes de assinar;
- heartbeat/ping-pong;
- timeout de conexao e de subscribe;
- backoff exponencial com jitter e teto;
- resubscribe com novos IDs;
- watermark efemero do ultimo bloco visto;
- `eth_getLogs` HTTP limitado para preencher o gap do reconnect;
- dedupe entre replay do gap e mensagens live;
- limites de memoria, bytes e tamanho do gap.

Se o gap ultrapassar o limite da fast lane, ela deve marcar o estado como
`degraded` e esperar a reconciliacao duravel. Nunca alegar continuidade falsa.

### 7. Tratar reorgs como preview

Logs WebSocket podem chegar com `removed=true`.

Enquanto a fast lane estiver em dry-run:

- remover o evento da janela rolling;
- incrementar metrica de reorg;
- registrar que o expected signal foi retraido;
- nunca alterar diretamente buckets persistidos.

Antes de alertas reais sera obrigatorio decidir se o produto aceita alertas
zero-confirmation ou se exige uma confirmacao curta antes da entrega.

## Sinal de baixa latencia

O reader SQL atual usa apenas minutos fechados. Ele deve continuar existindo
como comparador duravel, mas nao pode alimentar a fast lane.

A fast lane precisa de uma janela rolling em memoria por mercado/token:

- duracao: 5 minutos;
- liquidez minima V2: USD 3.000;
- volume minimo: USD 1.000;
- transacoes minimas: 10;
- idade maxima: 24 horas;
- admin blocklist chain-aware;
- quotes suportadas: WETH e USDG;
- `publishable=false` durante todo o soak inicial.

Cada observacao aceita atualiza a janela imediatamente. O dry-run registra a
transicao de `suppressed` para `expected-signal`, nao gera um sinal repetido a
cada swap.

Antes de entrega real sera necessario definir:

- cooldown por token/mercado;
- idempotency key do sinal;
- politica para multiplos pools do mesmo token;
- reconciliacao com o sinal baseado em buckets persistidos;
- comportamento quando metadata/quote estiver temporariamente indisponivel.

## Fases de implementacao

Cada fase deve manter aproximadamente ate 300 linhas de producao e possuir um
aceite independente.

### Fase 0 - Probe concluido

- confirmar endpoint e chain ID;
- assinar `Sync`/`Swap` V2;
- medir latencia e volume;
- nao persistir nem publicar.

### Fase 1 - Transporte EVM WebSocket

Estimativa: 180-230 linhas de producao.

- cliente JSON-RPC WebSocket provider-agnostic;
- state machine de conexao/subscribe;
- heartbeat, reconnect e jitter;
- normalizacao de logs;
- watermark/gap callback;
- snapshot administrativo;
- testes unitarios com socket falso.

### Fase 2 - Adapter Robinhood V2

Estimativa: 150-220 linhas de producao.

- carregar registry V2 ativo;
- assinatura separada de discovery e market;
- filtro antecipado de emitters desconhecidos;
- buffer ordenado por bloco/transacao/log;
- pipeline V2 com rollback e memoria limitados;
- callback de observacao preview;
- nenhuma escrita de cursor.

### Fase 3 - Gates rolling em dry-run

Estimativa: 120-180 linhas de producao.

- janela rolling de cinco minutos;
- gates calibrados do Bloco 11;
- transicao edge-triggered para expected signal;
- blocklist e identidade chain-aware;
- reconciliacao com buckets/worker;
- `publishable=false` invariavel.

### Fase 4 - Operacao e soak

Estimativa: 70-120 linhas de producao/status.

- configurar processo isolado ou integrar no worker Robinhood;
- status, health e metricas administrativas;
- soak comparativo;
- teste de queda/reconnect;
- teste de restart e memoria;
- runbook e rollback.

### Fase 5 - Publicacao real

Fora do escopo deste plano ate catalogo, matcher, entrega e frontend Robinhood
estarem concluídos e houver autorizacao explicita.

## Variaveis propostas

Nomes finais devem ser confirmados contra o codigo na retomada:

```text
ROBINHOOD_FAST_LANE_ENABLED=false
ROBINHOOD_FAST_LANE_WS_URL=
ROBINHOOD_FAST_LANE_PROTOCOLS=uniswap-v2
ROBINHOOD_FAST_LANE_RECONNECT_MIN_MS=500
ROBINHOOD_FAST_LANE_RECONNECT_MAX_MS=30000
ROBINHOOD_FAST_LANE_HEARTBEAT_MS=15000
ROBINHOOD_FAST_LANE_LOG_BUFFER_MS=50
ROBINHOOD_FAST_LANE_DEDUPE_LIMIT=50000
ROBINHOOD_FAST_LANE_GAP_MAX_BLOCKS=1000
ROBINHOOD_FAST_LANE_DRY_RUN=true
```

Nao adicionar a chave real ao repositorio ou a status administrativo.

## Metricas obrigatorias

Transporte:

- conexoes/reconexoes;
- subscribe/resubscribe;
- mensagens, logs e bytes;
- ping RTT;
- ultimo bloco recebido;
- gaps detectados/preenchidos/abandonados;
- erros e rate limits por provider.

Latencia:

- `receivedAt - blockTimestamp`;
- tempo no buffer de ordenacao;
- tempo de decode/enrichment;
- tempo ate observacao aceita;
- tempo ate expected signal;
- p50/p90/p95/p99 e maximo.

Qualidade:

- previewed;
- durable-confirmed;
- durable-only;
- duplicates;
- removed/reorged;
- emitters desconhecidos;
- observacoes rejeitadas por motivo;
- divergencias fast vs durable.

Memoria:

- logs no buffer;
- identidades no dedupe;
- mercados/tokens na janela;
- eventos rolling;
- heap usado e high-water mark.

## Criterios de aceite antes de publicacao

Aceite de transporte:

- p50 menor que 1,5 segundo e p95 menor que 3 segundos contra timestamp do
  bloco em soak representativo;
- nenhuma chave/URL secreta em logs ou status;
- reconnect automatico comprovado;
- nenhuma memoria sem limite.

Aceite de completude:

- 100% dos eventos fast lane reconciliados com a durable lane ou explicados
  como removidos/rejeitados;
- zero volume persistido em duplicidade;
- gap forcado recuperado ou marcado `degraded` sem alegar cobertura;
- restart sem perder a capacidade de reconciliar pelo worker HTTP.

Aceite de sinais:

- mesmo resultado dos gates quando fast e durable possuem a mesma janela;
- expected signal edge-triggered e idempotente;
- blocklist aplicada antes da decisao;
- `publishable=false` e zero tentativas de entrega durante o soak;
- decisao explicita sobre confirmacoes antes da primeira publicacao real.

Soak minimo sugerido:

1. 30 minutos para transporte e memoria;
2. 2 horas com reconnect forcado;
3. overnight para distribuicao de latencia e reconciliacao;
4. periodo maior antes de alertas reais, conforme volume observado.

## Testes proporcionais ao risco

Unitarios:

- state machine WebSocket;
- backoff/jitter;
- ordenacao `Sync`/`Swap`;
- dedupe e TTL;
- janela rolling e edge trigger;
- `removed=true`;
- limites de memoria.

Integracao:

- registry -> adapter -> pipeline -> expected signal;
- reconnect -> gap fill -> dedupe;
- fast preview -> durable confirmation;
- admin blocklist chain-aware;
- status sem segredo.

Smoke live:

- subscribe chain ID 4663;
- receber `Sync` e `Swap` reais;
- comparar hashes/indices com `eth_getLogs`;
- medir latencia sem escrita/publicacao.

Nao repetir em integracao todas as variacoes ja protegidas nos testes
unitarios.

## Rollback

O rollback operacional deve ser uma unica variavel:

```text
ROBINHOOD_FAST_LANE_ENABLED=false
```

Ao desligar:

- encerrar socket e timers;
- limpar buffers/TTL em memoria;
- manter worker HTTP e cursores intactos;
- nao apagar observacoes/buckets;
- status deve mostrar `disabled`, nao `healthy`.

Como a fast lane nao controla cursores, seu rollback nao exige rewind ou
correcao do banco.

## Riscos

- Alchemy Free pode limitar conexoes, subscriptions, bytes ou throughput;
- mensagem WebSocket pode chegar fora de ordem;
- reconnect pode misturar replay e eventos live;
- novo pool pode trocar antes do registry local ser atualizado;
- metadata/quote RPC pode dominar a latencia depois do transporte;
- liquidez V2 permanece estimativa spot manipulavel;
- zero-confirmation pode sofrer reorg;
- uma janela rolling diferente do SQL pode divergir se limites temporais nao
  forem definidos de forma identica;
- publicar preview sem idempotencia pode duplicar alertas quando a durable lane
  confirmar o mesmo evento.

## Alternativas rejeitadas inicialmente

### Apenas reduzir polling/confirmacoes

Nao cria push, aumenta requests/429 e enfraquece seguranca do writer.

### Substituir o worker HTTP por WebSocket

WebSocket nao oferece cursor duravel nem garantia de replay. Uma desconexao
pode perder eventos silenciosamente.

### Gravar cursor pela fast lane

Mistura preview sem confirmacao com cobertura duravel e pode pular ranges.

### Usar o Sequencer Feed como primeira versao

O feed pode antecipar dados do sequencer, mas nao entrega diretamente o receipt
executado e seus logs `Sync`/`Swap`. Obter o resultado exigiria reexecucao ou
inferencia especulativa. Pode ser reavaliado somente depois de a fast lane de
logs estar estavel e medida.

## Estimativa total

Estimativa inicial para Fases 1-4:

- 550-750 linhas de producao;
- testes e documentacao adicionais proporcionais aos contratos;
- implementacao obrigatoriamente dividida em blocos menores;
- nenhuma fase deve ativar publicacao implicitamente.

## Checklist para retomar

1. Concluir o roadmap funcional Robinhood atual.
2. Revalidar a documentacao e os limites do provider.
3. Repetir o probe WebSocket e registrar nova distribuicao.
4. Confirmar custo/quota Alchemy do ambiente de deploy.
5. Confirmar se o primeiro alvo continua V2-only.
6. Implementar apenas a Fase 1.
7. Rodar lint e testes afetados.
8. Fazer smoke live read-only.
9. Revisar diff e atualizar este documento.
10. Avancar de fase somente depois do aceite anterior.

## Fontes

- Robinhood Chain, conexao e endpoints oficiais:
  <https://docs.robinhood.com/chain/connecting/>
- Robinhood Chain, operacao de full node e portas HTTP/WS:
  <https://docs.robinhood.com/chain/run-a-full-node/>
- Codigo atual: `src/services/robinhood-continuous-runner.js`.
- Pipeline atual: `src/services/robinhood-onchain-pipeline.js`.
- Persistencia atual: `src/models/robinhood-persistence.js`.
- Gates atuais: `src/services/robinhood-signal-policy.js`.

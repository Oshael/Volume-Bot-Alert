# Plano de execução — latência realtime da UI Robinhood

Status: em execução; Slices 0, 1 e 2 implementados; código do Slice 3 implantado
em rollout global pré-lançamento, com a observação temporal de retenção pendente;
Slice 4A implementado localmente e ainda não implantado

Prioridade: crítica

Escopo: captura, processamento, swaps, liquidez, holders, readiness e publicação
para a interface Robinhood

Documento relacionado:
[arquitetura realtime Robinhood](robinhood-zero-delay-realtime-architecture-plan.md).
O documento relacionado define o desenho amplo; este documento transforma o
diagnóstico atual em uma sequência curta de mudanças verificáveis.

## 1. Objetivo

Remover esperas periódicas do caminho live entre o node e a interface. Em
regime saudável, o bot deve:

- manter a captura em zero a dois blocos do head;
- acordar cada consumidor assim que o estado que ele consome estiver durável;
- publicar preço, volume, sparkline, swaps, liquidez e holders sem aguardar um
  próximo tick periódico;
- informar imediatamente quando a cobertura deixa de estar pronta;
- usar polling somente para recuperação, reconciliação, tarefas frias ou
  ausência comprovada de uma fonte de evento;
- medir a latência ponta a ponta, em vez de inferi-la apenas pelo lag em blocos.

Meta on-chain, contada a partir do receipt disponível no node:

- p95 de até 500 ms até a projeção ser publicada;
- p99 de até 1 segundo;
- nenhuma espera artificial no caminho saudável.

Zero milissegundo absoluto não é possível, pois bloco, receipt, commit e rede
têm custo real. O alvo é zero atraso deliberado.

## 2. Baseline comprovado

### 2.1 Captura

O capturador não é o gargalo observado. A amostra de produção mostrou:

- transporte em `polling_fallback` no momento da medição;
- `lag_blocks = 0`;
- três blocos processados em 59 ms;
- 8 ms de fetch, 4 ms de snapshot e 47 ms de commit;
- concorrência de fetch igual a 32;
- nenhum erro consecutivo.

O requisito operacional é configurar `ROBINHOOD_WS_URL` com uma URL WebSocket,
por exemplo `ws://127.0.0.1:8547`, e confirmar no status que o transporte está
`subscribed`. O polling curto permanece como fallback.

### 2.2 Cobertura e banco

Durante o problema de volume/sparkline, a captura e a fronteira estavam atuais,
mas havia consultas de catálogo e agregados levando vários segundos. Os dois
ajustes já aplicados preservam timestamps da fronteira de mercado e reidratam a
UI quando a cadeia recupera cobertura. Eles corrigem sintomas importantes, mas
não eliminam as esperas periódicas restantes.

### 2.3 Publicação atual

O navegador já força Socket.IO sobre WebSocket e recebe:

- `market:bucket`;
- `market:trade`;
- `holder:count`;
- `holder:invalidate`;
- `alert:event`.

O transporte final até o navegador não explica atrasos de dois a cinco
segundos. O atraso principal ocorre antes da publicação, em consumidores que
ainda descobrem trabalho por timer.

## 3. Gargalos confirmados

| Prioridade | Fluxo | Espera atual | Impacto esperado |
| --- | --- | --- | --- |
| P0 | processamento market/discovery | 1 s ativo, até 5 s ocioso | preço, FDV, volume, sparkline e alertas |
| P0 | wallet swap | tick de 2 s e 12 blocos de confirmação | swaps aparecem normalmente em 2–3 s |
| P1 | liquidez na UI | backend reage a evento, UI reconsulta em ciclo de ~15 s | LP pode ficar atrasada |
| P1 | readiness | HTTP periódico de ~30 s e cache backend | recuperação pode demorar ~35 s para aparecer |
| P1 | captura de holders | tick de 500 ms e 12 blocos | holder count/invalidação atrasados |
| P2 | ranking/top performers | snapshot periódico de ~15 s | entrada/saída e ordem dos tokens atrasam |
| P2 | relays PostgreSQL | reconnect de 5 s; `NOTIFY` é efêmero | evento pode depender da reconciliação após queda |

O refresh HTTP de trades a cada 5 s e a reconstrução histórica de sparklines a
cada 60 s são reconciliações. Eles não são o caminho live quando o socket está
saudável e devem continuar como rede de segurança.

## 4. Contrato arquitetural obrigatório

Cada mudança deste plano deve preservar as regras abaixo.

1. O produtor grava o estado e o item de outbox/cursor na mesma transação.
2. O `pg_notify` ocorre somente depois do commit.
3. `NOTIFY` serve para acordar; nunca é a fonte de verdade.
4. O consumidor retoma por cursor ou fila durável se perder a notificação.
5. Cada consumo é idempotente e tolera duplicação, retry e ordem parcial.
6. Reorg usa identidade com block hash e produz correção/reversão explícita.
7. Polling de fallback é limitado, incremental, observável e não concorre com o
   caminho live enquanto o listener está saudável.
8. Dados externos de metadata nunca bloqueiam dados on-chain.

Não será introduzido Kafka ou Redis. O PostgreSQL existente já oferece journal,
outbox, lease, cursor e `LISTEN/NOTIFY` suficientes para este escopo.

## 5. Orçamento de latência

Os clocks abaixo serão registrados para separar node, banco, worker, relay e
navegador:

| Marco | Significado |
| --- | --- |
| `headObservedAt` | `newHeads` recebido ou head detectado pelo fallback |
| `receiptAvailableAt` | bloco e receipts ficaram legíveis |
| `captureCommittedAt` | journal/captura foi confirmado no PostgreSQL |
| `projectionCommittedAt` | observação/bucket/swap/liquidez/holder foi confirmado |
| `publishedAt` | relay publicou o payload no Socket.IO |
| `clientReceivedAt` | navegador recebeu o payload |
| `clientAppliedAt` | estado visível foi atualizado |

Orçamento inicial de p95:

- node e captura: 150 ms;
- processamento e persistência: 200 ms;
- outbox e relay: 75 ms;
- rede e aplicação no cliente: 75 ms.

Os percentis devem ser agregados por fluxo e não registrados evento a evento
em log normal. O relógio do host e do banco precisa estar sincronizado; durações
locais monotônicas continuam sendo usadas para tempos internos.

## 6. Slices de implementação

Cada slice deve caber em até 500 linhas alteradas, possuir commit próprio e ser
implantável ou reversível sem depender do próximo slice.

### Slice 0 — telemetria ponta a ponta

Objetivo: medir antes de otimizar e impedir regressões invisíveis.

Progresso:

- [x] Slice 0A: `market:bucket`, do receipt até o estado aplicado no navegador;
- [x] Slice 0B: `market:trade` e alertas;
- [x] Slice 0C: liquidez, holders e readiness. Holders propagam os marcos do
  bloco canônico até a aplicação no painel; liquidez mede apenas avanços de
  `updated_at` após estabelecer um baseline local; readiness mede
  `checkedAt -> clientAppliedAt` e o intervalo real entre polls.

- propagar os marcos de latência pelos payloads internos;
- expor p50, p95, p99, idade do último evento e estado do listener por fluxo;
- distinguir espera por finalidade de espera por scheduling;
- adicionar alerta para listener desconectado, cursor parado e SLO excedido;
- não incluir dados de alta cardinalidade como endereço de token em métricas
  globais.

Gate:

- uma transação de teste pode ser rastreada de receipt até `clientAppliedAt`;
- dashboard/status separa `capture`, `processing`, `projection`, `relay` e
  `client`;
- a telemetria não adiciona mais de 5% ao p95 medido.

### Slice 1 — acordar `robinhood-processing` por evento

Objetivo: remover a espera de até 5 s antes de market/discovery.

Progresso: implementado. O gate de latência em produção permanece pendente da
próxima medição comparável.

- fazer o worker escutar o cursor durável já publicado pela captura/head;
- executar imediatamente quando o commit sinalizar trabalho novo;
- acumular wakes recebidos durante um run, sem rodadas concorrentes;
- manter o timer de 1 s como fallback de recuperação;
- remover o intervalo ocioso de 5 s do caminho normal;
- expor `listenerState`, `lastWakeAt`, `lastProgressAt`, `fallbackRuns` e
  `wakeToClaimMs`.

Gate:

- wake antes do commit não permite consumo;
- wake duplicado não duplica projeção;
- notificação perdida é recuperada pelo fallback;
- p95 de `captureCommittedAt` até `projectionCommittedAt` abaixo de 250 ms sem
  backlog;
- market e discovery continuam com leases independentes.

### Slice 2 — wallet swaps dirigidos por outbox durável

Objetivo: remover a descoberta de swaps por tick de 2 s e eliminar releitura de
bloco no caminho canônico.

- [x] Slice 2A: schema e producer shadow atômico, autocontido com o contexto do
  journal canônico e `NOTIFY` pós-commit;
- [x] Slice 2B: consumer por lease/finalidade, publicação recuperável e cutover
  do cursor antigo.

- criar um item durável de trabalho quando a observação market aceita estiver
  confirmada;
- incluir ou referenciar `tx.from`, block number, block hash, transaction hash e
  posição on-chain já disponíveis no journal;
- acordar o consumidor tanto quando houver nova observação quanto quando a
  fronteira de finalidade avançar;
- atribuir e persistir o wallet swap de forma idempotente;
- publicar `market:trade` depois do commit;
- conservar o poll de cursor somente como fallback de recuperação;
- impedir chamadas RPC por swap quando a fonte for o journal canônico.

Gate:

- replay da mesma outbox não duplica trade;
- queda entre persistência e publicação é recuperável;
- reinício com backlog retoma pelo cursor;
- ordem por bloco, transaction index e log index é estável;
- nenhum `eth_getBlockByNumber` ou equivalente é feito por trade no caminho
  canônico.

### Slice 3 — política explícita de finalidade dos swaps

Objetivo: separar segurança de reorg de latência aparente.

Progresso:

- [x] Slice 3A: contrato Socket.IO v2 e aplicação frontend preparados. Clientes
  v2 entram em salas separadas, recebem `market:trade:finalized` e entendem
  `observed`, `finalized` e `invalidate`; o fluxo continua finalizado-only.
- [x] Slice 3B1: outbox append-only e gravação shadow atômica de `observed`,
  ainda sem consumidor ou publicação.
- [x] Slice 3B2A: promoção durável, limitada e idempotente para `finalized` em
  shadow, acordada pelo avanço da finalidade canônica.
- [x] Slice 3B2B: recuperação central de reorg e gravação durável de
  `invalidate`, incluindo rollback das projeções afetadas.
- [ ] Slice 3B3: consumidor, publicação v2 e telemetria separada de lag
  observado/finalizado.

#### Checkpoint de retomada do Slice 3

Estado implementado até este checkpoint:

- o processing grava `observed` na Stage 204 junto do commit da observação;
- o wallet worker promove somente bloco/hash ainda canônico para `finalized`,
  em lotes limitados, e expõe `promoted`;
- `observed` e `finalized` continuam em shadow, sem consumer e sem chegar à UI;
- o frontend v2 já entende os três eventos, mas recebe apenas o fluxo finalizado
  legado/v2 existente;
- a recuperação canônica central já detecta, planeja, persiste e executa rewind
  somente atrás do manifesto de domínios; market, wallet, publicação, transfers,
  signed-origin, first-buy, liquidity, holders e discovery-creator possuem
  rollback e o manifesto está completo;
- a Stage 204 não deve ser limpa enquanto invalidação, consumo e retenção não
  estiverem prontos. Neste ponto ela tende a guardar duas linhas por swap maduro.

Ao retomar em outro contexto, o próximo trabalho é obrigatoriamente
**3B3A — consumer shadow da Stage 204**. Não iniciar 3B3B, Slice 4 ou qualquer
slice posterior antes de concluir esse consumer e sua auditoria shadow.

#### Slice 3B2B — recuperação de reorg, em cortes menores

**3B2B-0A — estado durável e fence de captura**

- [x] adicionar `generation`, `recovery_state`, plano e instante de detecção ao
  cursor canônico;
- [x] persistir `recovery_required` sob lock e conferir checkpoint/generation;
- [x] recusar novos commits com erro fatal enquanto o estado exigir recuperação;
- [x] não oferecer reset/resume antes de existir rollback seguro.

**3B2B-0B1 — planner limitado e inventário de rollback**

- [x] definir profundidade máxima suportada e fronteira finalizada que nunca pode
  ser revertida automaticamente;
- [x] localizar ancestral comum por número/hash com leituras RPC limitadas;
- [x] inventariar, com testes, toda projeção/cursor que referencia blocos na faixa;
- [x] manter todo domínio como não registrado, tornando o plano não executável;
- [x] não alterar canonicalidade em produção neste corte.

**3B2B-0B2 — integração do planner e fence de geração**

- [x] serializar detecção/planejamento sob a lease da captura, persistir o plano
  sob o lock do cursor e cercar commits com a geração lida antes do fetch;
- [x] transformar divergência do primeiro bloco em plano durável e parada
  observável do worker;
- [x] não alterar canonicalidade em produção enquanto algum domínio afetado não
  possuir rollback registrado.

**3B2B-1A — journal e evento durável de detecção**

- [x] persistir uma recuperação por geração com fases reiniciáveis;
- [x] gravar `chain:reorg:detected` em outbox at-least-once na mesma transação do
  fence do cursor;
- [x] importar idempotentemente um cursor que já esteja em `recovery_required`;
- [x] manter canonicalidade e cursor intactos neste corte.

**3B2B-1B — rewind canônico atômico, atrás do gate**

- [x] preservar a ramificação órfã para auditoria, marcar seus blocos como não
  canônicos e recuar o cursor ao ancestral comum numa única transação;
- [x] gravar geração, faixa órfã, hashes antigo/novo e estado da recuperação numa
  outbox durável antes de permitir recaptura;
- [x] recusar recuperação além da profundidade configurada, abaixo da retenção ou
  cruzando a fronteira finalizada;
- [x] garantir restart seguro em cada ponto entre detecção, rewind e recaptura.

**3B2B-2 — rollback de market, wallet e publicação, subdividido**

O conjunto foi estimado em 1.600–2.100 linhas. Cada corte abaixo deve permanecer
abaixo de 500 linhas, terminar em commit próprio e executar lint mais o menor
teste de persistência/integração que cubra seu contrato. Schema check só é
necessário se uma migration surgir durante a implementação.

**3B2B-2A — invalidation durável de trades (~300–400 linhas)**

- [x] gerar `market:trade:invalidate` para cada `observed` órfão dentro da mesma
  transação do rewind e antes de liquidar seu ciclo realtime;
- [x] preservar ordenação por identidade para que um consumer entregue
  `observed` antes de `invalidate`, inclusive após crash/restart;
- [x] manter a Stage 204 em shadow, sem publicação no frontend e sem abrir o gate.

**3B2B-2B — rollback e reconstrução de market (~450–500 linhas)**

- [x] remover somente observações atribuídas aos hashes órfãos;
- [x] reconstruir buckets 1m/1h/agg afetados a partir das observações canônicas;
- [x] invalidar trabalho derivado órfão sem representar ausência de dados como
  volume ou preço zero.

**3B2B-2C1A — identidade de lifecycle por ramificação (~250–350 linhas)**

- [x] incluir `block_hash` na identidade dos eventos `observed`, `finalized` e
  `invalidate` da Stage 204;
- [x] migrar a PK existente online pela Stage 207 antes de implantar os writers;
- [x] provar que a mesma identidade `(tx, log)` pode ser invalidada numa
  ramificação e observada/finalizada novamente em outra.

**3B2B-2C1B — rollback de swaps e cursores (~350–450 linhas)**

- [x] remover efeitos órfãos de swaps e sidecars de posição transacional;
- [x] recuar cursores de wallet à fronteira comum com generation/hash fence;
- [x] manter replay idempotente e impedir publicação finalizada duplicada.

**3B2B-2C2 — reconstrução de posições (~400–500 linhas)**

- [x] identificar somente wallets/tokens contaminados pela faixa órfã;
- [x] reconstruir posição, custo e PnL dessas identidades a partir do ledger
  canônico retido;
- [x] atualizar os watermarks apenas junto do estado reconstruído.

**3B2B-2D — coordenação e paridade (~350–450 linhas)**

- [x] registrar market, wallet e publicação como `domain_ready` apenas depois de
  seus rollbacks duráveis concluírem;
- [x] reaplicar a nova ramificação idempotentemente e comprovar paridade;
- [x] manter resume fechado enquanto qualquer domínio de 3B2B-3 estiver pendente
  e liberá-lo somente depois de todos os gates.

**3B2B-3 — rollback dos demais domínios compartilhados**

Este corte permanece subdividido e deve seguir exatamente a ordem abaixo. Cada
subcorte termina em commit e validação próprios; concluir um domínio fora da
ordem não autoriza avançar para 3B3.

**3B2B-3A — wallet-derived**

- [x] criar a Stage 208 para preimages de transfers ainda reversíveis, com
  retenção fixa de três dias e limpeza somente após `finalized_head`;
- [x] gravar preimages por batch LIVE, com range explícito para replay parcial;
- [x] restaurar transfers/edges/resumos/evidências e recuar o cursor no reorg;
- [x] **3B2B-3A1:** reverter `wallet-signed-origin` e seu cursor com o mesmo
  fence de geração/canonicalidade;
- [x] **3B2B-3A2:** reverter `wallet-token-first-buy` e seu cursor sem conservar
  primeira compra pertencente à ramificação órfã.

**3B2B-3B — liquidity**

- [x] invalidar snapshots órfãos, reancorar a fila no ancestral e cercar writes
  RPC atrasados pela canonicalidade.

**3B2B-3C — holders**

- [x] reverter journal, balances, contagem e cursores afetados, preservando o
  estado anterior até a nova ramificação ser reaplicada.

**3B2B-3D — discovery-creator**

- [x] **3B2B-3D1 — discovery:** invalidar pools da ramificação órfã, remover o
  dedup correspondente para replay e reancorar proveniência no writer;
- [x] **3B2B-3D2 — creator:** reverter attribution/cursor LIVE e aplicar fence
  canônico ao writer, sem apagar evidência externa ou de backfill;
- [x] **3B2B-3D3 — derivados:** invalidar launch anchors/outbox e classificações
  derivadas até a nova ramificação convergir.

**3B2B-3E — integração final dos gates**

- [x] preservar estado anterior marcado stale ou incompleto enquanto a nova
  ramificação não tiver sido reaplicada;
- [x] provar que falha de um domínio mantém recuperação retomável sem liberar
  canonicalidade parcial para os outros;
- [x] liberar o manifesto apenas quando `wallet-derived`, `liquidity`, `holders`
  e `discovery-creator` estiverem coerentes na mesma geração.

Gate de 3B2B:

- troca de hash na mesma altura e reorg de múltiplos blocos convergem;
- crash/restart em cada fase não perde invalidação nem duplica efeito econômico;
- reorg abaixo da fronteira permitida entra em `recovery_required` e não avança;
- nenhum bucket, holder, LP, posição, alerta ou cursor conserva efeito órfão;
- captura volta ao head somente depois de todos os domínios necessários estarem
  coerentes com a nova geração.

#### Slice 3B3 — entrega, ativação e retenção

**3B3A — consumer shadow da Stage 204**

Para manter o estado de auditoria separado do contrato futuro de publicação,
este item é executado em dois cortes:

- [x] **3B3A1 — estado e repositório de auditoria:** Stage 209 adiciona estado
  `audit_*` independente; claim/lease/retry/reclaim são idempotentes e um evento
  terminal só fica elegível depois do `observed` do mesmo ciclo estar auditado;
- [x] **3B3A2 — worker shadow:** consome por `LISTEN/NOTIFY`, com fallback
  limitado, valida payload e audita duplicação, restart e backlog sem socket;
  falha do shadow não interrompe a entrega finalizada existente.

O shadow nunca altera `status`, `lease_*`, `attempt_count` ou `published_at` da
publicação. Assim, o canário 3B3B não confunde auditoria com entrega ao cliente.

**3B3B — canário e publicação v2**

Este item é executado em dois cortes para manter o transporte inerte até existir
uma audiência canário explicitamente autorizada:

- [x] **3B3B1 — publisher durável e transporte inerte:** claim/lease/retry no
  estado de publicação da Stage 204 e relay PostgreSQL para uma sala canário que
  ainda não aceita membros; o produtor não é composto no runtime neste corte;
- [x] **3B3B2 — allowlist e ativação:** admitir somente usuários/sessões canário,
  conectar o publisher sob flag desligada por default e provar promoção,
  invalidação e deduplicação; clientes v1 permanecem finalizados-only. Antes do
  lançamento público, uma flag global explícita também pode admitir sessões
  anônimas na mesma sala lifecycle sem remover a allowlist.
- [x] **3B3B3 — watermark de ativação e catch-up controlado:** falhar fechado
  sem bloco explícito, publicar somente `observed` a partir dessa fronteira e
  priorizar sua auditoria; batch e quantidade de claims shadow por tick são
  configuráveis sem ampliar o lote econômico.
- [x] **3B3B4 — terminalização indexável:** Stage 211 marca atomicamente cada
  `observed` que já possui `finalized`/`invalidate`; a promoção deixa de
  reescanear todo o histórico a cada tick e faz catch-up incremental.

A flag de rollback deve impedir novos `observed`, mas continuar entregando os
terminais de ciclos provisórios que já tenham sido publicados.

**3B3C — retenção e telemetria**

- [x] expor backlog/idade por `event_kind`, `observedLagBlocks`,
  `finalizedLagBlocks`, retries, blocked e última invalidação;
- [x] apagar ciclos terminais apenas depois da janela de reorg/replay e do
  watermark de todos os consumidores; nunca apagar `blocked` silenciosamente;
- [ ] medir novamente receipt→applied e comparar com o baseline já coletado.

#### Checkpoint operacional para retomada

Estado confirmado antes da próxima retomada:

- Stages 210 e 211 aplicadas; o catch-up da auditoria terminou e
  `terminalizacao_atrasada` chegou a zero;
- a lease `robinhood-retention-worker` está ativa e a retenção da realtime
  outbox permanece em três dias;
- o claim de publicação está limitado pelo activation block e não consulta o
  backlog histórico quando o rollout ainda não possui watermark;
- na VPS web, `ROBINHOOD_WALLET_SWAP_REALTIME_V2_GLOBAL_ENABLED=true` admite
  inclusive sessões anônimas na sala lifecycle v2;
- na VPS dos workers, `...V2_ACTIVATION_BLOCK` permanece fixado no bloco deste
  rollout e `...V2_OBSERVED_ENABLED=true` está ativo;
- `trendscope-web.service` e `trendscope-worker@robinhood-wallet` foram
  reiniciados; `observed` chegou corretamente à UI em tráfego real;
- as slow queries `WITH claimable` causadas pela varredura histórica cessaram.

Ordem obrigatória da próxima retomada:

1. observar tráfego por uma janela sem backlog e coletar novamente os snapshots
   de latência do navegador para `market:bucket`, `market:trade`, `alert:event`,
   `holder:count`, `liquidity` e `readiness`;
2. confirmar que `observed` vira `finalized` sem duplicação, que não existem
   leases expiradas/rows `blocked` e que um reconnect reidrata o painel;
3. após a janela de três dias, comprovar que a realtime outbox remove ciclos
   antigos completos sem apagar ciclos mistos ou bloqueados;
4. preparar e executar a bateria consolidada de segurança de reorg em database
   PostgreSQL isolado, preenchido pelas fixtures sintéticas; nunca apontar essa
   bateria para o database de produção;
5. simular o reorg curto, comprovar `observed -> invalidate`, convergência do
   snapshot HTTP e recuperação após restart;
6. fechar a medição de 3B3C e somente então iniciar o Slice 4.

Rollback deste rollout: na VPS dos workers, desligar apenas
`...V2_OBSERVED_ENABLED`; preservar o activation block e a flag global no web
até `finalized`/`invalidate` dos ciclos já publicados drenarem. Não truncar a
outbox e não escolher outro watermark durante o mesmo ciclo.

Gate final do Slice 3:

- usuário vê `observed` sem aguardar as 12 confirmações;
- promoção altera o mesmo trade, sem duplicá-lo;
- reorg remove/corrige o trade e o snapshot HTTP posterior converge;
- reconnect, perda de `NOTIFY` e replay mantêm ordem e completude;
- Stage 204 permanece limitada pela retenção e não cresce indefinidamente.

O valor atual de 12 blocos adiciona cerca de 1,2 s quando a cadeia produz perto
de dez blocos por segundo. Diminuir timers não remove essa espera.

Implementação recomendada:

- publicar imediatamente como `finality: observed`;
- promover posteriormente para `finality: finalized`;
- publicar invalidação/correção em caso de reorg;
- incluir `asOfBlock`, `asOfBlockHash`, `observedAt` e `publishedAt` no contrato.

Se a UI não puder aceitar dados provisórios no primeiro rollout, usar duas
confirmações como etapa intermediária e manter 12 apenas para operações que
exigem certeza econômica. Essa decisão é um gate de produto, não de performance.

Gate:

- reorg de teste remove ou corrige o trade observado;
- consumidor antigo não interpreta silenciosamente payload incompatível;
- o status separa `observedLagBlocks` e `finalizedLagBlocks`.

### Slice 4 — liquidez realtime até a UI

Objetivo: eliminar a dependência do refresh de dashboard para atualizar LP.

- gravar snapshot de liquidez e outbox na mesma transação;
- publicar um evento Socket.IO dedicado, por exemplo `market:liquidity`;
- aplicar apenas se o evento for mais novo que o estado local do token;
- atualizar tokens já visíveis sem reconstruir o dashboard inteiro;
- manter o snapshot HTTP como bootstrap e reconciliação;
- permitir mudança de LP sem depender da ocorrência de um swap.

O Slice 4 foi estimado em 1.300–1.700 linhas entre código, testes e documentação,
com alcance de aproximadamente 14–17 arquivos de produção. Para preservar o
limite de 500 linhas por commit e manter a lógica nova fora dos hubs, ele será
executado nos quatro cortes abaixo. Não criar outro serviço permanente: o
produtor pertence ao worker canônico de liquidez e o web mantém somente o relay
e a entrega Socket.IO.

**Baseline de lint do Slice 4:** a versão atualmente implantada em produção
possui 14 warnings e zero erros em `npm run lint`. Cada corte deve terminar com
zero erros e no máximo 14 warnings; nenhum warning novo introduzido pelo corte é
aceitável, mesmo quando a contagem total não aumentar.

#### Slice 4A — produtor durável (~350–450 linhas)

- [x] criar uma outbox dedicada ao realtime de liquidez, sem reutilizar a
  `robinhood_derived_outbox` específica de `market:bucket`;
- [x] gravar o sinal durável de cada token afetado na mesma transação que aceita
  o novo snapshot de pool;
- [x] emitir o wake transacional somente quando um sinal novo é criado e deixar
  a fila `pending` indexada para a recuperação limitada do consumer no 4B;
- [x] provar em integração commit atômico, rollback conjunto, replay idempotente
  e ausência de sinal para snapshot rejeitado por monotonicidade.

#### Slice 4B — entrega backend (~400–500 linhas)

- [x] consumir a outbox com claim, lease, retry, reclaim após restart e estado
  `blocked` observável;
- [x] reconstruir do estado durável a projeção agregada do token e publicar o
  evento dedicado `market:liquidity` por relay PostgreSQL;
- [x] reutilizar as salas `market:<chain>:<address>` existentes e limitar
  `socket-hub`, servidor e composição a wiring;
- [x] manter produção e audiência desligadas por configuração explícita até o
  canário, expondo backlog, idade, retries, bloqueios e estado do listener.

#### Slice 4C — aplicação frontend monotônica (~350–450 linhas)

- [x] definir e validar o contrato tipado com identidade, valor, cobertura,
  pools e `liquidityProjectionCommittedAt` compatível com o snapshot HTTP;
- [x] rejeitar evento antigo ou duplicado usando a mesma versão durável exposta
  pelo bootstrap HTTP;
- [x] atualizar apenas as instâncias visíveis do token, incluindo monitorados e
  fixados, sem reconstruir o dashboard ou alterar membership/ranking;
- [x] registrar receipt→applied do fluxo `liquidity` sem antecipar a comparação
  final de latência dos Slices 4–7.

#### Slice 4D — convergência, rollout e prova operacional (~200–350 linhas)

- [x] no reconnect, manter o evento como caminho live e usar o snapshot HTTP
  existente para reidratação e reconciliação;
- [x] provar atualização sem swap, deduplicação, evento fora de ordem,
  `NOTIFY` perdido e restart com backlog;
- [x] documentar schema, flags, workers, ordem de deploy/restart e rollback;
- [ ] ativar primeiro em canário e fechar o gate somente após tráfego real e um
  reconnect convergirem ao mesmo estado durável. O código e o runbook estão
  prontos; esta confirmação depende da execução na VPS.

Gate:

- evento de liquidez sem swap atualiza LP;
- evento antigo ou duplicado não regride o valor;
- reconnect seguido de snapshot converge ao valor durável.

### Slice 5 — readiness por push

Objetivo: mostrar `ready`, `syncing` e recuperação assim que a cobertura mudar.

- publicar transições de readiness após o estado durável mudar;
- emitir evento de socket com versão/assinatura do snapshot;
- reutilizar a rotina de reidratação já existente quando o cliente recebe
  recuperação;
- manter HTTP periódico como fallback e verificação de convergência;
- invalidar o cache backend quando a transição ocorrer.

Gate:

- `ready -> syncing -> ready` aparece sem esperar o ciclo de 30 s;
- reconexão do socket busca snapshot e não depende de NOTIFY perdido;
- transições repetidas com a mesma assinatura não causam tempestade de fetches.

### Slice 6 — holders dirigidos pelo journal

Objetivo: remover tick de 500 ms e espera implícita de 12 blocos do contador
visível.

#### Slice 6A — captura acordada pelo commit canônico (~250–350 linhas)

- [x] escutar o `NOTIFY` transacional da captura canônica e coalescer wakes;
- [x] consumir até o checkpoint já commitado, sem adicionar as 12 confirmações
  do reader RPC ao modo `canonical_journal`;
- [x] manter polling de 5 s apenas como recuperação de notificação perdida e
  expor listener, wakes e fallback na telemetria;
- [x] preservar as 12 confirmações e o agendamento configurável no rollback
  explícito para `rpc`.

#### Slice 6B — outbox durável do holder (~400–500 linhas)

- [x] gravar a publicação na mesma transação que atualiza balances, journal,
  `holder_count`, versão e frontier;
- [x] usar identidade idempotente, claim, lease, retry/reclaim e dead-letter
  observável;
- [x] manter snapshot HTTP como reconciliação quando entrega realtime for
  perdida ou o cliente reconectar.

#### Slice 6C — lifecycle e entrega até a UI (~400–500 linhas)

- [ ] adotar `observed`, `finalized` e `invalidate` sem permitir regressão da
  versão visível;
- [ ] entregar a outbox por relay PostgreSQL e reutilizar as salas por token;
- [ ] provar restart, notificação perdida e reorg, preservando auditoria e
  reconciliação fora do hot path.

Gate:

- mint, burn e transfer atualizam o contador observado sem scan RPC;
- replay e reorg convergem ao mesmo estado;
- auditoria encontra zero divergências após a janela definida.

### Slice 7 — ranking e membership realtime

Objetivo: atualizar a composição e ordem das listas sem esperar o snapshot de
aproximadamente 15 s.

- emitir invalidação pequena quando uma métrica que participa do ranking muda;
- recalcular apenas o conjunto afetado ou solicitar snapshot novo com debounce;
- manter o refresh periódico como reconciliação;
- não transmitir o catálogo inteiro por evento.

Gate:

- token cruza um limite e entra/sai da lista dentro do SLO definido para ranking;
- rajadas de swaps não provocam uma requisição por evento;
- snapshot periódico corrige qualquer divergência residual.

## 7. Polling que deve permanecer

Polling continua permitido somente nestes papéis:

- fallback de head quando WebSocket do node estiver indisponível;
- recuperação de filas/cursors após perda de `NOTIFY`;
- reconciliação de trades, sparklines, liquidez, holders e readiness;
- backfill e repair históricos;
- metadata externa, imagens, social, market ticker e bid zone;
- health checks e renovação de leases.

Cada fallback deve declarar cursor, batch, concorrência, intervalo saudável,
backoff de erro e métricas de uso. `fallbackRuns` crescendo com listener saudável
é falha, não comportamento normal.

## 8. Testes por camada

### Unitários

- coalescimento de wakes e exclusão mútua do runner;
- comparação de versões/blocos no cliente;
- transições `observed/finalized/invalidated`;
- cálculo e exposição dos estágios de latência.

### Integração PostgreSQL

- estado e outbox confirmados atomicamente;
- nenhum consumo antes do commit;
- replay, lease expirada e restart não duplicam efeitos;
- `NOTIFY` perdido é recuperado por cursor;
- reorg produz correção ordenada.

### Frontend

- eventos de market, trade, liquidity, holder e readiness aplicam somente dados
  mais novos;
- reconnect reidrata por HTTP;
- UI não apaga volume/sparkline enquanto a cobertura continua completa;
- `syncing` aparece apenas quando o contrato de cobertura realmente falha.

### Smoke

- gerar uma atualização on-chain controlada e medir receipt até UI;
- interromper e restaurar um listener;
- reiniciar worker com backlog;
- simular reorg curto;
- confirmar que fallback converge sem virar o caminho principal.

## 9. Rollout e rollback

Cada slice deve entrar atrás de uma configuração explícita até passar pelo
canário. Sequência de deploy:

1. aplicar schema/init, quando houver;
2. subir produtor compatível, ainda sem ativar novo consumidor;
3. subir consumidor em shadow e comparar resultados;
4. habilitar o caminho novo para Robinhood;
5. subir web/frontend quando o contrato público mudar;
6. observar pelo menos uma janela com tráfego e um reconnect;
7. desativar o poll live antigo, preservando reconciliação.

Rollback:

- desabilitar o caminho novo sem apagar cursor/outbox;
- reativar o consumidor anterior;
- manter payloads públicos compatíveis durante uma janela de rollout;
- nunca truncar filas nem recuar checkpoints como procedimento de rollback.

## 10. Gate operacional de conclusão

Um slice realtime só está concluído quando todos os itens aplicáveis abaixo
forem verdadeiros:

- [ ] transporte da captura está `subscribed` ou fallback está explicitamente
  sinalizado;
- [ ] capture lag permanece entre zero e dois blocos;
- [ ] filas não acumulam `due_now`, leases expiradas ou rows bloqueadas;
- [ ] listener está conectado e `lastWakeAt` avança;
- [ ] cursor progride após reinício e notificação perdida;
- [ ] p95 e p99 estão dentro do SLO sem backlog;
- [ ] nenhum live worker usa `eth_getLogs`;
- [ ] publicação acontece somente depois do commit;
- [ ] duplicação, retry e reorg têm teste;
- [ ] polling remanescente está documentado como fallback/reconciliação;
- [ ] runbook informa workers e ordem de restart;
- [ ] `docs/bot-reference.md` foi atualizado apenas se o estado operacional
  efetivamente mudou.

## 11. Ordem recomendada

Executar na seguinte ordem:

1. telemetria ponta a ponta;
2. wake event-driven do processing;
3. outbox durável de wallet swaps;
4. política de finalidade dos swaps;
5. evento de liquidez para a UI;
6. readiness por push;
7. holders pelo journal;
8. ranking/membership realtime.

Os slices 1 e 2 removem a maior parte do atraso percebido. Os slices seguintes
fecham superfícies que hoje ainda parecem rápidas apenas quando coincidem com um
refresh HTTP.

### Fila canônica de retomada atual

Esta fila prevalece sobre referências antigas a “próximo corte” e não deve ser
reordenada sem atualizar este checkpoint:

1. concluir os seis passos do checkpoint operacional de 3B3C acima;
2. executar Slice 4, liquidez realtime até a UI;
3. executar Slice 5, readiness por push;
4. executar Slice 6, holders dirigidos pelo journal;
5. executar Slice 7, ranking e membership realtime;
6. executar o gate operacional geral e consolidar o runbook final.

O próximo gate é **3B3C — medição, retenção observada e teste controlado de
reorg**.

## Ponto importante

Reduzir intervalos não torna o sistema verdadeiramente realtime. Isso aumenta
queries e disputa no PostgreSQL, mas continua deixando janelas de atraso. Da
mesma forma, 12 confirmações são uma política deliberada que adiciona blocos de
latência. O resultado esperado depende de duas decisões separadas: acordar por
evento após commit e definir explicitamente quais dados a UI pode mostrar como
`observed` antes de serem `finalized`.

# Plano de execução — latência realtime da UI Robinhood

Status: em execução; Slice 0 (telemetria) e Slice 1 (wake event-driven do
processing) implementados

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
- [ ] Slice 3B2B: recuperação central de reorg e gravação durável de
  `invalidate`, incluindo rollback das projeções afetadas.
- [ ] Slice 3B3: consumidor, publicação v2 e telemetria separada de lag
  observado/finalizado.

#### Checkpoint de retomada do Slice 3

Estado implementado:

- o processing grava `observed` na Stage 204 junto do commit da observação;
- o wallet worker promove somente bloco/hash ainda canônico para `finalized`,
  em lotes limitados, e expõe `promoted`;
- `observed` e `finalized` continuam em shadow, sem consumer e sem chegar à UI;
- o frontend v2 já entende os três eventos, mas recebe apenas o fluxo finalizado
  legado/v2 existente;
- a captura detecta divergência de parent hash e para com
  `capture_reorg_detected`; ainda não existe recuperação canônica central;
- a Stage 204 não deve ser limpa enquanto invalidação, consumo e retenção não
  estiverem prontos. Neste ponto ela tende a guardar duas linhas por swap maduro.

Ao retomar em outro contexto, o próximo trabalho é **3B2B-2A**, abaixo. Não ligar
`market:trade:observed` antes de concluir todos os gates de 3B2B.

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

- [ ] remover somente observações atribuídas aos hashes órfãos;
- [ ] reconstruir buckets 1m/1h/agg afetados a partir das observações canônicas;
- [ ] invalidar trabalho derivado órfão sem representar ausência de dados como
  volume ou preço zero.

**3B2B-2C1 — rollback de swaps e cursores (~350–450 linhas)**

- [ ] remover efeitos órfãos de swaps e sidecars de posição transacional;
- [ ] recuar cursores de wallet à fronteira comum com generation/hash fence;
- [ ] manter replay idempotente e impedir publicação finalizada duplicada.

**3B2B-2C2 — reconstrução de posições (~400–500 linhas)**

- [ ] identificar somente wallets/tokens contaminados pela faixa órfã;
- [ ] reconstruir posição, custo e PnL dessas identidades a partir do ledger
  canônico retido;
- [ ] atualizar os watermarks apenas junto do estado reconstruído.

**3B2B-2D — coordenação e paridade (~350–450 linhas)**

- [ ] registrar market, wallet e publicação como `domain_ready` apenas depois de
  seus rollbacks duráveis concluírem;
- [ ] reaplicar a nova ramificação idempotentemente e comprovar paridade;
- [ ] manter resume fechado enquanto qualquer domínio de 3B2B-3 estiver pendente
  e liberá-lo somente depois de todos os gates.

**3B2B-3 — rollback dos demais domínios compartilhados**

- [ ] adaptar discovery, liquidity, holders/transfers, creators e classificações
  ao mesmo evento/generation fence;
- [ ] preservar estado anterior marcado stale ou incompleto enquanto a nova
  ramificação não tiver sido reaplicada;
- [ ] provar que falha de um domínio mantém recuperação retomável sem liberar
  canonicalidade parcial para os outros.

Gate de 3B2B:

- troca de hash na mesma altura e reorg de múltiplos blocos convergem;
- crash/restart em cada fase não perde invalidação nem duplica efeito econômico;
- reorg abaixo da fronteira permitida entra em `recovery_required` e não avança;
- nenhum bucket, holder, LP, posição, alerta ou cursor conserva efeito órfão;
- captura volta ao head somente depois de todos os domínios necessários estarem
  coerentes com a nova geração.

#### Slice 3B3 — entrega, ativação e retenção

**3B3A — consumer shadow da Stage 204**

- [ ] claim/lease/retry idempotente com `LISTEN/NOTIFY` e fallback limitado;
- [ ] ordenar cada identidade como `observed` antes de `finalized` ou
  `invalidate`; evento terminal só é elegível após `observed` estar entregue;
- [ ] auditar payload, duplicação, restart e backlog sem emitir socket.

**3B3B — canário e publicação v2**

- [ ] publicar apenas nas salas opt-in v2; clientes v1 continuam finalizados-only;
- [ ] ativar primeiro para sessão/canário controlado e confirmar que
  `invalidate` remove o trade provisório;
- [ ] manter flag de rollback que desliga novos `observed` sem interromper o fluxo
  finalizado atual.

**3B3C — retenção e telemetria**

- [ ] expor backlog/idade por `event_kind`, `observedLagBlocks`,
  `finalizedLagBlocks`, retries, blocked e última invalidação;
- [ ] apagar ciclos terminais apenas depois da janela de reorg/replay e do
  watermark de todos os consumidores; nunca apagar `blocked` silenciosamente;
- [ ] medir novamente receipt→applied e comparar com o baseline já coletado.

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

- consumir transfers do journal canônico após commit;
- manter cursor/outbox durável e aplicação idempotente;
- adotar o mesmo contrato `observed/finalized` dos swaps;
- acordar o apply worker por queue notify;
- preservar auditoria/reconciliação fora do hot path.

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

## Ponto importante

Reduzir intervalos não torna o sistema verdadeiramente realtime. Isso aumenta
queries e disputa no PostgreSQL, mas continua deixando janelas de atraso. Da
mesma forma, 12 confirmações são uma política deliberada que adiciona blocos de
latência. O resultado esperado depende de duas decisões separadas: acordar por
evento após commit e definir explicitamente quais dados a UI pode mostrar como
`observed` antes de serem `finalized`.

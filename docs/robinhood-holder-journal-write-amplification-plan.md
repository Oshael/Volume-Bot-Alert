# Plano de correção estrutural do journal de holders Robinhood

## Status e objetivo

Este documento é o handoff para executar a correção estrutural do pipeline de
holders. Ele não altera runtime, schema ou dados de produção por si só.

O objetivo é parar de copiar para `robinhood_holder_transfer_journal` todos os
eventos ERC-20 `Transfer` da chain apenas para descartar depois os eventos de
tokens que nunca serão acompanhados. A correção deve manter:

- captura live sem lacunas;
- admissão tardia de tokens com saldo correto desde o deployment;
- handoff seguro entre backfill e live;
- rollback e replay de reorg;
- backfills histórico, global e cold;
- o mínimo de 3 dias de raw canônico em `robinhood_chain_events`;
- recuperação sem depender permanentemente de RPC archive para o trecho ainda
  coberto pelo raw local.

O resultado esperado é que o volume do holder journal passe a ser proporcional
aos tokens acompanhados, e não a todos os transfers da rede.

## Conclusão do diagnóstico

O problema não é simplesmente "autovacuum forte" nem o backfill histórico do
holder. O gerador principal da dívida é o próprio caminho live em catch-up:

```text
robinhood_chain_events (raw canônico, completo)
  -> canonical holder source lê todos os logs Transfer
  -> Node decodifica todos
  -> holder live força captureAllTransfers=true
  -> robinhood_holder_transfer_journal recebe todos os transfers
     -> token acompanhado: evento é aplicado e mantido para rollback
     -> token não acompanhado: evento fica pending e depois é apagado
  -> inserts + updates + deletes + WAL + dead tuples + vacuum
```

Isso é comprovado pelo código atual:

- `src/services/robinhood-holder-live-capture.js` chama o reader com
  `captureAllTransfers: true` em toda faixa live.
- `src/models/robinhood-canonical-holder-source.js` lê
  `robinhood_chain_events` por range e `topic0=Transfer`; o filtro por token só
  restringe o resultado quando `captureAllTransfers` é falso.
- `src/models/robinhood-holder-ledger.js` insere cada transfer no journal. Em
  conflito idêntico executa um `DO UPDATE` sem mudança lógica, ainda sujeito a
  churn MVCC.
- `src/models/robinhood-holder-journal-retention.js` percorre os pending
  expirados, testa se o token é protegido e apaga o restante como buffer não
  utilizado.
- o journal também é atualizado quando o evento é aplicado, pois passa a
  guardar before/after balance, delta e marcador `applied` para rollback.

A telemetria observada sustenta a escala do problema: uma execução capturou
aproximadamente 18.779 transfers por 1.000 blocos. Com cerca de 941.890 blocos
de lag, isso projeta aproximadamente 17,7 milhões de tentativas de inserção no
journal durante o catch-up. Grande parte não pertence a tokens acompanhados e
será apagada posteriormente.

Os vacuums longos são uma consequência real dessa escrita, embora possam não
ser o único consumidor do disco. A Stage 219 inicia autovacuum cedo e limita o
cost (`delay=10`, `limit=300`), mas isso apenas troca agressividade por duração;
não impõe um teto de I/O global e não elimina a produção de versões mortas.
Vacuum manual também não resolve de forma permanente: o catch-up volta a criar
a dívida assim que os serviços retornam.

## Por que esse desenho existia

O buffer universal não foi criado sem motivo. O histórico mostra a evolução:

1. `67be043e` — *Buffer holder transfers before token admission*: passou a
   capturar todos os transfers e criou `buffer_floor_block`. O objetivo era
   permitir que um token descoberto depois já tivesse sua história desde o
   deployment no holder journal.
2. `481c17b8` — desacoplou apply do avanço do cursor live usando o fence
   compartilhado.
3. `a5c078e5` — adicionou o source canônico baseado em
   `robinhood_chain_events`, mas manteve o buffer universal anterior.
4. `cf577f9e` — ampliou a admissão usando os floors retidos.
5. Stage 196 trocou um B-tree grande de rollback por BRIN; Stage 219 reduziu a
   agressividade de autovacuum; `ed666f4f`/Stage 229 limitou as varreduras do
   prune. São contenções válidas, não a remoção da causa.

Depois que o raw canônico completo passou a existir, o sistema ficou com duas
cópias do mesmo universo de transfers: o raw de 3 dias e o holder journal
universal. O segundo deixou de ser necessário para tokens não acompanhados,
desde que a admissão tardia passe a fazer replay sob demanda do primeiro.

## O que "backfill" significa neste plano

Não é o catch-up atual do cursor live. É o preenchimento de um token admitido
depois de seu deployment.

Exemplo:

```text
deployment do token: bloco 100
token admitido:      bloco 150
tail live inicia:    bloco 150
replay necessário:  blocos 100..149
```

Hoje o sistema pré-paga esse replay para todos os tokens da rede ao manter um
buffer universal. No desenho-alvo:

- o live passa a capturar somente tokens acompanhados;
- na admissão, o token entra como `backfilling` e recebe uma fronteira durável
  de início do tail live;
- o trecho anterior à fronteira é lido de `robinhood_chain_events` enquanto
  estiver dentro da retenção raw;
- se deployment ou lacuna estiver antes do floor raw, permanecem válidos os
  caminhos RPC/archive/global/cold existentes;
- o token só vira `shadow` quando replay e tail se encontram sem lacuna.

O executor regular atual ainda usa `createRobinhoodHolderTransferReader`, isto
é, RPC. Portanto, não se deve apenas trocar `captureAllTransfers` para `false`:
primeiro é necessário criar e provar o adaptador de replay canônico recente e
o novo contrato de cobertura.

## Papéis que o holder journal deve manter

O journal atual mistura quatro responsabilidades:

1. fila durável de transfers pendentes de tokens acompanhados;
2. evidência aplicada com before/after balance para rollback;
3. buffer universal de transfers de tokens ainda não admitidos;
4. fonte de checkpoints para localizar ancestral em reorg.

O estado-alvo mantém 1 e 2, remove 3 e move 4 para a fonte canônica:

```text
robinhood_chain_events (raw completo, retenção >= 3 dias)
  |-- live: filtra tokens acompanhados
  |     `-> holder_transfer_journal (pending + rollback somente dos acompanhados)
  |
  |-- token recente admitido tarde
  |     `-> replay deployment..tail_start -> backfill/handoff
  |
  `-- checkpoints/reorg -> robinhood_chain_blocks

token fora do floor raw -> RPC/archive/global/cold já existentes
```

O holder journal continua mutável e retido pelo período necessário ao rollback.
Ele não precisa herdar a política de 3 dias do raw. A retenção raw de 3 dias não
será reduzida por este trabalho.

## Invariantes obrigatórios

Nenhum corte pode avançar sem preservar estes contratos:

1. Um transfer de token acompanhado é persistido depois de o source canônico
   estar duravelmente commitado e antes de o cursor live ultrapassá-lo.
2. Entrega repetida é idempotente e divergência de payload falha fechada.
3. Um token recém-admitido não pode perder o intervalo entre deployment e
   início de sua captura live.
4. O início do tail é por token e durável. Um floor global de buffer não prova
   cobertura depois que a captura deixa de ser universal.
5. Handoff exige `backfill_next_block >= tail_capture_from_block` e checkpoint
   canônico compatível; ausência de qualquer evidência bloqueia promoção.
6. Estados existentes não recebem uma fronteira inventada. Migração só grava
   valores comprováveis ou mantém o caminho legado.
7. Tokens de cohort global só entram no conjunto live depois do
   `barrier_block`, preservando o fence atual.
8. O ancestral de reorg é localizado em `robinhood_chain_blocks`, inclusive
   quando blocos intermediários não têm transfer de token acompanhado.
9. O rollback continua usando apenas eventos aplicados do holder journal.
10. Replays recentes falham fechados se a faixa estiver abaixo do floor raw;
    nesse caso o roteamento explícito é RPC/archive, nunca sucesso parcial.
11. O caminho live permanece event-driven. Replay, auditoria e repair são
    exceções limitadas, incrementais, idempotentes e incapazes de famintar live.
12. Nenhuma mudança reduz os 3 dias de raw nem apaga evidência imutável.

## Plano de execução

Cada corte é um slice independente, com no máximo 500 linhas de código/testes,
commit próprio, validação própria e parada para revisão. Não combinar slices no
mesmo turno. Se o desenho exigir nova responsabilidade ou crescer mais de 20%,
parar e replanejar.

### Corte 1 — contrato de cobertura e telemetria, ainda em modo legado

Estado: implementado no código. A Stage 231 precisa ser aplicada antes do restart
dos workers de holders; o modo live continua com `captureAllTransfers=true`.

Objetivo: representar com precisão onde começa a cobertura live de cada token
antes de remover o buffer universal.

Mudanças propostas:

- criar coluna durável por token, provisoriamente chamada
  `tail_capture_from_block`;
- definir constraints entre deployment, backfill, tail e live-through;
- na admissão, sob o lock/fence do cursor, registrar
  `max(next_block live, deployment_block)` como início do tail e inserir o token
  como `backfilling`;
- manter `captureAllTransfers=true` neste corte;
- adicionar telemetria por ciclo: raw Transfers observados, transfers de tokens
  acompanhados, transfers extras mantidos pelo modo legado e número de tokens
  abrangidos;
- adicionar auditoria de estados sem fronteira ou com fronteira incoerente.

Decisões que precisam ser confirmadas no código antes da migration:

- nome final da coluna;
- como representar estados antigos sem prova (`NULL` deve falhar fechado);
- se a fronteira pertence apenas a `robinhood_holder_token_states` ou também ao
  registro de cohort enquanto ele ainda não foi anexado;
- índice necessário somente se um `EXPLAIN` provar uma rota crítica.

Aceite:

- nenhuma mudança na saída do live;
- novos tokens ficam `backfilling` com tail durável capturado sob fence;
- estados antigos continuam operáveis pelo modo legado;
- schema check e integrações de bootstrap/cursor passam;
- telemetria mede o desperdício sem fazer scan adicional da tabela.

Rollback: código antigo ignora coluna nullable; nenhuma linha é apagada.

### Corte 2 — reader canônico por token para replay recente

Estado: implementado no código, opt-in por
`ROBINHOOD_HOLDER_BACKFILL_SOURCE=canonical_recent`; `rpc` permanece o default e
o rollback operacional. O plano local usa o índice existente por range e não
justifica migration adicional.

Objetivo: usar o raw local já retido para preencher somente o token admitido.

Mudanças propostas:

- acrescentar ao source canônico uma leitura por token e range;
- consultar apenas blocos canônicos e `topic0=Transfer`, filtrar pelo endereço
  do token no SQL quando o índice/plan permitir e validar checkpoint na mesma
  snapshot `REPEATABLE READ READ ONLY`;
- declarar explicitamente floor, frontier e motivo de gap;
- rotear apenas faixas integralmente cobertas pelo raw para esse reader;
- preservar RPC/archive para faixas anteriores ao floor;
- limitar range, duração, batch, retry e prioridade abaixo do live.

Aceite:

- paridade de identidades e payload entre reader canônico e RPC em amostras;
- erro explícito para range parcial/abaixo do floor;
- idempotência ao repetir a faixa;
- testes de malformed log, reorg/checkpoint e fronteira da retenção;
- plano não executa seq scan global por token.

Rollback: desligar o roteamento canônico recente e continuar no executor RPC.

### Corte 3 — admissão e handoff sem dependência do buffer global

Estado: implementado no código para estados com tail durável; estados legados com
tail `NULL` preservam o handoff universal anterior enquanto o live ainda opera com
`captureAllTransfers=true`.

Objetivo: fechar matematicamente a lacuna deployment -> tail live.

Mudanças propostas:

- novos tokens sempre entram `backfilling`;
- replay avança de `deployment_block` até `tail_capture_from_block`;
- como `backfilling` já integra `listTrackedTokenAddresses`, o live captura o
  tail do token enquanto o replay anterior avança;
- handoff só promove quando os dois lados se encontram e os checkpoints são
  canônicos;
- manter invariantes de global cohort e `barrier_block`;
- impedir promoção se tail, raw floor ou checkpoint estiverem ausentes.

Aceite:

- testes com admissão concorrente ao avanço live não mostram bloco perdido;
- retry e crash em qualquer lado não duplicam saldo;
- token recente chega ao mesmo holder count do caminho legado;
- token anterior ao raw é roteado ao caminho histórico existente;
- handoff falha fechado com qualquer lacuna.

Rollback: continuar capturando tudo e usar o contrato antigo de buffer enquanto
o novo estado permanece apenas observacional.

### Corte 4 — reorg baseado no journal canônico de blocos

Objetivo: tornar a descoberta do ancestral independente da densidade do holder
journal, que passará a ser esparso.

Mudanças propostas:

- substituir `listJournalBlockCheckpoints` como fonte de busca por checkpoints
  canônicos de `robinhood_chain_blocks` dentro da janela recuperável;
- localizar o último ancestral comum mesmo em blocos sem transfer acompanhado;
- manter o rollback de saldos baseado nos eventos `applied` do holder journal;
- revisar rewind de `buffer_floor_block`, pois ele não será autoridade futura.

Aceite:

- reorg entre dois blocos sem eventos tracked é localizado corretamente;
- shallow reorg reverte e reaplica exatamente uma vez;
- reorg abaixo da evidência retida falha com estado operacional claro;
- cursor, balances, hot queue e journal permanecem consistentes após replay.

Rollback: manter a implementação antiga disponível enquanto o journal ainda é
universal; não ativar tracked-only antes deste corte estar validado.

### Corte 5 — shadow/paridade antes da ativação

Objetivo: provar que o novo caminho produz o mesmo estado antes de torná-lo
autoridade.

Executar ainda com buffer universal:

- para tokens novos e amostras existentes, comparar o histórico obtido do
  buffer antigo com o replay canônico no mesmo snapshot;
- comparar identidade `(transaction_hash, log_index)`, bloco, token, from, to e
  amount;
- comparar holder count/balances e decisão de handoff;
- observar vários ciclos com volume real, reorg simulado em integração e faixas
  junto ao floor raw;
- criar gate pontual de ativação que falha com missing, excess, divergent ou
  estado incompleto;
- se o flip exigir ausência de leases, documentar parada curta e exata dos
  grupos de holder; não pausar serviços apenas para medir performance.

Aceite: zero missing, excess e divergent nas amostras/auditoria definidas, sem
promoção indevida e sem regressão do live.

### Corte 6 — ativação tracked-only

Objetivo: parar a criação da dívida.

Mudanças propostas:

- adicionar autoridade/feature flag com default legado;
- no modo novo, chamar o source com tokens acompanhados e
  `captureAllTransfers=false`;
- persistir somente transfers desses tokens;
- falhar fechado se algum estado ativo não possuir contrato de tail completo;
- manter shadow de contagens por uma janela antes de remover compatibilidade.

Gate de produção antes do flip:

- migrations aplicadas e schema verificado;
- auditoria do Corte 5 segura;
- nenhum token ativo com tail incompleto;
- raw floor cobre todas as admissões que usarão replay recente;
- worker sem erro e checkpoints canônicos consistentes;
- rollback flag testado.

Aceite operacional:

- journal inserts passam a acompanhar transfers de tokens tracked;
- `discardedBufferedEvents` para dados novos cai a zero;
- lag live diminui de forma líquida sem aumentar erro ou divergência;
- WAL, deletes e crescimento de dead tuples do journal caem após a drenagem da
  dívida antiga.

Rollback: voltar a flag para legacy enquanto a compatibilidade e o raw da
janela estiverem presentes. Não dropar schema neste corte.

### Corte 7 — retirar buffer e prune obsoletos

Objetivo: remover a complexidade que deixou de ter função após uma janela
estável.

Somente depois de estabilidade comprovada:

- parar de avançar e consultar `buffer_floor_block` para admissão;
- remover o scan/delete de pending não acompanhado;
- manter retenção limitada de eventos tracked aplicados e pendentes;
- preservar repair, rollback e floor do journal ainda necessários;
- remover flag/código legado apenas depois de expirar a janela de rollback.

Não executar `DELETE` massivo para "limpar logo". A dívida anterior deve ser
drenada em batches limitados, abaixo da prioridade live. `VACUUM FULL`, CLUSTER
ou rewrite exigem janela offline e plano de espaço separado.

### Corte 8 — projeto separado para retenção física do raw canônico

Mesmo após o journal de holders ser corrigido,
`robinhood_chain_events` continuará sendo uma tabela raw monolítica com retenção
contínua. Isso é outro problema.

Não misturar nesta sequência uma conversão improvisada para particionamento. As
PKs e FKs atuais não incluem naturalmente a chave de partição; a migração pode
exigir shadow tables, novas chaves, dual-write, backfill, validação, cutover e
capacidade temporária de disco.

Só abrir esse projeto depois de medir o steady state dos Cortes 6/7. A retenção
de 3 dias permanece obrigatória.

## Medição antes e depois

Registrar uma baseline de pelo menos 15 minutos antes do flip e janelas de 15 e
60 minutos depois. Comparar deltas, nunca apenas contadores cumulativos.

### Semântica

- missing/excess/divergent entre replay legado e canônico;
- tokens com `tail_capture_from_block` ausente ou inconsistente;
- promoções de `backfilling` para `shadow` e tempo até handoff;
- holder count e balances antes/depois;
- resultado de reorg em faixa sem transfer tracked;
- erros de range abaixo do floor e roteamento para RPC/archive.

### Throughput e custo

- raw Transfer logs observados por ciclo;
- transfers tracked aceitos e linhas realmente inseridas no journal;
- razão `journal_inserted / raw_observed`;
- avanço líquido do cursor holder em blocos/minuto;
- `n_tup_ins`, `n_tup_upd`, `n_tup_del`, `n_dead_tup` do journal por janela;
- WAL bytes/minuto;
- batches, rows scanned e `discardedBufferedEvents` do prune;
- tempo e frequência de autovacuum no journal;
- waits `DataFileRead`, `DataFileWrite`, `WALWrite` e iowait do volume.

Uma queda imediata de inserts sem queda imediata de dead tuples é esperada: a
dívida histórica ainda precisa ser drenada e aspirada. O sucesso estrutural é
parar de recriá-la.

## Critérios de conclusão

O projeto termina somente quando:

1. raw canônico continua com no mínimo 3 dias;
2. novos tokens recentes completam replay + tail sem lacuna;
3. tokens antigos continuam atendidos por RPC/archive/global/cold;
4. auditorias não encontram divergência;
5. reorg independe de haver transfer tracked em cada bloco;
6. journal recebe apenas eventos necessários a tokens acompanhados;
7. prune não varre mais o universo de pending não acompanhados;
8. lag holder se mantém próximo da frontier em steady state;
9. WAL/deletes/dead tuples deixam de crescer na taxa chain-wide anterior;
10. vacuum volta a ser manutenção normal, não mecanismo contínuo de contenção.

## O que não fazer

- Não mudar apenas `captureAllTransfers` para falso.
- Não marcar novos tokens direto como `shadow` sem prova de cobertura.
- Não inferir uma fronteira por token para estados antigos sem evidência.
- Não usar holder journal esparso para achar ancestral de reorg.
- Não reduzir raw abaixo de 3 dias.
- Não aumentar retenção do holder journal para imitar raw.
- Não criar outra cópia completa de transfers.
- Não adicionar índices sem plano real provando a necessidade.
- Não resolver com vacuums manuais recorrentes.
- Não particionar tabelas existentes no mesmo corte funcional.
- Não aumentar concurrency para mascarar I/O e WAL já saturados.

## Início recomendado no próximo chat

1. Ler este documento e `AGENTS.md`.
2. Executar `git status --short` e preservar toda alteração não relacionada.
3. Revalidar os contratos nos arquivos citados contra o HEAD atual.
4. Planejar somente o Corte 1, listar arquivos, estimar linhas e testes.
5. Se o Corte 1 exceder 500 linhas ou revelar mudança de responsabilidade,
   parar e pedir aprovação do novo fatiamento.
6. Implementar migration compatível e telemetria sem desligar o modo legado.
7. Rodar `npm run lint`, `npm run db:schema-check` e os menores testes unitários
   e de integração de bootstrap/cursor/schema.
8. Revisar o diff completo, atualizar `docs/bot-reference.md` somente com o
   estado operacional realmente implementado, commitar o slice e parar antes
   do Corte 2.

## Arquivos de entrada para a próxima análise

- `src/services/robinhood-holder-live-capture.js`
- `src/models/robinhood-canonical-holder-source.js`
- `src/models/robinhood-holder-ledger.js`
- `src/models/robinhood-holder-bootstrap.js`
- `src/models/robinhood-holder-handoff.js`
- `src/models/robinhood-holder-journal-retention.js`
- `src/services/robinhood-holder-backfill-executor.js`
- `src/services/robinhood-holder-global-backfill-worker.js`
- `src/services/robinhood-holder-cold-worker.js`
- `src/services/robinhood-chain-event-pruner.js`
- `src/utils/db-init-stage196.js`
- `src/utils/db-init-stage219.js`
- `docs/robinhood-holder-global-backfill-plan.md`
- `docs/robinhood-token-holders-plan.md`

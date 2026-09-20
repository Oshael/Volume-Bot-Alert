# Plano de execução — wallet classification Robinhood com raw de 3 dias

Status: Cortes 0, 1A e 1B concluídos localmente; Stage 241 ainda não aplicada na VPS.
Os reparos existentes podem rodar no PC Archive enquanto os demais cortes de código
são implementados. O reader permanece no contrato anterior até o Corte 1C.

## 1. Objetivo

Manter os workers de wallet classification operando em tempo real na VPS com node
pruned e retenção máxima de três dias para dados raw. O PC Archive deve ser necessário
somente para:

- backfill inicial;
- recuperação de uma indisponibilidade maior que a janela local;
- reparo explícito de evidência histórica que não foi materializada a tempo.

O caminho normal deve sobreviver ao descarte do raw porque as provas de negócio,
fronteiras e âncoras canônicas necessárias foram persistidas antes do corte.

## 2. Restrições fechadas

1. Dados raw têm retenção máxima de três dias. O plano não pode resolver backlog
   aumentando indefinidamente essa retenção.
2. Não é permitido avançar cursores manualmente nem marcar trabalho como concluído sem
   evidência materializada.
3. O fluxo live continua event-driven. Reparo e backfill podem fazer leitura limitada,
   retomável e idempotente.
4. O Archive não entra como fallback silencioso dos workers da VPS.
5. Não será criado um novo serviço permanente para este projeto. Os workers e leases
   existentes permanecem os donos do processamento.
6. Cada corte de código/testes/schema deve alterar no máximo 500 linhas e exige uma
   autorização separada.
7. Migrations antigas não serão reescritas. A primeira migration nova prevista é a
   Stage 241.
8. Mudanças preexistentes e não relacionadas no worktree devem ser preservadas.

## 3. Modelo de dados alvo

O sistema passa a distinguir três camadas:

```text
raw canônico (até 3 dias)
  -> evidência de domínio durável
  -> snapshot/classificação durável
```

### 3.1 Raw canônico

Inclui blocos, transações, receipts e eventos usados para reconstrução recente. Pode ser
apagado após três dias. Não pode ser a única fonte de timestamp/hash para uma tarefa que
permanece ativa por mais tempo.

### 3.2 Evidência durável

Inclui, conforme o domínio:

- first buy;
- swap e sua posição na transação;
- transfer edge classificada;
- deployment block/hash e prova de transição de bytecode;
- creator canonicamente comprovado;
- launch anchor;
- âncora compacta de bloco referenciada por uma fronteira: número, hash e timestamp.

A âncora compacta não é uma cópia do bloco raw. Ela contém somente a identidade e o
tempo do bloco realmente referenciado por uma fronteira durável.

### 3.3 Snapshot/classificação

O resultado publicado deve carregar lineage suficiente para provar:

- versão da regra/evidência;
- fronteira inicial;
- fronteira final congelada;
- versão da requisição;
- checkpoint/fence canônico usado no commit.

## 4. Evidência operacional de partida

Coletas de 2026-09-20, aproximadamente entre 17:18 e 17:23
`America/Fortaleza`:

| Worker | Observação | Consequência |
| --- | --- | --- |
| wallet-transfer live | `lag_blocks=3.621.603`; cursor avançou 2.500 blocos enquanto a origem avançou 2.495 | o worker está ativo, mas a amostra não mostra convergência material |
| bundle-redistribution | 4.107 ativos; materializados 0 na coleta | fila depende de fontes ainda indisponíveis |
| redistribution creator | 1.780 `creator_unavailable`; os 1.780 sem creator; zero também na fila de deployment | o fluxo live atual não reabrirá sozinho esses creators históricos |
| redistribution bounds | 406 `partition_time_bounds_unavailable` | existem tarefas cuja janela temporal já não pode ser obtida da fonte atual |
| token-deployment | 175.722 ativos; backlog com `rpc_error` e `local_deployment_evidence_pending` | o histórico fora da janela do pruned precisa do Archive |
| bundle-funding | 35 ativos; oldest acima de 1,1 milhão de segundos | há trabalho mais antigo que a retenção raw desejada |
| direct-creator live | `caught-up`, `lagBlocks=0` | o caminho direto/launchpad recente está acompanhando a ponta |

Essas são observações pontuais, não uma série temporal completa.

## 5. Causas confirmadas, hipóteses e desconhecidos

### 5.1 Confirmado pelo código e pelas coletas

- O source de redistribution consulta `robinhood_chain_blocks` para obter o tempo de
  `observation_from_block` e do `live_through_hash` do holder. Depois do pruning, essa
  leitura pode retornar `partition_time_bounds_unavailable`.
- O deployment por `rpc_code_transition` precisa provar ausência de código em `N-1` e
  presença em `N`. Um node pruned não recupera essa prova depois que o estado envelhece.
- O direct-creator live cobre criações top-level e launchpads conhecidos, mas não prova
  toda criação interna de factory desconhecida.
- O reparo de creators via Archive já existe, é idempotente e reabre somente tokens
  reparados.
- A recuperação de holder deployments via Archive já existe e pode operar enquanto o
  live permanece ativo.
- O wallet-transfer canônico recente lê o journal PostgreSQL; seu atraso atual não é
  causado por falta de acesso direto ao Archive.

### 5.2 Hipóteses ainda não confirmadas

- A causa do throughput insuficiente do wallet-transfer pode estar em leitura,
  classificação, persistência, locks, I/O ou capacidade configurada. O snapshot atual não
  discrimina essas explicações.
- O node pruned pode ou não servir traces de blocos recentes com latência suficiente para
  completar creators internos no live.
- A fila de funding pode permanecer dentro de três dias depois do catch-up, mas isso deve
  ser demonstrado por idade/rate, não presumido.

### 5.3 Medição que falsifica cada hipótese

- Wallet-transfer: timings simultâneos por fase e `blocks/s` devem mostrar qual fase cresce
  junto com a duração do batch. Se nenhuma fase dominar, a hipótese de gargalo local dessa
  fase é falsa.
- Trace live: um probe no bloco recente deve provar suporte, resultado canônico e tempo de
  resposta. `method not found`, histórico indisponível ou latência fora do budget rejeitam
  esse caminho.
- Funding: se a idade p95/p99 continuar crescendo durante carga normal depois do catch-up,
  a capacidade live não sustenta a retenção de três dias.

## 6. Trabalho operacional que pode rodar agora

Enquanto os cortes de código são implementados, o PC Archive pode executar em loop,
sequencialmente:

1. `robinhood:bundle-redistribution-creator-repair`;
2. `robinhood:holder-deployment-recover -- --catalog-only`.

Regras:

- um único loop operacional por vez;
- cada batch registra início, fim, duração, candidatos, reparados e falhas;
- falha RPC/DB, `unresolved`, `failed` ou ausência persistente de progresso interrompe o
  loop para diagnóstico;
- o live continua ativo;
- não iniciar duas campanhas Archive pesadas em paralelo;
- esses reparos não substituem o futuro reparo de âncoras da Stage 241.

O ETA deve ser calculado pela queda da população pendente entre duas coletas:

```text
taxa = (pendente_anterior - pendente_atual) / minutos
ETA  = pendente_atual / taxa
```

Counters de tentativas ou `total_runs` não servem como denominador porque incluem retry.

## 7. Arquitetura escolhida para as âncoras

### 7.1 Tabela compacta de âncoras referenciadas

A Stage 241 deve criar uma tabela pequena para blocos explicitamente usados por uma
fronteira. Contrato mínimo:

- `chain`;
- `block_number`;
- `block_hash`;
- `block_timestamp`;
- `created_at`;
- chave que preserve forks distintos sem sobrescrever silenciosamente a lineage.

Ela não guardará transações, receipts, logs nem payload de bloco.

### 7.2 Captura event-driven

Triggers ou writes transacionais devem copiar a âncora enquanto o bloco ainda existe no
journal raw quando:

- uma ativação de redistribution é promovida;
- `live_through_block/hash` de um holder avança;
- uma versão de tarefa congela sua fronteira de processamento.

O trigger deve falhar fechado se número/hash não corresponderem ao bloco canônico. Para
linhas históricas já sem raw, deve registrar falta reparável; nunca inventar timestamp.

### 7.3 Fronteira congelada por versão

Uma tarefa de redistribution deve persistir, por `requested_version`:

- âncora de observação;
- bloco/hash/tempo final escolhido;
- fence da projeção.

Nova evidência incrementa `requested_version` e invalida a fronteira ainda não concluída.
O commit só aceita exatamente a versão e a fronteira que produziram o snapshot.

## 8. Cortes de implementação

### Corte 0 — plano executável

Status: concluído por este documento.

Entrega:

- contrato da retenção de três dias;
- diagnóstico separado entre observação, hipótese e causa confirmada;
- ordem dos cortes, rollout, rollback e gates.

Validação: revisar texto e diff. Lint/testes não são necessários.

### Corte 1A — Stage 241 e captura de âncoras

Status: concluído localmente; migration ainda não aplicada na VPS.

Objetivo: criar o contrato durável sem mudar ainda o reader do redistribution.

Arquivos previstos:

- `src/utils/db-init-stage241.js`;
- `src/utils/runtime-schema.js`;
- testes de schema/integração da Stage 241;
- `docs/bot-reference.md` somente para o novo contrato operacional.

Entrega:

- tabela compacta de âncoras;
- colunas nullable de fronteira congelada na fila;
- constraints all-or-none para bloco/hash/tempo;
- captura automática de novas ativações e frontiers;
- linhas legadas permanecem nullable e explicitamente reparáveis;
- migration idempotente e aplicável antes do código consumidor.

Estimativa: 350–490 linhas.

Validação:

- teste unitário de definição do schema;
- teste de integração para insert/update, hash divergente e idempotência;
- `npm run lint`;
- `npm run db:schema-check` e variante de teste;
- diff completo antes do commit.

Gate: nenhuma mudança de worker é implantada antes da Stage 241.

### Corte 1B — fila congela a fronteira por versão

Status: concluído localmente; depende da Stage 241 e deve ser implantado junto do 1C.

Objetivo: fazer claim/prepare fixar a fronteira exata usada pela tarefa.

Arquivos previstos:

- `src/models/robinhood-bundle-redistribution-live-queue.js`;
- testes unitários e de integração da fila.

Entrega:

- pin transacional da fronteira;
- retorno da âncora completa no item reclamado;
- novo evento limpa/invalida pin antigo ao aumentar `requested_version`;
- lease perdida ou versão alterada impede commit;
- retry preserva a mesma lineage enquanto a versão não muda.

Estimativa: 250–400 linhas.

Validação:

- testes de concorrência de claim;
- teste de evento chegando durante processamento;
- teste de lease/version stale;
- `npm run lint` e menor suite afetada.

### Corte 1C — source usa somente âncoras duráveis

Objetivo: remover os joins do source de redistribution com blocos raw antigos.

Arquivos previstos:

- `src/models/robinhood-bundle-redistribution-live-source.js`;
- `src/services/robinhood-bundle-redistribution-live-worker.js`, somente se necessário
  para transportar a lineage;
- testes do source e worker.

Entrega:

- bounds temporais vindos da fronteira congelada;
- erro explícito `redistribution_anchor_missing` para legado não reparado;
- readiness ainda exige holder, creator, first-buy, swap e transfer atravessando a
  fronteira congelada;
- snapshot recebe a mesma lineage usada pela query;
- nenhuma leitura de `robinhood_chain_blocks` para bounds históricos.

Estimativa: 250–420 linhas.

Validação:

- source funciona após apagar o bloco raw usado no teste;
- timestamps/hash divergentes falham fechado;
- reorg/version race não publica snapshot;
- `npm run lint` e suites direcionadas.

### Corte 2 — reparo histórico das âncoras

Objetivo: preencher linhas legadas usando PostgreSQL primeiro e Archive somente quando
necessário.

Arquivos previstos:

- novo utilitário `src/utils/repair-robinhood-bundle-redistribution-anchors.js`;
- entrada em `package.json`;
- testes do utilitário;
- `docs/bot-reference.md`.

Contrato do comando:

- read-only por default;
- apply exige flag de confirmação específica;
- exige `ROBINHOOD_ARCHIVE_RPC_URL` apenas para blocos ausentes localmente;
- valida chain ID, número, hash e timestamp;
- concorrência, batch e timeout limitados;
- checkpoint/retomada idempotente;
- reabre somente tarefas integralmente reparadas;
- unresolved permanece visível e não avança cursor.

Estimativa: 300–450 linhas.

Gate de saída:

- zero `redistribution_anchor_missing`;
- zero `partition_time_bounds_unavailable` legado;
- amostra canônica confrontada com Archive;
- redistribution volta a materializar snapshots.

### Corte 3 — retenção de três dias como contrato verificável

Objetivo: detectar risco antes do cutoff sem transformar o raw em armazenamento
permanente.

Arquivos previstos:

- `src/services/robinhood-retention-safety-audit.js`;
- `src/services/robinhood-chain-event-pruner.js`, apenas se o contrato atual não expuser
  os estados necessários;
- testes de retenção;
- `docs/bot-reference.md`.

Estados operacionais:

- `safe`: toda dependência anterior ao cutoff está materializada;
- `at_risk`: consumidor aproxima-se do limite, mas a prova ainda está no raw;
- `archive_required`: a janela expirou sem prova durável;
- `blocked`: incoerência canônica impede descarte seguro da faixa atual.

Regras:

- alertar antes de 48 horas e escalar antes de 72 horas;
- redistribution com âncoras completas não segura raw;
- funding deve concluir dentro da janela ou virar reparo Archive explícito;
- deployment deve provar o bloco enquanto o estado ainda está no pruned ou entrar em
  recuperação Archive;
- o pruner nunca representa perda como sucesso;
- a política não aumenta silenciosamente a retenção além de três dias.

Estimativa: 250–420 linhas.

### Corte 4 — deployment/creator live dentro da janela do pruned

Objetivo: garantir prioridade para evidência recente e medir perda da janela de estado.

Primeiro passo, sem assumir solução:

- medir idade do deployment mais novo pendente;
- medir taxa de entrada/saída e quantidade que envelhece para fora da janela;
- executar probe de `trace_block`/`debug_traceBlockByNumber` em blocos recentes.

Se o trace recente for suportado e couber no budget:

- reutilizar `robinhood-holder-deployment-verifier`;
- tentar creator interno somente para transições recentes ainda sem creator;
- persistir prova canônica antes da poda;
- manter concorrência e timeout limitados;
- não bloquear captura de blocos nem o deployment básico.

Se o trace recente não for suportado:

- não adicionar retry cego ao live;
- creator interno desconhecido fica como caso explícito de reparo Archive;
- deployment continua funcional com `rpc_code_transition` sem creator inventado.

Esse corte pode ser dividido em 4A (telemetria/prioridade) e 4B (trace), cada um abaixo
de 500 linhas. A decisão de implementar 4B depende do probe.

### Corte 5 — convergência do wallet-transfer

Objetivo: fazer o cursor live chegar ao head e manter margem de capacidade.

#### Corte 5A — instrumentação

Medir por batch:

- source read;
- role/context hydration;
- classificação;
- persistência;
- commit;
- blocos/s da origem;
- blocos/s processados;
- ganho líquido de catch-up;
- waits/locks/slow query correlacionados no mesmo intervalo.

Nenhuma otimização material será escolhida antes dessa medição.

#### Corte 5B — correção guiada pela evidência

Implementar somente a mudança que ataca a fase confirmada. Comparar depois a mesma
métrica primária: redução sustentada de `lag_blocks`.

Gate de saída:

- `lag_blocks=0`;
- taxa p95 do worker acima da taxa da chain com margem operacional definida;
- restart não recria gap;
- sem regressão em DB, WAL, locks e latência dos demais workers.

### Corte 6 — funding e readiness final

Objetivo: fechar o último consumidor de raw e fornecer um gate único de desligamento do
Archive.

Funding:

- proteger somente a janela ativa de 1.000 blocos enquanto ainda está dentro dos três
  dias;
- materializar resultado/evidência antes do cutoff;
- converter gap histórico em `archive_required`, nunca em conclusão vazia;
- usar o backfill existente para a campanha histórica.

Readiness final deve verificar:

- captura canônica no head;
- direct-creator no head;
- first-buy no head;
- wallet-transfer no head;
- holders live e coerentes;
- zero creators/anchors históricos reparáveis pendentes;
- zero deployment recente envelhecendo para fora da janela;
- funding abaixo do SLO de idade;
- retenção de três dias em `safe`;
- restart testado sem Archive.

Estimativa: dividir em 6A funding e 6B auditor de readiness, se o conjunto ultrapassar
500 linhas.

## 9. Ordem de rollout

1. Continuar creator/deployment repair no PC Archive, com timestamp e métricas por batch.
2. Implementar, validar e commitar o Corte 1A.
3. Aplicar Stage 241 antes de implantar o código dos Cortes 1B/1C.
4. Implantar 1B/1C com o Archive ainda disponível.
5. Rodar Corte 2 em dry-run; revisar amostra; aplicar e retomar até zerar gaps.
6. Confirmar redistribution materializando e drenando fila.
7. Implementar Corte 3 e observar pelo menos uma janela operacional relevante.
8. Executar Cortes 4 e 5 com medição antes/depois.
9. Fechar funding/readiness no Corte 6.
10. Fazer restart controlado da VPS com Archive indisponível para o live.
11. Desligar o PC Archive somente depois de todos os gates finais passarem.

## 10. Rollback

- Stage 241 adiciona estruturas nullable e não remove o contrato anterior. Aplicá-la antes
  do código é compatível com a versão antiga.
- Antes do cutover do source, o worker antigo ainda pode ler raw dentro da janela.
- Depois do cutover, rollback de código é permitido somente enquanto os blocos requeridos
  ainda estiverem no raw; fora disso, usar o reparo Archive.
- Nunca apagar as âncoras novas durante rollback operacional.
- Se um corte piorar a métrica primária, reverter o código daquele corte, preservar o
  schema aditivo e reabrir o diagnóstico.
- Não usar reset de cursor como rollback.

## 11. Critérios finais de aceite

O projeto está concluído somente quando:

1. raw mais antigo que três dias pode ser apagado sem mudar snapshots já materializados;
2. nenhum worker live consulta estado histórico fora da janela do pruned;
3. redistribution não depende de `robinhood_chain_blocks` podado para seus bounds;
4. wallet-transfer alcança e permanece no head;
5. filas recentes permanecem abaixo dos SLOs definidos;
6. qualquer gap histórico é marcado como `archive_required` e reparado explicitamente;
7. um restart controlado sem Archive mantém os workers saudáveis;
8. os mesmos indicadores permanecem saudáveis durante o soak;
9. `docs/bot-reference.md` descreve o contrato final e os comandos operacionais;
10. todos os cortes têm lint/testes/schema-check aplicáveis e diff completo revisado.

## 12. Limite inevitável

Com retenção raw de três dias, uma parada total superior a três dias não pode ser
recuperada somente pelo node pruned se a evidência não foi capturada antes da parada.
Nesse caso, o Archive ou outra fonte histórica equivalente continua sendo requisito de
disaster recovery. O objetivo deste plano é removê-lo do caminho normal, não prometer
recuperação histórica sem nenhuma fonte histórica.

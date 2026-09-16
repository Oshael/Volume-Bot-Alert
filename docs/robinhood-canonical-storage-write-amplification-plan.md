# Plano de redução de write amplification do canonical Robinhood

## Objetivo

Eliminar a dependência recorrente de vacuums pesados para manter o canonical
head e os demais workers responsivos. O plano prioriza a continuidade do fluxo
live, reduz primeiro o crescimento das filas quentes e somente adota uma nova
arquitetura de retenção se as medições posteriores comprovarem que ela ainda é
necessária.

Este documento é um plano de execução. Ele não autoriza alterar schema,
serviços ou dados de produção sem a aprovação do corte correspondente.

## Evidência disponível

O diagnóstico não parte apenas do tamanho das relações. Ele combina telemetria
do worker, estatísticas cumulativas do PostgreSQL e o ciclo de vida implementado
no código.

Baseline observado em 2026-09-15:

| Evidência | Valor observado | Interpretação |
| --- | ---: | --- |
| Canonical por ciclo | 64 blocos em 9.727 ms, 6,58 blocos/s | catch-up ativo, mas lento |
| Claim | 2.582 ms | custo PostgreSQL |
| Market/RPC | 214 ms | RPC não era o gargalo dominante |
| Append | 3.696 ms | custo PostgreSQL |
| Settle | 3.171 ms | custo PostgreSQL |
| Tempo de banco no ciclo | 9.449 ms, cerca de 97% do total | gargalo concentrado no banco |
| Domain outbox | 58,85 M live, 7,77 M dead, 31 GB | fila quente misturada com histórico concluído |
| Domain outbox cumulativo | 104,66 M inserts, 204,17 M updates | aproximadamente 1,95 update por insert |
| Head captures | 4,16 M live, 9,51 M dead, 27 GB | mais linhas mortas que vivas |
| Head captures cumulativo | 173,72 M inserts, 371,87 M updates, 136,85 M deletes | claim, settle e retenção amplificam escrita |
| Manutenção concorrente | três autovacuums grandes simultâneos | competição por I/O e WAL |
| Worker comum | espera `DataFileWrite` | impacto já alcançava tráfego normal |

O estado da domain outbox mostrava zero `pending`, zero `leased`, 24 `blocked`
e aproximadamente 58,85 milhões de linhas vivas. Embora `n_live_tup` seja uma
estimativa, a diferença de ordens de grandeza sustenta que quase toda a tabela
era formada por trabalho já concluído.

O código confirma os ciclos que produzem essas estatísticas:

```text
robinhood_chain_domain_outbox:
INSERT -> UPDATE de claim -> UPDATE de settle -> DELETE posterior por cascata

robinhood_head_captures:
INSERT -> UPDATE de claim -> UPDATE de settle -> DELETE após retenção
```

O PostgreSQL cria uma nova versão MVCC da linha em cada update ou delete. Um
vacuum recupera espaço reutilizável, mas não elimina a causa desse ciclo nem
reduz automaticamente os arquivos e índices existentes.

## Invariantes

Todos os cortes devem preservar:

1. O journal canônico continua sendo a fonte durável dos eventos da cadeia.
2. Nenhum item `pending`, `leased`, `blocked` ou em backoff pode desaparecer.
3. Claim e settle continuam idempotentes diante de crash e entrega pelo menos
   uma vez.
4. Reorg continua removendo ou invalidando somente a ramificação órfã.
5. Um erro determinístico continua bloqueando a frontier; erro transitório
   continua retentável.
6. Ausência de cursor, watermark ou telemetria exigida fecha a manutenção,
   nunca libera uma limpeza especulativa.
7. Fluxos live e catch-up têm precedência sobre retenção e compactação.
8. Nenhum corte depende de `VACUUM FULL` ou `REINDEX` como rotina operacional.
9. Logs e evidências imutáveis de `robinhood_head_captures` permanecem retidos
   por pelo menos 3 dias depois do estado terminal.

## Como medir os cortes

Uma comparação não deve usar um único tick, pois a quantidade de eventos por
bloco varia. Cada medição deve registrar no mínimo 20 ciclos e separar dois
cenários:

- `live`: canonical próximo do head;
- `catch-up`: backlog suficiente para manter o worker continuamente ocupado.

Para cada janela, registrar mediana e p95 de:

- blocos por segundo;
- itens reclamados por segundo;
- `claim_ms`, `market_ms`, `append_ms`, `settle_ms` e `total_ms`;
- queda ou crescimento do lag por minuto;
- waits PostgreSQL dos processos do bot;
- linhas vivas e mortas das tabelas afetadas;
- inserts, updates e deletes por minuto, usando deltas entre duas amostras;
- duração, fase e tabela de cada autovacuum;
- tamanho de heap e índices;
- WAL por query, quando `pg_stat_statements` disponibilizar essa coluna.

As amostras devem informar configuração de batch, concorrência, densidade de
itens por bloco e presença de vacuum. Sem isso, uma melhora pode ser apenas um
trecho da cadeia com menos eventos.

O resultado operacional principal é a velocidade líquida de recuperação:

```text
queda_lag_por_minuto = lag_no_início - lag_no_fim
tempo_estimado_de_catch_up = lag_atual / queda_lag_por_segundo
```

## Corte 1 — proteção automática da carga live

### Objetivo

Impedir que a retenção executada pelo bot concorra com o canonical ou com
outros workers durante lag ou pressão anormal do banco.

### Mudanças

- Remover `pruneExpiredCaptures` do loop do processing worker.
- Executar a poda somente no grupo isolado `robinhood-maintenance` existente.
- Adicionar um gate de admissão que considere lag canônico, disponibilidade dos
  cursores e execução de catch-up.
- Pausar em modo fail-closed quando qualquer evidência necessária estiver
  ausente.
- Limitar linhas, batches, tempo total e cooldown de cada rodada.
- Expor `running`, `paused`, `pauseReason`, lag observado, duração, linhas
  examinadas e linhas removidas.

O corte não tenta ligar, desligar ou cancelar autovacuum automaticamente. O
objetivo é remover a carga de manutenção controlada pela aplicação do caminho
live. Controle emergencial de autovacuum permanece uma operação limitada e
manual até que as tabelas quentes sejam reduzidas pelos cortes seguintes.

### Aceite

- Com lag acima do limite configurado, nenhuma poda de captures ou chain events
  é iniciada.
- A pausa aparece na telemetria com motivo objetivo.
- Processing e canonical continuam avançando durante a pausa.
- Com o sistema saudável, a retenção volta sem restart e respeita seus limites.
- Testes cobrem gate aberto, gate fechado, telemetria ausente e retomada.

### Rollback

Reverter o commit e reiniciar somente os workers `robinhood-processing` e
`robinhood-maintenance`. Não há mudança de schema ou dados.

## Corte 2 — domain outbox contém somente trabalho ativo

### Objetivo

Parar o crescimento futuro da `robinhood_chain_domain_outbox` por trabalho já
concluído.

### Mudanças

- No settle bem-sucedido, remover a linha concluída da outbox em vez de
  atualizá-la para `complete`.
- Preservar integralmente `pending`, `leased`, `blocked`, backoff e erro.
- Manter `robinhood_chain_events` como fonte durável; a outbox passa a ser
  somente o conjunto de trabalho ainda não concluído.
- Tratar o crash entre append idempotente e remoção: um novo claim pode
  reencontrar o item, reconhecer o append duplicado e concluir a remoção.
- Validar reorg e reprocessamento de uma nova ramificação.

Não será feito um `DELETE` massivo das dezenas de milhões de linhas antigas.
Elas continuarão saindo pela retenção existente, de forma limitada e apenas
quando o gate do Corte 1 permitir. Isso evita trocar bloat acumulado por uma
tempestade imediata de WAL, I/O e vacuum.

### Aceite

- Um lote concluído não deixa linhas `complete` novas na outbox.
- Retry e blocked permanecem consultáveis e bloqueiam a frontier correta.
- Crash depois do append e antes do settle não perde nem duplica o resultado
  observável.
- O número de linhas vivas converge para o backlog ativo, não para o volume de
  eventos retidos.
- `claim_ms` e `settle_ms` são comparados com a baseline em live e catch-up.

### Rollback

O schema atual continua aceitando `complete`. O rollback restaura o settle que
marca a linha como concluída; nenhuma reconstrução de dados é necessária.

## Corte 3 — separar payload imutável de estado mutável

Este corte é dividido para manter implantação e rollback controláveis.

### Corte 3A — schema e escrita compatível

Criar uma tabela estreita para o estado operacional de cada capture. Ela deve
conter apenas identidade, status, lease, tentativa, próxima tentativa, erro e
datas necessárias. O payload e a evidence continuam na estrutura durável
existente durante a transição.

A Stage 224 cria essa tabela inicialmente vazia e instala um trigger
transacional temporário no payload atual. Inserts e mutações de lifecycle passam
a ser espelhados sem trocar a autoridade de leitura. Registros anteriores serão
copiados por backfill limitado em corte separado; nenhum `INSERT ... SELECT`
massivo faz parte da criação do schema.

O backfill usa cursor keyset persistido em arquivo, lotes de 1.000 por default,
pausa configurável e revalidação do lag canônico antes de cada lote. Ele insere
somente estados ausentes com `ON CONFLICT DO NOTHING` e audita imediatamente a
paridade integral do lifecycle copiado. Falha de paridade reverte o lote e não
avança o checkpoint. O modo padrão é read-only; escrita exige `--write` e um
checkpoint explícito.

Se a correlação física da chave lógica tornar esse percurso dominado por I/O
aleatório, o modo físico percorre faixas CTID limitadas com checkpoint separado.
Ele conserva o gate de lag e a auditoria de lifecycle por faixa, rejeita qualquer
mudança de `relfilenode` e depende do trigger ativo para cobrir linhas que mudem
enquanto páginas já percorridas ficam para trás. Não é compatível com
`VACUUM FULL`, `CLUSTER` ou outro rewrite durante a execução.

O writer grava payload e estado na mesma transação. O consumidor antigo ainda
permanece oficial. Uma auditoria compara identidades e estados antes de qualquer
cutover.

Aceite do 3A:

- Cada capture elegível tem exatamente um estado correspondente.
- Retry do writer é idempotente.
- Falha parcial faz rollback das duas escritas.
- Auditoria não encontra ausência, excesso ou divergência de identidade.
- `db:schema-check` e integrações PostgreSQL passam.

### Corte 3B — cutover do claim e settle

O 3B será entregue nos subcortes abaixo. Nenhum subcorte preparatório altera
sozinho a autoridade do lifecycle em produção; a ativação é uma operação
separada, reversível e auditada. Cada fatia de código respeita o limite de 500
linhas do repositório e recebe commit e validação próprios.

#### 3B.1 — prova de cobertura e plano de claim

- Registrar os quatro checkpoints físicos concluídos, a amostra independente
  sem ausências/divergências, o trigger ativo e a FK validada. A amostra não é
  apresentada como auditoria exaustiva.
- Inventariar **todos** os leitores e writers de lifecycle, inclusive V4
  continuation, recovery, replay/reorg, watermark, cobertura e retenção.
- Medir, em produção e sem writes, a cardinalidade ativa e o plano para obter
  o primeiro capture por pool. A tabela 224 tem status, mas não tem `market_key`,
  `block_number` nem `transaction_index`; o índice V4 atual é parcial sobre o
  status do payload. Quando esse status parar de mudar, o índice deixará de
  representar a fronteira ativa. Uma nova estratégia de índice/roteamento
  precisa ser provada antes do cutover. Se exigir schema ou backfill adicional,
  apresentar custo, impacto no canonical e rollback antes de executar.

##### Decisão de desenho proposta: roteamento estreito antes do cutover

Medição de 2026-09-16 após `ANALYZE` da coluna de status: a tabela 224 estima
4.066.520 linhas, o índice parcial de `pending` estima 95.428 entradas e o de
`leased` estima zero. São estimativas, não contagens atuais nem prova de que
`blocked` seja pequeno. O `EXPLAIN` read-only da primeira captura V4 ativa
escolheu varrer estados por `chain`, buscar cada payload por PK e ordenar por
pool/bloco/transação/log. Estimou apenas ~20 mil estados com `chain='robinhood'`,
embora o CHECK da tabela imponha essa chain a todas as ~4 milhões de linhas.
Logo, nem custo estimado nem `LIMIT 1` tornam esse plano seguro; não executar
`EXPLAIN ANALYZE` no live para descobri-lo.

Proposta para um subcorte de schema separado, **ainda não autorizado para
execução**:

1. Adicionar ao estado os campos imutáveis mínimos de roteamento (`stream`,
   `protocol`, `market_key`, `block_number`, `transaction_index`), inicialmente
   nullable. O payload continua fonte da evidência bruta e desses valores no
   insert; não se apagam `topics`, `data` ou `evidence`, nem se reduz a retenção
   mínima de três dias. O trigger legado deve copiar os campos no insert e em
   qualquer reativação; após o cutover, a escrita estado-only deve preenchê-los
   antes de reativar uma linha histórica.
2. Backfill limitado e retomável dos estados `pending`, `leased` e `blocked`,
   com chave/checkpoint, batches pequenos, auditoria de identidade/roteamento
   e pausa automática por lag/timeout. Estados terminais antigos podem manter
   roteamento nulo; toda rota que reabre terminal deve hidratá-lo do payload
   na mesma transação. Antes da ativação, nenhum estado ativo pode ter rota
   incompleta. Não assumir que 95.428 seja o total ativo: medir `blocked` e
   candidatos de reabertura antes de dimensionar o trabalho.
3. Criar **um índice por vez, CONCURRENTLY**: fronteira V4 no estado por
   `(market_key, block_number, transaction_index, log_index)`, incluindo a
   identidade, parcial para `stream='market'`, `protocol='uniswap-v4'` e status
   ativo; claim independente ordenado por bloco/transação/log, parcial para
   `pending` fora de V4. Avaliar discovery separadamente antes de acrescentar
   outro índice. O índice existente por `next_attempt_at` permanece para retry.
   A presença de `leased`/`blocked` na fronteira V4 é obrigatória para impedir
   que um sucessor ultrapasse o predecessor. Provar com `EXPLAIN` e paridade
   shadow, inclusive continuação por pool, antes de apontar claims a eles.

Impacto esperado: `ALTER TABLE` nullable evita rewrite do payload, mas ainda
requer lock breve; backfill faz updates/WAL na tabela estreita, e cada
`CREATE INDEX CONCURRENTLY` lê essa tabela inteira e pode competir por I/O com
canonical e autovacuum. Não prometer duração com base nas estimativas do
planner. Serializar os passos, medir `claim_ms`, `settle_ms`, blocos/s, WAL,
I/O, dead tuples e lag dos demais workers; interromper se houver cascata de
lag ou timeout recorrente. Não acelerar via `VACUUM FULL`, parada de autovacuum
ou aumento irrestrito do gate de lag.

Rollback antes de 3B.4: o consumidor legado e o status do payload continuam
autoridade; parar o backfill/índice em andamento e manter colunas/índices
inertes até uma janela segura para eventual remoção. Não fazer `DROP` durante
o incidente. Após 3B.4, vale a reconciliação estado→payload descrita abaixo,
não simples troca de flag. Este desenho só avança para implementação após
aprovação específica do schema, do limite operacional de lag e da prova do
plano de claim.

#### 3B.2 — consultas shadow e paridade de decisões

- Implementar consultas estado+payload para claim, continuação V4 e frontiers
  sem alterar a autoridade ou criar uma segunda claim real.
- Comparar, sob a mesma fotografia transacional, identidade e ordem das
  decisões legadas e shadow, incluindo predecessor `leased`/`blocked`, retry
  ainda não vencido e bloqueio entre pools. Planos de execução precisam ter
  limites e índices seguros com backlog representativo.
- Cobrir também watermark, cobertura, recuperação e candidatos de retenção.
  Nenhum leitor pode depender do status antigo depois da ativação.

#### 3B.3 — escrita estreita pronta, porém inativa

- Preparar claim, lease, reclaim, retry, settle terminal e recovery para
  atualizar `robinhood_head_capture_states` e buscar o payload por identidade.
- Testar transações, crash, lease vencida, concorrência, ordenação V4,
  idempotência, reorg e retenção mínima de três dias no PostgreSQL.
- Proteger a direção do espelho: o trigger atual copia payload→estado. Um
  update legado do payload após a troca pode sobrescrever o estado novo.
  Instalação e ativação precisam ser cercadas por parada/lease e auditoria,
  mantendo o caminho antigo disponível apenas enquanto for coerente.

#### 3B.4 — ativação, rollback e observação

O primeiro subcorte de 3B.4 instala a Stage 228 e o seletor inativo de
repositório. A autoridade persistida nasce em `legacy`; a stage, isoladamente,
não muda o worker. A transição futura para `state` exige relatório de gate,
geração monotônica, índices válidos e trigger somente-insert. Retorno direto a
`legacy` é proibido porque requer a reconciliação descrita abaixo.
O subcorte seguinte torna todos os consumidores runtime de lifecycle
authority-aware e aponta os frontiers SQL compartilhados ao estado estreito,
sem alterar a linha de autoridade. A Stage 228 precisa existir antes do restart;
com `authority='legacy'`, claims e settles continuam no payload.

- Só ativar após auditoria de identidade/lifecycle, prova dos planos de claim,
  migração de todos os leitores/writers relevantes e parada limpa do processing.
  Confirmar que nenhuma claim antiga permanece em voo.
- Fazer canário reversível, medir claim/settle, blocos/s, WAL, dead tuples,
  waits e lag do canonical e dos demais workers. Voltar se houver regressão,
  divergência ou ordem V4 incorreta; não remover colunas/índices legados aqui.
- A fase estado-only deixa as colunas de lifecycle do payload desatualizadas.
  Portanto, rollback para o consumidor legado **não** é apenas trocar uma flag:
  exige parar o processing e reconciliar, de forma limitada e auditada, os
  estados alterados desde a ativação antes de reabrir claims legadas.

Após a ativação, claim, lease, reclaim, retry e settle atualizam somente a
tabela estreita. O payload pesado deixa de receber uma nova versão a cada
mudança de status; leituras do evento fazem join pela identidade.

Aceite do 3B:

- Processed, rejected, retry e blocked mantêm o comportamento anterior.
- V4 continuation, recovery e reorg preservam ordem e fronteiras.
- O payload recebe inserts, mas deixa de acumular updates de lifecycle.
- A taxa de updates da tabela de payload cai para perto de zero.
- Dead tuples podem crescer na tabela estreita, mas seu custo em bytes e índices
  deve ser muito menor que no payload atual.
- Mediana e p95 do canonical e do processing são comparados com os Cortes 1 e 2.

### Rollback

Antes da ativação estado-only, o consumidor ainda pode voltar ao estado legado
sem reconstruir payload. Depois dela, o retorno exige o procedimento de
reconciliação do 3B.4; escrita dupla permanente anularia a redução de WAL e
autovacuum procurada pelo corte. A remoção de colunas ou índices antigos não
pertence ao Corte 3.

## Gate de decisão após o Corte 3

Os Cortes 1–3 devem permanecer ativos por pelo menos:

- uma janela de catch-up com backlog real ou replay representativo;
- 24 horas de fluxo live;
- uma rodada de retenção admitida pelo gate;
- uma observação do comportamento do autovacuum nas tabelas modificadas.

O relatório deve comparar com a baseline:

| Métrica | Pergunta |
| --- | --- |
| blocos/s e queda de lag/min | o canonical recupera backlog mais rapidamente? |
| claim/append/settle mediana e p95 | qual fase ainda domina? |
| updates e dead tuples por minuto | a amplificação caiu na tabela de payload? |
| linhas vivas da domain outbox | ela acompanha apenas o backlog ativo? |
| duração de autovacuum | a manutenção deixou de durar horas? |
| lag dos demais workers | existe cascata durante manutenção? |
| crescimento de heap, índices e WAL | a tendência é sustentável? |

O Corte 4 não é executado se os Cortes 1–3 mantiverem os workers dentro dos
seus objetivos de lag e a manutenção couber no orçamento de I/O sem degradação
correlacionada.

Ele volta a ser considerado se as medições mostrarem pelo menos uma destas
condições materiais e repetíveis:

- retenção admitida provoca queda relevante e correlacionada de throughput ou
  lag em cascata;
- deletes continuam gerando dead tuples e WAL em ritmo que exige vacuum pesado
  frequente;
- heap e índices continuam crescendo apesar de backlog ativo estável;
- o tempo PostgreSQL continua dominando o ciclo depois da redução das filas
  quentes.

Tamanho absoluto de tabela, isoladamente, não autoriza o Corte 4.

## Corte 4 — retenção estrutural, somente se comprovada

O Corte 4 ainda não possui implementação escolhida. Antes dele, um benchmark
deve comparar pelo menos:

1. payload append-only particionado por tempo ou faixa de blocos, com descarte
   da partição após watermark seguro;
2. arquivo append-only separado da fila quente, com retenção incremental;
3. permanência do modelo resultante do Corte 3, caso já satisfaça o orçamento.

A escolha deve considerar PKs, FKs, reorg, recuperação, consultas históricas,
custo de migração e rollback. Particionamento não será adotado apenas por ser
uma prática comum.

Se comprovado, o trabalho será dividido em:

- **4A — schema e dual-write:** cria a estrutura candidata sem alterar leitores;
- **4B — cutover de leitura e retenção:** ativa watermarks e descarte limitado;
- **4C — retirada do legado:** ocorre somente depois da janela estável e de um
  rollback ensaiado.

Cada subcorte terá sua própria estimativa de arquivos e linhas antes da
aprovação. Nenhuma remoção física de legado será combinada com o cutover.

## Corte 5 — rollout, comparação e encerramento

O rollout acompanha os cortes que alteram persistência; não é uma otimização
independente.

- Publicar schema antes do writer que o utiliza.
- Manter escrita compatível durante a janela de comparação.
- Expor contagens e divergências sem varreduras ilimitadas.
- Ativar consumidores novos somente após equivalência.
- Reiniciar apenas as instâncias afetadas da template
  `trendscope-worker@.service`.
- Validar lease, cursor, frontier e throughput; processo `running` não é prova
  de funcionamento.
- Preservar a rota de rollback até a janela estável terminar.
- Atualizar `docs/bot-reference.md` quando o comportamento operacional realmente
  mudar, substituindo o contrato antigo em vez de registrar histórico de cortes.

O plano reutiliza os workers permanentes existentes. Se uma necessidade futura
exigir um novo serviço, ela deve passar novamente pelo checkpoint arquitetural e
seguir integralmente `docs/new-worker-service-runbook.md`.

## Sequência e aprovação

| Ordem | Corte | Schema | Resultado esperado |
| ---: | --- | --- | --- |
| 1 | proteção de carga | não | retenção não compete com catch-up/live |
| 2 | outbox somente ativa | não | parar crescimento por itens concluídos |
| 3A | estado estreito e escrita compatível | sim | preparar cutover reversível |
| 3B | claim/settle no estado estreito | não | eliminar updates do payload pesado |
| gate | medição live e catch-up | não | decidir com evidência se o Corte 4 existe |
| 4A–4C | retenção estrutural condicional | possivelmente | eliminar deletes massivos, se ainda necessário |
| 5 | encerramento do rollout | possivelmente | retirar legado somente após estabilidade |

Cada aprovação autoriza somente um corte. Cada corte deve permanecer abaixo
de 500 linhas alteradas, receber testes proporcionais, passar por `npm run lint`,
ter o diff completo revisado e gerar um commit exclusivo. Se o fan-out, schema
ou responsabilidade crescer além do previsto, o corte para e volta para nova
aprovação.

## Ponto importante

Os dados atuais sustentam executar os Cortes 1–3. Eles não sustentam escolher
agora uma estratégia definitiva para o Corte 4. A decisão de particionar ou criar
um arquivo separado será tomada somente depois de medir velocidade, write
amplification, autovacuum e impacto nos demais workers com as filas quentes já
corrigidas.

# Plano urgente: isolamento do head live da Robinhood

Status: Cortes 1–4 implementados e implantados em shadow; Corte 5 implementado
atrás de flags, aguardando deploy; Cortes 6–7 pendentes
Prioridade: crítica
Origem: incidente de produção de 2026-08-02

## 1. Decisão

O acompanhamento do head da Robinhood deve sair do processo genérico
`BACKGROUND_WORKER_GROUPS=robinhood` e ganhar um processo isolado cuja única
responsabilidade crítica seja capturar, enriquecer no head e persistir evidência
durável antes que o estado histórico desapareça do node podado.

Falhas em liquidez, catálogo, projeção, charts, agregação, alertas, metadata
social ou backfill não poderão impedir o avanço desse capturador.

Não basta criar outra unit systemd apontando para o mesmo grupo `robinhood`.
Isso apenas iniciaria as mesmas responsabilidades novamente e as leases fariam
os processos competir. A separação exige novos grupos, leases, cursores e uma
fronteira persistente entre captura e processamento.

## 2. Motivo urgente

No incidente de 2026-08-02, um delta negativo de `ModifyLiquidity` V4 atingiu
uma constraint de materialização. Como o cálculo e a persistência derivada
estavam na mesma transação do cursor live:

1. a faixa de mercado inteira foi revertida;
2. o cursor `market` deixou de avançar;
3. charts e dados realtime pararam de atualizar;
4. o lag chegou a 2.070 blocos;
5. a janela de estado histórico disponível no node é reportada como cerca de
   13 segundos.

O cursor permaneceu consistente e não houve skip silencioso, mas um defeito em
uma responsabilidade derivada conseguiu interromper a responsabilidade mais
sensível do sistema.

Esse acoplamento não é aceitável com uma janela de estado tão curta.

## 3. Baseline do incidente e estado atual

No baseline do incidente, o grupo `robinhood` iniciava, no mesmo processo Node.js:

- ingestion live de discovery e market;
- leitura e persistência de observações;
- cálculo de liquidez V2, V3 e V4;
- atualização de buckets;
- live catalog worker;
- market aggregate worker;
- realtime alert worker;
- catalog projection worker;
- catalog staging worker;
- opcionalmente wallet-swap live.

Desde então, `robinhood-head` captura logs e evidência state-dependent numa fila
durável com cursor independente, e `robinhood-processing` consome essa fila sem
RPC histórico. Em `2026-08-05`, o head shadow foi medido com lag zero; o processing
foi pausado porque o índice de claim fazia scan de milhões de linhas para cada lote
de 200. O monólito permanece ativo até o reparo do claim, a comparação do Corte 6
e o handoff dos derivados.

## 4. Restrição central: estado podado

Há dois tipos de dados com retenções diferentes:

- blocos, receipts e logs podem continuar consultáveis por muito mais tempo;
- estado histórico necessário para `eth_call` pode desaparecer em segundos.

Portanto, um capturador que salve apenas logs não resolve o problema. Antes de
avançar seu cursor, ele deve persistir também toda evidência dependente de estado
que não possa ser reconstruída posteriormente usando apenas logs.

### 4.1 Evidência que deve ser capturada no head

Para cada bloco/faixa elegível:

- identidade e hash do bloco;
- logs brutos e sua ordem global por `logIndex`;
- protocolo e mercado resolvidos pelo registry conhecido naquele momento;
- timestamps necessários;
- respostas de metadata ERC-20 necessárias para normalização;
- `totalSupply` e sua proveniência;
- quote USD usada e sua proveniência;
- V3: `balanceOf(pool)` do token e da quote no bloco do swap;
- qualquer outro `eth_call` ancorado no bloco exigido pelo contrato público da
  observação;
- erros de captura classificados como retryable ou terminal, nunca convertidos
  silenciosamente em zero.

V2 usa reservas emitidas por logs `Sync`. V4 possui preço e liquidez ativa no
evento de swap e distribuição por ticks no ledger de `ModifyLiquidity`, mas
metadata, supply e quote ainda precisam respeitar sua proveniência.

## 5. Topologia alvo

### 5.1 `robinhood-head`

Processo crítico e mínimo.

Responsabilidades permitidas:

- acompanhar discovery e market no node local;
- validar chain ID, bloco, checkpoint e reorg;
- capturar logs;
- executar imediatamente os `eth_call` que dependem do estado recente;
- persistir captura e evidência em uma transação curta;
- avançar somente o cursor de captura;
- publicar uma claim/outbox durável para processamento.

Responsabilidades proibidas:

- calcular TVL final;
- atualizar buckets ou charts;
- projetar catálogo;
- buscar Blockscout, DexScreener, IPFS ou metadata social;
- publicar alerts;
- executar materializações ou replay;
- aguardar consumidores derivados.

O processo deve possuir pool de banco pequeno e reservado, prioridade superior
às tarefas derivadas e nenhuma dependência síncrona de APIs sociais.

### 5.2 `robinhood-processing`

Consumidor durável e reiniciável.

Responsabilidades:

- reclamar capturas prontas usando lease curta;
- decodificar e validar eventos;
- aplicar regras de elegibilidade;
- calcular preço, FDV e liquidez V2/V3/V4;
- persistir observações e buckets;
- manter ledger/faixas V4;
- criar outbox para agregações, catálogo e alerts;
- usar retry com backoff e dead-letter auditável.

Um erro em um mercado deve isolar a claim correspondente. Ele não pode reverter
o cursor do capturador nem impedir a captura de blocos seguintes.

### 5.3 `robinhood-derived`

Processo de menor prioridade:

- live catalog alimentado por `market:bucket`;
- token aggregates alimentados por `market:bucket`;
- realtime alerts;
- publicação para Socket/relay;

Os pollers independentes de catalog projection/staging, metadata externa e
imagens permanecem fora desse consumidor.

Pode ficar indisponível e recuperar pela outbox sem impactar captura ou
processamento de observações.

### 5.4 `robinhood-backfill`

Permanece separado. Replay e materialização one-shot nunca devem executar dentro
do processo `robinhood-head`.

## 6. Fronteira persistente

O desenho deve introduzir uma fila durável de capturas live. Reusar diretamente
uma tabela de backfill só será aceito se os contratos de identidade, retenção,
claim e finalização forem realmente compatíveis; sem isso, deve existir uma
tabela dedicada.

Contrato mínimo de uma captura:

- `chain`;
- `stream`;
- `block_number` e `block_hash`;
- `transaction_hash` e `log_index`;
- endereço, topics e data do log;
- market/protocol resolvidos quando aplicável;
- payload de evidência JSONB versionado;
- versão do decoder/capturador;
- status de captura;
- status de processamento;
- tentativas, próximo retry e último erro;
- timestamps de criação, claim e finalização.

Identidade deve ser idempotente por chain, transação e log. Reorg deve invalidar
capturas pelo bloco/hash, nunca apenas pelo número.

## 7. Cursores e invariantes

Devem existir fronteiras independentes:

1. `capture_cursor`: até onde logs e evidência recente estão duravelmente salvos;
2. `processing_cursor` ou watermark equivalente: até onde as capturas foram
   transformadas em observações/buckets;
3. watermarks derivados: catálogo, aggregates e alerts.

Invariantes obrigatórios:

- captura e avanço de `capture_cursor` ocorrem na mesma transação;
- processamento nunca altera `capture_cursor`;
- falha derivada nunca remove uma captura pronta;
- nenhum consumidor usa `NOW()` ou `latest` para fingir evidência histórica;
- uma claim não pode ser finalizada se sua identidade/bloco divergir;
- reprocessamento produz o mesmo resultado ou falha explicitamente;
- nenhuma ação operacional usa skip de cursor como recuperação normal.

## 8. Units e grupos propostos

Nomes lógicos:

```text
trendscope-worker@robinhood-head.service
trendscope-worker@robinhood-processing.service
trendscope-worker@robinhood-derived.service
trendscope-worker@robinhood-backfill.service
```

Grupos:

```env
BACKGROUND_WORKER_GROUPS=robinhood-head
BACKGROUND_WORKER_GROUPS=robinhood-processing
BACKGROUND_WORKER_GROUPS=robinhood-derived
BACKGROUND_WORKER_GROUPS=robinhood-backfill
```

Leases distintas:

```text
robinhood-head-capture-worker
robinhood-processing-worker
robinhood-derived-worker
```

Cada grupo isolado deve ser mutuamente exclusivo com `all` e com outros grupos
na mesma instância, seguindo a proteção já aplicada ao backfill.

## 9. Orçamento de recursos

O head precisa de reserva própria:

- conexões PostgreSQL reservadas;
- limites independentes de CPU/memória no systemd;
- sem concorrência de queries pesadas de catálogo;
- timeouts curtos e explícitos;
- logs e métricas independentes;
- prioridade de I/O suficiente para persistir dentro da janela de estado.

Replay/materialização devem possuir statement timeout, lock timeout e limites de
recursos próprios. Nunca podem monopolizar as conexões reservadas ao head.

## 10. Observabilidade obrigatória

Alertas críticos não podem depender somente de `lagBlocks`.

Métricas mínimas do head:

- `captureHeadDelayMs`;
- `captureLagBlocks`;
- último bloco/hash capturado;
- idade do último commit;
- duração de RPC por método;
- duração da transação de captura;
- erros de estado podado;
- retries e falhas consecutivas;
- tamanho da fila durável.

Limites iniciais, sujeitos a medição:

- warning com delay de captura acima de 3 segundos;
- critical acima de 7 segundos;
- critical imediato para erro de estado podado;
- critical se o cursor não avançar enquanto o head avança;
- warning de backlog de processamento sem afetar saúde do capturador.

O status operacional deve mostrar separadamente:

```text
HEAD CAPTURE: healthy / delayed / halted
PROCESSING: healthy / backlogged / halted
DERIVED: healthy / backlogged / halted
```

## 11. Recuperação de incidentes

Regra principal: não parar o head para corrigir consumidor derivado.

Procedimento esperado:

1. confirmar que `capture_cursor` continua avançando;
2. pausar somente `robinhood-processing` ou `robinhood-derived`;
3. preservar capturas pendentes;
4. corrigir e redeployar o consumidor;
5. retomar claims do ponto persistido;
6. auditar pendências/rejeições antes de declarar recuperação.

Se o próprio head falhar, o incidente é crítico e deve usar fallback RPC capaz
de fornecer o estado necessário ou um capturador standby já seguindo o head.

## 12. Rollout sem janela de captura

Não será feito um corte que primeiro desligue o worker atual.

Estratégia:

1. aplicar schema somente aditivo e online;
2. iniciar `robinhood-head` em shadow com cursor independente;
3. comparar logs, evidências e hashes com o fluxo atual;
4. manter shadow junto ao head por período suficiente;
5. ativar persistência canônica idempotente/dual-write controlado;
6. iniciar `robinhood-processing` consumindo a nova fila em shadow;
7. comparar observações e buckets;
8. promover o novo head sem desligá-lo;
9. desativar apenas a captura antiga após confirmar o novo cursor;
10. mover derivados por último.

O handoff deve ser medido em milissegundos/segundos e não depender de restart
sequencial manual.

## 13. Cortes de implementação

Cada corte respeita o limite de 500 linhas alteradas e exige autorização
independente.

### Corte 1 — contrato e schema da captura (implementado)

- schema aditivo da fila live;
- cursor de captura independente;
- índices de claim/reorg;
- runtime schema check;
- testes de persistência/idempotência;
- migration online (`NOT VALID` + `VALIDATE` quando aplicável).

### Corte 2 — capturador de head (implementado)

- adapter mínimo do poller;
- captura de logs e evidência state-dependent;
- transação curta de captura/cursor;
- métricas de delay;
- testes unitários e de integração.

### Corte 3 — processo e unit isolados (implantado em shadow)

- grupo `robinhood-head`;
- lease exclusiva;
- env e unit systemd;
- pool/limites próprios;
- dry-run e shadow mode.

### Corte 4 — consumidor de processamento (implantado; pausado para reparo do claim)

- claim durável;
- decoder/valuation a partir da evidência capturada;
- retry/dead-letter;
- processamento idempotente;
- cursor/watermark independente.

### Corte 5 — isolamento dos derivados (implementado atrás de flags)

- retirar catálogo, aggregates e alerts da closure do ingestion atual;
- grupo `robinhood-derived`;
- consumo por outbox;
- falhas derivadas sem impacto no processamento.

### Corte 6 — shadow, comparação e cutover (6A/6B/6C implementados atrás de flags)

- auditoria bloco/log e comparação de observações entre caminhos (6A);
- comparação audit-only de buckets/outbox e resolução da disputa idempotente com o monólito (6B);
- geração/publicação idempotente de alertas padrão pelo derived, com gate e proteção de backlog (6C);
- canary em produção;
- handoff sem parar captura;
- rollback mantendo o novo head ativo.

### Corte 7 — remoção do caminho monolítico

- remover composição antiga somente após estabilidade;
- preservar ferramentas de auditoria;
- atualizar runbooks e topologia final.

## 14. Checkpoint arquitetural

Esta mudança deve tocar mais de 12 arquivos de produção e atravessa config,
server composition, poller, RPC, persistência, schema, workers, systemd e
observabilidade. Portanto é um checkpoint arquitetural obrigatório.

Antes do Corte 1 devem ser confirmados:

- esquema exato da evidência por protocolo;
- se a staging existente pode ser reutilizada sem misturar contratos;
- capacidade e retenção da fila live;
- orçamento de conexões do PostgreSQL;
- fallback de estado histórico;
- mecanismo de shadow/dual-write;
- procedimento de handoff sob 13 segundos.

## 15. Critérios de aceite final

- um erro proposital no cálculo V4 não interrompe `capture_cursor`;
- um erro de catálogo não afeta captura nem processamento;
- captura permanece dentro dos limites de 3/7 segundos;
- todas as chamadas dependentes de estado possuem evidência persistida;
- reinício de processamento não requer RPC histórico;
- reprocessamento é idempotente;
- reorg é detectado por bloco/hash;
- backlog derivado é visível e recuperável;
- nenhuma migration de tabelas quentes exige parar o head;
- deploy e rollback mantêm captura contínua;
- dashboard diferencia claramente saúde de head, processamento e derivados.

## 16. Ações imediatas para concluir o rollout

1. manter `robinhood-head` ativo e separado durante toda recuperação;
2. corrigir online o índice de claim market antes de retomar processing;
3. provar throughput superior à entrada e drenar o backlog;
4. comparar observações/buckets entre monólito e novo caminho;
5. implantar derived em shadow e completar os sinks do Corte 6;
6. remover o monólito somente depois dos gates de estabilidade e rollback.

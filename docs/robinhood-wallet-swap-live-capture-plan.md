# Plano de execução — captura LIVE de wallet-swaps e cutover para a VPS2

> Estado revisado em `2026-08-01` contra o código da branch
> `Robinhood-Implementation` no commit `954ae548` e contra os frontiers informados
> da produção. Este documento separa o LIVE principal da captura LIVE de
> wallet-swaps e define o handoff sem lacuna. Implementação continua fatiada;
> cada fatia de código exige aprovação explícita antes de editar.

## 1. Resultado pretendido

Na topologia final:

- VPS2 executa o node Robinhood podado/full no head, RPC local em `127.0.0.1:8547`;
- VPS2 executa o grupo `BACKGROUND_WORKER_GROUPS=robinhood`;
- ingestão, enrichment, buckets e wallet-swaps novos acompanham continuamente o head;
- todos os componentes do backfill ficam desabilitados;
- o node archive e os processos temporários do PC podem ser desligados;
- PostgreSQL na VPS2 continua sendo a fonte durável do histórico consolidado.

O cutover deve ser feito com **sobreposição**: primeiro ligar e comprovar o LIVE na
VPS2; somente depois interromper o backfill. Não existe uma etapa planejada em que
os dois produtores fiquem desligados.

## 2. Dois pipelines diferentes

```text
Node Robinhood VPS2
        |
        v
LIVE principal (@robinhood)
  discovery + market logs
        |
        v
robinhood_market_observations + buckets
        |
        v
LIVE de wallet-swaps (novo)
  bloco cheio -> tx.from
        |
        v
robinhood_wallet_swaps
```

### 2.1 LIVE principal — já implementado

Arquivos centrais:

- `src/services/robinhood-ingestion-worker.js`;
- `src/services/robinhood-continuous-runner.js`;
- `src/services/robinhood-onchain-pipeline.js`;
- wiring no grupo `robinhood` em `src/server.js`.

O caminho de swaps foi alterado para usar WETH/USD e metadata/supply em `latest`,
removendo a dependência de estado histórico para o enrichment normal de mercado.
A stage 96 adiciona a proveniência `latest_call` exigida por essa escrita.

### 2.2 LIVE de wallet-swaps — código completo localmente, execução pendente

Hoje existem no checkout local:

- tabela particionada `robinhood_wallet_swaps`;
- cursor independente com streams `seed` e `live`;
- source reader de observações aceitas;
- adapter de bloco cheio para `tx.from`;
- attributor/persistência;
- runner contínuo fail-closed;
- worker com preflight de chain ID, lease, telemetria e wiring no grupo `robinhood`;
- configuração operacional desabilitada por padrão;
- seed standalone `src/utils/robinhood-wallet-swap-seed.js`.

Ainda falta o bootstrap auditável do cursor `live` e o runbook da fatia 4. Sem o
cursor, o worker retorna `awaiting-bootstrap`, mantém a lease saudável e não grava
nem avança estado. O `robinhood-realtime-alert-worker.js` não substitui essa
responsabilidade.

## 3. Correções ao desenho anterior

O plano anterior tinha premissas que não correspondem às APIs atuais:

- `advanceCursor('live', {safeHead})` não é válido: o método atual também exige
  `nextBlock` e `expectedVersion`;
- `COALESCE($safeHead, safe_head)` evita gravar `NULL`, mas **não** impede regressão
  numérica de `safe_head`;
- o cursor repository ainda não possui operação explícita de rewind/reorg;
- `runSeedBatch` avança mesmo quando o attributor reporta `missing`/`unresolved`;
- quando não há observação aceita no intervalo, o seed retorna `done` sem avançar
  `next_block` até o limite auditado;
- não existe hoje lease para o futuro worker LIVE; a versão otimista evita
  clobber do cursor `live`, mas não evita dois donos fazendo RPC/trabalho duplicado.
  O seed usa outro stream e deve permanecer operacionalmente separado.

Esses pontos precisam ser corrigidos na implementação, não apenas documentados.

## 4. Contratos de segurança do novo worker

### 4.1 Limite processável

Cada tick calcula dois limites:

```text
nodeSafeHead = nodeHead - ROBINHOOD_WALLET_SWAP_LIVE_REORG_DEPTH
sourceSafeHead = robinhood_ingestion_cursors.market.next_block - 1
processableThrough = min(nodeSafeHead, sourceSafeHead)
```

Default recomendado:

```env
ROBINHOOD_WALLET_SWAP_LIVE_REORG_DEPTH=12
```

O worker nunca processa um bloco que o LIVE principal ainda não tenha commitado e
nunca fica mais perto do head que a profundidade de reorg escolhida.

### 4.2 Progresso em intervalos sem swap

É seguro avançar o cursor sobre um intervalo sem observações somente porque o
`sourceSafeHead` prova que o cursor `market` upstream já commitou o intervalo.
Nesse caso, o worker avança `next_block` para `processableThrough + 1` sem RPC de
bloco. Isso evita reconsultar indefinidamente um range vazio.

### 4.3 Política para `missing` e `unresolved`

Política obrigatória: **fail closed**.

- processar grupos por bloco, em ordem;
- buscar `eth_getBlockByNumber(block, true)`;
- se qualquer transação observada não existir no bloco canônico, não avançar o
  cursor além daquele bloco;
- registrar erro, retry/backoff e contagem na telemetria;
- depois do limite configurado de tentativas consecutivas, marcar o worker como
  `halted` e manter a lease em estado operacionalmente visível;
- nunca persistir wallet nula e nunca transformar `missing` em sucesso.

Inserções anteriores são idempotentes, portanto um retry do mesmo bloco não duplica
wallet-swaps.

### 4.4 Checkpoint e reorg

O adapter deve validar e devolver `blockHash`, além de número e timestamp. Depois de
um bloco atribuído sem buracos, o cursor grava:

- `next_block = block + 1`;
- `checkpoint_block = block`;
- `checkpoint_hash = hash canônico retornado pelo node`;
- `checkpoint_timestamp = timestamp do bloco`.

No início de cada tick, quando existir checkpoint, o worker busca novamente o hash
do checkpoint e compara com o persistido.

Primeira versão: **não fazer rewind automático**. Uma divergência após 12 blocos deve
parar com `persistent_reorg`, porque um rewind correto também exigiria reconciliar
observações upstream e remover wallet-swaps do bloco órfão. Rewind parcial apenas do
cursor criaria duplicação ou dados órfãos. Recuperação automática fica fora da
primeira versão até existir uma transação de reconciliação completa.

### 4.5 Monotonicidade do cursor

O repository deve ganhar uma operação específica para o LIVE que:

- exige `expectedVersion`;
- não permite reduzir `next_block`;
- não permite reduzir `safe_head` silenciosamente;
- preserva checkpoint quando a atualização altera somente o frontier;
- atualiza frontier e checkpoint atomicamente;
- retorna conflito quando outro dono avançou a versão.

Não é necessária migration: as colunas existentes bastam.

## 5. Bootstrap e handoff seed -> LIVE de wallet-swaps

O bootstrap deve ser um comando operacional explícito, dry-run por padrão. O worker
não inventa seu ponto inicial no primeiro boot.

Precondições:

1. cursor `seed` existe;
2. nenhuma instância LIVE de wallet-swaps possui lease ativa;
3. cursor `live` ainda não existe, ou o comando entra apenas em modo de inspeção;
4. o bloco mais antigo necessário ainda é servido com transações completas pelo
   RPC da VPS2;
5. o seed não possui observações aceitas não atribuídas dentro do limite que ele
   declarou processado.

Auditoria central:

```sql
SELECT COUNT(*) AS accepted_without_wallet
FROM robinhood_market_observations observation
WHERE observation.chain = 'robinhood'
  AND observation.status = 'accepted'
  AND observation.block_number <= $SEED_SAFE_HEAD
  AND NOT EXISTS (
    SELECT 1
    FROM robinhood_wallet_swaps wallet_swap
    WHERE wallet_swap.chain = observation.chain
      AND wallet_swap.transaction_hash = observation.transaction_hash
      AND wallet_swap.action_index = observation.log_index
  );
```

Se o resultado for zero, o bootstrap pode iniciar `live.next_block` em
`seed.safe_head + 1`. Se houver pendências, o bootstrap recusa e lista a menor e a
maior altura afetadas; primeiro deve haver retry/reparo do seed.

O comando de bootstrap deve:

- mostrar seed cursor, market cursor upstream, node head e ponto proposto;
- testar `eth_getBlockByNumber(oldestNeeded, true)` quando existir gap;
- não alterar nada sem flag de confirmação longa e inequívoca;
- criar o cursor `live` uma única vez, com `ON CONFLICT DO NOTHING`;
- imprimir uma checagem pós-condição.

## 6. RPC e execução na VPS2

O worker reutiliza a factory/roteamento RPC Robinhood já existente, configurado com:

```env
ROBINHOOD_RPC_URL=http://127.0.0.1:8547
ROBINHOOD_USE_DRPC=false
ROBINHOOD_USE_ALCHEMY=false
```

Ele usa somente:

- `eth_chainId` no preflight;
- `eth_blockNumber` para frontier;
- `eth_getBlockByNumber(n, true)` para atribuição;
- `eth_getBlockByNumber(n, false)` ou equivalente para revalidar checkpoint.

Não faz `eth_call` de estado histórico. Diferentemente do enrichment de mercado,
o wallet attributor pode alcançar observações antigas desde que o node ainda sirva
o corpo completo dos blocos. Essa capacidade deve ser testada, não presumida.

## 7. Worker, lease, configuração e telemetria

Configuração proposta:

```env
ROBINHOOD_WALLET_SWAP_LIVE_ENABLED=true
ROBINHOOD_WALLET_SWAP_LIVE_INTERVAL_MS=2000
ROBINHOOD_WALLET_SWAP_LIVE_MAX_BLOCKS_PER_TICK=200
ROBINHOOD_WALLET_SWAP_LIVE_REORG_DEPTH=12
ROBINHOOD_WALLET_SWAP_LIVE_MAX_CONSECUTIVE_FAILURES=5
```

Lease:

```text
robinhood-wallet-swap-live-worker
```

O worker pertence exclusivamente ao grupo `robinhood`, mas sua flag é independente
da flag de ingestão. Assim ele pode drenar até o frontier persistido mesmo durante
uma parada temporária do ingestion worker.

`getStatus()`/telemetria deve expor no mínimo:

- running, inFlight, halted;
- nodeHead, nodeSafeHead, sourceSafeHead, processableThrough;
- nextBlock, safeHead, checkpointBlock;
- lagBlocks;
- batches, processedBlocks, attributed, inserted;
- duplicate inserts;
- missing, unresolved, retries, conflicts;
- último erro sanitizado e timestamp da última conclusão.

## 8. Fan-out revisado

Produção estimada: 7-8 arquivos, abaixo do architecture checkpoint de 12 arquivos.

- alterar `src/services/robinhood-transaction-sender-adapter.js` para normalizar e
  devolver `blockHash`;
- alterar `src/services/robinhood-wallet-swap-attributor.js` para devolver metadados
  do bloco e sustentar a política fail-closed;
- alterar `src/models/robinhood-wallet-swap-cursor.js` com avanço LIVE monotônico;
- novo `src/services/robinhood-wallet-swap-live-runner.js`;
- novo `src/services/robinhood-wallet-swap-live-worker.js`;
- novo `src/utils/bootstrap-robinhood-wallet-swap-live.js`;
- wiring/configuração em `config/index.js` e `src/server.js`.

Não tocar:

- schema stages 90/91/92;
- backfill enrichment adapter;
- regra de pricing do LIVE principal;
- API/read model de wallet tracking.

## 9. Fatias de implementação

Cada fatia muda no máximo 500 linhas e exige aprovação separada.

### Fatia 1 — contratos de bloco e cursor

**Concluída localmente em `2026-08-01`.**

- adapter devolve hash canônico;
- attributor devolve resultado por bloco com checkpoint;
- avanço LIVE monotônico preserva checkpoint;
- testes unitários para hash inválido, regressão recusada, conflito e preservação.

Durante a implementação, o contrato fail-closed revelou uma regressão no seed
existente: ele avançava mesmo quando o attributor reportava transações ausentes.
O seed runner agora para com `stopped='unresolved'` e mantém o cursor no bloco
anterior. O attributor também deixou de fazer escrita parcial quando qualquer
transação do grupo não existe no bloco canônico.

Estimativa: 220-320 linhas alteradas.

Regressões protegidas: cursor não pula buraco; checkpoint não é apagado por update
de frontier; safe head não regride silenciosamente; seed não confirma atribuição
parcial.

### Fatia 2 — runner puro

**Concluída localmente em `2026-08-01`.**

- cálculo dos três frontiers;
- revalidação do checkpoint;
- leitura por grupos;
- processamento sequencial fail-closed;
- avanço seguro de intervalos vazios;
- orçamento por tick e conflito otimista.

Estimativa: 250-380 linhas alteradas.

Testes table-driven: caught-up, intervalo vazio, novos swaps, atraso upstream,
missing, conflito, head abaixo de reorg depth e persistent reorg.

O runner retorna `awaiting-bootstrap` sem erro quando o cursor `live` ainda não
existe. Isso permite que o futuro worker adquira sua lease e permaneça saudável
antes do handoff explícito do seed. Ranges vazios só avançam até o menor frontier
comprovado; uma página cheia nunca pula o restante do range sem nova consulta.

### Fatia 3 — worker e wiring

**Concluída localmente em `2026-08-01`.**

- start/stop/runOnce/getStatus;
- RPC local e chain ID 4663;
- lease e wiring no grupo `robinhood`;
- config/env example;
- telemetria sanitizada.

O worker reutiliza o cliente RPC Robinhood e valida todos os providers como chain
ID `4663` antes do primeiro tick. Sua lease é independente da ingestão principal;
ele pode drenar apenas até o frontier `market` já commitado. A flag permanece
`false` no env example e nenhum cursor `live` é criado automaticamente.

Estimativa: 280-400 linhas alteradas.

### Fatia 4 — bootstrap e runbook

**Concluída localmente em `2026-08-01`.**

- comando dry-run/confirm;
- auditoria seed -> live;
- probe do bloco cheio mais antigo necessário;
- comandos de ativação, monitoramento e rollback;
- atualização final de `docs/bot-reference.md`.

O comando `npm run robinhood:wallet-live-bootstrap` é read-only por padrão. Ele
audita o seed, mostra o cursor market e o head, valida chain ID `4663`, exige
`eth_syncing=false` e busca com transações completas o primeiro bloco com observação
aceita no gap que o worker precisará reler. A escrita exige
`--confirm-bootstrap-robinhood-wallet-swap-live`, revalida tudo sob transação e
cria `live.next_block = seed.safe_head + 1` uma única vez, com `safe_head=NULL`.

Estimativa: 220-350 linhas, majoritariamente documentação operacional.

## 10. Cutover do LIVE principal com sobreposição

Snapshot informado em `2026-08-01`:

```text
discovery_scan.next_block  = 25346067
market_scan.next_block     = 25345966
market_enriched.next_block = 25345966
```

Nesse snapshot o market está integralmente enriquecido até `25345965` e discovery
está 101 blocos à frente. Os valores são móveis; o cutover não deve reutilizar esse
número horas depois.

Sequência correta:

1. manter todos os componentes atuais do backfill rodando;
2. aplicar migrations requeridas pelo checkout e obter schema check limpo;
3. confirmar node VPS2 em chain 4663, `eth_syncing=false` e head recente;
4. ler um snapshot fresco dos três frontiers;
5. exigir `market_scan.next_block = market_enriched.next_block`;
6. definir `H = market_enriched.next_block` daquele instante;
7. se os cursores LIVE `discovery`/`market` não existirem, configurar
   `ROBINHOOD_START_BLOCK=H`;
8. se já existirem, não confiar no env: o código prefere o cursor persistido; auditar
   os dois e usar recuperação controlada se estiverem antigos;
9. iniciar a unit LIVE da VPS2 mantendo backfill e PC ativos;
10. confirmar lease, chain ID, ausência de erro e ambos os cursores LIVE avançando;
11. confirmar observações `latest_call` novas e buckets recentes;
12. manter o wallet worker desabilitado, executar o bootstrap dry-run e revisar a
    auditoria do seed;
13. confirmar o bootstrap, habilitar o wallet LIVE e reiniciar somente a unit
    Robinhood da VPS2;
14. confirmar lease própria, cursor wallet avançando e `missing=unresolved=0`;
15. manter canary com overlap até observar estabilidade e lag próximo de zero;
16. parar primeiro os scanners RPC-heavy do backfill;
17. deixar enrichment/finalizer/aggregation drenarem o que já foi capturado;
18. exigir staging e outbox sem pendências e frontiers finais alinhados;
19. desabilitar as units/processos de backfill para que não retornem no reboot;
20. manter o node archive do PC até concluir e auditar o seed de wallet-swaps;
21. somente então desligar o node archive do PC.

A sobreposição é segura porque as identidades de processed logs, observações e
wallet-swaps são idempotentes no banco. O ponto perigoso é uma lacuna, não a leitura
duplicada controlada.

## 11. Ambiente LIVE-only da VPS2

O arquivo da unit LIVE deve declarar explicitamente:

```env
RUN_SOCKET_HUB=false
RUN_BACKGROUND_JOBS=true
BACKGROUND_WORKER_GROUPS=robinhood

ROBINHOOD_INGESTION_ENABLED=true
ROBINHOOD_TRANSPORT_ENABLED=true
ROBINHOOD_PERSISTENCE_ENABLED=true
ROBINHOOD_ALERTS_ENABLED=false
ROBINHOOD_RPC_URL=http://127.0.0.1:8547

ROBINHOOD_BACKFILL_DISCOVERY_ENABLED=false
ROBINHOOD_BACKFILL_SHADOW_ENABLED=false
ROBINHOOD_BACKFILL_ENRICHMENT_ENABLED=false
ROBINHOOD_BACKFILL_FINALIZER_ENABLED=false
ROBINHOOD_BACKFILL_WATCHDOG_ENABLED=false
ROBINHOOD_BACKFILL_AGGREGATION_ENABLED=false
```

As flags de backfill precisam estar explicitamente falsas: `src/server.js` permite
que esses subworkers sejam registrados no grupo `robinhood` quando suas flags ficam
ativas. Selecionar o grupo LIVE sozinho não neutraliza flags herdadas de `.env`.

Depois do bootstrap confirmado:

```env
ROBINHOOD_WALLET_SWAP_LIVE_ENABLED=true
```

### 11.1 Bootstrap wallet LIVE, ainda com backfill ligado

Use os valores reais de `User`, `WorkingDirectory`, `EnvironmentFile` e caminho do
`npm` já verificados na unit. O exemplo abaixo cria uma unit transitória e não
imprime os segredos do env:

```bash
sudo systemd-run --wait --pipe --collect \
  --unit=robinhood-wallet-live-bootstrap \
  --setenv=NODE_ENV=production \
  --property=User=REPLACE_APP_USER \
  --property=WorkingDirectory=/REPLACE/ABSOLUTE/PATH/Volume-Bot-Alert \
  --property=EnvironmentFile=/etc/volume-bot-alert/robinhood.env \
  /REPLACE/ABSOLUTE/PATH/TO/npm run robinhood:wallet-live-bootstrap
```

O dry-run precisa mostrar:

- `liveWorkerActive=false`;
- seed com `safeHead` não nulo;
- `acceptedWithoutWallet="0"`;
- `providerChainIds` iguais a `4663`;
- `syncing=false`;
- `probedBlock` preenchido quando houver observação aceita no gap;
- cursor `live` ausente, ou modo apenas de inspeção se já existir.

Somente após revisar a saída, executar a confirmação longa:

```bash
sudo systemd-run --wait --pipe --collect \
  --unit=robinhood-wallet-live-bootstrap-confirm \
  --setenv=NODE_ENV=production \
  --property=User=REPLACE_APP_USER \
  --property=WorkingDirectory=/REPLACE/ABSOLUTE/PATH/Volume-Bot-Alert \
  --property=EnvironmentFile=/etc/volume-bot-alert/robinhood.env \
  /REPLACE/ABSOLUTE/PATH/TO/npm run robinhood:wallet-live-bootstrap -- \
  --confirm-bootstrap-robinhood-wallet-swap-live
```

Se `acceptedWithoutWallet` for maior que zero, não confirmar: reparar/reexecutar o
seed nas alturas `missingMinBlock..missingMaxBlock`. Se o cursor `live` já existir,
o comando confirmado recusa; não apagar nem resetar o cursor para tentar de novo.

### 11.2 Ligar os dois caminhos LIVE antes de parar o backfill

No `/etc/volume-bot-alert/robinhood.env`, manter as flags de backfill explicitamente
falsas e alterar somente:

```env
ROBINHOOD_WALLET_SWAP_LIVE_ENABLED=true
```

Aplicar reiniciando apenas a unit Robinhood; o backfill continua ativo cobrindo a
janela da reinicialização:

```bash
sudo systemctl restart volume-bot-alert-worker-robinhood.service
systemctl status volume-bot-alert-worker-robinhood.service --no-pager -l
journalctl -u volume-bot-alert-worker-robinhood.service -n 150 --no-pager
```

Auditar leases e cursores repetidamente durante o canary:

```sql
SELECT lease_key, owner_id, lease_until,
       metadata->>'state' AS state,
       metadata->'telemetry' AS telemetry
FROM worker_leases
WHERE lease_key IN ('robinhood-ingestion-worker',
                    'robinhood-wallet-swap-live-worker')
ORDER BY lease_key;

SELECT stream, next_block, safe_head, checkpoint_block, version, updated_at
FROM robinhood_wallet_swap_cursors
WHERE chain = 'robinhood'
ORDER BY stream;

SELECT stream, next_block, safe_head, checkpoint_block, version, updated_at
FROM robinhood_ingestion_cursors
WHERE chain = 'robinhood'
ORDER BY stream;
```

Critério mínimo antes de tocar no backfill: leases únicas e renovando, cursores
discovery/market e wallet `live` avançando, lag próximo de zero, nenhum
`persistent_reorg`, `wallet_attribution_blocked`, `missing` ou `unresolved`.

### 11.3 Parar o backfill em duas etapas

Primeiro alterar o env da unit backfill para parar somente captura:

```env
ROBINHOOD_BACKFILL_DISCOVERY_ENABLED=false
ROBINHOOD_BACKFILL_SHADOW_ENABLED=false
```

Manter enrichment/finalizer/watchdog/aggregation ativos e reiniciar somente a unit
backfill. Depois conferir staging/outbox e frontiers até drenar:

```sql
SELECT frontier, next_block, checkpoint_block, updated_at
FROM robinhood_backfill_watermarks
WHERE chain = 'robinhood'
ORDER BY frontier;

SELECT enrichment_status, COUNT(*)
FROM robinhood_market_log_staging
GROUP BY enrichment_status
ORDER BY enrichment_status;
SELECT status, COUNT(*) FROM robinhood_backfill_aggregation_outbox GROUP BY status ORDER BY status;
```

Quando não houver pendências/claims/blocked e `market_scan = market_enriched`, parar
e impedir retorno no reboot:

```bash
sudo systemctl disable --now volume-bot-alert-worker-robinhood-backfill.service
systemctl is-enabled volume-bot-alert-worker-robinhood-backfill.service
systemctl is-active volume-bot-alert-worker-robinhood-backfill.service
```

O node archive do PC continua ligado até a auditoria final e o canary LIVE serem
aceitos.

### 11.4 Rollback durante o overlap

Se apenas wallet LIVE falhar, voltar sua flag para `false` e reiniciar somente a unit
Robinhood. Preservar o cursor e a lease halted para diagnóstico. Se o LIVE principal
falhar, manter o backfill ativo. Se os scanners já foram desabilitados, reativar as
duas flags de scanner e reiniciar a unit backfill. Nunca deletar cursores, wallet
swaps ou ranges como primeiro rollback.

## 12. Bloqueadores operacionais atuais

### 12.1 Schema runtime

O diagnóstico anexado mostra `npm run db:schema-check` falhando por stages Telegram
84-89 e 93-95 ausentes. No checkout atual, `src/server.js` executa o runtime schema
check antes de iniciar workers e encerra o processo em falha.

Portanto não basta aplicar a stage 96. Antes do canary LIVE é necessário escolher e
executar, em mudança separada e após backup, uma das opções:

- aplicar todas as migrations já exigidas pelo profile runtime, mantendo Telegram
  desabilitado por configuração; ou
- alterar o contrato de runtime schema para ser role/capability-aware, mudança
  arquitetural maior que não pertence ao cutover.

Recomendação operacional: aplicar as migrations esperadas pelo código implantado,
sem habilitar Telegram, e obter `npm run db:schema-check` limpo. Isso exige aprovação
explícita de schema e validação própria.

### 12.2 Dependência histórica residual do LIVE principal

O enrichment normal de swaps ficou pruned-safe, mas a validação NOXA ainda usa
`eth_call`/`eth_getCode` no bloco do lançamento. Em steady state próximo do head isso
cabe na janela recente; depois de uma parada longa, um lançamento NOXA no gap pode
bloquear o catch-up.

Antes de declarar a topologia resiliente sem archive, escolher uma política:

- adaptar a validação NOXA LIVE para `latest` com contrato próprio; ou
- manter um fallback realmente archive para essas chamadas; ou
- aceitar halt operacional e recuperação manual quando o gap ultrapassar a janela.

Para o primeiro cutover com overlap, o risco é reduzido iniciando no frontier fresco e
confirmando lag zero antes de desligar o backfill. Ele continua sendo dívida de
resiliência pós-cutover.

## 13. Aceite do cutover

O backfill/node do PC só pode ser desligado quando todos forem verdadeiros:

- [ ] commit desejado implantado na VPS2;
- [ ] runtime schema check passa;
- [ ] stage 96 aplicada;
- [ ] node local responde chain ID 4663, não está sincronizando e acompanha o head;
- [ ] LIVE principal possui lease ativa única;
- [ ] cursores LIVE discovery/market avançam e ficam próximos do safe head;
- [ ] novas observações usam `token_supply_status='latest_call'`;
- [ ] buckets recentes continuam sendo produzidos;
- [ ] backfill final está drenado, sem staging/outbox pendente ou blocked;
- [ ] flags e units de backfill estão desabilitadas na VPS2 e no PC;
- [ ] seed wallet foi auditado sem observações aceitas faltantes em seu limite;
- [ ] worker LIVE de wallet-swaps possui lease única e cursor avançando;
- [ ] `missing=0`, `unresolved=0`, sem `persistent_reorg`;
- [ ] rollback operacional foi registrado antes de desligar o archive.

## 14. Rollback

Se o canary LIVE falhar antes de desligar o backfill:

- parar somente a unit LIVE;
- preservar cursores e logs para diagnóstico;
- manter backfill e node do PC inalterados.

Se falhar depois de parar scanners, mas antes de desligar o archive:

- parar LIVE;
- reabilitar scanners a partir dos watermarks persistidos;
- drenar novamente enrichment/finalizer/aggregation;
- não resetar cursores nem ranges.

Depois de desligar o archive, rollback histórico deixa de ser imediato. Por isso o
archive é o último componente removido e só depois do aceite completo.

## 15. Fora de escopo

- read model/rota/UI de wallet tracking;
- matcher de alertas por wallet acompanhada;
- retenção multichain de 30 dias;
- rewind automático com deleção/reconciliação de dados órfãos;
- outras chains EVM ou Solana;
- publicação de alertas Robinhood durante o canary.

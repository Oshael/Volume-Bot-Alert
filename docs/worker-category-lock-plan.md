# Worker Category And Lock Plan

Plano para separar os background workers por categoria e adicionar protecao contra duplicacao de jobs sem mudar a logica de negocio dos workers de uma vez.

## Objetivo

Permitir operacao mais segura do bot em producao:
- reiniciar/pausar grupos de workers sem derrubar todos os jobs;
- reduzir blast radius de GMGN, Meteora, cleanup ou catalog;
- impedir duas instancias do mesmo worker de executarem contra o mesmo Postgres/upstream;
- preparar escala futura sem criar alertas duplicados, writes duplicados ou overload acidental.

## Estado Atual

Hoje `src/server.js` inicia todos os workers de background dentro de um unico processo quando `RUN_BACKGROUND_JOBS=true`:

- `userConfigSync`
- `catalogWorker`
- `catalogCleanupWorker`
- `meteoraSnapshotWorker`
- `dexDiscoveryWorker`
- `bidZoneWorker`
- `tokenRiskEnrichmentWorker`
- `tokenRiskReviewSyncWorker`
- `mockTradingTakeProfitWorker`
- `gmgnDiscoveryWorker`
- `gmgnClaimSignalWorker`

Isso e aceitavel para launch simples com exatamente um processo background ativo, mas nao e ideal para operacao de longo prazo.

## Premissas Criticas

- Separar workers por categoria nao deve mudar regras de alerta, catalogo, billing, auth ou frontend.
- A primeira versao deve continuar suportando o modelo atual `start:worker`, iniciando todos os grupos por default.
- A separacao por grupo nao resolve escala por si so; ela melhora controle operacional.
- Multi-processo so e seguro se cada processo iniciar grupos bem definidos ou se houver lock distribuido impedindo duplicacao.
- Paralelizar o mesmo worker, por exemplo dois `catalogWorker`, exige desenho separado com ownership por lote/token/fila.

## Categorias Propostas

### `core`

Responsabilidade:
- catalogo principal;
- descoberta Dex;
- enriquecimento/revisao de risco ligada ao catalogo.

Workers:
- `catalogWorker`
- `dexDiscoveryWorker`
- `tokenRiskEnrichmentWorker`
- `tokenRiskReviewSyncWorker`
- `userConfigSync`

Observacao:
- `userConfigSync` acompanha config de usuario e hoje e iniciado junto do worker set. Na primeira versao, manter em `core` evita criar categoria especial.

### `market`

Responsabilidade:
- fontes de mercado auxiliares e sinais de mercado.

Workers:
- `meteoraSnapshotWorker`
- `gmgnDiscoveryWorker`
- `gmgnClaimSignalWorker`
- `bidZoneWorker`

Observacao:
- `bidZoneWorker` continua respeitando `config.bidZoneWorker.enabled`.
- `gmgnDiscoveryWorker` tambem inicia a fila `gmgnRiskReviewQueue`; na primeira versao, essa fila fica acoplada ao grupo `market`.

### `maintenance`

Responsabilidade:
- limpeza, manutencao e automacoes que nao precisam estar no mesmo ciclo dos workers de mercado.

Workers:
- `catalogCleanupWorker`
- `mockTradingTakeProfitWorker`

Observacao:
- `catalogCleanupWorker` tem subrotinas internas diferentes:
  - quarantine cleanup;
  - soft archive cleanup;
  - blocked artifact cleanup.
- Na primeira versao, manter lock por worker inteiro. Se a manutencao virar gargalo, evoluir para locks por subrotina.

## Configuracao Proposta

Adicionar uma env:

```text
BACKGROUND_WORKER_GROUPS=all
```

Valores aceitos:
- `all`: inicia todos os grupos, mantendo comportamento atual do `start:worker`;
- `core`: inicia apenas grupo core;
- `market`: inicia apenas grupo market;
- `maintenance`: inicia apenas grupo maintenance;
- lista separada por virgula, por exemplo `core,market`.

Scripts sugeridos:

```bash
npm run start:worker
npm run start:worker:core
npm run start:worker:market
npm run start:worker:maintenance
```

Contrato esperado:
- `start:worker` continua equivalente a `RUN_SOCKET_HUB=false RUN_BACKGROUND_JOBS=true BACKGROUND_WORKER_GROUPS=all`;
- scripts por categoria continuam com `RUN_SOCKET_HUB=false`;
- web continua com `RUN_BACKGROUND_JOBS=false`.

## Status Admin

`GET /api/admin/ws-status` deve expor:
- `runtime.workerGroupsRequested`;
- `runtime.workerGroupsActive`;
- status individual dos workers como ja acontece hoje.

Opcional na primeira versao:
- `runtime.workerGroupsSkipped`, indicando grupos nao iniciados no processo atual.

## Lock Distribuido

### Objetivo Do Lock

O lock evita que duas instancias executem o mesmo job ao mesmo tempo.

Exemplo:
- se dois processos tentarem iniciar `catalogWorker`, so um deve adquirir o lock `catalog-worker`;
- o outro processo deve ficar em standby para esse worker ou simplesmente nao executar o ciclo.

### O Que O Lock Nao Faz

- Nao aumenta throughput automaticamente.
- Nao divide tokens entre workers.
- Nao torna seguro rodar dois `catalogWorker` processando o mesmo backlog.
- Nao substitui fila com ownership quando quisermos escala horizontal real.

### Modelo Inicial Recomendado

Usar lock distribuido por worker com Postgres.

Opcoes:
- Postgres advisory lock:
  - simples;
  - ligado a conexao;
  - bom para singleton por processo;
  - precisa cuidado para manter conexao viva enquanto o worker roda.
- Tabela de lease:
  - mais visivel no admin/status;
  - permite `owner`, `acquiredAt`, `heartbeatAt`, `leaseUntil`;
  - melhor para operacao e debugging;
  - exige schema/init e schema check.

Recomendacao:
- para launch controlado, usar tabela de lease se quisermos visibilidade operacional forte;
- advisory lock e menor, mas menos explicito para status/admin.

### Locks Minimos

Locks por worker:
- `catalog-worker`
- `catalog-cleanup-worker`
- `meteora-snapshot-worker`
- `dex-discovery-worker`
- `token-risk-enrichment-worker`
- `token-risk-review-sync-worker`
- `mock-trading-take-profit-worker`
- `gmgn-discovery-worker`
- `gmgn-claim-signal-worker`
- `bid-zone-worker`
- `user-config-sync`

Possivel evolucao granular:
- `catalog-cleanup:quarantine`
- `catalog-cleanup:archive`
- `catalog-cleanup:blocked-artifacts`
- `gmgn-discovery:trending`
- `gmgn-discovery:risk-review-queue`

## Ordem De Implementacao

### Bloco A - Selecao Por Categoria

Status local em `2026-07-09`:
- implementado;
- `BACKGROUND_WORKER_GROUPS` e normalizado em `config/index.js`;
- `src/server.js` inicia workers conforme `core`, `market`, `maintenance` ou `all`;
- `GET /api/health` e `GET /api/admin/ws-status` expoem grupos requisitados, ativos e pulados;
- `.env.example` documenta a env.

Escopo:
- criar parser de `BACKGROUND_WORKER_GROUPS`;
- extrair o start dos workers para uma estrutura declarativa;
- iniciar apenas grupos selecionados;
- manter `all` como default;
- expor grupos no status admin.

Estimativa:
- 120 a 220 linhas de codigo;
- 40 a 80 linhas de testes;
- 30 a 80 linhas de docs.

Risco:
- baixo/medio;
- risco principal e deixar algum worker essencial fora de `all` ou de uma categoria esperada.

Validacao:

```bash
npm run lint
node --test tests/config.test.js
```

Se testes especificos de runtime forem adicionados, rodar tambem:

```bash
node --test tests/runtime-worker-groups.test.js
```

### Bloco B - Scripts E Operacao

Status local em `2026-07-09`:
- implementado;
- `package.json` tem scripts `start:worker:core`, `start:worker:market` e `start:worker:maintenance`;
- `package.json` tambem tem variantes `dev:worker:core`, `dev:worker:market` e `dev:worker:maintenance` para validacao local;
- `start:worker` continua sendo o rollback para iniciar todos os grupos no mesmo processo.

Escopo:
- adicionar scripts npm por grupo;
- documentar unidades systemd sugeridas;
- documentar rollback para `start:worker` unico.

Estimativa:
- 20 a 60 linhas de codigo/config;
- 40 a 100 linhas de docs.

Risco:
- baixo;
- risco principal e divergencia entre scripts locais e systemd real.

Validacao:

```bash
npm run lint
```

### Bloco C - Lock Distribuido Singleton

Status local em `2026-07-09`:
- parcialmente implementado;
- tabela `worker_leases` criada no Stage 50;
- `src/models/worker-lease.js` faz acquire, heartbeat, release e listagem;
- `src/services/worker-lease-manager.js` aplica retry/heartbeat e impede start quando outro owner segura o lease;
- `src/server.js` envolve os workers do worker set com lease por worker;
- `GET /api/admin/ws-status` expoe `workerLeases` vindos do banco e `workerLeaseProcess` do processo consultado;
- se um processo perder heartbeat de um worker ja iniciado, ele encerra para o supervisor reiniciar limpo.
- shutdown limpo via `SIGINT`/`SIGTERM` libera os leases do processo antes de sair;
- processos em standby tentam adquirir leases novamente a cada 5s;
- crash real, `kill -9` ou queda da maquina ainda dependem da expiracao do TTL do lease.

Escopo:
- criar helper de lock;
- envolver start/ciclo dos workers criticos;
- expor status de lock por worker no admin;
- garantir que worker sem lock fica idle/standby.

Estimativa:
- 250 a 450 linhas de codigo se usar tabela de lease;
- 120 a 250 linhas de testes;
- possivel schema/init se houver tabela nova.

Risco:
- medio/alto;
- risco principal e falso negativo segurando worker parado ou falso positivo permitindo duplicacao.

Validacao:

```bash
npm run lint
node --test tests/worker-lock.test.js
npm run db:schema-check
```

Validacao local atual:

```bash
node --test tests/worker-lease.test.js
npm run db:schema-check
```

### Bloco D - Granularidade E Escala Real

Status local em `2026-07-09`:
- iniciado como Bloco D0/D1;
- `tokenCatalog.claimDueForEvaluation()` cria uma primitiva atomica para claim de lote do `catalog-worker`;
- a primitiva usa `FOR UPDATE SKIP LOCKED` e empurra `next_evaluation_at` para frente por um TTL de claim;
- `CATALOG_WORKER_DISTRIBUTED_CLAIM_ENABLED=false` mantem o comportamento antigo por default;
- quando a flag estiver ligada e o Dex estiver em modo normal, o `catalog-worker` usa claim distribuido para selecionar o lote;
- quando o Dex estiver em cooldown/recovery, o worker volta para a selecao antiga para nao claimar tokens que seriam filtrados por throttle;
- ainda nao libera multiplas instancias de `catalog-worker` em producao, porque o lock singleton continua protegendo o worker inteiro;
- proximo passo e validar a flag em um processo unico e depois desenhar a liberacao multi-instancia com budget/rate-limit compartilhado.

Escopo futuro:
- dividir trabalho do mesmo worker por lote/token;
- usar `FOR UPDATE SKIP LOCKED` ou tabela/fila de jobs;
- permitir multiplos processos trabalhando em itens diferentes.

Estimativa:
- acima de 450 linhas e deve ser planejado por worker, nao como mudanca unica.

Risco:
- alto;
- mexe em contratos de idempotencia, dedupe, alertas e persistencia.

## Systemd Sugerido

Modelo inicial depois do Bloco A/B:

Comandos npm:

```bash
npm run start:web
npm run start:worker:core
npm run start:worker:market
npm run start:worker:maintenance
```

Exemplo de env por unidade:

```text
volume-bot-alert-web.service
PORT=3000
RUN_SOCKET_HUB=true
RUN_BACKGROUND_JOBS=false

volume-bot-alert-worker-core.service
PORT=3001
RUN_SOCKET_HUB=false
RUN_BACKGROUND_JOBS=true
BACKGROUND_WORKER_GROUPS=core

volume-bot-alert-worker-market.service
PORT=3002
RUN_SOCKET_HUB=false
RUN_BACKGROUND_JOBS=true
BACKGROUND_WORKER_GROUPS=market

volume-bot-alert-worker-maintenance.service
PORT=3003
RUN_SOCKET_HUB=false
RUN_BACKGROUND_JOBS=true
BACKGROUND_WORKER_GROUPS=maintenance
```

Exemplo de `ExecStart`:

```text
ExecStart=/usr/bin/npm run start:web
ExecStart=/usr/bin/npm run start:worker:core
ExecStart=/usr/bin/npm run start:worker:market
ExecStart=/usr/bin/npm run start:worker:maintenance
```

Cada linha acima representa uma unidade separada, nao varias linhas dentro da mesma unidade.
Os workers nao recebem trafego do nginx, mas o processo atual ainda abre HTTP para boot/health; por isso cada unidade precisa de uma porta diferente.

Fallback operacional:

```text
volume-bot-alert-worker.service
PORT=3001
RUN_SOCKET_HUB=false
RUN_BACKGROUND_JOBS=true
BACKGROUND_WORKER_GROUPS=all
```

Rollback:
- parar as unidades `volume-bot-alert-worker-core`, `volume-bot-alert-worker-market` e `volume-bot-alert-worker-maintenance`;
- iniciar apenas `volume-bot-alert-worker` com `npm run start:worker`;
- confirmar em `/api/admin/ws-status` que `runtime.workerGroupsActive` voltou para `core`, `market`, `maintenance` no mesmo processo;
- manter somente uma unidade com `RUN_BACKGROUND_JOBS=true` para cada grupo enquanto o lock distribuido nao existir.

## Pontos importantes

- Separar por categoria e diferente de escalar o mesmo worker horizontalmente.
- A primeira separacao deve preservar comportamento atual com `BACKGROUND_WORKER_GROUPS=all`.
- Nao subir duas unidades com o mesmo grupo ativo em producao antes do lock.
- O lock singleton protege contra duplicacao, mas nao alivia backlog sozinho.
- Para aliviar backlog de um worker especifico, precisamos particionar o trabalho daquele worker.
- `catalogCleanupWorker` e `gmgnDiscoveryWorker` merecem cuidado especial porque contem subrotinas internas.
- Mudancas com schema/lock devem ser feitas separadas da selecao por categoria.

## Go/No-Go Para Aplicar Em Producao

Go para selecao por categoria quando:
- `start:worker` com `all` preserva o comportamento atual;
- scripts por categoria iniciam somente os workers esperados;
- admin status mostra grupos ativos;
- systemd real nao deixa dois processos com o mesmo grupo antes do lock.

No-go se:
- algum worker essencial nao iniciar em `all`;
- grupo `market` ou `maintenance` iniciar worker de outro grupo sem intencao;
- status admin nao deixar claro qual grupo esta ativo;
- houver duvida sobre qual unidade systemd deve rodar em producao.

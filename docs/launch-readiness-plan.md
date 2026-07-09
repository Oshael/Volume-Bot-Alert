# Launch Readiness Plan

Documento operacional para deixar o bot pronto para lancamento sem depender do contexto da conversa.

## Objetivo

Preparar o TrendScope / Volume Bot Alert para um lancamento controlado com varios usuarios, reduzindo risco de:

- duplicacao de workers;
- overload de Postgres/upstreams;
- alertas duplicados ou atrasados;
- regressao em auth, billing, acesso, mock trading e dashboards;
- documentacao desatualizada durante operacao.

## Estado Atual Resumido

- O backend suporta papeis explicitos:
  - `RUN_SOCKET_HUB`
  - `RUN_BACKGROUND_JOBS`
  - scripts `start:web` e `start:worker`.
- O default do codigo ainda e `combined`, ou seja, web/socket/background no mesmo processo.
- Em producao no VPS, o runtime ja foi separado em:
  - `volume-bot-alert-web.service`
    - `NODE_ENV=production`
    - `PORT=3000`
    - `RUN_SOCKET_HUB=true`
    - `RUN_BACKGROUND_JOBS=false`
  - `volume-bot-alert-worker.service`
    - `NODE_ENV=production`
    - `PORT=3001`
    - `RUN_SOCKET_HUB=false`
    - `RUN_BACKGROUND_JOBS=true`
- A separacao web/worker evita misturar trafego de usuario com jobs pesados, mas ainda nao cria lock distribuido.
- O bot ainda deve ser tratado como:
  - multiplas instancias web somente com cuidado;
  - exatamente uma instancia background ativa;
  - nenhum backend completo duplicado contra o mesmo banco de producao.
- O antigo `volume-bot-alert.service` deve permanecer desabilitado/parado depois da troca para web/worker.

## Progresso Operacional

Atualizado em `2026-07-09`.

Concluido:
- confirmado que antes havia apenas um processo `node src/server.js`;
- `NODE_ENV=production` foi tornado explicito no systemd;
- `volume-bot-alert-web.service` foi criado e validado com runtime:
  - `role = web`
  - `socketEnabled = true`
  - `backgroundJobsEnabled = false`
- `volume-bot-alert-worker.service` foi criado e validado com logs:
  - `Runtime: socket=off background=on`
  - `CatalogWorker Started`
  - `CatalogCleanupWorker Started`
  - `MeteoraSnapshotWorker Started`
  - `DexDiscoveryWorker Started`
  - `TokenRiskEnrichmentWorker Started`
  - `GmgnDiscoveryWorker Started`
  - `GmgnClaimSignalWorker Started`
- o risco imediato de duplicacao de workers foi reduzido, desde que somente o worker novo rode background jobs.

Em andamento:
- calibragem de rate limits de producao;
- investigacao de excesso de chamadas frontend para:
  - `POST /api/catalog/monitored-metadata-batch`
  - `POST /api/catalog/sparklines`

Incidente observado:
- um unico usuario ativo atingiu `catalog-read` mesmo apos subir `CATALOG_READ_RATE_LIMIT_MAX_REQUESTS` para `600` por `15m`;
- isso indica que o frontend pode estar multiplicando chamadas de metadados/sparklines alem do esperado para uso normal;
- aumentar rate limit destrava temporariamente, mas a correcao correta e identificar e reduzir chamadas redundantes.

Diagnostico inicial:
- `MONITORED_REFRESH_INTERVAL_MS` roda a cada `3s`;
- `/api/catalog/monitored-metadata-batch` e `/api/catalog/sparklines` compartilham o mesmo limiter `catalog-read`;
- `hydrateManualTokensMetadataBatch()` podia ser chamada mais de uma vez no mesmo refresh de dashboard antes de gravar cache;
- `refreshDashboardTopPerformers()` disparava `refreshHistoryWorkspaceSparklines()` mesmo quando o ciclo principal ja tinha disparado o refresh de sparklines;
- chamadas de sparklines que chegavam enquanto outra estava em voo eram sempre reexecutadas como `force=true`, podendo ignorar a janela de cache se a query demorasse mais que o ciclo de polling;
- o `BroadcastChannel` reduz polling somente no workspace `history`; varias abas no workspace `live` ainda multiplicam o ciclo de `3s`.

Correcao aplicada localmente:
- dedupe/in-flight para `hydrateManualTokensMetadataBatch()` por chave de enderecos + modo Meteora;
- preservacao do `force` original quando um refresh de sparkline e enfileirado durante outro em voo;
- remocao do refresh extra de sparklines disparado por `refreshDashboardTopPerformers()`.

Validacao local:
- `npm run lint` passou sem erros, mantendo warnings antigos de complexidade;
- `npm --prefix frontend run build` passou, mantendo aviso antigo de chunk grande.

Leitura atual por bloco, confrontada com o codigo local:
- Bloco 1 esta tratado como concluido com ressalva operacional:
  - o frontend de producao tem fallback para `https://api.trendscope.pro`;
  - `.env.test` existe e `config/index.js` tem guardrails para DB de teste;
  - ainda depende de conferencia no VPS para garantir que nao ha processo `combined`, env de teste em producao ou background duplicado.
- Bloco 2 esta tratado como concluido no codigo e no relato operacional:
  - scripts `start:web` e `start:worker` existem;
  - `GET /api/health` e `GET /api/admin/ws-status` expoem `runtime.role`, `socketEnabled` e `backgroundJobsEnabled`;
  - a prova final continua sendo a configuracao real do systemd/nginx no VPS.
- Bloco 3 esta parcialmente implementado:
  - existe lease distribuido por worker via tabela `worker_leases`;
  - workers do worker set so iniciam depois de adquirir lease;
  - `/api/admin/ws-status` expoe leases do banco e estado local do processo;
  - `worker_runtime_state` continua guardando apenas cadencia/ultima execucao e nao e usado como leader election.
  - plano de separacao por categoria + lock: `docs/worker-category-lock-plan.md`.
- Bloco 4 esta parcialmente feito:
  - schema guard, metricas de worker, cleanup de artifacts bloqueados e slow-query config existem;
  - falta medir backlog, overrun, degradacao Meteora, crescimento de buckets e slow queries recorrentes no banco real.
- Bloco 5 esta parcialmente feito:
  - rotas e testes de auth, billing e token gate existem;
  - falta validar em producao email real, Google/Discord, MoonPay/Helio, webhooks, token gate e envs finais.
- Bloco 6 esta tratado como concluido:
  - status admin expoe workers criticos;
  - testes cobrem matcher/feed/GMGN claim signal;
  - GMGN `1m` continua desabilitado por default quando ruidoso.
- Bloco 7 esta parcialmente feito:
  - a correcao local de dedupe/in-flight de metadata batch e sparkline foi aplicada;
  - falta deployar/monitorar no VPS, medir hit rate/cache e decidir se o workspace `live` tambem precisa de leader-tab.
- Bloco 8 esta parcialmente feito:
  - existem health/admin status, slow-query config e script de coleta VPS;
  - falta checklist operacional explicito de rollback e switches de emergencia.
- Bloco 9 ainda esta parcial/faltando:
  - `README.md` e `docs/bot-reference.md` ainda misturam a topologia antiga de processo unico com o runtime split atual;
  - falta atualizar data de revisao, runtime split, regra de unico background worker, status QuickNode/Jupiter e scripts de probe.
- Bloco 10 ainda nao esta pronto para Go:
  - depende principalmente dos blocos 3, 4, 5, 7, 8 e 9.

## Pontos importantes

- Nao subir dois processos com `RUN_BACKGROUND_JOBS=true` em producao antes de implementar trava distribuida.
- `worker_runtime_state` guarda cadencia/ultima execucao, mas nao e leader election.
- `catalog-worker`, `meteora-snapshot-worker`, discovery, GMGN, Helius, mock take-profit e cleanup podem duplicar trabalho se dois workers rodarem.
- Trava distribuida por worker nao e o mesmo que escalar processamento automaticamente; ela evita duplicacao do mesmo job. Para aliviar pressao com multi-worker, cada worker precisa ter ownership/particionamento claro do trabalho ou uma fila que distribua tarefas.
- Rate limit atual usa memoria do processo; se houver mais de uma instancia web, cada uma tera contadores proprios.
- Integracao de testes e destrutiva contra o banco selecionado; so rodar com `.env.test` e DB claramente isolado.
- QuickNode/Jupiter/onchain estao em modo laboratorio/probe e nao devem virar caminho de producao sem decisao explicita.

## Ordem Sugerida

1. Bloqueios de lancamento.
2. Deploy e runtime split.
3. Validacao de banco e schema.
4. Validacao de auth, billing e acesso.
5. Validacao de workers e alertas.
6. Performance multiusuario.
7. Observabilidade e rollback.
8. Atualizacao de documentacao.
9. Go/no-go final.

## Bloco 1 - Bloqueios De Lancamento

Objetivo:
- eliminar riscos que podem quebrar o lancamento mesmo com poucos usuarios.

Tarefas:
- confirmar que so existe um processo background ativo no VPS;
- confirmar que nenhum processo `combined` extra esta rodando junto com `start:worker`;
- confirmar que o frontend aponta para `https://api.trendscope.pro`;
- confirmar que `CORS_ORIGINS`, cookies e dominio publico estao coerentes;
- confirmar que `.env` de producao nao contem valores de teste;
- confirmar que `.env.test` existe e usa DB isolado.

Validacao:

```bash
npm run db:schema-check
npm run lint
npm test
npm --prefix frontend run build
```

Pronto quando:
- todos os comandos acima passam;
- warnings novos foram explicados ou corrigidos;
- nao ha processo background duplicado.

## Bloco 2 - Runtime Split No VPS

Objetivo:
- separar trafego de usuario dos workers sem duplicar jobs.

Modelo recomendado para lancamento:

```bash
npm run start:web
npm run start:worker
```

Config esperada:

```text
web:
RUN_SOCKET_HUB=true
RUN_BACKGROUND_JOBS=false

worker:
RUN_SOCKET_HUB=false
RUN_BACKGROUND_JOBS=true
```

Tarefas:
- criar/ajustar duas unidades `systemd`, uma para web e uma para worker;
- garantir que so a unidade web recebe trafego do nginx;
- garantir restart separado para web e worker;
- configurar logs separados por unidade;
- adicionar procedimento de emergencia para parar somente worker sem derrubar login/UI.

Pronto quando:
- `GET /api/health` mostra runtime `web` no processo publico;
- `GET /api/admin/ws-status` mostra runtime correto no processo consultado;
- logs mostram somente um worker set iniciado;
- reiniciar web nao reinicia workers;
- reiniciar worker nao derruba socket/web.

## Bloco 3 - Trava Anti-Duplicacao De Workers

Objetivo:
- preparar o bot para falhas operacionais e futura escala sem duplicar jobs.

Primeira versao recomendada:
- lock distribuido por worker usando tabela de lease Postgres;
- cada worker tenta adquirir lock antes de rodar;
- lock com identificador estavel por worker:
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
- status admin deve expor:
  - lock adquirido;
  - owner;
  - acquiredAt;
  - heartbeat/leaseUntil quando aplicavel.

Escopo sugerido de implementacao:
- Bloco 3A: helper de lock + testes unitarios.
- Bloco 3B: aplicar no worker set mais critico: catalog, Meteora, GMGN, mock take-profit.
- Bloco 3C: aplicar nos demais workers e expor status admin.

Pronto quando:
- iniciar dois workers em ambiente de teste nao duplica ciclos;
- processo sem lock fica idle/standby;
- queda do worker libera ou expira o lock;
- admin consegue enxergar quem e o dono.

Status local em `2026-07-09`:
- tabela `worker_leases` e Stage 50 criados;
- `catalog-worker`, `catalog-cleanup-worker`, `meteora-snapshot-worker`, `dex-discovery-worker`, `token-risk-enrichment-worker`, `token-risk-review-sync-worker`, `mock-trading-take-profit-worker`, `gmgn-discovery-worker`, `gmgn-claim-signal-worker`, `bid-zone-worker` e `user-config-sync` passam pelo lease antes de iniciar;
- heartbeat renova o lease enquanto o worker esta ativo;
- se o processo perder ownership de um lease ja iniciado, ele encerra para evitar duplicacao;
- shutdown limpo via `SIGINT`/`SIGTERM` libera leases imediatamente;
- standby tenta assumir leases livres a cada 5s;
- crash real, `kill -9` ou queda da maquina ainda dependem da expiracao do TTL do lease;
- ainda falta validar em producao com duas unidades tentando o mesmo grupo e observar expiracao real de lease.

## Bloco 4 - Banco, Indices E Backlog

Objetivo:
- garantir que o Postgres aguenta o catalogo atual e crescimento inicial.

Tarefas:
- rodar `npm run db:schema-check`;
- revisar slow queries nos logs;
- medir:
  - backlog de `token_catalog.next_evaluation_at`;
  - tempo dos ciclos de `catalogWorker`;
  - `lastLoopOverrunMs`;
  - `lastBacklogCount`;
  - universo Meteora e `lastBudgetDegraded`;
- confirmar que tabelas de buckets nao estao crescendo sem manutencao;
- confirmar cleanup de tokens bloqueados/arquivados.

Pronto quando:
- schema check passa;
- catalog worker nao fica permanentemente atrasado;
- Meteora nao fica sempre degradado nos tiers importantes;
- queries lentas recorrentes tem indice/plano revisado.

## Bloco 5 - Auth, Billing E Acesso

Objetivo:
- evitar lancar com falhas em login, pagamento, token gate ou acesso.

Tarefas:
- validar registro por invite;
- validar verificacao de email;
- validar login local com OTP;
- validar Google login;
- validar Discord somente para conta vinculada;
- validar `inactive`, expirado, pago, token access e `revoked`;
- validar retorno do fluxo `/access`;
- validar webhook/token gate se estiver habilitado;
- revisar envs de email, billing, MoonPay/Helio e token gate.

Validacao recomendada:

```bash
npm run test:auth
npm run test:billing
node --test tests/token-gate-route.test.js
```

Pronto quando:
- usuario novo consegue chegar no estado esperado;
- usuario sem acesso nao entra no bot;
- usuario pago ou elegivel por token entra;
- usuario revogado continua bloqueado.

## Bloco 6 - Alertas E Workers Criticos

Objetivo:
- garantir que alertas reais chegam sem duplicacao e sem spam.

Tarefas:
- validar `catalogWorker` em `/api/admin/ws-status`;
- validar `userAlertMatcher` via testes unitarios;
- validar eventos backend:
  - monitored vol;
  - monitored mcap;
  - recent surge;
  - old-week surge;
  - meteora surge;
  - GMGN claim signal se habilitado;
- confirmar que GMGN 1m volume continua desabilitado se ainda for ruidoso;
- confirmar que tokens admin-blocked nao emitem alertas;
- confirmar que usuarios escondidos/background nao recebem replay sonoro indevido.

Validacao recomendada:

```bash
node --test tests/user-alert-matcher.test.js
node --test tests/backend-alert-feed.test.js
node --test tests/gmgn-claim-signal-worker.test.js
node --test tests/gmgn-claim-signal-alert.test.js
```

Pronto quando:
- eventos persistem uma vez por regra/dedupe esperada;
- socket entrega realtime para usuario ativo;
- feed de alertas recupera historico sem replay indevido;
- cooldown/rearm continuam protegidos por teste.

## Bloco 7 - Performance Multiusuario

Objetivo:
- reduzir custo por usuario conectado.

Tarefas:
- investigar com prioridade o excesso de chamadas de uma unica sessao para:
  - `POST /api/catalog/monitored-metadata-batch`
  - `POST /api/catalog/sparklines`
- apos deploy da correcao local, monitorar `journalctl -u volume-bot-alert-web -f` por pelo menos `15m`;
- se ainda houver excesso com uma unica aba, medir por endpoint no nginx ou adicionar log temporario com payload resumido para diferenciar:
  - sparklines de workspace;
  - sparklines de alertas;
  - metadata manual batch;
- confirmar paginacao nos dashboards;
- confirmar que `/monitor` usa leader tab via `BroadcastChannel`;
- decidir se o workspace `live` tambem deve ter leader tab para reduzir custo com multiplas abas;
- medir endpoints mais chamados:
  - `GET /api/dashboard/monitored`
  - `POST /api/dashboard/history-bootstrap`
  - `POST /api/catalog/sparklines`
  - `POST /api/catalog/sparklines/expanded`
  - `GET /api/dashboard/alert-feeds`
- revisar `DB_POOL_MAX`;
- revisar limites de socket:
  - por IP;
  - por sessao;
  - por socket subscription;
- considerar Redis/shared store antes de multiplas instancias web;
- considerar code-splitting do frontend se bundle principal continuar crescendo.

Pronto quando:
- varios usuarios/tabs nao multiplicam polling desnecessariamente;
- sparkline cache tem hit rate aceitavel;
- Postgres nao satura pool;
- endpoint de dashboard responde dentro de janela aceitavel em carga realista.

## Bloco 8 - Observabilidade E Operacao

Objetivo:
- conseguir diagnosticar problema em producao sem improvisar.

Tarefas:
- revisar logs de:
  - web;
  - worker;
  - nginx;
  - Postgres;
- garantir slow query log habilitado;
- acompanhar `/api/health`;
- acompanhar `/api/admin/ws-status`;
- criar checklist operacional:
  - como parar worker;
  - como religar worker;
  - como pausar bid-zone;
  - como desabilitar GMGN discovery;
  - como desabilitar aggregate-on-write;
  - como voltar para processo unico se necessario.

Pronto quando:
- existe procedimento claro de rollback;
- status admin mostra todos os workers importantes;
- incidentes comuns tem switch/env de emergencia documentado.

## Bloco 9 - Documentacao

Objetivo:
- deixar a documentacao alinhada ao codigo real.

Tarefas:
- atualizar `docs/bot-reference.md` com:
  - data de revisao atual;
  - runtime split;
  - regra de um unico background worker;
  - status QuickNode/Jupiter como laboratorio;
  - scripts novos de probe;
  - `gmgnClaimSignalWorker` no status admin;
  - `solUsdPrice` no status admin;
  - warnings conhecidos de escala;
- manter `README.md` como entrada operacional curta;
- manter planos experimentais separados:
  - QuickNode;
  - Jupiter;
  - backfills.

Pronto quando:
- uma pessoa consegue operar o bot lendo README + bot-reference + este plano;
- experimentos nao parecem features ativas de producao;
- riscos de worker duplicado estao documentados em todos os pontos de deploy.

## Bloco 10 - Go/No-Go Final

Go quando:
- runtime split validado;
- exatamente um background worker ativo;
- schema check passa;
- lint sem erros;
- unit tests passam;
- build frontend passa;
- auth/billing/acesso validados;
- admin status mostra workers saudaveis;
- rollback documentado.

No-go se:
- houver dois workers ativos;
- schema check falhar;
- auth/billing/access tiver falha nao explicada;
- catalog worker estiver com backlog crescente sem estabilizar;
- Postgres saturar pool em uso normal;
- docs ainda deixarem duvida sobre qual processo deve rodar em producao.

## Comandos De Referencia

Validacao geral:

```bash
npm run lint
npm test
npm --prefix frontend run build
npm run db:schema-check
```

Testes criticos por area:

```bash
npm run test:auth
npm run test:billing
npm run test:catalog
npm run test:dashboard
npm run test:mock-trading-routes
node --test tests/user-alert-matcher.test.js
node --test tests/backend-alert-feed.test.js
node --test tests/token-gate-route.test.js
```

Runtime:

```bash
npm run start:web
npm run start:worker
```

Probes/laboratorio, nao producao por default:

```bash
npm run quicknode:smoke
npm run quicknode:probe
npm run quicknode:dry-run
npm run quicknode:continuous-dry-run
npm run quicknode:logs-dry-run
npm run jupiter:probe
```

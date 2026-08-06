# TrendScope — Referência Técnica Atual

> Estado revisado em `2026-08-01`.
>
> Esta referência descreve o que foi confirmado no código, no banco e na
> infraestrutura durante a migração para os servidores Netcup. Planos futuros
> aparecem separados do que já está em produção.

## 1. Objetivo e regra de confiança

Este documento é o mapa técnico do TrendScope. Ele deve responder:

- onde cada parte do produto roda;
- qual processo é responsável por cada trabalho;
- quais dados são persistidos;
- como Solana e Robinhood entram no sistema;
- quais integrações externas estão envolvidas;
- o que já existe e o que ainda é roadmap;
- como validar, implantar e recuperar o serviço.

Quando houver conflito, use esta ordem de confiança:

1. código e schema da branch implantada;
2. configuração efetiva dos serviços e do `.env` do host;
3. estado observado no PostgreSQL e nos endpoints de health;
4. este documento;
5. planos históricos.

Nunca coloque neste arquivo:

- senhas;
- chaves privadas;
- API keys;
- bearer tokens;
- JWT secrets;
- conteúdo de arquivos WireGuard privados.

## 2. Estado resumido

O TrendScope é uma aplicação web multichain em evolução, com:

- frontend Vite + TypeScript;
- API Express;
- Socket.io para atualizações em tempo real;
- PostgreSQL como armazenamento central;
- workers separados por responsabilidade;
- Solana como chain original;
- Robinhood Chain em rollout/backfill;
- autenticação local, social e por carteira;
- acesso token-gated;
- billing implementado no código, mas não necessário para o lançamento
  token-gated atual;
- integração Telegram registrada em checkpoints locais, ainda não tratada como produção;
- wallet tracking multichain planejado, ainda não implementado como produto.

Baseline observado na migração:

- branch implantada nas duas VPS: `Robinhood-Implementation`;
- commit implantado: `350c45d`;
- a base local auditada antes das fatias wallet LIVE era `954ae548`, com o
  enrichment preparado para leituras de supply/quote no head, mas esse commit
  não deve ser
  presumido nas VPS sem conferir `git rev-parse --short HEAD`;
- o histórico local possui checkpoints posteriores, além de mudanças ainda não commitadas;
- os checkpoints locais, incluindo Telegram, não devem ser presumidos nas VPS até
  push, deploy e schema check correspondentes.

## 3. Topologia de produção atual

```mermaid
flowchart LR
    U["Usuário"] --> W["www.trendscope.pro"]
    U --> A["api.trendscope.pro"]
    W --> N1["VPS1 — TrendScopeBot-01"]
    A --> N1
    N1 -->|"WireGuard / PostgreSQL"| N2["VPS2 — TrendScopeWorkers-01"]
    N2 --> DB[("PostgreSQL 16")]
    N2 --> WK["Workers de rede e manutenção"]
    PC["PC / WSL rh-node\nbackfill temporário"] -->|"túneis SSH"| N2
    PC --> RH["Nitro Robinhood local"]
```

### 3.1 VPS1 — produto público

Hostname operacional:

```text
TrendScopeBot-01
```

Responsabilidades:

- servir o frontend estático;
- expor a API pública;
- manter o Socket.io;
- terminar TLS no Nginx;
- consumir o PostgreSQL pela rede privada WireGuard;
- não executar background workers.

Caminhos atuais:

```text
/opt/trendscope/app                 repositório
/var/www/trendscope                 build estático do frontend
/etc/nginx/sites-available/trendscope
/etc/nginx/sites-available/api.trendscope.pro
/etc/systemd/system/trendscope-web.service
```

Serviço web:

```text
trendscope-web.service
```

Contrato do runtime:

```env
NODE_ENV=production
PORT=3000
RUN_SOCKET_HUB=true
RUN_BACKGROUND_JOBS=false
DB_HOST=10.77.0.2
DB_PORT=5432
DB_NAME=volume_alert
```

`BACKGROUND_WORKER_GROUPS` não deve existir no `.env` da VPS1.

### 3.2 VPS2 — dados e processamento

Hostname operacional:

```text
TrendScopeWorkers-01
```

Responsabilidades:

- hospedar PostgreSQL 16;
- executar workers permanentes;
- executar partes pesadas do backfill Robinhood;
- receber conexões da VPS1 apenas pela rede privada;
- concentrar armazenamento de buckets, catálogos e dados de wallet tracking
  quando essa feature for implantada.

Características confirmadas:

- disco de aproximadamente 2 TB;
- PostgreSQL local na própria VPS2;
- database principal `volume_alert`;
- aplicação conectando com o usuário PostgreSQL `volumebot`;
- acesso entre VPS1 e VPS2 via WireGuard;
- PostgreSQL não deve ser publicado diretamente na internet.

Contrato geral de processos worker:

```env
NODE_ENV=production
RUN_SOCKET_HUB=false
RUN_BACKGROUND_JOBS=true
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=volume_alert
```

Cada unidade deve escolher apenas o grupo que realmente executa.

### 3.3 PC/WSL — papel temporário no backfill Robinhood

O ambiente `rh-node` no WSL mantém o Nitro Robinhood e foi usado para acelerar o
backfill.

Estado observado durante a migração:

- Nitro exposto localmente na porta `8547`;
- chain id retornado: `0x1237`;
- RPC reverso entregue à VPS2 em `127.0.0.1:18545`;
- acesso ao PostgreSQL da VPS2 feito por túnel;
- dois processos/shards de enrichment foram usados no WSL;
- discovery/shadow e enrichment foram distribuídos no PC;
- finalização/agregação pesada foi executada na VPS2.

Essa divisão é temporária. Antes de reiniciar o backfill, sempre confira as
unidades efetivas; não presuma que o `.env` sozinho representa o processo:

```bash
systemctl show <unidade> -p Environment -p ExecStart -p ActiveState
```

## 4. DNS, HTTPS e tráfego público

Registros públicos atuais:

```text
trendscope.pro      A      VPS1
www.trendscope.pro  A      VPS1
api.trendscope.pro  A      VPS1
```

A Vercel não está mais no caminho do frontend.

Nginx possui dois papéis:

- `trendscope.pro` e `www.trendscope.pro` servem `/var/www/trendscope`;
- `api.trendscope.pro` faz proxy para `127.0.0.1:3000`;
- `/socket.io/` suporta upgrade WebSocket;
- o fallback do frontend usa `index.html`, necessário para rotas SPA.

TLS:

- certificados emitidos pelo Let's Encrypt;
- Certbot integrado ao Nginx;
- `certbot.timer` habilitado e ativo;
- HTTP redirecionado para HTTPS.

Checagens:

```bash
curl -I https://www.trendscope.pro
curl -i https://api.trendscope.pro/api/health
curl -s https://api.trendscope.pro/nginx-health
systemctl is-active certbot.timer
```

`/nginx-health` prova apenas que o Nginx está vivo. `/api/health` prova que o
Node também está respondendo.

## 5. Repositório e componentes

### 5.1 Frontend

Diretório:

```text
frontend/
```

Tecnologias:

- Vite;
- TypeScript;
- Lightweight Charts;
- Socket.io Client;
- Solana Wallet Standard.

Arquivos centrais:

- `frontend/src/main.ts`;
- `frontend/src/state/app-controller.ts`;
- `frontend/src/state/app-state.ts`;
- `frontend/src/ui/app-shell.ts`;
- `frontend/src/ui/sections/`;
- `frontend/src/services/api/`;
- `frontend/src/services/socket/`.

Em produção, `frontend/src/services/api/base.ts` usa:

```text
https://api.trendscope.pro
```

como API padrão, salvo override permitido pelo próprio código.

### 5.2 Backend

Diretório:

```text
src/
```

Responsabilidades:

- API HTTP;
- cookies e sessões;
- OAuth;
- token gate;
- billing;
- catálogo;
- dashboard;
- alertas;
- Socket.io;
- composição e inicialização dos workers.

`src/server.js` é um arquivo de composição. Lógica nova de domínio deve ser
extraída para `src/services/` ou `src/models/`, não acumulada no servidor.

### 5.3 Banco e schema

Principais áreas:

- `src/models/`: acesso e contratos de persistência;
- `src/utils/db-init*.js`: criação/migração incremental;
- `src/utils/runtime-schema.js`: contrato do schema esperado;
- `src/utils/check-runtime-schema.js`: verificação operacional.

Validação obrigatória:

```bash
npm run db:schema-check
```

## 6. Runtime roles e workers

Controles principais:

```env
RUN_SOCKET_HUB=
RUN_BACKGROUND_JOBS=
BACKGROUND_WORKER_GROUPS=
```

Papéis derivados:

| Papel | Socket/API | Background jobs |
|---|---:|---:|
| `web` | sim | não |
| `background` | não | sim |
| `combined` | sim | sim |
| `idle` | não | não |

Produção deve usar processos separados. `combined` é forma de desenvolvimento
ou rollback emergencial, não topologia normal.

Grupos existentes:

| Grupo | Responsabilidades principais |
|---|---|
| `core` | catálogo, descoberta DEX, risco/enrichment e review sync |
| `market` | Meteora, bid zone, GMGN discovery e claim signals |
| `maintenance` | limpeza, retenção Robinhood e mock-trading take-profit |
| `robinhood` | ingestão live monolítica: captura + valuation + projeção + staging + agregação + alertas |
| `robinhood-head` | captura isolada do head: só grava evidência durável na fila e avança o cursor de captura |
| `robinhood-processing` | consumidor isolado: reclama capturas por lease, decodifica a evidência congelada sem RPC, calcula preço/FDV/liquidez, persiste observações/buckets e poda a fila; no mesmo processo, um 2º runner drena `stream='discovery'` para o `robinhood_pool_registry` |
| `robinhood-derived` | consumidor isolado: drena a outbox de emit ao vivo e replica o fan-out `market:bucket` (socket/relay) sem o monólito |
| `robinhood-backfill` | discovery, scan, enrichment, finalizer e aggregation do replay |

`robinhood`, `robinhood-head`, `robinhood-processing`, `robinhood-derived` e
`robinhood-backfill` são grupos isolados. O config rejeita combinar um grupo isolado com
grupos compartilhados ou entre si.

O grupo `robinhood-head` roda um processo separado (systemd
`trendscope-worker@robinhood-head.service`) que instancia o runner de ingestão com o
adapter de captura (`robinhood_head_captures` + cursor próprio) e o pipeline em
`captureMode`. Ele **não** inicia catalog/alert/aggregate/staging: falha em qualquer
derivado não pode travar o cursor de captura — que é a fronteira que o incidente de
`2026-08-02` violou. É a implementação do isolamento descrito no plano urgente e no
contrato de evidência. Sobe apenas por deploy de uma unit própria com
`BACKGROUND_WORKER_GROUPS=robinhood-head`, `ROBINHOOD_INGESTION_ENABLED=true` e um
`ROBINHOOD_START_BLOCK` fresco; roda em shadow ao lado do `robinhood` com cursor
independente, sem substituir o monólito (a remoção do monólito é etapa posterior do
plano). A unit existe na VPS2 e, no diagnóstico de `2026-08-05`, mantinha discovery e
market no head com lag zero. Lease: `robinhood-head-capture-worker`.

O grupo `robinhood-processing` roda um processo separado (systemd
`trendscope-worker@robinhood-processing.service`, lease `robinhood-processing-worker`,
`start:worker:robinhood-processing` na porta 3007). O worker reclama capturas por lease
(`FOR UPDATE SKIP LOCKED`, ordem on-chain), re-decodifica o log congelado contra um contexto
de pool sintetizado da evidência e lê metadata/quote/saldos da própria evidência — **nenhum
`eth_call` histórico**. Persiste logs, deltas V4, observações e buckets numa transação
(`commitHeadProcessingBatch`) que **não** commita cursor nem emite socket/alert (derivados são
etapa posterior); erro isola a claim (retry com backoff ou dead-letter `blocked`) sem tocar o
cursor de captura. Poda a fila 1 dia após o terminal (`retention_eligible_at`). Watermark de
processamento independente do cursor de captura. A unit foi implantada em shadow, mas
ficou pausada em `2026-08-05` até a correção online do índice de claim market: o plano
vigente lia milhões de entradas do índice de reorg para reclamar lotes de 200. A Stage 107
adiciona `idx_robinhood_head_captures_market_claim` com `CREATE INDEX CONCURRENTLY`, na
ordem `(block_number, transaction_index, log_index, next_attempt_at)` e predicate parcial
`pending + market`; o índice antigo permanece para discovery. O processing só deve ser
retomado depois que `pg_index` confirmar `indisvalid/indisready` e `EXPLAIN (ANALYZE,
BUFFERS)` provar que a claim usa esse índice sem sort/scan massivo.

No mesmo processo do `robinhood-processing`, o `robinhood-discovery-processing-runner`
consome `stream='discovery'`. O cutover do isolamento do head tinha deixado o stream de
discovery **sem consumidor**: o head só enfileira o evento (`commitDiscoveryRange` do
adapter = `appendCaptures`), e o `upsertPool` vivia apenas no `commitDiscoveryRange` do
monólito, agora desligado — então pools lançados após o cutover paravam de entrar no
`robinhood_pool_registry` e sumiam do board (o market faz `INNER JOIN` no registry ativo).
O runner reclama por lease, decodifica o `event` congelado (sem RPC) e chama
`commitDiscoveryProcessingBatch`, que espelha os writes de pool/noxa do monólito **sem**
avançar `robinhood_ingestion_cursors` nem o cursor de captura e **sem** publicar backfill.
Reprocessar é idempotente (`insertProcessedLog` dedup + `upsertPool ON CONFLICT`), então o
drain do backlog acumulado registra só os lançamentos pós-cutover. Lease owner distinto
(`…:discovery`); o reclaim fica com o runner de market, cujo `reclaimExpiredLeases` é
chain-wide e já cobre os leases de discovery.

A Stage 108 remove o segundo scan quente descoberto no Corte 6D. O frontier derived não executa
mais `MIN/COUNT FILTER` sobre todo o histórico a cada batch: consulta somente a evidência ativa
mais antiga por índices parciais. `pending` usa a Stage 107, `leased` materializa apenas o lote em
voo e `blocked` usa `idx_robinhood_head_captures_blocked_frontier`, criado com
`CREATE INDEX CONCURRENTLY`. O watermark com contagens permanece disponível só para diagnóstico.

O primeiro gate do Corte 6 é o auditor opt-in do processing
(`ROBINHOOD_PROCESSING_SHADOW_AUDIT_ENABLED`, default `false`). Antes de o batch do novo
caminho tentar persistir, ele lê em lote as observações canônicas que o monólito já
commitou para as mesmas identidades `(transaction_hash, log_index)` e compara ordem,
mercado, amounts, supply/quote provenance, preço, volume, FDV e liquidez. A telemetria da
lease expõe totais `compared/matched/mismatched/missing/errors` e amostras limitadas das
divergências. Ausência, mismatch ou falha da query **nunca** falham a claim nem mudam a
persistência; a leitura possui `statement_timeout` dedicado (default 1s). Este gate é
estritamente read-only/fail-open e não liga outbox ou derived.

No processing, leituras do ledger materializado V4 são reutilizadas por `poolId` dentro do mesmo
batch. Todos os swaps dessa fase já enxergam o mesmo estado anterior ao commit; o cache elimina
queries idênticas sem mudar ordem, valuation ou a aplicação posterior dos deltas de liquidez.

O grupo `robinhood-derived` (Corte 5, systemd `trendscope-worker@robinhood-derived.service`,
lease `robinhood-derived-worker`, `start:worker:robinhood-derived` na porta 3008) é o consumidor
que devolve o **board ao vivo** sem o monólito. O `commitHeadProcessingBatch` do processing, quando
`ROBINHOOD_DERIVED_OUTBOX_ENABLED=true` (default off), deixa de descartar os `liveBuckets`: valoriza
o volume/coverage 5m contra a **fronteira estrita de processamento** (timestamp do bloco logo abaixo
do `pendingBlock` da fila — `resolveMarketFrontier`), grava um payload `market:bucket` pronto por
bucket na `robinhood_derived_outbox` **na mesma transação** e dispara `pg_notify`. O worker derived
reclama a outbox por lease (`FOR UPDATE SKIP LOCKED`), acorda por `LISTEN robinhood_derived_outbox`
(cai no poll se a conexão cair, sem perder linha) e replica o **mesmo hub de fan-out** do monólito
(`createRobinhoodMarketBucketFanout`): o relay `market_bucket_updated` publica pro web tier via
`pg_notify`, deixando o board tickando. Entrega apaga a linha (self-pruning, at-least-once); falha
isola a linha (retry/backoff, dead-letter `blocked`). Os sinks in-memory (catalog/alert/aggregate)
**não** sobem nesse processo ainda — evita double-processing no overlap; o co-start e o cutover do
monólito são a etapa seguinte (Corte 6/7). Nenhum `.env` atual seleciona o grupo nem liga a flag.
Contrato: `docs/robinhood-derived-outbox-contract.md`.

O Corte 6B adiciona um modo seguro de shadow ao mesmo consumidor:
`ROBINHOOD_DERIVED_SHADOW_AUDIT_ONLY=true` (default `false`). Nesse modo, cada payload da outbox é
comparado com o bucket canônico atual em `robinhood_market_buckets_1m`; igualdade, divergência,
ausência e payload já superseded por ordem on-chain ficam na telemetria. O sink de delivery é
substituído pelo auditor, portanto **nenhum** socket, relay, alerta, catálogo ou aggregate é
executado. Falha da leitura retenta a linha; comparação concluída a remove normalmente. Durante o
overlap, o processing também passa a reconstruir a outbox a partir do bucket canônico quando o
monólito venceu a identidade idempotente do log, sem reinserir observação nem somar volume/swaps.
Os campos dinâmicos de janela 5m e diagnósticos por protocolo não fazem parte deste primeiro gate;
o núcleo 1m, valuation, candle, atividade e ordem são comparados.

O Corte 6C fecha o fluxo de **alertas padrão** pelo derived, ainda opt-in. O payload da outbox
carrega identidade do mercado e frontier estrita de processamento; somente o bucket on-chain mais
novo de cada token no commit recebe `standardAlertEligible`. O sink
`robinhood-derived-standard-alert-sink` reconstrói o contrato canônico, consulta baselines com o
frontier derived e reutiliza a publicação idempotente existente. Linhas antigas/sem elegibilidade e
eventos acima do limite de idade são descartados antes da query. Ativação de cálculo:
`ROBINHOOD_DERIVED_STANDARD_ALERTS_ENABLED=true`; envio real exige também
`ROBINHOOD_DERIVED_STANDARD_ALERTS_PUBLISHABLE=true` **e** `ROBINHOOD_ALERTS_ENABLED=true`.
Audit-only prevalece e nunca instancia esse sink. O Corte 6C não inicia os workers in-memory de
catálogo live ou aggregates no processo derived; esse co-start continua pendente antes do cutover.

A persistência de estado de alerta (`user_alert_rule_state`) clampa `last_alerted_value`
(`NUMERIC(20,4)`) e `last_alerted_pct` (`NUMERIC(10,2)`) aos limites das colunas no único ponto de
escrita (`upsertState`, chain-agnóstico). Tokens micro-cap ou FDV/mcap corrompido geravam
valores/variações astronômicos que estouravam o INSERT (`numeric_field_overflow`), dead-letterando a
outbox do derived e quebrando todos os alertas. Ampliar a coluna não bastava (valores chegavam a
~1e53); o clamp na origem garante que a escrita nunca estoura.

O Corte 6D entrega esse co-start, ainda **desligado por padrão**. Com
`ROBINHOOD_DERIVED_LIVE_SINKS_ENABLED=true`, e somente fora do audit-only, o processo derived passa
a possuir o catálogo live e o worker de aggregates; `ROBINHOOD_MARKET_AGGREGATES_ENABLED=true` é
pré-condição explícita. O alerta realtime possui gates separados de cálculo e publicação
(`ROBINHOOD_DERIVED_REALTIME_ALERTS_ENABLED` e
`ROBINHOOD_DERIVED_REALTIME_ALERTS_PUBLISHABLE`). Tanto ele quanto a publicação dos alertas padrão
falham fechados se as leases do head/processing estiverem inativas, sem telemetria recente, fora do
head, com gaps, bloqueios ou erro. O gate também lê, pelos índices parciais da fila, a evidência
`pending/leased` mais antiga e bloqueia publicação quando sua idade excede o limite de saúde; fila
vazia ou um lote recente em voo continuam saudáveis. A leitura completa é cacheada por 5s. O corte não desliga o
monólito automaticamente: overlap, observação e parada continuam sendo ações operacionais.

Após o Corte 7, a readiness do workspace prefere a lease ativa
`robinhood-head-capture-worker` e exige também a saúde de
`robinhood-processing-worker`; a lease combinada `robinhood-ingestion-worker` fica somente como
fallback de rollback. Assim, parar o monólito não produz um falso `syncing`, enquanto head fora da
ponta, telemetria vencida, processing parado, bloqueado ou com erro continuam ocultando os painéis
de mercado de forma fail-closed.

As janelas do workspace também deixam de usar o `checkpoint_timestamp` congelado do cursor do
monólito como fim de cobertura. O início histórico continua vindo de
`robinhood_ingestion_cursors`, mas o fim passa a ser a evidência ativa mais antiga da fila do
processing — apenas trabalho não-terminal (`pending/leased`); com a fila vazia, usa o checkpoint
do head. Dead-letters (`blocked`) ficam de fora do frontier de propósito: como nunca viram
observação, incluí-los congelaria `coverage_end` no passado e apagaria `5m/1h` e liquidez de todos
os tokens. A evidência do dead-letter é retida e reprocessável; sua profundidade permanece visível
no health read da fila. Desse modo, `5m/1h/6h/24h` não degradam artificialmente após o Corte 7 e
nunca avançam além dos dados efetivamente processados.

A projeção Robinhood mantém um reparo persistente de metadata separado da página
de mercado ativa. Identidades `robinhood-onchain` com imagem ou launchpad pendente
são priorizadas, e a atividade recente desempata dentro da mesma classe;
assim o enriquecimento não depende de o token continuar no recorte de mercado de
15 minutos. Para preencher apenas imagens ausentes, a ordem é `logo()` pons
on-chain, `logoUrl` de `/rhj/assets` para Stock Tokens, `tokenURI()` IPFS para
metadata de contratos, `icon_url` do Blockscout e `info.imageUrl` do DexScreener. Esse
fallback de imagem fica sempre ativo. `ROBINHOOD_SOCIAL_METADATA_ENABLED=true`
controla somente o reparo adicional de website, X e comunidade via DexScreener;
`symbol/name` continuam vindo do ERC-20 on-chain e do Blockscout.

O worker processa por padrão até 50 identidades por minuto, com concorrência 8.
Os limites podem ser ajustados por `ROBINHOOD_CATALOG_PROJECTION_MAX_TOKENS`,
`ROBINHOOD_CATALOG_PROJECTION_CONCURRENCY` e
`ROBINHOOD_BLOCKSCOUT_METADATA_BATCH_SIZE` (máximo 50).

Dentro do mesmo worker, um fast path consome `GET /token-profiles/latest/v1` do
DexScreener e trata o Token Profile como fonte de verdade da imagem de tokens
Robinhood (`chainId=robinhood`). Ele roda depois do batch principal e é
best-effort: throttle, timeout, 429 ou falha de persistência não derrubam o ciclo
de projeção. A imagem é gravada — inclusive **sobrescrevendo** uma imagem existente
de outra fonte — quando o token já existe no catálogo e `robinhood_blockscout_checked_at`
já foi tentado; um `icon` idêntico ao atual é ignorado para não reescrever a linha a
cada ciclo. Profiles sem `icon` seguro não chamam `recordDexscreenerMetadata` (não
marcam o timestamp DexScreener nem apagam a imagem atual, preservando o fallback por
endereço). A sobrescrita é exclusiva desse fast path (`overwriteImage`); o fallback
DexScreener por endereço continua só preenchendo imagem ausente. Uma fila em memória
curta e limitada cobre só a corrida profile-versus-descoberta, não histórico. É
desligado por padrão (`ROBINHOOD_DEXSCREENER_PROFILE_ENABLED=false`) e ajustado por
`ROBINHOOD_DEXSCREENER_PROFILE_INTERVAL_MS`,
`ROBINHOOD_DEXSCREENER_PROFILE_PENDING_TTL_MS` e
`ROBINHOOD_DEXSCREENER_PROFILE_PENDING_MAX`. Website/X/comunidade do profile só são
persistidos com `ROBINHOOD_SOCIAL_METADATA_ENABLED=true`.

O catálogo também possui atribuição persistente de launchpad. O vocabulário
Robinhood diferencia pons, Bankr/Doppler, LaunchHood, RobinPad, Stock Tokens e o
fallback explícito `robinhood` para contratos diretos ou ainda desconhecidos.
Factories conhecidas vêm do creator retornado pelo Blockscout. Bankr/Doppler só
é atribuído quando o registro público da Bankr confirma o contrato; `tokenURI()`
genérico não é evidência suficiente. Factories prevalecem sobre metadata genérica.
As respostas do workspace e do feed de alertas expõem `launchpadId` e o protocolo
do mercado; no avatar, o frontend mostra o logo local da launchpad atribuída.
Contratos diretos, desconhecidos ou respostas antigas sem atribuição usam o
unicórnio da Uniswap. O tooltip do badge identifica a pool como Uniswap V2, V3
ou V4 quando `pairDexId` está disponível.

Worker leases no PostgreSQL evitam dois donos ativos para loops protegidos. Eles
não autorizam iniciar processos arbitrários: sempre verifique as leases e os
logs antes de escalar.

## 7. Superfícies do produto

Rotas web principais:

| Rota | Função |
|---|---|
| `/` | landing pública |
| `/login` | autenticação e criação de conta |
| `/access` | acesso/token gate e billing quando habilitado |
| `/account-security` | segurança e identidades vinculadas |
| `/alerts` | monitorados, manuais e feed de alertas |
| `/monitor` | RADAR, tokens recentes, antigos e bid zone |

Chains visíveis:

- Solana é a chain base;
- Robinhood só entra em `availableChains` quando
  `ROBINHOOD_USER_VISIBILITY_ENABLED=true`;
- readiness de Robinhood considera flags locais da API e a lease/telemetria
  compartilhada do worker.

Por isso a VPS1 mantém flags de rollout/readiness Robinhood mesmo com
`RUN_BACKGROUND_JOBS=false`.

As sparklines do workspace preservam a última série renderizável quando um
refresh do mesmo range/resolução falha ou retorna temporariamente vazio. A
entrada preservada recebe apenas o novo instante de refresh, evitando apagar o
gráfico ou iniciar retries agressivos; mudanças reais de range/resolução não
reutilizam a série anterior. Eventos `market:bucket` atualizam métricas e candles
em realtime; se um snapshot HTTP iniciado antes terminar depois, os candles
realtime posteriores ao corte do snapshot são mesclados novamente para impedir
rollback visual.

## 8. API pública

Mount points confirmados em `src/server.js`:

| Prefixo | Área |
|---|---|
| `/api/health` | health |
| `/api/auth` | autenticação local |
| `/api/auth/social` | Google/Discord |
| `/api/wallet-auth` | autenticação por carteira |
| `/api/invites` | convites |
| `/api/admin` | administração |
| `/api/account` | conta |
| `/api/account-security` | segurança |
| `/api/billing` | billing/MoonPay |
| `/api/token-gate` | token gate e webhook Helius |
| `/api/pre-access` | sessão pré-acesso |
| `/api/config` | configuração do usuário |
| `/api/bootstrap` | bootstrap de sessão/workspace |
| `/api/catalog` | catálogo |
| `/api/dashboard` | painéis, históricos e charts |
| `/api/x-profile` | perfil X |
| `/api/telegram` | integração Telegram presente apenas nos checkpoints locais em desenvolvimento |

Rotas sensíveis usam autenticação, rate limit e/ou checagem de origem. Não
publique o Node diretamente; o tráfego deve entrar pelo Nginx.

## 9. Autenticação, sessão e acesso

O sistema possui:

- login local;
- verificação de e-mail;
- recuperação de senha;
- OTP de login por e-mail;
- sessões persistidas;
- logout individual e global;
- vinculação/login com Google;
- vinculação/login com Discord;
- autenticação por carteira;
- pre-access;
- token gate.

URLs de produção esperadas:

```env
APP_BASE_URL=https://www.trendscope.pro
SOCIAL_AUTH_CALLBACK_BASE_URL=https://api.trendscope.pro
CORS_ORIGINS=https://www.trendscope.pro,https://trendscope.pro
PRE_ACCESS_RETURN_URL=https://www.trendscope.pro/access
```

Callbacks OAuth:

```text
https://api.trendscope.pro/api/auth/social/google/callback
https://api.trendscope.pro/api/auth/social/google/login/callback
https://api.trendscope.pro/api/auth/social/discord/callback
https://api.trendscope.pro/api/auth/social/discord/login/callback
```

Esses endereços precisam coincidir exatamente com os cadastrados nos consoles
Google e Discord.

## 10. Token gate

O lançamento atual não depende de assinatura. O acesso será token-gated.

Configuração conceitual:

```env
TOKEN_GATE_ENABLED=true
TOKEN_GATE_CHAIN=solana
TOKEN_GATE_RPC_PROVIDER=helius
```

Decisão de lançamento:

- tier unlimited habilitado;
- desconto desabilitado;
- promoção temporária desabilitada, salvo nova decisão explícita.

Valores usados para essa forma:

```env
TOKEN_GATE_UNLIMITED_THRESHOLD=10000
TOKEN_GATE_DISCOUNT_THRESHOLD=0
TOKEN_GATE_DISCOUNT_PERCENT=0
TOKEN_GATE_LAUNCH_PROMO_ENABLED=false
```

Webhook Helius esperado:

```text
https://api.trendscope.pro/api/token-gate/webhooks/helius
```

O webhook exige bearer token. A sincronização automática também precisa de ID,
URL e token configurados. Não registre esses segredos neste documento.

## 11. Integrações externas

### 11.1 Resend

Responsável por e-mails transacionais:

- verificação de e-mail;
- reset de senha;
- OTP.

Contrato:

```env
EMAIL_ENABLED=true
EMAIL_PROVIDER=resend
APP_BASE_URL=https://www.trendscope.pro
```

`EMAIL_FROM` deve usar domínio verificado no Resend. A migração da Vercel para a
VPS não altera Resend desde que os registros de e-mail e o domínio do remetente
continuem válidos.

### 11.2 Google e Discord

O backend inicia e conclui o OAuth em `api.trendscope.pro`; o retorno visual vai
para `www.trendscope.pro`.

Rotacionar um client secret não altera client ID nem callbacks, mas exige
atualizar o `.env` antes de remover o secret antigo.

### 11.3 MoonPay Commerce

Código de billing e webhook existe, mas billing não é requisito do lançamento
token-gated.

Webhook implementado:

```text
POST /api/billing/webhooks/moonpay
```

URL pública correspondente:

```text
https://api.trendscope.pro/api/billing/webhooks/moonpay
```

Não habilite billing parcialmente. `BILLING_ENABLED=true` só deve entrar quando
planos, credenciais, bearer token, webhook token e fluxo de retorno estiverem
validados juntos.

### 11.4 Telegram

Há uma implementação ampla registrada em checkpoints locais:

- vínculo por token;
- webhook;
- menus e alertas localizados automaticamente pelo `language_code` do Telegram,
  com português para tags `pt-*`, inglês como fallback e estados binários
  padronizados em `✅` ativo e `❌` inativo;
- perfis e regras;
- state independente;
- outbox de entrega;
- coordenação de destino Solana.
- cutoff interno no último bucket completo anterior ao alerta, sem parâmetro público.
- `sharp` 0.35.3 selecionado para rasterização; requer Node >= 20.9 nas VPS.
- renderer Telegram gera PNG 960x420 e sinaliza fallback quando faltam pontos.
- sender Telegram compõe histórico e imagem, com fallback textual pré-envio.
- formatter Telegram produz HTML seguro e links validados por rede.
- worker Telegram possui claim, access gate, heartbeat e settlement isolados.
- contexto de entrega revalida lease e identidade antes de montar o sender.
- access gate de entrega suspende a conexao e cancela backlog ainda nao claimed.
- acesso recuperado grava pedido de reativacao, mas nao libera envio sem baseline.
- epoch de reativacao possui transicao atomica pronta, ainda sem wiring runtime.
- planner converte observacoes de reativacao em baseline sem criar delivery.
- destino Solana ativa a conexao apenas depois do commit seguro do baseline.
- reconciliador pode reativar sem baseline quando Solana esta desabilitado,
  revalidando essa condicao no mesmo `UPDATE` que libera a conexao.
- runtime Telegram drena a outbox antes de reconciliar reativacoes e executa
  ciclos serializados com backoff.
- quando habilitado, o grupo `core` inicia esse runtime sob lease distribuido e
  o encerra antes de liberar os leases no shutdown.
- telemetria Telegram agrega fila, latencia, erros, perfis, conexoes, updates e
  fallbacks sem expor secrets, chats ou payloads; o admin recebe o diagnostico
  completo sanitizado e `/api/health` recebe apenas o resumo publico.
- registro e remocao do webhook ainda sao operacoes manuais documentadas em
  `docs/telegram-alert-operations-runbook.md`; nao existe shadow Telegram
  separado, portanto a primeira ativacao deve ficar isolada no admin de staging.
- smoke Playwright protege a transicao visivel entre integracao desabilitada e
  criacao controlada do deep link, sem chamar a Bot API real.

Stages locais relacionados:

```text
84 a 89, 93, 94 e 95
```

Até push, deploy, migrations e validação em produção, Telegram deve ser
tratado como **em desenvolvimento**, não como capacidade ativa do bot.

### 11.5 Fontes de mercado Solana

O código contém integrações e workers relacionados a:

- GMGN;
- DexScreener;
- Meteora;
- PumpFun;
- Helius;
- QuickNode e Jupiter em scripts/probes.

Scripts de probe não são automaticamente infraestrutura de produção.

SHYFT/Yellowstone gRPC continua planejado. Não confundir o plano de firehose com
uma integração já implantada.

## 12. Solana

Solana continua sendo a chain funcional original.

Responsabilidades atuais incluem:

- descoberta e atualização de catálogo;
- snapshots e buckets de mercado;
- monitorados e tokens manuais;
- RADAR;
- alertas;
- snapshots Meteora;
- PumpFun;
- token gate via Helius;
- Socket.io para atualização do frontend.

Durante migrações, interromper workers Solana cria lacunas nos buckets. O banco
central reduz a fragmentação, mas não recompõe automaticamente períodos que
nenhum worker coletou. Backfill de lacunas deve ser uma ação explícita e
validada por fonte.

### 12.1 Recovery recente de candles via CoinGecko

`npm run market-buckets:recover-coingecko` audita as últimas 12 horas completas
de candles de 1 minuto dos tokens Solana elegíveis e ativos, excluindo
prioridade `dormant` e tokens bloqueados. O relatório segue market cap
decrescente e mostra exatamente os intervalos ausentes por token.

O comando é dry-run por padrão. `--confirm-fill` imprime primeiro o relatório
completo e depois insere somente timestamps ausentes, com backup transacional e
reconstrução dos agregados dependentes. Buckets de 1 minuto já existentes nunca
são substituídos. A conversão de preço para market cap usa o par
`last_mcap / last_price` do mesmo snapshot de catálogo.

Esse recovery deve rodar na VPS2, onde está o PostgreSQL de produção, com a
chave CoinGecko disponível apenas no backend:

```bash
npm run market-buckets:recover-coingecko
npm run market-buckets:recover-coingecko -- --confirm-fill
```

## 13. Robinhood Chain

### 13.1 Objetivo

O pipeline Robinhood deve:

- acompanhar a chain;
- descobrir pools/markets;
- normalizar logs de mercado;
- produzir observações;
- gerar buckets de 1 minuto, 1 hora e agregados;
- alimentar catálogo, charts e alertas;
- permitir wallet tracking EVM futuramente.

### 13.2 Componentes persistidos

Stages confirmados:

| Stage | Função |
|---:|---|
| 63 | registry de pools, cursores e processed logs |
| 64 | observações exatas de mercado |
| 65 | buckets de 1 minuto |
| 66 | buckets de 1 hora |
| 67–68 | liquidez em observações/buckets |
| 72–75 | metadata e proveniência de cobertura |
| 78 | buckets agregados por token |
| 79 | proveniência de supply |
| 82 | captura durável do backfill |
| 83 | outbox de agregação do backfill |
| 90 | swaps Robinhood atribuídos à wallet (`tx.from`) |
| 91 | cursores independentes `seed`/`live` de wallet-swaps |
| 92 | índice de leitura das observações para atribuição |
| 96 | proveniência `latest_call` usada pelo enrichment LIVE no node podado |
| 98 | TVL Uniswap V3 pelos saldos ERC-20 da pool e constraints correspondentes |
| 99 | ledger idempotente dos deltas `ModifyLiquidity` V4 por pool/faixa de ticks |
| 100 | cursor independente do replay histórico de liquidez V4 pelo RPC local |
| 101 | faixas V4 materializadas e mantidas incrementalmente após o replay |
| 102 | TVL V4 point-in-time pelas faixas de ticks e constraints correspondentes |

Observações V3/V4 usam o preço spot pós-swap derivado do `sqrtPriceX96` para
preço e FDV; os amounts executados continuam sendo a fonte exclusiva do volume.
V2 mantém o preço médio executado enquanto não houver spot de reservas no contrato
de evidência.

O histórico anterior a essa correção é reparado in-place com
`repair-robinhood-fdv-observations.js --target spot`: o utilitário lê o log bruto
durável do staging (com fallback para head captures), recalcula apenas preço/FDV,
exige janela fixa e checkpoint no modo write e falha fechado se faltar evidência.
Buckets devem ser reconstruídos somente depois desse reparo terminar.

A liquidez V3 usa os saldos reais de token e quote mantidos pelo contrato da
pool, valorados ao preço spot do mesmo snapshot. V4 captura os deltas assinados
de liquidez de forma atômica com o processed log, mas continua fail-closed até o
backfill histórico e a materialização das posições/ticks do `PoolManager`.
O replay V4 usa `eth_getLogs` em `127.0.0.1:8547`, não altera os watermarks do
backfill geral e pode ser retomado com `npm run robinhood:v4-liquidity-replay`.
Depois de `completed`, `npm run robinhood:v4-liquidity-materialize` valida saldos
não negativos, cria as faixas e ativa sua manutenção atômica pelo worker live.
Com a Stage 102, swaps V4 valoram o principal das faixas no preço corrente; o
backfill consulta o ledger no bloco/log do swap, sem usar posições futuras.
Deltas live negativos atualizam faixas existentes sem tentar inserir saldo negativo.
Nos cards monitorados, volume continua vindo das janelas exatas de observações/buckets.
A liquidez Robinhood é agregada na leitura exata a partir do snapshot recente mais
novo de cada pool ativa; pools ainda não valoradas não anulam a soma conhecida, que
é exposta como limite inferior. O card mantém o valor limpo e o hover detalha a
liquidez conhecida por protocolo/pool e a cobertura valorada.

### 13.3 Pipeline de backfill

Ordem lógica:

```text
discovery/scan
    -> staging durável
    -> enrichment
    -> finalizer
    -> aggregation outbox
    -> buckets permanentes
```

As tabelas de staging, ranges, watermarks e outbox existem para o trabalho
continuar após restart sem escolher manualmente o último bloco.

Reiniciar um worker corretamente configurado deve retomar claims pendentes,
leases expiradas e watermarks persistidos. Não resete cursores ou ranges para
"começar de novo" sem auditoria.

#### Recovery de buckets Robinhood

Quando observations corrigidas precisam substituir buckets históricos, o recovery
segue a dependência `_observations -> _1m -> _agg 5/15/30m -> _1h -> _agg 1h/4h/1d`.
O `_1m` antigo pode já ter expirado; durante o recovery ele é recriado temporariamente
em janelas de blocos e volta a ser elegível para retenção somente depois de os pais
permanentes serem validados. `--from-block` representa o último bloco já comprometido
(limite exclusivo), write exige `--to-block`, e o backfill de agregados usa checkpoint
com cutoff fixo. Maintenance/retention permanece parado durante a cadeia completa.

Produtores sobrepostos também precisam executar a mesma versão antes do recovery.
Observations são inseridas com `ON CONFLICT ... DO NOTHING`; portanto um monólito antigo
pode ganhar a corrida contra `robinhood-processing` e preservar métricas obsoletas.
FDV com supply acima de `1e15` tokens humanos é limpo pelo alvo isolado
`repair-robinhood-fdv-observations.js --target supply`, sem executar heurísticas de transposição.
O procedimento operacional detalhado fica em
`docs/robinhood-bucket-corruption-remaining-work.md`.

Snapshot informado em `2026-08-01`:

```text
discovery_scan.next_block  = 25346067
market_scan.next_block     = 25345966
market_enriched.next_block = 25345966
```

Nesse instante, market scan e enrichment estavam alinhados; discovery estava
101 blocos à frente. Esses valores são móveis e servem como evidência de saúde,
não como bloco fixo para um cutover posterior.

### 13.4 Live depois do backfill

O backfill histórico e o acompanhamento do head são responsabilidades
diferentes.

Depois do catch-up:

- um node pruned pode acompanhar o head;
- workers transformam eventos novos em observações/buckets;
- histórico consolidado permanece no PostgreSQL;
- os listeners PostgreSQL de buckets e alertas reconectam automaticamente após
  queda de rede, reinício do banco ou encerramento administrativo da conexão;
  como `LISTEN/NOTIFY` não retém mensagens, a reconexão recupera o transporte,
  mas não reemite sozinha a janela perdida; gráficos podem recarregar pela API
  e alertas de usuário permanecem persistidos para replay quando o cliente
  reconecta;
- o backend expõe histórico expandido completo em 5m, 15m e 30m diretamente de
  `robinhood_market_buckets_agg`, limitado a 10.000 candles e com `truncated`
  explícito quando o token ultrapassa esse teto; o frontend solicita esse modo
  somente nesses três períodos e mantém 1m/1h/4h/24h nos limites usuais;
- agregados por token separam atividade de valoração: volume, swaps e contadores
  continuam somando todas as pools, enquanto preço/FDV OHLC usam, entre as pools
  ativas no candle, a de maior volume acumulado nas 24h encerradas no candle;
  `valuation_protocol`, `valuation_market_key` e `valuation_volume_24h_usd`
  preservam a proveniência e os desempates são atividade mais recente, protocolo
  e `market_key`;
- o backfill relê os limites da tabela fonte em cada mudança de fase; assim a
  fase coarse inclui buckets `1h` antigos que acabaram de ser regenerados pela
  fase hourly da mesma execução;
- o modo “Tudo” de 1h troca para agregados corrigidos apenas com reads habilitados
  e cobertura verificada; fora desse intervalo preserva o histórico `1h` legado
  como fallback e mantém a amostragem limitada;
- o gráfico expandido densifica somente para apresentação os intervalos internos
  sem candle entre 1m e 1h: os pontos sintéticos interpolam do último fechamento
  real até a abertura do próximo candle, com `open` conectado ao `close` anterior;
  nunca gravam bucket, swap ou volume e respeitam um teto de 25.000 candles; o
  viewport também é isolado por timeframe;
- o leitor expandido Robinhood pede até 10.000 pontos no timeframe de 1m (cerca
  de 6,9 dias), enquanto os demais leitores não agregados mantêm o teto de 720;
  com aggregate reads habilitados, o OHLC 1m fixa em todo o intervalo a pool da
  proveniência 5m mais recente e preserva volume/atividade somados de todas as pools;
- o leitor de histórico Robinhood aplica carry-forward de abertura na montagem da
  série (`buildHistoryResult`): a abertura de cada candle passa a ser o fechamento
  do candle anterior, e high/low são alargados para conter essa abertura. Numa AMM
  o spot só se move em swap, então a abertura gravada (pós-swap do primeiro trade
  do bucket) já saltava do fechamento anterior e deixava vãos entre candles. É
  apresentação apenas: buckets gravados, alertas (que leem as tabelas de bucket
  direto) e Solana ficam intactos; minutos sem swap seguem esparsos e nenhum candle
  é fabricado; o primeiro candle da série mantém a abertura crua;
- archive completo do node não é necessário apenas para processar blocos novos;
- qualquer consulta histórica fora da janela do node precisa do PostgreSQL,
  de um provedor archive ou de um snapshot próprio.

O node atual no WSL foi iniciado com archive durante o backfill. A troca para
uma configuração pruned/live deve ser feita somente depois de confirmar head,
cursores e cobertura.

Na base local auditada `954ae548`, o enrichment LIVE normal de swaps já usa WETH/USD e
metadata/supply em `latest`, com `token_supply_status='latest_call'`. Esse caminho
depende da stage 96 antes de ser ligado. A validação de lançamentos NOXA ainda faz
`eth_call`/`eth_getCode` no bloco do evento; portanto steady state perto do head
é compatível com o node podado, mas catch-up após uma parada maior que a janela
de estado ainda precisa de política própria ou recuperação operacional.

O cutover aprovado é por sobreposição: manter o backfill ativo, ligar o LIVE na
VPS2 a partir de um `market_enriched.next_block` fresco, comprovar cursores e
buckets avançando, parar scanners, drenar os consumidores do backfill e só então
desabilitar as units antigas. O archive do PC é o último componente a ser desligado.

## 14. Buckets, swaps e retenção

Princípio:

- buckets consolidados são históricos de longo prazo;
- swaps/eventos normalizados sustentam wallet tracking e evidência detalhada;
- dados brutos não devem crescer indefinidamente.

Decisão de produto:

- preservar aproximadamente 30 dias de swaps normalizados;
- remover dados expirados em batches;
- manter buckets e agregados além dessa janela;
- usar o timestamp do swap para posicionar markers históricos no chart.

Estado atual:

- Robinhood já possui tabelas duráveis de observações, buckets e backfill;
- Solana já possui buckets de mercado;
- a retenção normalizada multichain de swaps por 30 dias é um plano aprovado,
  mas não deve ser tratada como totalmente implantada sem schema, jobs e
  métricas correspondentes em produção.

## 15. Wallet tracking multichain

Wallet tracking de produto ainda é roadmap, mas a fundação de captura Robinhood
já existe localmente: tabela particionada, persistência, adapter `tx.from`,
attributor, cursores `seed`/`live` e seed standalone. A captura contínua do stream
`live` também está implementada no checkout local, mas permanece desabilitada e
sem cursor até executar o bootstrap explícito; não confundir código pronto com
cobertura LIVE já ativa de `robinhood_wallet_swaps`.

Os contratos locais de atribuição já são fail-closed: o bloco cheio fornece hash,
número e timestamp para checkpoint; qualquer transação ausente impede escrita
parcial e avanço do seed. O repository também possui avanço monotônico específico
para o futuro cursor `live`, preservando checkpoint em atualizações de frontier.

O runner e o worker de wallet-swaps LIVE existem localmente. Eles limitam o trabalho
ao menor valor entre `nodeHead - 12` e o último bloco commitado pelo cursor market,
revalidam checkpoint, avançam ranges comprovadamente vazios e ficam em
`awaiting-bootstrap` enquanto o cursor `live` não foi criado. O worker reutiliza o
RPC Robinhood com preflight de chain ID `4663`, lease própria, telemetria, backoff e
wiring no grupo `robinhood`; execução do bootstrap, deploy e canary continuam pendentes.

O bootstrap também existe localmente como
`npm run robinhood:wallet-live-bootstrap`: dry-run por padrão, audita observações
aceitas sem wallet até `seed.safe_head`, valida o RPC/chain e prova o bloco cheio
mais antigo com observação aceita no gap. A confirmação longa cria o cursor uma
única vez; sua existência no código não significa que o comando já foi executado
na VPS2.

Ele deve nascer multichain:

- identidade inclui `chain` + endereço normalizado;
- EVM e Solana usam adaptadores diferentes;
- fee payer, signer, router, beneficiário e trader não são sempre a mesma coisa;
- compras/vendas precisam de direção, token, quote, valor, market e timestamp;
- dedupe deve usar identidade própria da chain;
- markers do chart devem apontar para eventos persistidos.

Não confundir:

- wallets vinculadas para login/token gate, que já existem;
- wallets acompanhadas como smart money/trader, que são uma feature futura.

Sequência aprovada:

1. concluir e estabilizar o backfill Robinhood;
2. estabilizar o node/live Robinhood;
3. criar fundação de wallet tracking multichain;
4. lançar wallet tracking Robinhood;
5. integrar SHYFT/Yellowstone para Solana;
6. adicionar wallets Solana;
7. avaliar Base, BSC e outras EVM por adaptador.

## 16. Persistência

Áreas de dados importantes:

- usuários, sessões e tokens de auth;
- identidades sociais;
- wallets vinculadas;
- acesso/token gate;
- billing orders e events;
- configs e preferências;
- tokens manuais, starred, blocklist e folders;
- catálogo;
- snapshots e buckets;
- alert events e states;
- mock trading;
- Robinhood registry, cursores, observações e buckets;
- worker leases;
- staging/outbox de backfill;
- Telegram, quando as stages 84–89 forem oficialmente implantadas.

O PostgreSQL deve continuar sendo o ponto compartilhado entre web e workers.
Não coloque um segundo banco independente na VPS1.

## 17. Backup e recuperação

A migração física com `pg_basebackup` não é uma política de backup contínuo.

Política mínima ainda necessária:

- backup lógico ou físico automatizado;
- destino fora da VPS2;
- retenção diária/semanal;
- criptografia;
- teste periódico de restore;
- monitoramento de tamanho e falha;
- cópia dos arquivos operacionais que não estão no Git.

Um `pg_dump` pode ser muito menor que o diretório do PostgreSQL porque:

- não copia espaço livre/bloat da mesma maneira;
- recria índices durante restore em vez de armazenar todas as páginas do índice;
- comprime dados repetitivos.

Isso não significa que o restore usará apenas o tamanho do dump. O banco
restaurado volta a ocupar dados + índices + WAL + espaço operacional.

Arquivos que precisam de cópia segura separada:

- `.env` de produção;
- chaves WireGuard;
- unidades systemd;
- configs Nginx;
- inventário de DNS/OAuth/webhooks;
- procedimento de recuperação.

## 18. Deploy do frontend

Fluxo atual na VPS1:

```bash
cd /opt/trendscope/app
runuser -u trendscope -- npm --prefix frontend ci
runuser -u trendscope -- npm --prefix frontend run build
rsync -a --delete frontend/dist/ /var/www/trendscope/
chown -R www-data:www-data /var/www/trendscope
nginx -t
systemctl reload nginx
```

Validação:

```bash
curl -I -H 'Host: www.trendscope.pro' http://127.0.0.1
curl -I https://www.trendscope.pro
```

Risco atual:

- `rsync --delete` atualiza o diretório ativo;
- ainda não há release directory versionado/symlink atômico documentado;
- rollback do frontend depende de Git + rebuild.

## 19. Deploy do backend

Antes:

```bash
cd /opt/trendscope/app
git status --short
git branch --show-current
git log -1 --oneline
```

Nunca execute pull sobre alterações desconhecidas.

Depois de atualizar dependências/configuração:

```bash
runuser -u trendscope -- npm run db:schema-check
systemctl restart trendscope-web.service
systemctl status trendscope-web.service --no-pager -l
curl -i https://api.trendscope.pro/api/health
```

Se falhar:

```bash
journalctl -u trendscope-web.service -n 100 --no-pager
```

O deploy de workers deve reiniciar somente as unidades afetadas. Não reinicie
todos os workers por conveniência durante backfill ou ingestão live.

## 20. Segurança operacional

Controles atuais:

- SSH por chave;
- firewall permitindo apenas portas necessárias;
- Nginx na frente do Node;
- HTTPS;
- banco em rede privada;
- API e workers separados;
- cookies seguros em produção;
- CORS explícito;
- Helmet/CSP;
- rate limiting;
- schema check antes de restart.

Regras:

- não publicar PostgreSQL em `0.0.0.0/0`;
- não expor RPC do node diretamente à internet;
- não reutilizar private keys entre hosts;
- não commitar `.env`;
- rotacionar segredo vazado, não apenas apagá-lo de uma mensagem;
- manter VPS1 sem background jobs;
- manter VPS2 sem socket hub público;
- auditar unidades systemd e processos depois de reboot.

## 21. Testes e segurança do banco

Testes unitários:

```bash
npm run test:unit
```

Integração:

```bash
npm run test:integration
```

Integração é destrutiva contra o database selecionado. Nunca use:

- banco de produção;
- snapshot de produção;
- VPS2;
- `.env` normal.

Use `.env.test` e database local claramente nomeado como teste.

Validação por mudança:

- frontend: lint + build;
- backend: lint + testes afetados;
- schema: schema check;
- auth/billing/persistência: validação de integração proporcional;
- fluxo visível: smoke quando aplicável.

## 22. Observabilidade e checagens rápidas

Web:

```bash
systemctl status trendscope-web.service --no-pager -l
curl -i https://api.trendscope.pro/api/health
curl -I https://www.trendscope.pro
```

Banco:

```bash
sudo -u postgres psql -Atc "SELECT current_database(), current_user;"
sudo -u postgres psql -Atc "SELECT pg_size_pretty(pg_database_size('volume_alert'));"
```

WireGuard:

```bash
wg show
ping -c 3 10.77.0.2
```

Schema:

```bash
npm run db:schema-check
```

Workers:

```bash
systemctl list-units --type=service --all | grep -Ei 'trendscope|volume|robinhood'
```

Backfill:

- conferir ranges por status;
- conferir leases expiradas;
- conferir staging pendente;
- conferir watermarks;
- conferir outbox de agregação;
- conferir cobertura/buckets, não apenas CPU do processo.

## 23. Pendências e riscos atuais

### Infraestrutura

- backup externo automatizado ainda precisa ser formalizado;
- rollback atômico do frontend ainda não está montado;
- inventário permanente das unidades worker da VPS2 precisa ser mantido;
- monitoração de disco, WAL, conexões e leases deve ganhar alertas.
- no diagnóstico de `2026-08-01`, o runtime schema check da VPS2 ainda reportava
  stages Telegram 84-89 e 93-95 ausentes; o servidor do HEAD local valida o profile
  runtime antes de iniciar workers, portanto essa divergência precisa ser resolvida
  antes do canary LIVE. A stage 96 deve ser confirmada e aplicada somente se o
  schema check completo ainda a reportar como pendente.

### Documentação

O `README.md` ainda contém premissas antigas:

- frontend na Vercel;
- PostgreSQL na mesma VPS do backend;
- nomes antigos sugeridos para unidades systemd;
- referência a um ops runbook removido.

Ele deve ser corrigido em uma mudança separada para não continuar contradizendo
esta referência.

### Produto

- o backfill Robinhood foi reportado como alcançado no snapshot de `2026-08-01`,
  mas ainda precisa da auditoria final de staging/outbox antes de ser desligado;
- o LIVE Robinhood preparado no código precisa de migrations, deploy, canary com
  overlap e estabilização no head da VPS2;
- o worker LIVE de wallet-swaps, seu runner fail-closed, configuração, lease e
  bootstrap auditável já existem no checkout local, desabilitados por padrão.
  Ainda faltam executar o bootstrap na VPS2, deploy e canary antes de considerar
  o desligamento do seed/archive como handoff completo de wallet tracking;
- retenção de swaps por 30 dias precisa virar implementação verificável;
- wallet tracking multichain ainda é roadmap;
- SHYFT/Yellowstone ainda é roadmap;
- Telegram está em desenvolvimento local;
- billing existe, mas lançamento atual é token-gated.

## 24. Relação com outros documentos

Referências úteis:

- `README.md`: entrada do projeto, parcialmente desatualizada na topologia;
- `docs/robinhood-vps-history-rollout-plan.md`: desenho do replay Robinhood;
- `docs/robinhood-live-head-isolation-urgent-plan.md`: plano urgente para separar
  captura live, processamento e derivados sem perder a janela de estado podado;
- `docs/robinhood-head-capture-evidence-contract.md`: contrato de evidência
  (gate §14/§16.6 do plano acima) que define o payload state-dependent por
  protocolo. Cortes 1–4 já existem em código: schema `robinhood_head_captures`/
  `robinhood_head_capture_cursors` + `appendCaptures`, evidence builder, adapter,
  `captureMode` no pipeline e o grupo `robinhood-head` (captura); e o consumidor
  `robinhood-processing` (Corte 4): decoder-a-partir-de-evidência sem RPC, fila por
  lease (claim/settle/reclaim/poda + watermark), `commitHeadProcessingBatch` e o
  runner/worker isolados no `server.js`. Head validado e ativo em shadow; a unit de
  processing foi implantada e pausada até o reparo do índice de claim. O Corte 5
  implementa outbox/derived atrás de flags; ainda faltam seu deploy, o cutover (6) e a
  remoção do monólito (7);

Os planos locais de retenção, wallet tracking, SHYFT/Yellowstone, Telegram,
configuração por chain e alertas derivados do X ainda precisam de commits
documentais separados antes de serem referenciados aqui como arquivos
versionados.

Planos descrevem direção e decisões; não provam deploy.

## 25. Checklist de estado saudável

- [ ] `www.trendscope.pro` responde HTTPS com o frontend atual.
- [ ] `api.trendscope.pro/api/health` responde sem `502`.
- [ ] `trendscope-web.service` está `active`.
- [ ] VPS1 reporta `RUN_BACKGROUND_JOBS=false`.
- [ ] VPS2 alcança PostgreSQL local.
- [ ] VPS1 alcança PostgreSQL apenas pelo WireGuard.
- [ ] Schema check passa no perfil runtime.
- [ ] Cada worker possui no máximo uma lease ativa.
- [ ] Solana continua produzindo dados recentes.
- [ ] Robinhood backfill avança sem ranges presos.
- [ ] Buckets Robinhood são auditados por cobertura.
- [ ] Disco e WAL possuem folga.
- [ ] Certbot timer está ativo.
- [ ] OAuth usa callbacks em `api.trendscope.pro`.
- [ ] Resend usa remetente verificado.
- [ ] Helius token gate aponta para o webhook de produção.
- [ ] Nenhum segredo está versionado.
- [ ] Existe backup externo recente e um restore já foi testado.

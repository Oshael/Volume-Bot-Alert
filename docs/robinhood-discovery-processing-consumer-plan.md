# Plano: consumidor de discovery para o caminho isolado (pós-cutover)

Status: proposto, aguardando autorização da fatia 1
Prioridade: alta (perda contínua de descoberta de pools)
Origem: achado durante o incidente de cobertura de 2026-08-06
Relacionado: `docs/robinhood-live-head-isolation-urgent-plan.md`,
`docs/robinhood-head-capture-evidence-contract.md`

## 1. Contexto e problema

O cutover do isolamento do head foi concluído: o monólito `robinhood` está
desligado e a produção roda `robinhood-head` + `robinhood-processing` (+ derived).

O cutover ficou **incompleto**: o market ganhou seu consumidor
(`robinhood-processing`), mas o stream `discovery` **não ganhou o dele**. Em
`captureMode`, o head enfileira eventos de discovery em
`robinhood_head_captures (stream='discovery')` via `commitDiscoveryRange`
(adapter) e **não** registra pool. O registro de pool (`upsertPool`) só acontecia
dentro do `commitDiscoveryRange` do **monólito** (`robinhood-persistence.js`),
agora desligado. Nada no caminho novo consome o stream `discovery`
(`claimCaptures` só é chamado com `stream:'market'` em
`robinhood-processing-runner.js`).

### Evidência (prod, 2026-08-06)

- Fila: `discovery` com **53.620 pending** (bloco 26548318 → 29089579), nunca
  consumidos.
- `robinhood_pool_registry`: `pools_2h = 0`, `pools_24h = 22236`,
  `latest_pool = 2026-08-05 23:51` — a descoberta parou seco no instante do
  desligamento do monólito.

### Impacto

Pools lançados após ~23:51 não entram no `robinhood_pool_registry`. Como as
observações de market fazem `INNER JOIN robinhood_pool_registry (active=true)`,
os swaps desses tokens **não aparecem no board**. A cada hora ~900 lançamentos
ficam invisíveis.

### Mitigação já existente

Os lançamentos **não estão perdidos**: o head capturou cada um com a evidência
congelada (`buildDiscoveryEvidence` guarda `event` e `noxa` pré-decodificados em
`robinhood-head-evidence.js`). Estão apenas não-consumidos. Assim que houver um
consumidor, o drain registra todos retroativamente, sem RPC.

## 2. Objetivo

Adicionar um consumidor durável que dreia `robinhood_head_captures
(stream='discovery')` para o `robinhood_pool_registry`, sem RPC, reprocessável e
idempotente, respeitando os mesmos invariantes do `robinhood-processing`
(nunca toca o capture cursor). Depois drenar o backlog de 53.620.

## 3. Design

### 3.1 Reuso direto (sem alteração)

- `robinhood-head-processing.js` (model): `claimCaptures({stream:'discovery'})`,
  `settleClaims`, `reclaimExpiredLeases`, `getProcessingWatermark`,
  `pruneExpiredCaptures` já são stream-aware (`STREAMS` inclui `discovery`).
- `robinhood-head-processing-decoder.js`: `decodeCapture` já retorna
  `{ kind: 'discovery', log, event, noxa }` a partir da evidência congelada. Sem
  RPC.

### 3.2 Novo — `commitDiscoveryProcessingBatch({ entries })` na persistence

Espelha o `commitDiscoveryRange` do monólito, mas para o caminho de processing:

- por entry: `insertProcessedLog` (dedup idempotente) → se `normalizePool(event)`
  não nulo, `upsertPool` → se `normalizeNoxaLaunch(event)` não nulo,
  `updatePoolNoxaLaunch`;
- **sem** `upsertCursor` e **sem** `publishDiscoveryBackfillRange`;
- 1 transação curta; erro isola o lote (retry), nunca o capture cursor;
- reusa as funções internas já existentes (`insertProcessedLog`, `normalizePool`,
  `normalizeNoxaLaunch`, `upsertPool`, `updatePoolNoxaLaunch`).

Invariantes (contrato §7 do plano de isolamento):

- processing nunca altera `robinhood_ingestion_cursors` nem
  `robinhood_head_capture_cursors`;
- reprocessar produz o mesmo resultado (`insertProcessedLog` dedup +
  `upsertPool ON CONFLICT`);
- uma falha de commit reprograma a claim (retry/backoff), nunca some com a
  captura.

### 3.3 Novo — `src/services/robinhood-discovery-processing-runner.js`

Loop: `reclaim → claim(stream='discovery') → decode → monta pool/noxa →
commitDiscoveryProcessingBatch → settle`.

- erro terminal de decode (`assertSupportedVersion`, evento inválido) →
  `rejected` (auditável, não-retryable);
- captura não-discovery/kind inesperado → `rejected` defensivo;
- falha de commit → retry com backoff → eventual `blocked` (agora inofensivo ao
  frontier de cobertura graças ao fix de 2026-08-06, commits `23b8bf31` +
  `8dbfbcf7`).

É o market runner **menos** valuation/liquidez/V4/outbox.

## 4. Wiring

### Opção A — co-localizar no `robinhood-processing` (recomendada)

`robinhood-processing-worker.js` passa a instanciar e tickar também o discovery
runner, no **mesmo processo/grupo/lease** (`robinhood-processing`).

- Deploy: pull + `systemctl restart trendscope-worker@robinhood-processing` na
  VPS2. **Sem unit nova, sem config nova, sem schema.**
- Justificativa: discovery é baixo volume (~900/h) e é o mesmo papel
  "processing sem RPC"; menor superfície operacional.
- Coordenação de lease: `reclaimExpiredLeases` é idempotente; se ambos os runners
  chamarem, apenas reprograma leases expiradas (inofensivo). Alternativa: só o
  market runner chama reclaim.

### Opção B — grupo dedicado `robinhood-discovery`

Worker + grupo + config + unit systemd + scripts npm próprios.

- Isolamento total de falha entre discovery e market processing.
- Custo: unit systemd nova na VPS2, config, scripts, mais linhas.
- Escolher só se quiser falha de discovery 100% isolada do processing de market.

## 5. Drenar o backlog

Com o runner no ar, dreia os 53.620 `pending` em ordem on-chain
(~5 min a 200/batch/1s). **Idempotente**: pools já registrados pelo monólito são
no-op via `ON CONFLICT`; só os lançamentos pós-cutover viram registro novo. **Não
precisa reset manual** — já estão `pending`.

Verificação pós-drain:

```sql
SELECT max(discovered_at) AS latest_pool,
       count(*) FILTER (WHERE discovered_at > now() - interval '15 minutes') AS pools_15m
FROM robinhood_pool_registry WHERE chain = 'robinhood';
-- pools_15m > 0 e latest_pool ~ agora => descoberta live restaurada
```

```sql
SELECT processing_status, count(*) FROM robinhood_head_captures
WHERE chain='robinhood' AND stream='discovery' GROUP BY processing_status;
-- pending deve cair para ~0 (só o topo em voo)
```

## 6. Testes (proporcionais ao risco)

- **Integração** (`commitDiscoveryProcessingBatch`):
  - registra um pool a partir da evidência congelada;
  - idempotente no re-run (sem duplicar, sem erro);
  - **não avança nenhum cursor** — assert `robinhood_ingestion_cursors` e
    `robinhood_head_capture_cursors` intactos (protege o invariante central).
- **Unit** (runner):
  - roteia pool vs não-pool (`normalizePool` nulo → settle sem upsert);
  - decode terminal → `rejected`.

Não replicar em E2E; o contrato é de persistência + roteamento.

## 7. Escopo e fatias (limite de 500 linhas)

Opção A, fatia única estimada:

- `robinhood-persistence.js` — `commitDiscoveryProcessingBatch` (~45)
- `robinhood-discovery-processing-runner.js` — novo (~90)
- `robinhood-processing-worker.js` — wiring do 2º runner (~25)
- testes integração + unit (~90)
- `docs/bot-reference.md` — nova seção (~10)

Total ≈ **260 linhas, 1 fatia** (<500). Sem schema → sem `db:schema-check`. Sem
mudança no frontend/web.

Se escolher a Opção B, some ~100 linhas (config + `server.js` group start +
scripts) e trabalho de unit systemd na VPS — provável 2 fatias.

## 8. Riscos

- **Versão de evidência antiga**: o backlog vai até o bloco 26548318; capturas
  antigas podem ter `evidence_version` fora de `SUPPORTED_EVIDENCE_VERSIONS` →
  `assertSupportedVersion` terminal → `rejected`. Aceitável (esses pools antigos
  já estão no registry pelo monólito). Confirmar no código antes de implementar;
  se necessário, tolerar versão antiga no decode de discovery.
- **Volume do drain**: 53k upserts individuais; a 200/batch é trivial, mas
  monitorar CPU/lease durante o primeiro drain.
- **Concorrência de reclaim** entre os dois runners: idempotente, mas decidir se
  só um chama `reclaimExpiredLeases`.

## 9. Runbook de deploy (Opção A)

1. Merge/pull da branch na VPS2.
2. `systemctl restart trendscope-worker@robinhood-processing`.
3. Acompanhar o drain com as queries da seção 5.
4. Confirmar no board o aparecimento de tokens lançados após o cutover.
5. Sem ação na VPS1 (web) — nenhuma mudança de read path.

## 10. Critérios de aceite

- Pools lançados após o deploy entram no `robinhood_pool_registry` em segundos.
- Backlog `discovery` pending cai para ~0.
- Reprocessar uma captura discovery é idempotente e não altera cursor algum.
- Uma falha de commit isola a claim (retry/backoff) sem tocar o capture cursor.
- Nenhuma mudança de schema; deploy e rollback mantêm captura contínua.

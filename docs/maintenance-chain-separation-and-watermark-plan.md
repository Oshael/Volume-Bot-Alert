# Plano de separação de maintenance por chain e watermarks de retenção

Data da decisão: 2026-08-09.

Este documento define a evolução do grupo genérico `maintenance` para
responsabilidades isoladas por chain, o contrato fail-closed entre a retenção
Robinhood e seus consumidores e o impacto futuro da ingestão Solana por
SHYFT Build/Yellowstone gRPC.

O plano complementa, sem substituir:

- `docs/worker-category-lock-plan.md`;
- `docs/solana-yellowstone-grpc-firehose-plan.md`;
- `docs/normalized-swap-retention-capacity-plan.md`;
- `docs/robinhood-wallet-swap-live-capture-plan.md`;
- `docs/robinhood-wallet-swap-capture-execution-plan.md`.

## Status

- Blocos 0–3 implementados localmente.
- O runtime possui `solana-maintenance` compartilhado e
  `robinhood-maintenance` isolado; `maintenance` permanece somente como alias
  explícito de rollback durante a transição.
- Catalog cleanup é Solana-only e o gate durável de wallet attribution existe,
  mas Robinhood retention ainda não o consome até o Bloco 4.
- SHYFT/Yellowstone continua planejado; não existe consumer gRPC de produção no
  repositório.
- Mock trading continua no código, mas está destinado a desativação e remoção
  em iniciativa própria.

## Objetivos

1. Separar manutenção Solana de retenção Robinhood no runtime e no deploy.
2. Remover o nome genérico `maintenance` depois de uma transição observável.
3. Impedir que Robinhood retention apague observations ainda necessárias para
   wallet attribution, seed ou outro consumidor durável.
4. Tornar catalog cleanup explicitamente chain-scoped antes de chamá-lo de
   Solana-only.
5. Preparar o boundary de manutenção Solana para uma futura fonte canônica
   on-chain via SHYFT/Yellowstone, sem acoplar o cleanup ao provedor.
6. Retirar mock trading do caminho operacional sem misturar sua remoção com a
   mudança de retenção.

## Não objetivos deste plano

- Implementar o consumer SHYFT/Yellowstone. Essa execução permanece no plano
  específico de firehose.
- Escolher ou escrever todos os decoders de PumpSwap, Raydium e Meteora.
- Alterar a política de retenção normalizada de 30 dias.
- Remover agora tabelas ou dados históricos de mock trading.
- Unificar as tabelas de mercado Solana e Robinhood.
- Colocar ingestão, processamento ou replay SHYFT dentro de um worker de
  maintenance.

## Estado atual validado no código

### Composição do grupo `maintenance`

`src/server.js` inicia três leases independentes dentro do mesmo processo:

| Lease | Módulo | Responsabilidade |
|---|---|---|
| `catalog-cleanup-worker` | `src/services/catalog-cleanup-worker.js` | quarantine, soft archive e remoção de artefatos de tokens bloqueados |
| `robinhood-retention-worker` | `src/services/robinhood-retention-worker.js` | poda de logs/observations expirados e compactação segura de buckets Robinhood |
| `mock-trading-take-profit-worker` | `src/services/mock-trading-take-profit-worker.js` | automação de take-profit simulado a cada poucos segundos |

As leases evitam dois owners simultâneos para o mesmo worker, mas não isolam:

- event loop;
- pool PostgreSQL;
- consumo de memória;
- restart e deploy;
- imports e bootstrap de `src/server.js`;
- falha de processo.

O take-profit é uma automação de produto sensível à latência, não uma rotina de
maintenance. Sua presença no grupo é um erro de classificação, mesmo que a
feature seja removida em vez de receber um grupo próprio.

### Catalog cleanup ainda não é explicitamente Solana-only

O blocked-artifact cleanup passa `chain: 'solana'` aos modelos de buckets, mas
as queries de quarantine e soft archive em `src/models/token-catalog.js` não
filtram `tc.chain = 'solana'`.

Além disso, os conjuntos de proteção usam somente `address` em partes do SQL,
embora a identidade canônica do catálogo seja `(chain, address)`.

Hoje as condições e sources tornam a maior parte do comportamento efetivamente
Solana, mas isso é uma coincidência de dados, não um contrato. O grupo não deve
ser renomeado para `solana-maintenance` até as queries serem chain-scoped.

### Robinhood retention e wallet usam a mesma evidência

O wallet worker lê observations `accepted` de
`robinhood_market_observations`, agrupadas por bloco. A retention remove linhas
de `robinhood_processed_logs`; a foreign key das observations usa
`ON DELETE CASCADE`.

A regra atual protege accepted observations pela existência de bucket 1m, mas
não consulta o cursor do wallet worker. Portanto, bucket coverage não prova que
wallet attribution terminou.

Se a fonte já tiver sido removida, o runner LIVE pode observar um range vazio e
avançar até o frontier. Esse comportamento é correto para blocos realmente sem
swaps, mas não distingue um bloco vazio de um bloco cuja observation expirou
antes do consumo.

## Decisão de topologia

### `solana-maintenance`

Grupo compartilhado, incluído pelo alias `all` durante a topologia padrão.

Responsabilidade inicial:

- `catalog-cleanup-worker` explicitamente limitado a `chain = 'solana'`.

Não pertence a esse grupo:

- ingestão SHYFT/Yellowstone;
- decodificação de transações;
- formação live de buckets;
- replay de slots;
- normalized swap retention;
- qualquer worker Robinhood;
- mock trading.

### `robinhood-maintenance`

Grupo isolado, iniciado explicitamente e proibido de combinar com grupos
compartilhados ou com outro grupo isolado no mesmo processo.

O nome é canônico em config, scripts, ownership de processo e deploy. A unit
simétrica à Solana é `trendscope-worker@robinhood-maintenance.service`, na porta
`3011`; Solana usa `trendscope-worker@solana-maintenance.service`, na porta
`3003`.

Responsabilidade inicial:

- `robinhood-retention-worker`.

O grupo não deve entrar automaticamente em `BACKGROUND_WORKER_GROUPS=all`.
Retenção destrutiva precisa de ativação operacional explícita, telemetria e
watermarks válidos.

### Transição do grupo legado

Rollout proposto:

1. adicionar os grupos novos sem remover `maintenance`;
2. fazer `maintenance` falhar com configuração ambígua ou atuar somente como
   alias temporário documentado;
3. implantar units/processos novos;
4. confirmar leases e telemetria;
5. remover a unit antiga;
6. remover o alias `maintenance` do config e dos scripts.

Nunca iniciar o grupo legado e os grupos novos ao mesmo tempo contando apenas
com as leases como estratégia de rollout. Standby involuntário mascara erro de
configuração e dificulta saber qual processo deveria ser owner.

## Contrato de watermark Robinhood

### Invariante

Uma observation `accepted` só é elegível para poda quando todos os consumidores
duráveis obrigatórios tiverem comprovado consumo completo daquele bloco.

Em forma lógica:

```text
accepted_observation_retention_eligible =
  expired
  AND canonical_bucket_coverage_complete
  AND observation.block_number <= durable_consumer_complete_through
  AND no_protected_replay_or_recovery_window
```

Ausência, corrupção ou regressão do watermark bloqueia a poda de accepted
observations. Não existe fallback por idade.

### Watermark recomendado

Criar um contrato explícito de completude, em vez de fazer a retention conhecer
detalhes internos de cada runner:

```text
chain                         robinhood
consumer                      wallet-attribution
complete_through_block        bigint
checkpoint_hash               0x...
source_frontier_block         bigint
version                       bigint
updated_at                    timestamptz
```

Alternativas de persistência a avaliar no bloco de schema:

1. estender `robinhood_wallet_swap_cursors` com um estado operacional explícito;
2. criar tabela genérica de consumer watermarks;
3. publicar uma view validada sobre os cursores existentes.

A preferência é uma boundary genérica e pequena se já houver outro consumidor
que precise participar da retenção. Se wallet for o único consumidor real, uma
view ou método de modelo sobre o cursor existente reduz schema e migração.

### Semântica de avanço

O watermark só avança depois que:

- a fonte de observations está completa até o frontier usado pelo runner;
- todos os blocos com observations no intervalo foram atribuídos;
- não existem `missing` ou `unresolved`;
- as linhas normalizadas foram persistidas de forma idempotente;
- o checkpoint do bloco foi validado;
- o cursor e a persistência não podem divergir em sucesso parcial.

`next_block` representa o próximo bloco não processado. Se o contrato reutilizar
esse cursor, então o complete-through derivado é `next_block - 1`, nunca
`next_block`.

### Seed e LIVE

O stream `seed` e o stream `live` têm objetivos diferentes. A retention não
pode simplesmente usar o maior cursor.

Enquanto seed histórico estiver ativo:

- a janela necessária pelo seed continua protegida;
- LIVE pode avançar normalmente sem liberar a evidência histórica do seed;
- o estado de seed precisa indicar `pending`, `running`, `complete`, `abandoned`
  ou equivalente;
- `abandoned` exige decisão operacional explícita, não timeout automático.

Depois que seed for concluído e a retenção normalizada estiver validada, o
watermark LIVE pode ser a fronteira contínua para novas observations.

### Comportamento em falhas

| Falha | Comportamento obrigatório |
|---|---|
| watermark ausente | não podar accepted observations |
| watermark regressou | halt/fail-closed e alerta operacional |
| wallet atrasado | manter evidence, expor lag e uso de disco |
| seed ativo | proteger range do seed |
| recovery/backfill declarado | congelar poda do range protegido |
| bucket coverage incompleta | manter regra atual de proteção |
| observation rejected | política independente, sem exigir wallet attribution |

### Telemetria mínima

- `retentionCandidateBlockMin/Max`;
- `walletCompleteThroughBlock`;
- `walletLagBlocks` e idade do watermark;
- candidatos protegidos por wallet;
- candidatos protegidos por bucket coverage;
- candidatos protegidos por recovery;
- deletes efetivos por ciclo;
- último erro e duração;
- crescimento das tabelas quando a retenção estiver bloqueada.

## Impacto futuro do SHYFT Build na manutenção Solana

### Correção da premissa

SHYFT/Yellowstone pode substituir DexScreener, GMGN e outros pollers como fonte
canônica de atividade de mercado em tempo real. Porém, Yellowstone é transporte
de dados on-chain, não um serviço que entrega os buckets específicos do bot
prontos.

O stream fornece transações, accounts, slots e blocos. O bot ainda precisa:

- filtrar programas;
- decodificar PumpSwap, Raydium, Meteora e outros protocolos suportados;
- identificar o swap econômico;
- calcular deltas de token/quote;
- resolver decimals e rota WSOL/stable;
- formar preço e volume;
- deduplicar assinatura/ação;
- lidar com commitment, reconnect e replay;
- agregar e persistir buckets.

Portanto, a dependência de APIs de DEX para preço/volume pode sair. A dependência
dos contratos e layouts dos protocolos DEX on-chain continua existindo nos
decoders.

Referências oficiais atuais:

- [SHYFT Yellowstone gRPC](https://docs.shyft.to/solana-yellowstone-grpc/docs)
  permite subscriptions filtradas de transactions, accounts, slots e blocks,
  com commitment configurável;
- a [página oficial de preços](https://shyft.to/solana-rpc-grpc-pricing)
  anuncia o plano Build com gRPC access e RPC/gPA;
- a documentação Yellowstone atual informa replay limitado a uma pequena
  janela de slots, portanto ele não substitui um cursor/outbox durável nem um
  mecanismo de recovery histórico.

Preços, limites e replay devem ser reconfirmados no momento da contratação.

### O que deixa de fazer sentido

Depois do cutover validado, devem ser aposentadas como fonte canônica de market
data Solana:

- descoberta baseada somente em polling DexScreener;
- atualização de preço/volume baseada em snapshots externos;
- formação de buckets a partir de campos agregados declarados por terceiros;
- heurísticas de freshness acopladas ao cadence desses pollers;
- recovery que assume que a API externa é a única verdade disponível.

DexScreener/GMGN podem continuar apenas para metadata e enriquecimento
best-effort, por exemplo:

- imagem;
- website;
- X/comunidade;
- labels e links de terminal;
- comparação/auditoria, sem autoridade para sobrescrever market data canônico.

### O que continua existindo em maintenance

Maintenance Solana não desaparece; muda de responsabilidade. Continuam
necessários:

- lifecycle do catálogo e política de admissão/arquivamento;
- limpeza de tokens bloqueados;
- retenção e rollup de buckets;
- partições de swaps normalizados;
- expiração de evidence temporária;
- detecção e reparo de gaps;
- compactação/rebuild de agregados;
- reconciliação de watermarks;
- auditoria de divergência entre live e fontes secundárias;
- antecipação e remoção segura de partições;
- monitoramento de WAL, bloat e uso de disco.

O catalog cleanup atual, baseado em baixo mcap/volume reportado e sources como
`dexscreener-discovery`, terá de ser redesenhado. A política futura deve usar
evidência on-chain canônica e proveniência explícita, por exemplo:

```text
last_canonical_swap_at
canonical_volume_24h
canonical_liquidity_status
admission_source = solana-yellowstone
market_data_complete_through_slot
metadata_source = dexscreener | gmgn | onchain | manual
```

### Boundary recomendada para SHYFT

```text
SHYFT/Yellowstone transport
  -> Solana protocol adapters/decoders
  -> durable accepted-swap/evidence boundary
  -> bucket + normalized-swap consumers
  -> realtime fan-out
  -> retention/maintenance gated by consumer watermarks
```

O transport conhece endpoint, token, subscriptions, commitment e reconnect.
Ele não conhece regras de catálogo, alertas ou SQL de buckets.

Os adapters conhecem protocolos Solana e produzem um contrato econômico
normalizado. Eles não conhecem SHYFT especificamente.

Os consumidores persistem buckets e swaps idempotentes. Maintenance lê somente
contratos duráveis e watermarks; nunca o estado em memória do stream.

### Watermarks Solana futuros

Antes de desligar os pollers, definir pelo menos:

```text
ingestion_complete_through_slot
accepted_swap_complete_through_slot
bucket_complete_through_slot
wallet_attribution_complete_through_slot
replay_required_from_slot
```

Qualquer retenção de evidence deve usar o menor complete-through dos consumidores
obrigatórios. Se um consumidor atrasar, a retenção para e a telemetria explica
qual watermark bloqueou.

### Relação com o plano existente de firehose

`docs/solana-yellowstone-grpc-firehose-plan.md` continua sendo a fonte de verdade
para transporte, probe, dry-run, soak e primeiro worker permanente.

Antes do bloco de persistência daquele plano, acrescentar um checkpoint de
arquitetura para definir:

- accepted-swap/evidence contract;
- cursor durável e replay;
- protocolo de idempotência;
- ownership dos buckets;
- watermarks de consumers;
- política de coexistência com pollers;
- política de retention e recovery.

Sem esse checkpoint, ligar SHYFT diretamente nas tabelas atuais apenas troca um
acoplamento de fonte por outro.

## Mock trading: desativação e remoção

### Decisão

Mock trading não receberá um grupo dedicado porque a feature não será usada.
Ela será desativada e removida em trabalho separado.

### Transição segura

1. definir `MOCK_TRADING_ENABLED=false` no ambiente;
2. impedir o bootstrap do take-profit quando a feature estiver desabilitada;
3. confirmar que rotas retornam disabled/404 e que o frontend não oferece a UI;
4. remover o worker e sua configuração do grupo legado;
5. planejar a remoção transversal de backend, frontend, testes e schema;
6. decidir explicitamente entre preservar, exportar ou apagar os dados antigos.

Desligar a flag hoje impede ações de produto, mas o bootstrap atual ainda pode
manter timer no-op e o serviço SOL/USD. A remoção do runtime precisa ser
explícita.

A remoção integral toca mais de 12 arquivos de produção e é um architecture
checkpoint independente. Ela não deve entrar nos mesmos commits da separação de
chains ou do watermark de retenção.

## Blocos de execução

Cada bloco de código respeita no máximo 500 linhas alteradas, exige autorização
individual e termina com validação, revisão de diff e relatório de riscos.

### Bloco 0 — Documento de decisão

Escopo:

- criar este documento;
- registrar a relação com SHYFT e os planos existentes;
- nenhuma mudança de runtime.

Validação:

- revisão do documento;
- lint do repositório para confirmar ausência de regressão estrutural.

### Bloco 1 — Tornar catalog cleanup Solana-only

Arquivos estimados:

- `src/models/token-catalog.js`;
- `src/services/catalog-cleanup-worker.js`, somente se a chain precisar entrar
  como opção explícita;
- teste existente de catalog cleanup ou token catalog;
- `docs/bot-reference.md`.

Mudanças:

- adicionar `chain = 'solana'` a todas as candidates/updates;
- tornar protected identity chain-aware;
- garantir que deleções de artefatos continuem chain-scoped;
- preservar exatamente as cadências e limites atuais.

Risco protegido no teste unit/integration mais barato:

- uma linha Robinhood com campos parecidos não pode ser quarentenada ou
  arquivada pelo cleanup Solana;
- proteção de endereço deve respeitar `(chain, address)`.

Estimativa: 80–180 linhas alteradas.

Validação:

```bash
npm run lint
node --test tests/catalog-cleanup-worker.test.js <teste de token catalog afetado>
```

### Bloco 2 — Separar os grupos de runtime

Arquivos estimados:

- `config/index.js`;
- `src/server.js`;
- `package.json`;
- `tests/runtime-worker-groups.test.js`;
- `README.md`;
- `docs/bot-reference.md`;
- exemplos de deploy pertinentes.

Mudanças:

- criar `solana-maintenance` compartilhado;
- criar `robinhood-maintenance` isolado;
- adicionar scripts start/dev com portas distintas;
- manter alias legado somente durante rollout;
- impedir combinações inválidas no config;
- não incluir Robinhood retention em `all`.

Risco protegido em unit/config:

- `all` inicia Solana maintenance, não Robinhood retention;
- grupos isolados não podem ser combinados;
- o grupo Solana não registra lease Robinhood;
- o grupo Robinhood não registra catalog cleanup.

Estimativa: 180–320 linhas alteradas.

Validação:

```bash
npm run lint
node --test tests/runtime-worker-groups.test.js
```

### Bloco 3 — Contrato durável de watermark

Decisão implementada: reutilizar e estender `robinhood_wallet_swap_cursors`,
evitando uma segunda fonte de progresso. A Stage 122 adiciona lifecycle durável;
o modelo publica um gate validado para a retention.

Arquivos estimados:

- uma migration/stage, se necessária;
- `src/utils/runtime-schema.js`;
- modelo de cursor/watermark;
- testes unitários de monotonicidade e fail-closed;
- `docs/bot-reference.md`.

Riscos protegidos:

- avanço monotônico;
- rejeição de regressão;
- cálculo correto de `next_block - 1`;
- seed ativo mantém seu range protegido;
- watermark ausente não libera retention.

Resultado:

- `seed` usa `pending`, `running`, `complete` ou `abandoned`;
- conclusão exige `next_block > safe_head`; cauda vazia avança até
  `safe_head + 1` antes do estado terminal;
- abandono exige motivo explícito;
- LIVE e seed não podem regredir pelo repository;
- o gate rejeita seed não terminal, frontier não comprovado, checkpoint inválido
  e regressão em relação ao watermark previamente observado;
- a retention permanece inalterada até o Bloco 4.

Estimativa: 220–450 linhas alteradas.

Validação:

```bash
npm run lint
npm run db:schema-check
node --test <testes de cursor/watermark afetados>
```

### Bloco 4 — Aplicar watermark na Robinhood retention

Arquivos estimados:

- `src/services/robinhood-retention-worker.js`;
- `tests/robinhood-retention-worker.test.js`;
- config/telemetria se necessário;
- `docs/bot-reference.md`.

Mudanças:

- carregar o watermark antes do lote;
- filtrar accepted observations pelo complete-through;
- reportar candidatos protegidos por consumer;
- falhar fechado em watermark inválido;
- preservar regras atuais de bucket coverage e statement timeout.

Riscos protegidos em unit:

- observation à frente do wallet não é apagada;
- observation atrás do watermark ainda exige bucket coverage;
- rejected observation mantém política independente;
- watermark ausente não toca accepted observations;
- nenhuma query adicional cria loop sem limite.

Estimativa: 180–350 linhas alteradas.

Validação:

```bash
npm run lint
node --test tests/robinhood-retention-worker.test.js
```

Para produção, exigir ainda explain/auditoria do índice usado pelo novo
predicado antes de ativar deletes em volume.

### Bloco 5 — Rollout operacional e remoção do alias

Mudanças:

- criar/ajustar units e envs;
- iniciar grupos novos com retention inicialmente disabled;
- conferir leases, watermarks e lag;
- ativar Robinhood retention somente após dry-run/auditoria;
- remover unit e scripts legados;
- atualizar documentação operacional.

Rollback:

- desligar `robinhood-maintenance` preserva dados e é o primeiro rollback;
- nunca fazer rollback removendo ou resetando cursores;
- `solana-maintenance` pode ser pausado temporariamente sem iniciar o grupo
  legado misto.

### Bloco 6 — Descomissionamento de mock trading

Criar plano próprio antes de editar. Divisão mínima esperada:

1. runtime e rotas;
2. frontend e estado;
3. serviços/modelos/testes;
4. decisão de dados e schema.

Frontend exige `npm --prefix frontend run build`. Schema exige
`npm run db:schema-check`. A remoção de dados nunca será inferida apenas da
remoção da feature.

## Critérios de conclusão

- nenhum processo mistura manutenção Solana e retenção Robinhood;
- catalog cleanup possui chain scope explícito e testes contra cross-chain;
- Robinhood retention não apaga accepted observations além do watermark;
- seed/recovery possuem proteção operacional documentada;
- ausência de watermark é visível e fail-closed;
- mock trading não roda em background depois da desativação;
- `maintenance` legado não aparece em config, scripts ou deploy final;
- SHYFT permanece atrás de adapters e contratos duráveis;
- fontes externas de DEX ficam limitadas a metadata/auditoria após o cutover;
- `docs/bot-reference.md` reflete somente capacidades já implantadas, sem
  apresentar planos como produção.

## Decisões pendentes antes dos blocos de código

1. Persistência do watermark: cursor existente, view ou tabela genérica.
2. Estado durável do seed e condição formal de `complete`/`abandoned`.
3. Destino dos dados históricos de mock trading.
4. Região SHYFT e estratégia de recovery além da janela de slot replay.

## Ponto importante

A migração para SHYFT muda profundamente a produção e a manutenção dos dados
Solana, mas não elimina maintenance. O novo maintenance deixa de limpar um
catálogo dirigido por snapshots de terceiros e passa a administrar evidência,
watermarks, buckets, partições, gaps e retenção de uma pipeline on-chain própria.

Tratar SHYFT como substituto de decoders, cursores ou armazenamento durável
criaria perda silenciosa de dados. O provider deve ser apenas o transport; a
completude continua sendo responsabilidade do bot.

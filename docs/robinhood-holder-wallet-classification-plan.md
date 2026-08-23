# Plano de Classificação de Wallets na Robinhood Chain

Atualizado em 2026-08-23. Este documento consolida as decisões de produto, o
estado confirmado no código e o plano de implementação para enriquecer a lista
de holders da Robinhood Chain com saldo nativo, médias de entrada/saída, PnL,
transfers e classificações explicáveis de wallets.

A fundação financeira, o ledger de holders, os transfers resumidos e a primeira
fatia visual já existem. As classificações `SNIPER`, `INSIDER`, `CEX`, `FRESH`,
`BUNDLED` e `LP LOCKED` ainda não devem ser tratadas como dados disponíveis. A
seção 0 é a referência canônica para implementar essas classificações. As demais
seções preservam a arquitetura financeira e o histórico do plano; em caso de
divergência sobre classificação, prevalece a seção 0.

Cada corte futuro deve ser autorizado, implementado, validado, revisado e
commitado separadamente, respeitando o limite de 500 linhas alteradas por corte.

## 0. Roteiro canônico de classificação de holders

### 0.1 Resultado esperado

O painel de holders continua abaixo do conjunto chart/trades. A UI deve poder:

- filtrar wallets por `TOP`, `INSIDERS`, `SNIPERS` e `FRESH`;
- exibir glifos de `SNIPER`, `FRESH`, `CEX`, `LP` e `UNKNOWN` sem transformar
  inferência em fato;
- mostrar `DEV HOLD`, `INSIDERS`, `LP LOCKED` e `BUNDLED` no painel de
  distribuição;
- distinguir zero real, dado indisponível e classificação ainda processando;
- explicar por que uma tag foi atribuída e até qual bloco a evidência é válida.

Não faz parte deste roteiro afirmar que duas wallets têm o mesmo dono. Relação
on-chain, funding comum e comportamento coordenado são sinais, não identidade.

### 0.2 Estado confirmado em 2026-08-21

Já existe no repositório:

- ledger de holders com saldo atual e supply;
- swaps atribuídos a `tx.from`, com lado, volume, bloco, horário e posição na
  transação;
- atribuição de criador/deployer com bloco e fonte da atribuição;
- registro de pools da Robinhood Chain;
- eventos ERC-20 e arestas permanentes resumidas entre wallets;
- projeção financeira de compra, venda, market cap médio e PnL;
- endpoint paginado de holders e a fatia visual compacta;
- concentração `Top 10` e `Top 50` calculada a partir de saldos reais.

Ainda não existe fonte comprovada para preencher `SNIPER`, `INSIDER`, `CEX`,
`FRESH`, `BUNDLED` ou `LP LOCKED`. Enquanto isso:

- filtros sem dados permanecem desabilitados;
- métricas sem dados mostram `—`, nunca `0` inventado;
- somente `LP` determinístico pelo registro de pools e `UNKNOWN` podem aparecer
  como glifos hoje.

### 0.3 Invariantes

1. Classificação é materializada de forma assíncrona; abrir o modal nunca dispara
   varredura pesada, RPC ou consulta externa por wallet.
2. Toda tag possui versão da regra, `reason_code`, evidência mínima e frontier de
   bloco/hash.
3. Ausência de evidência resulta em `unavailable` ou ausência da tag, não em
   classificação negativa falsa.
4. Reprocessamento é idempotente e seguro para reorg dentro da frontier adotada.
5. Endereços são normalizados por chain; registros de infraestrutura nunca são
   reutilizados implicitamente entre redes.
6. Uma wallet pode ter múltiplas tags. O glifo é apenas uma representação visual
   de prioridade, não perda de informação.
7. `FRESH` é a última fase e a única que depende de enriquecimento externo de
   histórico da wallet em runtime/worker.
8. Regras e thresholds são versionados; uma mudança de threshold não reescreve
   silenciosamente o significado de classificações antigas.

### 0.4 Âncora de lançamento do token

Todas as janelas de lançamento usam o primeiro swap confirmado do token em um
pool registrado, ordenado pela posição canônica `(block_number,
transaction_index, action_index)`. Não usar `createdAt` de metadata, horário de
ingestão ou primeiro alerta.

Se o primeiro swap não puder ser provado, classificações dependentes do
lançamento ficam `unavailable` para o token.

### 0.5 Regras v1

Os limites abaixo são defaults recomendados para a primeira versão e devem ficar
em configuração versionada.

#### LP

- Evidência: endereço é pool V2/V3 ativo do token ou o `PoolManager` de uma pool
  V4 ativa no registro interno. Na V4, a evidência inclui os `pool_id` do token.
- Natureza: determinística.
- Exclusões: nenhuma heurística por saldo ou padrão de transfer. O `PoolManager`
  V4 é infraestrutura compartilhada e não produz AVG BUY/SELL ou PnL de wallet.
- Motivo público: `registered_token_pool` ou `registered_v4_pool_manager`.

#### CEX

- Evidência: correspondência exata com registro interno, auditado e específico
  da chain, incluindo origem e data da informação.
- Natureza: determinística por allowlist; nunca inferida por volume, fan-out ou
  número de transações.
- Operação: o registro pode ser mantido com pesquisa externa fora do caminho do
  produto, mas a classificação consulta somente a cópia interna versionada.
- Motivo público: `known_cex_address`.

#### DEV HOLD

- Fórmula: saldo atual do criador atribuído dividido pelo supply atual.
- Evidência: `creator_address` confirmado pela atribuição existente.
- Sem criador confirmado: `unavailable`, não `0%`.
- Excluir burn e pool apenas do denominador se uma futura métrica explicitamente
  adotar circulating supply; a v1 usa supply total para manter consistência com
  `Remaining`.

#### SNIPER

- Candidatos internos continuam usando a janela exploratória
  `delta_blocks <= 3` ou `delta_seconds <= 90`; ela não publica tag.
- Exclusões: criador, pools, routers, burn/dead addresses e CEX conhecido.
- A regra pública `rh_sniper_high_v1`, fechada após calibração, exige primeira
  compra entre os 5 primeiros compradores canônicos, em até 1 bloco da âncora,
  notional de pelo menos US$50 e o mesmo padrão em pelo menos 2 lançamentos.
- Natureza: regra temporal explicável, não acusação de bot ou má-fé.
- Motivo público: `early_launch_buy` com bloco, horário e delta da âncora.
- `early_launch_buy` e candidatos permanecem sinais internos. A UI só publica
  `SNIPER` quando posição canônica, proximidade da âncora, notional e recorrência
  entre lançamentos satisfizerem uma regra calibrada de alta confiança.

#### INSIDER

- V1 aceita somente relação direta e de alta confiança com o criador/deployer:
  alocação direta do token ou funding direto comprovado antes da primeira compra.
- Excluir pools, routers, bridges, CEX, lockers e contratos de infraestrutura
  compartilhada.
- Não expandir automaticamente para dois ou mais hops na v1.
- Um funding vindo do criador não prova propriedade comum; a UI deve descrevê-lo
  como vínculo on-chain.
- Motivos públicos: `creator_token_distribution` ou `creator_direct_funding`.

#### BUNDLED

- Sinal mínimo: grupo com pelo menos 2 wallets que compartilham o mesmo funder
  não-CEX e compram na janela de lançamento no mesmo bloco ou em até 2 blocos.
- Exigir funding anterior às compras e evidência econômica não-dust.
- Excluir pools, routers, bridges, CEX, lockers e fan-out técnico conhecido.
- O resultado pertence ao grupo; cada membro recebe o identificador do bundle e
  as evidências comuns.
- Se o funding relevante for nativo, a fase exige ingestão/RPC de transfers
  nativos; arestas ERC-20 não são substituto silencioso.
- Motivo público: `common_funder_launch_cluster`.

#### LP LOCKED

- Fórmula: participação do LP token ou posição LP NFT comprovadamente enviada a
  burn address ou custodiada por locker suportado, respeitando expiração.
- Não inferir lock porque a liquidez continua no pool.
- Cada protocolo de locker exige adapter testado e registro de contratos.
- Sem suporte ao tipo de pool/locker: `unavailable`.

#### FRESH

- Implementar somente depois de todas as fases internas estarem estáveis.
- Default v1: no instante da primeira compra do token, wallet com até 24 horas
  desde a primeira atividade on-chain e no máximo 5 transações anteriores.
- Exige histórico anterior da wallet por RPC/explorer/provider externo, porque o
  banco local começa a observar apenas o recorte do produto.
- O worker consulta, normaliza e cacheia a evidência; a API do modal nunca chama
  o provider diretamente.
- Falha, rate limit ou histórico incompleto resulta em `unavailable`, não em
  `not_fresh`.
- Motivo público: `new_wallet_at_first_buy`, incluindo provider, primeira
  atividade observada, contagem anterior e horário da consulta.

### 0.6 Tags simultâneas e prioridade visual

A API retorna todas as tags aplicáveis. Quando houver espaço para apenas um
glifo, usar:

`SNIPER > FRESH > CEX > LP > UNKNOWN`

`INSIDER` permanece consultável e filtrável mesmo sem glifo primário próprio.
`BUNDLED`, `DEV HOLD` e `LP LOCKED` são sinais/métricas adicionais e não devem
apagar tags de endereço.

### 0.7 Métricas de distribuição

- `Top 10` e `Top 50`: soma dos saldos das primeiras wallets sobre supply total.
  A UI atual preserva a visão bruta; uma variante que exclua infraestrutura deve
  ter nome e campo distintos.
- `Snipers`, `Fresh wallets` e `Insiders`: soma do saldo atual das wallets com a
  tag correspondente sobre supply total, além de contagem de wallets.
- `DEV HOLD`: regra da seção 0.5.
- `LP LOCKED`: percentual efetivamente travado segundo adapter suportado.
- `BUNDLED`: quantidade de wallets únicas em bundles ativos; a API também deve
  poder expor quantidade de grupos.

Percentuais usam valores inteiros/raw antes da formatação. Uma wallet com tags
múltiplas pode participar de mais de uma métrica; as categorias não são parcelas
mutuamente exclusivas.

### 0.8 Contratos conceituais

Registro materializado por wallet/tag:

```text
chain
token_address
wallet_address
tag
classification_version
confidence                 # deterministic | high | heuristic
reason_code
evidence_json
through_block_number
through_block_hash
observed_at
expires_at                 # opcional para evidência temporal/registry
```

Registro de infraestrutura:

```text
chain
address
kind                       # cex | router | bridge | locker | burn
label
source
verified_at
valid_from / valid_to
```

O endpoint de holders deve evoluir sem quebrar os campos atuais e adicionar:

- `tags[]`, `primaryTag`, `classificationVersion` e `classificationStatus` por
  wallet;
- `classificationThroughBlock` no envelope;
- distribuição com `value`, `walletCount`, `status` e, quando aplicável,
  `groupCount`;
- evidência resumida segura para tooltip e detalhe auditável por endpoint
  dedicado, evitando payload grande na paginação principal.

### 0.9 Ordem de implementação

Cada fase é um corte independente de no máximo 500 linhas alteradas. Mudança de
schema, se necessária, fica em corte próprio com schema-check e teste de
integração.

#### 0.9.1 Limite de runtime e deploy

O worker determinístico já entregue (`LP`, `CEX` e `DEV HOLD`) permanece como a
única exceção dentro do processo `robinhood-holders`. Nenhum classificador futuro
será acrescentado a esse processo. Os próximos classificadores reutilizam os
contratos materializados no PostgreSQL, mas terão grupo, processo systemd, lease,
flags, telemetria e limites de recurso próprios; desligar ou degradar um deles não
pode interromper captura live, apply ou leitura básica de holders.

Para evitar um processo por tag, a divisão aprovada é por fonte e workload:

1. **Launch intelligence** — `SNIPER`, `INSIDER` direto e `BUNDLED`. Compartilha
   âncora de lançamento, primeira compra, criador e grafo de funding/transfer;
   cada classificador mantém estado, métricas e circuit breaker independentes.
2. **Liquidity custody intelligence** — `LP LOCKED`. Isola adapters de AMM,
   lockers, NFTs/LP tokens e expiração de locks do caminho de lançamento.
3. **Wallet freshness enrichment** — `FRESH`. Isola provider externo, rate
   limits, orçamento, cache, retry e backfill dos classificadores on-chain.

Nenhum desses processos exige que outro classificador esteja ativo. Eles podem
exigir uma frontier materializada mínima como entrada, mas devem aguardar ou
publicar `unavailable` quando ela estiver ausente ou stale, sem iniciar o produtor
upstream no próprio runtime.

#### 0.9.2 Orçamento obrigatório dos backfills

Cada novo backfill desta iniciativa deve ser projetado para concluir a população
histórica necessária em **no máximo 3–5 horas na VPS de produção**. Esse teto vale
para o trabalho completo exigido pela fonte materializada; não pode ser atendido
artificialmente dividindo a mesma carga em vários comandos de até cinco horas.

Antes da execução completa, um preflight representativo deve medir throughput,
custo de banco/RPC e projetar o ETA. Se o upper bound projetado ultrapassar cinco
horas, o backfill completo não deve começar: primeiro é obrigatório otimizar o
acesso, reduzir trabalho redundante ou redesenhar a materialização e repetir o
benchmark.

Todo backfill deve ainda:

- ser particionado, idempotente, checkpointed e retomável após interrupção;
- usar concorrência e tamanho de lote configuráveis, com claim/lease que permita
  paralelismo seguro quando necessário;
- publicar progresso, throughput, ETA, falhas e último checkpoint;
- limitar commits, WAL, conexões e RPC para não degradar os workers live;
- produzir uma fonte de evidência reutilizável por classificadores, evitando
  repetir a carga histórica quando thresholds ou regras forem recalibrados.

O requisito se aplica às fontes históricas de primeira compra, transfer/funding,
custódia/lock de liquidez e freshness externo. Uma exceção futura exige medição
documentada e aprovação explícita antes da execução, nunca depois de iniciar uma
carga sem ETA confiável.

1. **Fundação de classificação**
   - fechar schema/contrato, versionamento, estados e reason codes;
   - criar funções puras para prioridade e disponibilidade;
   - validar idempotência, frontier e reorg.
   - Status em 2026-08-21: domínio, Stage 143 e repository de snapshots
     de tags concluídos; a Stage 144 também prepara snapshots agregados de métricas.
     Repositório de métricas, materializadores e integração REST permanecem em
     cortes próprios.
2. **Determinísticos internos**
   - materializar `LP`, `DEV HOLD` e lookup `CEX` pelo registro interno;
   - entregar tool/processo auditável para manter o registro de infraestrutura.
   - Status em 2026-08-21: materializador `LP` concluído, usando a frontier live
     do ledger, contratos V2/V3 e o `PoolManager` contextual das pools V4 ativas;
     o materializador `DEV HOLD` também está concluído com saldo e supply na mesma
     frontier. A Stage 145 prepara o registro auditável de infraestrutura e o
     lookup interno por endereço/tipo/bloco e o materializador `CEX` estão
     concluídos. O importador auditável append-only também está concluído; o
     Stage 146 prepara metadados coerentes de encerramento auditado, e a ferramenta
     de closure atômico está concluída. O worker determinístico opt-in agora
     mantém `LP`, `CEX` e `DEV HOLD` alinhados à frontier live. O contrato REST
     aditivo também expõe tags compactas, status/frontier e todas as métricas,
     preservando a página com `unavailable` quando a inteligência não pode ser lida.
     A fatia visual consome glifos `LP`/`CEX` e métricas materializadas, mantendo
     filtros de classificadores ainda não implementados desabilitados.
3. **SNIPER**
   - materializar âncora de lançamento e primeira compra;
   - fechar notional mínimo com amostra real antes de ativar UI.
   - Status em 2026-08-21: domínio e source PostgreSQL de evidência temporal
     concluídos, com ordem canônica, histórico seed/live contínuo, somente pools
     registradas e falha fechada sem `transaction_index`. O materializador
     atômico também está concluído, mas exige notional mínimo positivo explícito
     e permanece sem worker. A ferramenta read-only de amostragem e quantis está
     concluída e usa a criação do primeiro pool registrado, não o deployment,
     para separar a população elegível sem afrouxar a cobertura. A calibração
     também compara perfis agregados por bloco/posição e mede as wallets
     `within1BlockTop5` da amostra contra toda a população elegível, sem expor
     endereços. A Stage 149 cria a fonte durável de primeira compra canônica por
     token/wallet, sem misturar classificação ou confiança. O writer SQL em lote
     também está concluído: processa ranges temporais limitados, aceita execução
     fora de ordem com precedência canônica e falha fechado sem posição de tx.
     A Stage 151 e seu repository acrescentam campanha congelada, ranges
     checkpointed, claims por lease e progresso/ETA medidos. O runner de backfill
     também está concluído: preflight read-only obrigatório usa amostras
     distribuídas, margem conservadora e recusa cargas projetadas acima de 5h;
     campanhas interrompidas retomam pelo `run-id`. A Stage 152 e o runner puro
     da manutenção live acrescentam cursor próprio, handoff explícito do seed e
     avanço fail-closed contra a frontier durável do wallet-swap. O worker opt-in,
     lease própria, telemetria, backoff e halt fatal também estão concluídos no
     grupo isolado de classificação de wallets. A regra `rh_sniper_high_v1` também
     está fechada e coberta no materializador: top 5, até 1 bloco, pelo menos
     US$50 e recorrência em 2+ lançamentos; a recorrência lê a projeção canônica
     da Stage 149 em vez de reagrupar swaps brutos e adia a classificação até o
     cursor da Stage 152 estar alcançado. O runner shadow paginado também está
     concluído: seleciona apenas ledgers live atrasados, só avança quando o cursor
     de first-buy está alcançado, limita concorrência e contém falhas por token.
     A leitura pública mantém allowlist `LP`/`CEX`, portanto snapshots SNIPER
     persistidos pelo shadow não vazam para a UI. O loop operacional opt-in roda
     no grupo `robinhood-wallet-classification`, usa lease própria, pagina todo o
     catálogo e publica telemetria sem pertencer ao worker de holders. Auditoria
     da amostra e ativação pública seguem em cortes separados.
4. **INSIDER direto**
   - começar por distribuição direta do token;
   - adicionar funding nativo direto somente quando a fonte estiver comprovada.
   - Status em 2026-08-23: a Stage 153 prepara evidência direcional da primeira
     `wallet_transfer` em cada aresta sem reescrever o histórico na migration. O
     writer seed/live/reclassification já mantém o primeiro evento pela posição
     canônica. A Stage 154 prepara campanhas block-based congeladas e ranges com
     lease/checkpoint para o replay histórico no archive RPC; o repository já
     implementa criação atômica, claims concorrentes, retry, retomada e ETA.
     Preflight e runner puros também estão concluídos, com amostra distribuída,
     teto projetado de 5 horas e recusa por checkpoint não canônico. Source/CLI,
     materializador, worker shadow e publicação seguem em cortes próprios,
     portanto `INSIDER` continua indisponível na API/UI.
5. **BUNDLED**
   - construir clusters explicáveis por funder e janela;
   - publicar como `possible bundle`, nunca como identidade comum.
6. **LP LOCKED**
   - escolher tipos de pool e lockers prioritários;
   - implementar um adapter por vez, com fixtures reais.
7. **FRESH — última fase**
   - escolher provider externo, orçamento, limites, cache e política de retry;
   - executar backfill assíncrono e shadow mode antes de habilitar filtro/métrica.

### 0.10 Critério de aceite por fase

Uma fase só pode habilitar UI quando:

- regra, versão, fonte e exclusões estão documentadas;
- unit tests cobrem boundaries e exclusões plausíveis;
- integration test prova materialização, persistência e contrato REST;
- reprocessar o mesmo intervalo não duplica nem altera resultado sem nova
  evidência/versão;
- reorg/fonte incompleta produz status explícito;
- uma amostra real foi auditada com falsos positivos e falsos negativos
  registrados;
- métricas e logs mostram duração, frontier, wallets avaliadas, classificadas,
  indisponíveis e erros por motivo;
- rollout começa em shadow mode e permite desligar a nova regra sem afetar chart,
  trades, holders básicos ou alertas.

### 0.11 Decisões pendentes antes de código novo

1. Se haverá uma segunda concentração `Top 10/50 eligible` excluindo
   infraestrutura, sem substituir a métrica bruta atual.
2. Processo e fonte de manutenção do registro `CEX`.
3. Quais AMMs e lockers entram primeiro em `LP LOCKED`.
4. Fonte de transfers nativos para `INSIDER` e `BUNDLED`.
5. Provider externo de `FRESH`, orçamento, taxa, cobertura histórica e TTL.

### 0.12 Definição de concluído

O roteiro termina quando todas as tags habilitadas são materializadas,
versionadas, explicáveis e fail-closed; filtros e métricas exibem somente dados
com fonte comprovada; o modal não depende de chamadas externas; e `FRESH`, após
shadow mode, alcança cobertura e custo aceitos sem degradar os workers críticos.

Até lá, a UI deve continuar honesta: funcionalidade indisponível fica
desabilitada ou marcada com `—`.

### 0.13 Mapa para retomar o trabalho

Pontos de entrada confirmados, para o próximo corte não depender desta conversa:

- leitura/paginação de holders: `src/models/robinhood-holder-page.js`;
- rota pública: `src/routes/robinhood-holders.js`;
- swaps e primeira compra: `src/models/robinhood-wallet-swap-read.js` e tabela
  `robinhood_wallet_swaps`;
- criador/deployer: `src/models/robinhood-token-attribution.js` e tabela
  `robinhood_token_attributions`;
- pools/LP: `src/models/robinhood-persistence.js` e tabela
  `robinhood_pool_registry`;
- transfer graph: `src/models/robinhood-wallet-transfer-projection.js` e tabela
  `robinhood_wallet_transfer_edges`;
- contrato frontend: `frontend/src/services/api/robinhood-holders.ts`;
- renderização da lista: `frontend/src/ui/robinhood-expanded-holders.ts`;
- tooltip de holder: `frontend/src/ui/robinhood-holder-hover.ts`;
- testes-base de rota e leitura: `tests/robinhood-holders-route.test.js` e
  `tests/robinhood-holder-page.integration.test.js`;
- testes-base de transfers: `tests/robinhood-wallet-transfer-projection.integration.test.js`.

Antes do primeiro corte, conferir `docs/bot-reference.md`, `git status` e o
schema efetivamente implantado. Este documento define intenção e contratos; a
referência operacional continua sendo a fonte do estado em produção.

## 1. Resumo executivo da fundação financeira

Esta seção registra a arquitetura que originou a fundação financeira. Em
2026-08-21, o painel já entrega `Remaining`, volumes de compra/venda, market caps
médios e `U. PnL`; valores indisponíveis continuam explícitos. Os dados vêm de
três fontes independentes:

1. o ledger de holders fornece o saldo ERC-20 atual por token e wallet;
2. `robinhood_wallet_swaps` fornece compras e vendas atribuídas a `tx.from`;
3. eventos ERC-20 `Transfer` e arestas resumidas preservam origem, destino,
   quantidade e relações relevantes conforme a política de retenção.

A arquitetura alvo deve manter:

- transfers brutos particionados por dia durante 30 dias;
- um resumo permanente das relações entre wallets;
- uma posição financeira permanente por token e wallet;
- evidências mínimas que permitam explicar cada relação sinalizada;
- uma projeção incremental e idempotente, nunca uma agregação síncrona das
  centenas de milhões de swaps quando a tela for aberta.

O comportamento financeiro aprovado segue a convenção observada na Axiom:
tokens recebidos sem compra conhecida entram com custo presumido zero. Se uma
wallet tem $46,6 mil do token, nenhuma compra e nenhuma venda, `U. PnL` mostra
`+$46,6K`, enquanto `Avg Buy` e `Avg Sell` mostram zero.

Essa convenção é útil para análise por wallet, mas não representa prova do custo
econômico original. A API e a UI devem expor a procedência da estimativa.

## 2. Objetivos

### 2.1 Superfície de holders

Preencher para holders Robinhood:

- `ETH Bal`: saldo nativo atual da wallet;
- `Avg Buy`: market cap médio de compra, quantidade de transações e USD gasto;
- `Avg Sell`: market cap médio de saída, quantidade de transações e PnL
  realizado em USD;
- `U. PnL`: PnL não realizado sobre o saldo restante;
- `Remaining`: valor atual e participação no supply, preservando o cálculo
  existente.

### 2.2 Inteligência de transfers

Adicionar uma superfície semelhante à aba `Transfers` da referência visual:

- direção `In`/`Out` relativa à wallet analisada;
- valor e quantidade do token;
- origem e destino;
- idade/data;
- link para o explorer;
- paginação por cursor;
- somente os 30 dias brutos retidos.

### 2.3 Relações e bundles

Preservar além dos 30 dias um grafo resumido capaz de identificar:

- uma origem distribuindo tokens para várias wallets;
- holders financiados pela mesma wallet;
- transfer recebido antes da primeira compra;
- transfers e compras em uma janela curta;
- circulação entre wallets relacionadas;
- relações com deployer, pool, router ou contratos conhecidos;
- concentração distribuída artificialmente entre várias wallets.

Os resultados devem ser descritos como `linked`, `common funder`, `possible
bundle` ou equivalentes. Uma conexão on-chain não prova que duas wallets possuem
o mesmo dono.

## 3. Fora de escopo inicial

- afirmar identidade humana comum entre wallets;
- score definitivo de fraude ou bloqueio automático de tokens;
- alertas Telegram baseados em bundles no primeiro rollout;
- histórico bruto ilimitado de todos os transfers;
- reconstrução de transfers internos de ETH sem RPC com traces;
- suporte multichain no primeiro projeto;
- alterar o cálculo já existente de `Remaining` sem uma auditoria específica;
- colocar consultas RPC ou agregações pesadas no caminho crítico de chart,
  trades, alertas ou ingestão de mercado.

## 4. Decisões de produto fechadas

1. O projeto começa somente na chain `robinhood`.
2. `Avg Buy` e `Avg Sell` representam market cap médio, não preço unitário.
3. A média é ponderada pelo volume USD para evitar que dust trades tenham o
   mesmo peso de operações economicamente relevantes.
4. Quantidade de compras/vendas significa transações distintas:
   `COUNT(DISTINCT transaction_hash)`, não número de ações/logs.
5. Tokens recebidos sem compra atribuída entram com custo presumido zero.
6. Uma venda de inventário com custo zero produz ganho realizado igual ao valor
   vendido.
7. Um transfer de saída remove quantidade e custo proporcional, sem realizar
   PnL.
8. O custo das posições compradas usa média móvel proporcional.
9. `U. PnL` é valor atual restante menos custo restante.
10. Sem compra conhecida, `U. PnL` pode ser igual ao valor atual total positivo.
11. A API deve distinguir valor confirmado, valor estimado e valor indisponível.
12. `null` significa indisponível; zero significa zero observado/calculado.
13. Transfers brutos são retidos por 30 dias.
14. Relações resumidas, evidências selecionadas e estado financeiro são
    permanentes.
15. O histórico antigo será reprocessado diretamente para os resumos, sem
    materializar todo o passado na tabela bruta.
16. Pools, burn addresses, routers e contratos não podem ser tratados como
    wallets comuns no score de bundle.
17. Falha da inteligência de wallet não pode derrubar a lista básica de holders.
18. A tela deve renderizar holders primeiro e hidratar as métricas depois.
19. O raw ERC-20 guarda somente tokens admitidos ao catálogo/ledger de
    inteligência Robinhood; a estimativa global de 1,9 GB/dia é upper bound, não
    autorização para persistir indiscriminadamente todos os contratos da chain.

## 5. Estado atual confirmado no código

### 5.1 Frontend

`frontend/src/ui/robinhood-expanded-holders.ts`:

- renderiza explicitamente quatro placeholders;
- calcula `Remaining` como `balanceRaw / totalSupplyRaw * fdv`;
- mostra valor USD e percentual do supply;
- carrega 50 holders por página e mantém uma pilha local de cursores;
- não possui contrato para métricas financeiras ou saldo nativo.

`frontend/src/services/api/robinhood-holders.ts` entrega por holder apenas:

- rank;
- endereço;
- saldo bruto do token;
- tipo do endereço;
- label;
- indicador de contrato verificado.

### 5.2 Lista e ledger de holders

`src/models/robinhood-holder-page.js` lê
`robinhood_holder_balances` por token, ordenando saldo decrescente e endereço
crescente. O ledger contém o saldo ERC-20 atual, mas não custo, PnL ou histórico
de contrapartes.

O caminho local identifica apenas burn address canônico e pools conhecidos. Os
demais endereços podem permanecer `unknown`; não se deve concluir que todo
`unknown` é uma EOA.

### 5.3 Swaps atribuídos por wallet

`robinhood_wallet_swaps` contém aproximadamente 426 milhões de linhas e guarda:

- `wallet_address = tx.from`;
- token e quote;
- side `buy`/`sell`;
- quantidades;
- `price_usd` e `volume_usd`;
- bloco, horário, transação e action/log index;
- protocolo e mercado.

Os índices atuais favorecem leituras recentes por token ou wallet. Eles não
justificam recalcular a posição histórica de 50 holders a cada request.

`wallet_swaps.price_usd` possui um risco histórico conhecido: parte dos valores
foi cristalizada antes da correção de preço. Para médias de market cap, a fonte
preferida deve ser `robinhood_swap_mc`, que contém FDV corrigido por swap e
supply observado.

As colunas `router_address` e `recipient_address` existem no schema de swaps,
mas o caminho real em `robinhood-wallet-swap-attributor.js` não as preenche.
Antes de classificar transfers associados a swaps, essa proveniência precisa ser
recuperada ou substituída por uma regra comprovada baseada nos logs da mesma
transação.

### 5.4 Provider de saldo

`src/services/token-balance-provider.js` é exclusivo de Solana/Helius e consulta
saldo de SPL token. Ele não fornece saldo nativo EVM.

O repositório já possui `createEvmJsonRpcClient`, incluindo requests JSON-RPC em
lote. `ETH Bal` deve usar um adapter Robinhood específico baseado em
`eth_getBalance`, com cache, timeout e degradação por wallet/lote.

### 5.5 Transfers ERC-20

`robinhood_holder_transfer_journal` já modela:

- bloco e hash do bloco;
- transação, transaction index e log index;
- token;
- origem e destino;
- quantidade bruta;
- balances antes/depois para rollback;
- estado de aplicação.

Esse journal não é histórico permanente:

- a retenção default é 20.000 blocos;
- eventos aplicados abaixo do cutoff são removidos em lotes;
- o objetivo é deduplicação e rollback de reorg.

O backfill global lê `Transfer` desde o bloco zero, mas consolida os eventos
diretamente em `robinhood_holder_balances` e counts. Ele não grava o histórico
bruto completo.

Consequência: o saldo histórico foi reconstruído, mas as arestas antigas
`from -> to` precisam ser lidas novamente da chain para formar o grafo.

### 5.6 Medição existente de armazenamento

Uma amostra real de 2.000 blocos encontrou:

- 20.186 eventos globais;
- 417 tokens;
- 5.920 pares token-wallet;
- projeção de aproximadamente 1,9 GB de journal por dia de chain time.

Na ordem de grandeza atual:

- baseline histórico do journal: aproximadamente 1,9 GB/dia;
- upper bound chain-wide medido no preflight A0 de 2026-08-14:
  aproximadamente 3,93 GB/dia;
- 30 dias brutos no upper bound atual: aproximadamente 118 GB, antes de
  índices/WAL;
- 90 dias brutos no upper bound atual: aproximadamente 354 GB;
- um ano bruto no upper bound atual: aproximadamente 1,43 TB.

Esses valores representam projeções globais e funcionam como upper bounds. O
preflight atual mediu densidade maior que a amostra histórica; portanto, 57 GB
não é mais uma estimativa segura para provisionar 30 dias. O escopo elegível do
produto deve ser medido separadamente na VPS e deve ser significativamente menor
que chain-wide. Os valores não substituem a auditoria do schema estreito
proposto; índices, WAL, autovacuum, backups e margem operacional precisam ser
medidos antes do rollout.

## 6. Semântica financeira

### 6.1 Valor atual

O valor atual de uma posição continua sendo:

```text
currentFraction = holderBalanceRaw / totalSupplyRaw
currentValueUsd = currentFraction * currentFdvUsd
```

O cálculo deve permanecer decimal-safe no backend. O uso de `Number(BigInt)` no
frontend atual é suficiente para apresentação aproximada, mas a projeção
financeira não deve depender dessa conversão.

### 6.2 Market cap médio de compra

```text
avgBuyMcapUsd = sum(buyMcapUsd * buyVolumeUsd) / sum(buyVolumeUsd)
buyTxCount = count(distinct buyTransactionHash)
buyVolumeUsd = sum(buyVolumeUsd)
```

Se não houver compra válida:

```text
avgBuyMcapUsd = 0
buyTxCount = 0
buyVolumeUsd = 0
```

### 6.3 Market cap médio de saída

```text
avgSellMcapUsd = sum(sellMcapUsd * sellVolumeUsd) / sum(sellVolumeUsd)
sellTxCount = count(distinct sellTransactionHash)
sellProceedsUsd = sum(sellVolumeUsd)
```

O valor USD ganho ou perdido nas vendas é o PnL realizado:

```text
realizedPnlUsd = sum(sellProceedsUsd - costBasisSoldUsd)
```

### 6.4 Média móvel de custo

Em uma compra:

```text
newQuantity = oldQuantity + boughtQuantity
newCostBasis = oldCostBasis + buyVolumeUsd
avgCostUsd = newCostBasis / newQuantity
```

Em uma venda:

```text
sellRatio = soldQuantity / oldQuantity
costBasisSold = oldCostBasis * sellRatio
remainingCostBasis = oldCostBasis - costBasisSold
realizedPnl = sellProceeds - costBasisSold
```

### 6.5 Transfer recebido

Um transfer recebido fora do fluxo econômico do próprio swap segue a decisão de
produto:

```text
newQuantity = oldQuantity + transferredQuantity
newCostBasis = oldCostBasis
assumedZeroCostReceived += transferredQuantity
```

Se a wallet não possui compras, o saldo recebido inteiro permanece com custo
zero.

### 6.6 Transfer enviado

```text
transferRatio = transferredQuantity / oldQuantity
costBasisMoved = oldCostBasis * transferRatio
remainingQuantity = oldQuantity - transferredQuantity
remainingCostBasis = oldCostBasis - costBasisMoved
```

O envio não realiza PnL. Pela convenção aprovada, o destino recebe o token com
custo presumido zero; o custo não é propagado entre wallets na métrica exibida.

### 6.7 U. PnL

```text
unrealizedPnlUsd = currentValueUsd - remainingCostBasisUsd
unrealizedPnlPct = remainingCostBasisUsd > 0
  ? unrealizedPnlUsd / remainingCostBasisUsd * 100
  : null
```

Quando `remainingCostBasisUsd = 0` e há saldo:

- `unrealizedPnlUsd = currentValueUsd`;
- o percentual não deve ser infinito;
- a UI mostra valor USD positivo e pode exibir `—` para percentual;
- `costBasisSource = transferred_assumed_zero` explica a convenção.

### 6.8 Venda sem compra

Quando uma wallet vende mais tokens do que sua quantidade comprada projetada,
o excesso é tratado como inventário recebido com custo zero:

```text
zeroCostSold = max(0, soldQuantity - costedQuantityAvailable)
realizedPnlFromZeroCost = proceedsAllocatedToZeroCostSold
```

Essa regra reproduz o comportamento esperado, mas precisa ser marcada como
estimativa.

### 6.9 Qualidade e procedência

Cada posição deve expor uma das categorias:

- `exact_swap_only`: saldo e posição explicados somente por swaps;
- `transfer_adjusted`: transfers classificados foram incorporados;
- `transferred_assumed_zero`: existe inventário recebido com custo zero;
- `partial_history`: a projeção não cobre toda a vida do token/wallet;
- `reconciliation_mismatch`: saldo projetado diverge do ledger;
- `unavailable`: fonte ou cálculo indisponível.

`reconciliation_mismatch` não deve virar zero. O backend retorna métricas
financeiras nulas ou explicitamente estimadas, preservando o saldo do holder.

### 6.10 Tipos de endereço

- burn: não recebe métricas de trading/PnL;
- pool: não recebe PnL de wallet e não entra em score de bundle;
- router: não recebe PnL de wallet e não entra em score de bundle;
- contrato verificado: métricas somente quando a semântica for conhecida;
- wallet: métricas completas;
- unknown: métricas podem ser calculadas, mas com tipo/procedência explícitos.

Sem essa filtragem, pools apareceriam com `U. PnL` enorme e custo zero, produzindo
um resultado visualmente convincente, porém incorreto.

### 6.11 Ordem canônica de swaps e transfers

PnL depende da ordem dos eventos. Não é correto processar todo o histórico de
swaps e depois aplicar transfers antigos sobre a posição final.

A projeção definitiva deve:

1. classificar e remover do fluxo financeiro os transfers que pertencem ao
   próprio swap;
2. unir swaps e `wallet_transfer` restantes;
3. ordenar por bloco e log index canônico;
4. aplicar a máquina financeira em uma única sequência;
5. avançar posição e cursor na mesma transação.

O log index EVM ordena logs dentro do bloco. Quando uma fonte não possuir log
index utilizável, transaction index deve participar da chave de ordem e a
evidência ambígua não pode ser aplicada silenciosamente.

A projeção swap-only dos primeiros cortes é provisória e versionada. Quando os
transfers forem incorporados, uma nova versão deve ser reconstruída do zero em
shadow pelo replay unificado; não atualizar posições antigas fora de ordem.

## 7. Classificação de transfers

Todo `Transfer` bruto deve receber uma classificação derivada, sem alterar a
evidência original:

- `mint`: origem zero;
- `burn`: destino zero/dead;
- `dex_flow`: movimento pertencente a compra/venda conhecida;
- `liquidity_flow`: pool, LP ou liquidez;
- `router_flow`: passagem técnica por router;
- `wallet_transfer`: transferência econômica provável entre wallets;
- `contract_flow`: contrato não classificado como pool/router;
- `unknown`: evidência insuficiente.

Somente `wallet_transfer` deve alterar a posição como transfer de custo zero e
alimentar diretamente sinais de bundle. As demais classes continuam consultáveis
na aba `Transfers`, mas não devem gerar conclusões de wallet connection sem outra
evidência.

### 7.1 Evitar dupla contagem com swaps

Um swap pode emitir vários `Transfer` na mesma transação. Somar o swap e todos
esses transfers duplicaria quantidade e custo.

A classificação deve correlacionar por:

- chain;
- transaction hash;
- token;
- ordem por block/log index;
- wallet atribuída (`tx.from`);
- pools/routers conhecidos;
- quantidades compatíveis;
- recipient, quando comprovadamente disponível.

Casos ambíguos ficam `unknown` e não alteram automaticamente a posição.

## 8. Arquitetura alvo

```text
Robinhood RPC / logs
  -> captura ERC-20 Transfer
  -> evidência bruta particionada (30 dias)
  -> classificador de transfer
       -> projeção financeira permanente
       -> resumo permanente de arestas
       -> evidências selecionadas

robinhood_wallet_swaps + robinhood_swap_mc
  + wallet_transfer classificado
  -> projetor cronológico unificado
       -> projeção financeira permanente
       -> estatísticas Avg Buy / Avg Sell / PnL

holder ledger + current FDV
  -> reconciliação e Current Value / U. PnL

eth_getBalance em lote
  -> cache curto
  -> ETH Bal opcional

REST de holders (rápido)
  + REST de inteligência (degradação independente)
  -> hidratação progressiva no frontend
```

O classificador, o projetor financeiro e o grafo devem ser módulos de domínio
isolados. `server.js`, `config/index.js` e outros hubs recebem somente wiring.

## 9. Modelo de dados conceitual

A fundação de posição canônica usa a Stage 139; stages posteriores continuam
sendo escolhidas somente no início do respectivo corte.

### 9.0 Posição canônica das transações de swap

A Stage 139 cria `robinhood_transaction_positions`, sidecar estreita por
`(chain, transaction_hash)` com bloco, hash canônico e `transaction_index`.
Ela evita reescrever o acervo de `robinhood_wallet_swaps`. Seed e LIVE gravam a
posição antes do swap usando o mesmo full-block já consultado; falha da sidecar
impede o avanço do cursor. No catch-up histórico, somente hashes ainda ausentes
na sidecar são resolvidos pelo archive do PC; o dry-run mantém a resolução em
memória e o modo confirmado persiste antes de avançar a posição unificada.

### 9.1 `robinhood_token_transfer_events`

Evidência bruta com retenção de 30 dias, particionada por `block_time` UTC:

```text
chain
block_number
block_hash
block_time
transaction_hash
transaction_index
log_index
token_address
from_wallet
to_wallet
amount_raw
transfer_kind
classification_version
created_at
```

Identidade:

```text
PRIMARY KEY (chain, transaction_hash, log_index, block_time)
```

Índices mínimos, validados por `EXPLAIN` antes de adicionar outros:

- `(chain, token_address, block_time DESC)`;
- `(chain, from_wallet, block_time DESC)`;
- `(chain, to_wallet, block_time DESC)`;
- BRIN em `block_time` pode ser avaliado nas partições maiores.

Evitar copiar balances antes/depois, flags de apply e proveniência de rollback do
journal atual. A tabela bruta de produto deve ser estreita.

### 9.2 `robinhood_wallet_token_positions`

Estado financeiro permanente:

```text
chain
token_address
wallet_address
quantity_raw
cost_basis_usd
realized_pnl_usd
buy_volume_usd
sell_proceeds_usd
buy_mcap_weighted_sum
buy_mcap_weight_usd
sell_mcap_weighted_sum
sell_mcap_weight_usd
buy_tx_count
sell_tx_count
zero_cost_received_raw
zero_cost_sold_raw
cost_basis_source
quality
through_block
through_log_index
projection_version
created_at
updated_at
```

Chave:

```text
PRIMARY KEY (chain, projection_version, token_address, wallet_address)
```

Isso permite manter `swap_only_v1` e uma futura projeção unificada em shadow ao
mesmo tempo, sem sobrescrever a versão ativa antes da validação e do cutover.

Contagem de transações distintas não pode ser mantida com `count += rows` em um
retry. O projetor precisa de deduplicação por evento/transaction ou de uma
projeção idempotente com cursor e fonte imutável.

### 9.3 `robinhood_wallet_transfer_edges`

Resumo permanente por token e par direcionado:

```text
chain
token_address
from_wallet
to_wallet
transfer_count
total_amount_raw
first_block
first_seen_at
first_transaction_hash
last_block
last_seen_at
last_transaction_hash
largest_amount_raw
largest_transaction_hash
wallet_transfer_count
dex_flow_count
classification_version
updated_at
```

Chave:

```text
PRIMARY KEY (chain, token_address, from_wallet, to_wallet)
```

### 9.4 `robinhood_wallet_relationship_evidence`

Evidências permanentes e limitadas para relações materializadas:

```text
chain
token_address nullable
left_wallet
right_wallet
relationship_kind
evidence_transaction_hash
evidence_block
evidence_at
amount_raw nullable
score_component
algorithm_version
created_at
```

Não copiar todos os transfers. Preservar somente evidências necessárias para
explicar a relação: primeira, maior, última e as que dispararam sinais temporais
relevantes.

### 9.5 Cursor e watermark da projeção

O projetor deve guardar:

- próxima posição on-chain;
- checkpoint de bloco;
- versão do algoritmo;
- último dia bruto completamente resumido;
- estado `pending/running/complete/failed` para backfill;
- erro resumido e timestamps operacionais.

O cursor precisa avançar na mesma transação que atualiza posição, arestas e
evidências.

## 10. Retenção e compactação

### 10.1 Janela bruta

- 30 dias completos mais a partição UTC corrente;
- partições diárias;
- expiração por `DROP TABLE/PARTITION`, nunca `DELETE` linha a linha;
- nenhuma partição é removida enquanto houver risco de reorg, projeção pendente
  ou reconciliação incompleta.

### 10.2 Invariante de compactação

Uma partição só pode ser removida quando:

1. todos os eventos da partição foram classificados;
2. posição financeira e arestas foram atualizadas;
3. evidências relevantes foram preservadas;
4. count e soma de amount do resumo reconciliam com a partição;
5. o cursor durável está além do fim da partição;
6. o checkpoint canônico foi validado;
7. o watermark de compactação foi commitado.

Qualquer dúvida preserva a partição e gera estado degradado; nunca avançar o
watermark para liberar espaço após uma falha parcial.

### 10.3 Histórico anterior aos 30 dias

O backfill histórico deve:

1. reusar o reader global de `Transfer`;
2. ler ranges limitados com checkpoint;
3. classificar e aplicar em ordem;
4. gravar somente posição, aresta e evidências selecionadas para eventos antigos;
5. gravar também o bruto quando o evento estiver dentro da janela atual de 30
   dias;
6. avançar cursor somente após commit atômico;
7. não competir com live holders, swaps, chart, alertas ou candles.

Isso recupera o grafo histórico sem materializar centenas de gigabytes de bruto
antigo.

## 11. Sinais de relação e possible bundle

O primeiro rollout deve produzir componentes explicáveis, não um score mágico.

### 11.1 Sinais básicos

- `direct_token_transfer`: A enviou o token diretamente para B;
- `common_token_source`: A enviou o mesmo token para B e C;
- `pre_buy_funding`: B recebeu o token antes da primeira compra;
- `same_block_buy`: wallets relacionadas compraram no mesmo bloco;
- `short_window_buy`: wallets relacionadas compraram dentro de uma janela curta;
- `deployer_distribution`: origem coincide com criador atribuído;
- `circular_flow`: token retorna à origem dentro da janela;
- `split_concentration`: uma origem distribui supply entre muitos holders atuais.

### 11.2 Filtros obrigatórios

- remover zero/dead address de relações entre wallets;
- identificar pools conhecidos;
- identificar routers conhecidos;
- não contar mint como financiamento;
- não contar `dex_flow` como transfer entre wallets;
- limitar fan-out técnico de contratos;
- exigir evidência temporal e/ou econômica adicional para `possible_bundle`.

### 11.3 Resultado público

Exemplo conceitual:

```json
{
  "kind": "possible_bundle",
  "score": 0.82,
  "signals": ["common_token_source", "short_window_buy"],
  "evidence": [
    { "transactionHash": "0x...", "blockNumber": 123 }
  ],
  "disclaimer": "On-chain relationship; ownership is not proven"
}
```

Os thresholds e pesos permanecem configuração/versionamento de domínio e exigem
auditoria antes de uso em qualquer regra de bloqueio.

## 12. Funding em ETH

ERC-20 `Transfer` identifica distribuição do token, mas não uma wallet enviando
ETH para várias compradoras.

### 12.1 Transfers nativos diretos

Blocos completos permitem observar transações com:

- `from`;
- `to`;
- `value`;
- transaction index;
- bloco e timestamp.

Uma fase posterior pode manter raw de 30 dias e resumo permanente de arestas
nativas, seguindo a mesma política de retenção.

### 12.2 Transfers internos

Transfers internos exigem traces. O RPC público Robinhood validado anteriormente
não expõe `debug_traceTransaction` nem `trace_transaction`.

Portanto:

- funding direto pode ser implementado sem traces;
- funding interno deve permanecer `unavailable` até existir provider/node
  trace-enabled;
- ausência de trace não pode ser interpretada como ausência de relação.

## 13. Contratos de API

### 13.1 Lista básica de holders

`GET /api/robinhood/holders` continua sendo o bootstrap rápido. Não deve aguardar
RPC de saldo nativo nem projeção/backfill.

### 13.2 Inteligência da página

Endpoint proposto:

```text
POST /api/robinhood/holder-intelligence
```

Request limitado:

```json
{
  "token": "0x...",
  "wallets": ["0x..."]
}
```

Regras:

- autenticação e visibility Robinhood existentes;
- máximo de 50 wallets;
- endereços normalizados e deduplicados;
- o backend não aceita chain arbitrária;
- métricas ausentes retornam `null`, não causam 503 da lista de holders;
- saldo nativo possui freshness/provider próprios;
- current FDV é resolvido no backend pela fonte de mercado vigente; o cliente
  não define a source of truth da valoração.

Resposta conceitual:

```json
{
  "token": "0x...",
  "throughBlock": 123,
  "wallets": {
    "0x...": {
      "nativeBalanceWei": "123",
      "nativeBalanceEth": "0.000000000000000123",
      "avgBuyMcapUsd": 100000,
      "buyTxCount": 2,
      "buyVolumeUsd": 400,
      "avgSellMcapUsd": 180000,
      "sellTxCount": 1,
      "sellProceedsUsd": 300,
      "realizedPnlUsd": 120,
      "unrealizedPnlUsd": 46600,
      "unrealizedPnlPct": null,
      "quality": "transferred_assumed_zero",
      "observedAt": "2026-08-14T00:00:00.000Z"
    }
  }
}
```

### 13.3 Transfers brutos

Endpoint proposto:

```text
GET /api/robinhood/wallet-transfers?token=0x...&wallet=0x...&cursor=...
```

- keyset pagination;
- no máximo 50 itens;
- somente janela bruta disponível;
- direção relativa à wallet;
- cursor opaco;
- resposta informa `rawAvailableFrom`.

### 13.4 Relações resumidas

Endpoint proposto:

```text
GET /api/robinhood/wallet-links?token=0x...&wallet=0x...&cursor=...
```

Retorna relações permanentes, sinais, evidências e disclaimer. Essa rota não
promete cada transfer bruto antigo.

## 14. Frontend alvo

### 14.1 Tabela de holders

Renderização progressiva:

1. carregar e mostrar holders/Remaining;
2. solicitar inteligência para as wallets da página;
3. preencher células individualmente;
4. preservar `—` para indisponível;
5. exibir zero somente quando confirmado;
6. não limpar dados válidos se refresh parcial falhar.

Apresentação sugerida:

- `ETH Bal`: valor ETH, tooltip com bloco/freshness;
- `Avg Buy`: MC principal; abaixo `tx count / USD spent`;
- `Avg Sell`: MC principal; abaixo `tx count / realized PnL`;
- `U. PnL`: USD com cor; tooltip com custo e procedência;
- `Remaining`: comportamento atual.

`transferred_assumed_zero` deve ter tooltip ou indicador discreto: “Cost basis
assumed zero for transferred tokens”.

### 14.2 Aba Transfers

Para a wallet selecionada:

- `In`/`Out`;
- token/amount;
- `From` e `To`;
- idade;
- explorer;
- filtro por classificação;
- loading, empty, error e retry;
- aviso da janela bruta de 30 dias.

### 14.3 Relações antigas

Quando o evento bruto expirou:

- mostrar relação agregada, não inventar lista de eventos;
- informar first/last seen e transfer count;
- permitir abrir evidências preservadas;
- distinguir `summary` de `raw`.

## 15. Worker e isolamento operacional

Este projeto é um architecture checkpoint:

- estimativa superior a 12 arquivos de produção;
- schema e retenção novos;
- domínio financeiro e domínio de grafo;
- fan-out para RPC, workers, API e frontend.

Criar um grupo isolado, nome provisório
`robinhood-wallet-classification`, em vez de adicionar trabalho pesado aos grupos
de holders ou mercado.

Responsabilidades:

- capturar/projetar transfers live;
- projetar novos swaps;
- executar backfill histórico sob lease própria;
- compactar partições;
- reconciliar posição com holder ledger;
- publicar somente eventos de invalidação/refresh necessários.

Nenhuma falha desse grupo pode atrasar:

- `robinhood-wallet` attribution;
- `robinhood-holders` live/apply;
- market ingestion;
- chart/trades;
- alertas ou Telegram.

## 16. Auditorias obrigatórias antes do schema

### 16.1 Cobertura financeira

Medir por ranges antigo e recente:

- cobertura de `volume_usd`;
- cobertura do sidecar `robinhood_swap_mc`;
- divergência entre net swaps e holder balance;
- frequência de vendas acima da quantidade comprada;
- quantidade de wallets com apenas transfer-in;
- estado dos cursores seed/live de wallet swaps.

### 16.2 Transfers e classificação

Medir:

- eventos/dia;
- pares únicos `(token, from, to)`;
- razão eventos/aresta;
- fan-out p50/p95/p99;
- proporção mint/burn/pool/router/wallet/unknown;
- transfers na mesma transação de um swap;
- percentual classificável sem recipient preenchido;
- crescimento estimado da tabela estreita e de cada índice.

### 16.3 Capacidade

- espaço livre real;
- tamanho atual de swaps, holder balances e journal;
- WAL/dia durante carga semelhante;
- tempo de criação de partição/índice;
- latência p95 de insert e consultas por wallet;
- impacto do backfill no lag dos workers live.

O resultado da auditoria pode reduzir ou aumentar escopo. Crescimento superior a
20%, dependência de traces ou novo subsistema exige novo checkpoint antes de
editar.

### 16.4 Preflight A0 local de 2026-08-14

O preflight foi executado sem escrita, usando transação PostgreSQL `READ ONLY`,
`statement_timeout` de 30 segundos, amostras limitadas e o probe RPC existente.

#### PostgreSQL local

O banco local não representa a VPS de produção:

- `token_catalog` possui zero tokens Robinhood;
- não há rows em `robinhood_wallet_swaps`, `robinhood_swap_mc`, holder balances,
  holder states ou journals;
- não há cursores seed/live de wallet swaps ou holders;
- a Stage 118 está presente (`journal_floor_block` existe);
- a Stage 122 não está aplicada (`lifecycle_state`, `completed_at` e
  `abandoned_at` não existem).

Consequências:

- cobertura histórica de volume/MC não pôde ser medida localmente;
- divergência net swaps versus holder balance não pôde ser medida;
- o rollout deve validar/aplicar migrations pendentes antes de iniciar qualquer
  novo worker;
- nenhuma conclusão de capacidade da VPS pode usar os tamanhos do banco local.

#### RPC Robinhood chain-wide

Amostra recente:

- range: blocos 36.432.773–36.433.272;
- 500 blocos em 50 segundos de chain time;
- 10.332 transfers ERC-20 válidos;
- 1.765 logs com o mesmo tópico que não passaram pelo formato ERC-20 esperado;
- 252 tokens e 3.945 wallets;
- 6.219 pares token-wallet tocados;
- 743 mints e 494 burns;
- duas chamadas `eth_getLogs`, sem split, range de 250 blocos por chamada;
- projeção chain-wide de aproximadamente 17,85 milhões de eventos válidos/dia;
- upper bound de tail: aproximadamente 3,93 GB/dia com 220 bytes/evento;
- upper bound bruto de 30 dias: aproximadamente 118 GB antes de índices/WAL.

Os logs malformados são chain-wide e podem incluir padrões `Transfer` que não são
ERC-20; não devem ser interpretados automaticamente como defeito de tokens
elegíveis. A amostra curta e recente também não é SLA para o scan histórico.

#### Pendências para concluir A0

Executar na VPS, ainda read-only:

1. o mesmo probe limitado ao catálogo elegível;
2. cobertura de `volume_usd` e `robinhood_swap_mc` em ranges antigo/recente;
3. tamanhos reais, partições, WAL e espaço livre;
4. cursores seed/live e frontier;
5. razão evento/aresta `(token, from, to)`;
6. proporção de transfers correlacionados a swaps;
7. `EXPLAIN` das queries candidatas.

Nenhum corte de schema deve começar antes dessas medições.

## 17. Plano de implementação em cortes

Estimativa inicial: 4.800–6.400 linhas de código/testes, mais documentação. A
estimativa será recalibrada depois da auditoria. Cada corte altera no máximo 500
linhas e termina com validação, revisão integral do diff, commit e nova
autorização.

### Corte A0 — auditoria read-only

Status: preflight local concluído; medições definitivas na VPS pendentes.

Objetivo:

- produzir medições da seção 16;
- validar queries com `EXPLAIN`, sem criar índices;
- confirmar a disponibilidade dos dados necessários;
- fechar o dimensionamento do schema.

Possíveis arquivos:

- utilitário read-only isolado em `src/utils/`;
- teste unitário apenas para normalização/relatório, se houver lógica relevante;
- atualização deste plano com resultados duráveis.

Validação:

- `npm run lint`;
- teste focal do utilitário, se criado;
- dry-run com range pequeno;
- nenhuma escrita no banco.

### Corte A1 — domínio financeiro puro

Status: concluído.

Objetivo:

- implementar a máquina de estado de compra, venda, transfer-in e transfer-out;
- definir média móvel, PnL e qualidade;
- cobrir custo zero, oversell, zero balance e precisão decimal.

Arquivos previstos:

- novo serviço de domínio isolado;
- teste unitário table-driven.

Sem schema, rota, worker ou frontend.

### Corte A2 — schema de posição e cursor

Status: concluído com schema versionado no Stage 126 e persistência transacional.

Objetivo:

- criar posição permanente e cursor da projeção;
- registrar runtime schema;
- criar repository transacional mínimo.

Validação:

- `npm run lint`;
- testes focais de schema/repository;
- integração PostgreSQL;
- `npm run db:schema-check`;
- revisão dos planos de rollback.

### Corte A3 — projeção histórica de swaps

Status: concluído com backfill `swap_only_v1` dry-run-first e Stage 127 para
leitura particionada.

Objetivo:

- ler swaps em ordem;
- usar MC corrigido do sidecar;
- aplicar estado financeiro idempotentemente;
- manter buy/sell tx counts sem duplicação;
- backfill dry-run-first.

Não incluir transfers neste corte. A posição permanece `swap_only`, em shadow,
e será reconstruída por replay unificado quando a classificação de transfers
estiver pronta; este corte não define o estado financeiro final.

### Corte A4 — projeção live de swaps e reconciliação

Status: concluído em shadow com grupo isolado e reconciliação conservadora.

Objetivo:

- acompanhar o frontier live;
- atualizar posições depois de persistência durável do swap;
- reconciliar quantidade projetada com o holder ledger;
- expor telemetria e estados degradados.

O worker usa somente o frontier durável de `robinhood_wallet_swap_cursors.live`,
faz handoff após o seed da posição estar `complete` e permanece opt-in. A
reconciliação só compara saldos quando o holder ledger está exatamente no mesmo
bloco da projeção. Divergências continuam como telemetria provisória até o replay
unificado incluir transfers; não degradam permanentemente a qualidade persistida.

### Corte B1 — schema bruto de transfers

Status: concluído como fundação de persistência, sem writer ativo ou retenção.

Objetivo:

- criar tabela particionada estreita;
- repository idempotente;
- partições diárias;
- índices mínimos aprovados pelo A0;
- contrato de 30 dias sem ligar retenção.

A Stage 128 mantém evidência on-chain imutável em partições UTC diárias. Novos
eventos entram como `unclassified`; a classificação versionada será preenchida
no B2. O contrato de 30 dias está explícito no repository, mas nenhuma partição
é removida antes dos gates de compactação e checkpoint existirem.

Validação inclui schema check e integração em fronteira de partição.

### Corte B2 — classificador de transfers

Status: concluído como domínio puro, explicável e fail-closed.

Objetivo:

- classificar mint, burn, pool, router, DEX, wallet e unknown;
- correlacionar swap/transfer na mesma transação;
- impedir dupla contagem;
- manter decisão explicável/versionada.

Somente domínio e testes unitários; sem worker.

A versão `rh_transfer_v1` só produz `wallet_transfer` quando ambos os endpoints
são wallets comprovadas e a cobertura de swaps da transação está confirmada.
Correlação DEX ambígua vira `unknown`, e fluxos de pool, router e contrato
dependem de papéis fornecidos pelo futuro adapter B4.

### Corte B3 — arestas e evidências permanentes

Status: concluído. B3a criou o schema versionado, B3b1 adicionou frontiers exatos
de log e B3b2 implementou o commit transacional.

Objetivo:

- criar resumo por `(token, from, to)`;
- preservar primeira/última/maior evidência;
- preparar o stream classificado consumido pelo replay financeiro unificado;
- cursor e commit atômicos.

Não aplicar transfers históricos diretamente sobre a posição swap-only já
materializada.

A Stage 129 permite versões de classificação coexistirem em shadow, limita
evidências aos papéis `first`, `largest`, `last` e `temporal`, e mantém cursor
on-chain mais watermark diário. A Stage 130 acrescenta `log_index` às fronteiras
primeira, última e maior para ordenar transfers do mesmo bloco sem depender do
raw após a compactação. Nenhum writer é ativado nesses subcortes.

O repository do B3b2 bloqueia o cursor antes de resumir somente
`wallet_transfer`/`dex_flow`, rejeita overlap e writer obsoleto, e grava arestas,
evidências limitadas e cursor na mesma transação. Ainda não há worker ativo.

### Corte B4 — captura/projeção live de transfers

Status: concluído em B4a–B4e com adapters PostgreSQL/RPC, tick, evidência de tipo,
worker opt-in e lease isolada.

Objetivo:

- reutilizar o reader atual sem acoplar ao journal de rollback;
- persistir bruto e resumos;
- usar lease e grupo isolado;
- não competir com holder live.

O B4a limita a futura leitura ao frontier `live` comprovado de wallet-swaps,
reutiliza o mesmo escopo de tokens do holder ledger e carrega em lote swaps,
pools e papéis já persistidos. Ele não inicia RPC nem worker.

O B4b reutiliza o reader global de `Transfer`, busca número, hash e timestamp dos
blocos em batches limitados e rejeita o range inteiro se qualquer hash divergir.
Assim, o futuro tick recebe `blockTime` verificável sem iniciar worker ou escrita.

O B4c compõe captura, classificação, bruto idempotente e commit atômico de
arestas/cursor. O bootstrap começa em um único bloco já coberto pelo source; a
cobertura histórica continua sendo responsabilidade do B6.

O B4d consulta `eth_getCode` no bloco de cada transfer em batches limitados.
Ausência de bytecode permite classificar o endpoint operacionalmente como wallet,
mas não prova propriedade; qualquer bytecode observado prevalece como contrato.

O B4e liga o tick somente sob flag explícita e lease própria no grupo
`robinhood-wallet-classification`; configuração, batches, backoff e telemetria são
limitados, e mismatch de checkpoint paralisa o writer.

O corretivo B4f evita filtros RPC inviáveis para catálogos grandes. Até 100
tokens o reader mantém `address-filtered`; acima disso consulta globalmente pelo
tópico `Transfer` e filtra localmente pelo allowlist, expondo o modo e os splits
na telemetria. A medição operacional que motivou o corte encontrou 119.168
tokens, que não podem ser enviados em um único filtro `address`.

O corretivo B4g substitui a dependência histórica de `eth_getCode`/Alchemy por
evidência compacta produzida no PC com archive node e persistida na VPS pelo
túnel já usado nos demais backfills. O B4g1 cria a Stage 135 e o repository de
papéis por endpoint. O registro é conservador: evidência de contrato prevalece
sobre wallet, inclusive em replays fora de ordem. O worker ainda não consome
essa tabela neste subcorte e deve permanecer desligado até o B4g2.

O B4g2 move a leitura normal de papéis para o mesmo source PostgreSQL que carrega
swaps e pools. O LIVE deixa de instanciar o reader RPC de `eth_getCode`; endpoint
sem registro continua `unknown`, é persistido como evidência bruta e não impede
o avanço do cursor. O backfill seed recebeu depois o gate archive descrito no B6i.

O B4g3 adiciona um comando bounded e idempotente para o PC. Ele seleciona na
VPS endpoints sem papel ou wallets com evidência desatualizada entre as transfers brutas, consulta
somente `RH_NODE_RPC_URL` e grava evidência na Stage 135 via `DATABASE_URL`.
O comando é dry-run por padrão; não avança cursores nem reclassifica eventos.

O B4g4a cria a Stage 136, um ledger imutável para transições aplicadas de
`unknown` para uma decisão comprovada. O registro preserva o evento original,
versões anterior/nova, motivo e snapshot JSON da evidência. Não existe writer
neste subcorte; raw, arestas, resumos e cursores permanecem inalterados.

O B4g4b aplica cada transição uma única vez e na mesma transação: ledger, raw,
arestas, evidências limitadas e resumo diário. Watermarks existentes das versões
afetadas voltam para `blocked`, pois a prova anterior fica obsoleta. A projeção
financeira continua separada; `swap_only_v1` não é alterada por este writer.

O B4g4c adiciona o executor manual limitado a um dia UTC e até 1.000 eventos.
Ele reutiliza swaps, pools e o classifier existente, aceita somente endpoints
dentro da cobertura Stage 135 e é dry-run por padrão. Não usa RPC nem inicia
worker; a confirmação longa aplica cada transição pelo writer do B4g4b.

O B4g5 corrige a fila do PC para expandir a Stage 135 nas duas direções. Transfers
anteriores a `observed_from_block` e posteriores a `observed_through_block`
voltam ao backfill; a precedência conservadora de contrato permanece inalterada.

### Corte B5 — compactação e retenção

Status: em andamento. O B5a criou o contrato persistente do resumo diário por
token e versão. O B5b integrou seu `UPSERT` ao mesmo commit de arestas,
evidências e cursor. O B5c criou o watermark diário fail-closed; ainda não existe
remoção de partições. O B5d1 adicionou o auditor shadow de um dia, sem scheduler.

Objetivo:

- criar watermark diário;
- reconciliar raw/resumo;
- implementar drop de partição fail-closed;
- manter retenção desligada por default.

Nenhuma partição é removida no primeiro rollout desse corte.

A Stage 131 mantém contagem e soma raw separadas para `wallet_transfer` e
`dex_flow`, além do frontier exato processado em cada dia UTC. Esse resumo é a
contraparte compacta necessária para reconciliar o raw; as arestas, por serem
acumuladas entre dias, não servem sozinhas como prova de completude diária.
Retry obsoleto é rejeitado pelo CAS do cursor antes de tocar o resumo, e qualquer
falha no resumo reverte também as arestas, evidências e avanço do cursor.

A Stage 132 impede `verified` enquanto classificação, reconciliação do resumo,
posição, evidências, cursor e checkpoint canônico não estiverem comprovados. O
estado `dropped` fica reservado para o futuro executor; auditorias explícitas
podem criar watermarks, mas não liberam retenção nem removem partições.

O auditor B5d1 compara raw e resumo por token sob snapshot `REPEATABLE READ`,
valida o checkpoint por adapter canônico injetado e grava `blocked`/`verified`.
Ele rejeita `swap_only_v1` como prova de posição e não possui loop automático;
portanto ainda não libera nem remove partições.

O B5d2 adiciona um comando restrito a um dia por execução, dry-run por padrão e
com `--commit` limitado a persistir o watermark. A validação de chain ID e hash
canônico usa o mesmo cliente RPC Robinhood do LIVE; não há seleção em massa,
scheduler ou DDL destrutivo.

O B5e planeja no máximo 100 candidatos `verified` anteriores à janela de 30 dias
e confere existência, vínculo com a tabela pai e bounds diários no catálogo. O
resultado é sempre não destrutivo e exige reauditoria canônica antes de qualquer
futuro executor.

### Corte B6 — backfill histórico summary-first

Objetivo:

- revarrer a chain em ranges;
- gravar somente resumo/evidência fora dos 30 dias;
- gravar bruto também dentro da janela;
- checkpoint, retry, backpressure e telemetria;
- dry-run e auto-start separados;
- reconstruir em shadow uma nova versão da posição, unindo swaps e transfers em
  ordem canônica;
- promover a nova versão somente depois de reconciliar saldo e frontier.

O B6a separa a cobertura histórica da cobertura LIVE: contexto de classificação
para backfill só fica disponível quando o seed de swaps está `complete`, com
frontier terminal válido, `origin_block` explícito e o cursor LIVE provando sua
cobertura atual desde o bloco seguinte ao seed. Cursores antigos sem ambas as
origens permanecem bloqueados até reparo.

O B6b adiciona reparo operacional dry-run das origens antigas. O bloco inicial
do seed é sempre informado pelo operador; somente a origem LIVE é derivada do
handoff durável (`seed.safe_head + 1`). A confirmação exige lease LIVE inativa,
locks, validação de conflitos e pós-condição atômica.

O B6c preserva `origin_block` nos novos cursores de transfers, usando a posição
inicial do próprio cursor. Para um cursor LIVE antigo, a origem deve ser auditada
e informada explicitamente ao comando dry-run; confirmação exige a lease LIVE
inativa e nunca deriva a origem do primeiro evento retido.

O B6d calcula a janela seed sem RPC ou escrita: começa na origem histórica
comprovada dos swaps e termina exatamente no bloco anterior à origem LIVE de
transfers. O plano falha fechado se houver gap, sobreposição ou se um cursor
seed existente não preservar as mesmas fronteiras imutáveis.

O B6e adiciona um tick histórico bounded apenas em memória. Ele revalida o
checkpoint seed, captura e classifica um range, separa eventos dentro da janela
raw de 30 dias dos que seriam somente resumidos e reporta telemetria, sem criar
ou avançar cursor e sem persistir eventos, arestas ou evidências.

O B6f adiciona commit explícito ao tick, sem scheduler. A origem usa o timestamp
canônico do primeiro bloco; raw é escrito somente dentro da janela, enquanto
resumos/arestas/evidências e cursor usam CAS transacional. Corrida de bootstrap
é rejeitada antes do raw e retry após conflito continua idempotente.

O B6g expõe somente uma faixa por invocação em comando dry-run-first, validando
chain ID antes do tick. Escrita exige a confirmação longa específica; não há
loop, lease ou auto-start, e o limite informado continua entre 1 e 5.000 blocos.

O B6h adiciona ao mesmo comando um loop manual limitado por `--max-ranges`, com
pausa explícita e lease exclusiva `robinhood-wallet-transfer-backfill-worker`.
Uma faixa continua sendo o default; conclusão, bloqueio, conflito de cursor ou
perda da lease interrompem o processo. Ainda não há auto-start ou wiring no
`server.js`.

O corretivo B6i impede que uma faixa antiga perca transfers `unknown` após sair
da retenção bruta. Antes da classificação, o comando consulta na Stage 135 quais
endpoints/blocos ainda não têm cobertura, resolve somente esses pares no archive
do PC e, em modo confirmado, persiste a evidência antes de avançar o cursor. A
captura e essa hidratação compartilham exclusivamente `RH_NODE_RPC_URL`; falha ou
resposta incompleta do archive aborta a faixa. O dry-run consulta sem gravar.

O B6j1 cria o domínio puro da posição `unified_transfer_v1`. Ele ordena swaps e
`wallet_transfer` por bloco, índice da transação e log, evita contabilizar
`dex_flow` duas vezes, preserva a contagem por transação e aplica entrada/saída
com as regras financeiras existentes. A ausência do índice canônico de qualquer
swap falha fechado. Este subcorte ainda não lê nem grava banco e não altera o
backfill operacional.

O B6j2 adiciona ao repository de posições a leitura exata dos swaps financeiros
de uma faixa, limitada simultaneamente por tempo, bloco e escopo de tokens. A
query preserva partition pruning e usa `robinhood_swap_mc` como market cap
durável. Ainda não existe commit conjunto nem avanço do cursor unificado.

O B6j3 permite que o repository de transfers seja o único dono da transação que
grava arestas, resumos, posições unificadas e ambos os cursores. Conflito no
cursor financeiro reverte todo o range, inclusive os agregados de transfer. O
tick histórico ainda não produz nem envia o batch financeiro neste subcorte.

O B6j4 adiciona na Stage 137 a origem durável e nullable do cursor financeiro.
Novos cursores registram a origem exata somente na criação; valores ausentes em
cursores antigos não são inferidos. Isso permite provar o início de um catch-up
financeiro isolado antes de acoplar a posição ao backfill unificado, sem declarar
como processados os 500 blocos já avançados apenas pela projeção de transfers.

O B6j5 implementa o catch-up manual e dry-run-first da posição unificada. Ele
usa a origem e o frontier duráveis dos dois cursores, relê no archive apenas a
lacuna financeira, combina os swaps persistidos na VPS com transfers novamente
classificados e avança somente `unified_transfer_v1`. Checkpoint não canônico,
origem ausente/divergente ou posição à frente falham fechados. O backfill de
transfers ainda não envia o batch financeiro automaticamente neste subcorte.

O corretivo B6j6 resolve o hard-block causado por self-transfer entre wallets
conhecidas. A Stage 138 cria o tipo durável não-edge `wallet_self`; classifier,
raw, LIVE, backfill e posição passam a preservar a evidência sem gerar aresta,
resumo, conexão ou mutação financeira. A projection continua falhando para uma
aresta inválida, de modo que o filtro explícito não enfraquece sua invariante.

### Corte C1 — read model e API de inteligência

Objetivo:

- leitura em lote das 50 wallets;
- contrato de métricas/qualidade;
- failure isolation da lista básica;
- auth, visibility e limites.

Testes:

- rota primária;
- métricas parciais;
- `null` versus zero;
- endereço/tamanho inválidos;
- falha do repository sem quebrar holders.

### Corte C2 — saldo ETH em lote

Objetivo:

- adapter `eth_getBalance` usando batch RPC;
- cache e deduplicação in-flight;
- timeout/fallback;
- integração opcional à resposta de inteligência.

Não persistir saldo nativo histórico neste corte.

### Corte C3 — frontend das colunas

Objetivo:

- tipos de API;
- hidratação progressiva;
- formatadores;
- tooltips de qualidade/custo zero;
- manter Remaining e paginação.

Validação:

- `npm run lint`;
- `cd frontend && npm run build`;
- unit/component test mais barato que proteja o contrato;
- smoke do expanded holders.

### Corte C4 — API e frontend de Transfers

Objetivo:

- rota paginada raw de 30 dias;
- aba `Transfers` por wallet;
- links do explorer;
- loading/error/empty;
- aviso de retenção.

### Corte C5 — API e frontend de relações

Objetivo:

- relações agregadas antigas;
- evidências;
- first/last seen;
- distinção raw versus summary;
- linguagem que não afirma identidade.

### Corte D1 — sinais de possible bundle

Objetivo:

- componentes de score explicáveis;
- thresholds versionados;
- auditoria offline;
- nenhuma ação automática.

### Corte D2 — funding ETH direto

Objetivo:

- capturar `from/to/value` de transações nativas diretas;
- raw 30 dias e resumo permanente;
- incorporar `common funder` com evidência.

Transfers internos permanecem fora do escopo até RPC com traces.

## 18. Estratégia de testes

### Unit

- média ponderada;
- custo médio;
- compra/venda parcial;
- transfer zero-cost;
- oversell;
- zero balance;
- mint/burn/self-transfer;
- classificação DEX versus wallet;
- score e disclaimers;
- cursor/normalização.

### Integration

- schema e constraints;
- partições diárias;
- idempotência/retry;
- posição + aresta + cursor na mesma transação;
- rollback em falha;
- keyset pagination;
- compactação somente após watermark;
- reconciliação de contagens/somas;
- auth/visibility para novas rotas críticas.

### Smoke/E2E

- holders aparecem antes da inteligência;
- métricas hidratam sem substituir Remaining;
- zero e indisponível são diferentes;
- wallet recebida mostra U. PnL igual ao valor restante com custo zero;
- navegação da aba Transfers;
- explorer;
- falha da inteligência não fecha/quebra o modal.

Não repetir toda a máquina financeira no smoke; as variações pertencem ao teste
unitário.

## 19. Observabilidade

### Projeção

- cursor/through block;
- lag para o head;
- eventos processados/duplicados/classificados;
- posição criada/atualizada;
- mismatches de reconciliação;
- contagem por quality/cost basis source;
- p50/p95/p99 de batch/commit.

### Storage

- bytes e linhas por partição/dia;
- crescimento de índices;
- WAL por hora/dia;
- partição mais antiga;
- watermark mais antigo;
- dias brutos efetivamente retidos;
- drops bloqueados e motivo.

### Grafo

- arestas novas/atualizadas;
- eventos por aresta;
- fan-out;
- relações por tipo;
- evidências preservadas;
- unknown/dex classification rate;
- candidatos possible bundle por versão.

### RPC

- batch size;
- requests/s;
- timeout/429/fallback;
- cache hit rate de ETH balance;
- provider e freshness.

## 20. Rollout

1. Concluir A0 e revisar capacidade.
2. Entregar posição financeira histórica em shadow, sem API pública.
3. Comparar amostras manualmente com swaps, balances e Axiom.
4. Criar raw/resumo de transfers com retenção desligada.
5. Ligar captura live sob lease isolada e medir 7 dias.
6. Rodar backfill summary-first com prefetch 1.
7. Subir concorrência apenas quando lag live, WAL e commits permanecerem
   saudáveis.
8. Publicar API de inteligência atrás de flag.
9. Publicar colunas no frontend com fallback para placeholders.
10. Publicar aba Transfers.
11. Validar compactação em shadow sem remover partições.
12. Habilitar drop somente após duas janelas completas reconciliadas.
13. Publicar relações agregadas.
14. Auditar possible bundle offline antes de expor score.
15. Considerar funding ETH direto em rollout separado.

Ordem de deploy por corte com schema:

1. migration/schema;
2. schema check;
3. repositories/workers desligados;
4. backfill/shadow;
5. web/API;
6. frontend;
7. flags operacionais.

## 21. Rollback e recuperação

- Desligar worker/flag nunca apaga raw, posição ou resumo.
- API desabilitada mantém holders/Remaining funcionando.
- Frontend desconhecendo novos campos mantém placeholders.
- Cursor inválido ou regressivo interrompe projeção, sem reset automático.
- Rebuild da posição exige checkpoint conhecido e replay ordenado.
- Classificação nova incrementa `classification_version`; não sobrescrever
  silenciosamente evidência antiga.
- Score novo incrementa `algorithm_version`.
- Retenção falha fechado se a versão projetada não for compatível com o
  watermark.
- Nunca usar `DROP PARTITION` manual antes de validar resumo, cursor e evidência.

## 22. Segurança e privacidade

- Somente dados públicos on-chain.
- Não associar wallet a identidade humana sem evidência externa autorizada.
- Não expor payloads RPC completos em logs.
- Limitar requests de 50 wallets e paginação.
- Rate limit nas novas rotas.
- Normalizar endereços e cursores no backend.
- Não aceitar URLs RPC ou chain IDs do cliente.
- Evidências públicas devem conter somente hashes/endereço/valores necessários.

## 23. Critérios de conclusão

A entrega financeira só é considerada concluída quando:

- as quatro colunas possuem fonte real ou degradação explícita;
- custo zero reproduz o caso da referência visual;
- PnL realizado e não realizado têm testes de fronteira;
- reconciliação com holder balance está observável;
- a tela básica não depende da inteligência.

A entrega de transfers só é considerada concluída quando:

- raw de 30 dias está particionado e paginável;
- resumo permanente é reconciliado antes de qualquer drop;
- histórico antigo foi backfilled summary-first;
- classificação evita dupla contagem de swaps;
- relações preservam evidências;
- a UI distingue raw de summary.

A entrega de bundle intelligence só é considerada concluída quando:

- sinais são explicáveis e versionados;
- pools/routers/mint/burn não geram falsos positivos óbvios;
- resultados foram auditados offline;
- a linguagem não afirma propriedade comum;
- nenhum score dispara bloqueio ou alerta automático sem aprovação posterior.

## 24. Documentação operacional

Este plano guarda decisões, riscos e histórico de cortes. `docs/bot-reference.md`
deve ser atualizado somente quando uma implementação realmente alterar o estado
operacional atual, por exemplo:

- novos schemas obrigatórios;
- novos workers/flags/leases;
- ordem de deploy;
- contratos REST públicos;
- retenção e recuperação;
- invariantes de PnL/grafo consumidos por outros subsistemas.

Não copiar o progresso de cada corte para a referência operacional.

## 25. Ponto importante

O custo zero de tokens transferidos é uma convenção de visualização por wallet,
não conservação econômica global. Se A compra um token e envia para B, o custo é
removido de A e B recebe custo presumido zero; somar o PnL de A e B pode inflar o
resultado do cluster. O grafo deve preservar a proveniência A -> B para análises
de bundle, mas a coluna individual de B continua seguindo a convenção aprovada.

Também não se deve reduzir este projeto a “guardar transfers por 30 dias”. O
produto depende de três camadas distintas e duráveis: posição financeira,
resumo de arestas e evidências explicáveis. A tabela bruta de 30 dias é apenas a
camada de investigação detalhada e replay recente.

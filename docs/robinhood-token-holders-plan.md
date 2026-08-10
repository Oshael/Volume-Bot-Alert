# Plano de Holders por Token na Robinhood Chain

Documento operacional para implementar, validar, implantar e acompanhar a
contagem e a lista de holders dos tokens da Robinhood Chain no TrendScope.

Este documento descreve o estado local do repositorio em 2026-08-10 e divide a
entrega em cortes independentes de no maximo 500 linhas alteradas. Codigo local
nao significa funcionalidade aprovada ou implantada; a apresentacao no expanded
chart e a fase realtime ainda possuem checkpoints explicitos abaixo.

## Objetivo

Adicionar holders por token apenas para a Robinhood Chain, com tres superficies:

1. mostrar a quantidade total no painel `MONITORED`, ao lado de `TOTAL LIQ`;
2. preencher o campo `HLD` ja reservado nas tabelas `recent`, `old-week` e
   `manual` para linhas da RH;
3. disponibilizar lista e historico no expanded chart da RH, em apresentacao
   visual ainda a ser definida; existe uma aba local como prototipo, nao como
   decisao final de produto.

A entrega deve continuar funcionando quando o Blockscout estiver lento,
limitado, atrasado ou indisponivel. Nenhum fluxo critico do bot pode depender de
uma resposta online do Blockscout.

## Fora de Escopo da Entrega Blockscout Atual

- wallet profile ao clicar em um holder;
- wallet tracking persistente;
- watchlists, labels e notas por usuario;
- alertas de compra ou venda por wallet;
- alertas de wallet no Telegram;
- PnL, custo medio ou portfolio historico de wallet;
- snapshots historicos diarios de todos os holders;
- ledger proprio de saldos reconstruido por todos os eventos `Transfer`;
- holders de Solana;
- excluir automaticamente pools, contratos ou burn addresses da contagem;
- armazenar localmente todas as wallets de todos os tokens.

Wallet intelligence/tracking deve ser tratado como projeto posterior, usando a
lista de holders e `robinhood_wallet_swaps` como duas fontes independentes.

## Estado Atual Confirmado no Codigo

### Frontend

- `frontend/src/ui/sections/shared.ts` renderiza o summary persistido em `HLD`
  para RH em `recent`, `old-week` e `manual`, com `-` nas demais chains.
- `frontend/src/ui/sections/monitored-section.ts` mostra `HOLDERS` ao lado de
  `TOTAL LIQ`; o tooltip informa observacao e freshness do snapshot.
- `frontend/src/ui/sections/layout-sections.ts` monta o expanded chart da RH com
  grafico e um painel lateral de trades.
- `frontend/src/ui/robinhood-expanded-trades.ts` e um modulo isolado para o feed
  de trades. Existe tambem um prototipo local isolado em
  `frontend/src/ui/robinhood-expanded-holders.ts`; sua posicao no modal ainda nao
  e uma decisao aprovada de produto.

### Backend

- `src/services/robinhood-blockscout-metadata.js` ja consulta
  `https://robinhoodchain.blockscout.com/api/v2/tokens/<token>`.
- A resposta real desse endpoint inclui `holders_count`, mas o normalizador atual
  descarta o campo.
- O client atual usa timeout padrao de 5 segundos, sem retry.
- O worker de projecao de catalogo roda por padrao a cada 60 segundos, com
  concorrencia 8 e lote Blockscout de ate 50.
- Essa concorrencia nao e apropriada para uma coleta recorrente de holders sem
  scheduler proprio, pois pode produzir rajadas acima do limite publico.
- `robinhood_wallet_swaps` ja armazena swaps atribuidos por wallet, mas nao faz
  parte deste projeto.

### Documentacao anterior

`docs/robinhood-vps-history-rollout-plan.md` excluiu explicitamente holders e
saldos por wallet do replay historico e determinou que holders fossem um projeto
separado. Este plano e esse projeto separado; nao modifica o contrato do replay
de swaps/candles.

## Evidencia Validada na Instancia RH

Em 2026-08-09, consultas reais para CASHCAT confirmaram:

- metadata do token retorna `holders_count`;
- `/api/v2/tokens/<token>/counters` retorna `token_holders_count`;
- `/api/v2/tokens/<token>/holders` retorna 50 holders e
  `next_page_params`;
- cada holder contem saldo bruto e dados do endereco, incluindo se e contrato,
  nome verificado e tags quando disponiveis;
- a lista inclui pools, contratos e burn address;
- contadores consultados em instantes diferentes podem variar, portanto nao sao
  um snapshot atomico com a pagina de holders.

O Blockscout documenta limite default por IP de 3 requisicoes por segundo e 300
por minuto. Endpoints por instancia tambem estao marcados para descontinuacao
futura em favor da API multichain PRO. Por isso a integracao deve existir atras
de um adapter substituivel e nunca ser chamada diretamente pelo frontend.

## Decisoes Fechadas

1. A funcionalidade e exclusiva da chain `robinhood`.
2. `holderCount` representa a contagem bruta publicada pelo Blockscout.
3. Pools, contratos, wallets comuns e burn address participam do total.
4. A lista identifica o tipo do endereco; nao o esconde automaticamente.
5. Solana continua mostrando `HLD -` neste projeto.
6. O dashboard le somente o ultimo resumo persistido; nunca aguarda Blockscout.
7. Falha externa preserva o ultimo valor conhecido.
8. Valor sem sucesso anterior e exibido como `-`, nunca como zero.
9. `0` e um valor valido somente quando confirmado pela fonte.
10. A tela informa quando o valor foi observado e quando esta stale.
11. A pagina de holders e carregada apenas quando a aba e aberta ou paginada.
12. A pagina usa keyset/cursor do Blockscout e 50 itens por request.
13. O cursor externo e validado e encapsulado pelo backend; o browser nao monta
    URLs do Blockscout.
14. Qualquer integracao de holders deve preservar o chart como experiencia
    inicial, salvo nova decisao explicita de produto.
15. Lista e historico nao podem disputar recursos com chart/trades; a composicao
    visual exata permanece aberta.
16. Wallet profile e wallet tracking nao serao adicionados implicitamente.
17. A entrega Blockscout atual nao reprocessa `Transfer`; a fase realtime
    planejada abaixo substitui essa restricao por um ledger proprio.
18. A primeira versao usa Blockscout por instancia, mas o contrato interno nao
    incorpora URLs ou formatos especificos da instancia.

### Decisoes de produto ainda abertas

- posicao, navegacao e composicao visual dos holders no expanded chart;
- se o prototipo local em tabs sera reaproveitado, redesenhado ou removido;
- criterio visual para tokens sem historico suficiente.

## Semantica do Dado

### Holder count

O contrato interno deve distinguir:

- `holderCount`: inteiro seguro, maior ou igual a zero, ou `null`;
- `observedAt`: quando a fonte retornou o valor com sucesso;
- `checkedAt`: quando ocorreu a ultima tentativa;
- `freshness`: `fresh`, `stale` ou `unavailable`;
- `source`: inicialmente `blockscout`;
- `lastErrorCode`: codigo operacional seguro, nunca mensagem externa crua.

`observedAt` nao deve ser atualizado em falha. `checkedAt` pode ser atualizado em
falha para suportar backoff e telemetria.

### Lista de holders

Cada item normalizado deve conter apenas o necessario para a interface:

- `rank` dentro da navegacao atual;
- `address` normalizado;
- `balanceRaw` como string decimal inteira;
- `balance` formatado usando decimals conhecidos do token;
- `percentage` calculado somente quando `totalSupply > 0` for confiavel;
- `addressType`: `wallet`, `contract`, `pool`, `burn` ou `unknown`;
- `label` seguro derivado de nome/tag publico conhecido;
- `isVerifiedContract`;
- URL interna/permitida do explorer montada pelo frontend a partir do endereco.

Saldo bruto nunca deve passar por `Number`, pois ERC-20 pode exceder a precisao
segura de JavaScript. Calculo e formatacao devem usar string/BigInt ou decimal
arbitrario.

### Freshness do fallback Blockscout

- token quente: alvo de 15 minutos;
- token frio: alvo de 24 horas;
- expanded holders: pode solicitar refresh prioritario do token aberto;
- falha: servir o ultimo resumo com `stale = true`;
- sem resumo: servir `holderCount = null` e erro nao bloqueante;
- lista paginada nao e tratada como snapshot historico: transferencias entre
  paginas podem causar mudanca natural de ranking.

Token quente inclui, no minimo, tokens RH presentes em `monitored`, pins,
`manual`, `recent` ou `old-week`. A selecao concreta deve reutilizar as fronteiras
de catalogo/dashboard existentes, sem duplicar regras de elegibilidade.

Esses intervalos nao representam o alvo realtime. Quando o ledger de `Transfer`
estiver ativo, o count publicado deve acompanhar o cursor live em segundos; o
Blockscout permanece como bootstrap, auditoria e reconciliacao.

## Arquitetura Proposta

```text
Blockscout per-instance API
  -> RobinhoodHoldersProvider (adapter HTTP, normalizacao, timeout)
  -> HolderRequestScheduler (rate limit, retry, backoff, circuit breaker)
  -> RobinhoodHolderSummaryRepository (ultimo valor conhecido)
  -> HolderSummaryWorker (hot/cold priority)
  -> dashboard/read models (somente banco)
  -> frontend list surfaces

Expanded HOLDERS tab
  -> authenticated RH holders route
  -> scheduler/provider sob demanda
  -> pagina normalizada de 50 itens
  -> modulo frontend isolado
```

### Fronteira do provider

O provider deve expor operacoes semanticamente estaveis, por exemplo:

- `getTokenHolderSummary(tokenAddress)`;
- `getTokenHoldersPage(tokenAddress, cursor)`.

Somente o provider conhece `holders_count`, `address_hash`,
`next_page_params` e URLs Blockscout. Rotas, repositorios e frontend trabalham
com o contrato normalizado.

### Scheduler e protecao externa

Politica inicial:

- no maximo 2 requisicoes Blockscout por segundo;
- concorrencia maxima 2;
- timeout de metadata/count entre 5 e 8 segundos;
- timeout de pagina de holders entre 8 e 12 segundos;
- no maximo 2 retries para falhas transitorias;
- respeitar `Retry-After` em 429/503 quando presente;
- exponential backoff com jitter;
- nao repetir 4xx permanentes, exceto 408/429;
- circuit breaker depois de falhas consecutivas dentro de janela curta;
- probe controlado antes de fechar novamente o circuito;
- erros isolados por token nao interrompem o lote.

Os valores exatos devem ser configuraveis e limitados no `config/index.js`, mas
defaults conservadores precisam funcionar sem chave de API.

### Persistencia

Preferir uma tabela nova, evitando ampliar responsabilidades e lock de alteracao
em tabelas quentes:

`robinhood_token_holder_summaries`

Campos minimos previstos:

- `chain` com check fixo `robinhood`;
- `token_address` normalizado e chave primaria junto com chain;
- `holder_count BIGINT` nullable e nao negativo;
- `source`;
- `observed_at` nullable;
- `checked_at`;
- `last_error_code` nullable;
- `consecutive_failures` nao negativo;
- `retry_after_at` nullable;
- `created_at` e `updated_at`.

A tabela armazena somente resumo. A lista de wallets permanece no Blockscout e e
buscada sob demanda.

### API interna

Rotas previstas, autenticadas e protegidas pela visibilidade RH:

1. `GET /api/robinhood/holders`
   - query: `token`, `cursor` opcional;
   - retorna resumo, pagina de 50 itens, `hasMore` e `nextCursor`;
   - erros de validacao: 400;
   - RH oculta: mesma politica das rotas RH atuais;
   - indisponibilidade sem cache da pagina: 503 seguro;
   - nunca retorna payload/erro bruto do provider.

2. O holder count das superficies de lista deve viajar nos payloads existentes
   de dashboard/history, evitando uma chamada frontend por linha.

Nao criar endpoint publico que aceite lote arbitrario e dispare dezenas de
requests externas sincronicamente.

## UX Fechada

### Monitored

Ordem esperada:

`<valuation> · AGE · VOL 1H · VOL 6H · VOL 24H · TOTAL LIQ · HOLDERS`

Regras:

- mostrar numero compacto (`53K`) e valor completo no title/tooltip;
- `-` quando nunca observado;
- indicador visual discreto e tooltip quando stale;
- apenas RH recebe valor; outras chains preservam comportamento atual.

### Recent, old-week e manual

- substituir apenas o placeholder `HLD` para linhas RH;
- preservar grid e as outras metricas;
- tooltip com valor completo e `Updated ... ago`;
- nao renomear `HLD` neste corte para evitar regressao de largura.

### Expanded chart RH

Cabecalho do corpo:

`CHART | HOLDERS (<count>)`

- `CHART` default: grafico e painel de trades existentes;
- `HOLDERS`: tabela full-width;
- colunas: `#`, `Wallet`, `Balance`, `% Supply`, `Type / Label`;
- 50 itens por pagina;
- `Prev` e `Next`, sem page number inventado para cursor keyset;
- loading, empty, stale e retry states explicitos;
- endereco clicavel abre explorer em nova aba;
- nenhum wallet profile dentro deste projeto;
- ao trocar para `CHART`, polling/listeners de holders sao descartados;
- ao fechar o modal, requests tardios nao podem atualizar DOM desconectado.

## Seguranca e Privacidade

- somente enderecos on-chain publicos sao exibidos;
- nenhuma associacao entre wallet e usuario do produto e criada;
- tags privadas do Blockscout nao devem ser copiadas;
- apenas tags/names publicos explicitamente retornados e normalizados podem virar
  label;
- strings externas passam por normalizacao, limite de tamanho e escape HTML;
- URLs externas nao sao aceitas do payload para navegacao, exceto assets ja
  cobertos pelas politicas existentes;
- cursores possuem limite de tamanho e schema estrito;
- logs nao devem incluir o payload completo de holders;
- respostas 404 nao devem permitir bypass de visibilidade da chain.

## Observabilidade Operacional

Telemetria minima do worker/provider:

- requests iniciados, bem-sucedidos e falhos por operacao;
- 429, timeout, 5xx e invalid response separados;
- latencia p50/p95 ou buckets equivalentes;
- circuit breaker aberto/half-open/fechado;
- summaries frescos, stale e unavailable;
- tamanho da fila hot/cold;
- idade do resumo mais antigo entre tokens quentes;
- ultima pagina de holders bem-sucedida, sem registrar wallets.

O health geral do bot nao deve ficar vermelho apenas porque Blockscout falhou.
Deve existir status degradado especifico para a capacidade de holders.

## Fan-out e Checkpoint Arquitetural

Estimativa atual: 18 a 24 arquivos de producao e 8 a 12 arquivos de teste ao
longo do projeto. Portanto, a mudanca e um checkpoint arquitetural.

Subsistemas afetados:

- config/runtime de worker;
- adapter HTTP Blockscout;
- scheduler de chamadas externas;
- schema/runtime-schema;
- repositorio de resumo;
- selecao de candidatos hot/cold;
- rotas autenticadas RH;
- respostas dashboard/history;
- tipos e normalizacao frontend;
- listas monitored/recent/old/manual;
- expanded chart;
- estilos e smoke tests;
- documentacao operacional/de referencia.

Guardrails:

- business logic nova fica em provider/scheduler/repository/modulo UI;
- `server.js`, dashboard routes e `layout-sections.ts` recebem somente wiring;
- nao espalhar novos `chain === 'robinhood'` fora das fronteiras ja existentes;
- nao adicionar logica de holders ao decoder/replay de swaps;
- nenhuma query de lista faz N requests externas;
- cada corte para depois de no maximo 500 linhas alteradas.

## Estimativa Total e Cortes

Estimativa revisada: 2.100 a 2.700 linhas alteradas, sem contar este documento
operacional. A margem inclui testes e ajustes de CSS/smoke. Se qualquer corte
ultrapassar a estimativa em mais de 20%, ele deve parar antes de editar o novo
escopo.

## Mapa Executivo de Entrega

Atualizado em 2026-08-10. Este mapa e a fonte de verdade para status e ordem
macro. A posicao historica das secoes detalhadas abaixo nao cria outra fase nem
altera a sequencia deste quadro.

### Entrega Blockscout e superficies atuais

| Macro | Entrega | Status | Evidencia principal |
|---|---|---|---|
| 1 | Provider Blockscout e contrato puro | concluido e commitado | `574ad326` |
| 2 | Scheduler, retry e circuit breaker | concluido e commitado | `574ad326` |
| 3 | Schema/repository de summary (Stage 111) | concluido e commitado | `574ad326` |
| 4 | Worker hot/cold de summaries | concluido e commitado | `574ad326` |
| 5 | Rota paginada/lista de holders | concluido e commitado | `574ad326` |
| 6 | Count em monitored/recent/old/manual | concluido e commitado | `e7b1de26` |
| 7 | Snapshot diario e endpoint historico (Stage 112) | concluido e commitado | `574ad326` |
| 8 | Expanded chart HOLDERS | bloqueado por decisao visual | prototipo local fora dos commits |

### Fase realtime por `Transfer`

| Macro realtime | Entrega | Status | Subcortes/evidencia |
|---|---|---|---|
| 1 | Probe read-only global e catalog-scoped | concluido, commitado e executado no node da VPS | RT1/RT1B; `afd0147a`, `9b43e90e` |
| 2 | Schema e ledger shadow reversivel | concluido no codigo; migrations 116-118 ainda nao aplicadas em producao; nenhum runner ligado | RT2A-RT2C4; `43a6f9d7` ate `49609b99` |
| 3 | Backfill/catch-up de tokens novos sem lacuna | concluido no codigo/desligado | RT3A-RT3C runner opt-in; RT4A/RT4E1 handoff retido; RT4F1 wiring com lease |
| 4 | Live incremental shadow, deteccao automatica de reorg e scheduler da poda | concluido no codigo/desligado | RT4A-RT4E2 base integrada; RT4F1/F2 grupo, leases e poda opt-in |
| 5 | Backfill frio dos tokens antigos | concluido no codigo/desligado | RT5A-RT5B3; admissao, verificacao, tick limitado e runtime opt-in com lease |
| 6 | Reconciliacao, promocao e publicacao REST/socket | em andamento/desligado | RT6A-RT6C criam promocao, runtime e wiring opt-in; drift/publicacao pendentes |
| 7 | Frontend realtime/expanded chart | pendente de layout aprovado | nao reutilizar o prototipo sem decisao explicita |

Os nomes RT nao sao uma segunda arquitetura. Eles apenas repartem os macros
realtime em slices de no maximo 500 linhas:

- RT1/RT1B realizam o macro realtime 1;
- RT2A cria a fundacao persistente do macro 2;
- RT2B1/RT2B2 implementam captura e aplicacao atomicas;
- RT2C1/RT2C2 implementam procedencia e rollback;
- RT2C3/RT2C4 implementam floor e poda limitada de 20.000 blocos;
- RT3 em diante continuam os macros pendentes deste quadro, sem abrir um
  plano paralelo.

### Reuso dos arquivos da entrega inicial

| Componente existente | Papel durante e depois do realtime |
|---|---|
| `robinhood-blockscout-holders.js` | bootstrap, lista paginada, auditoria e reconciliacao externa |
| `robinhood-holder-request-scheduler.js` | protege chamadas Blockscout de rate limit/falhas |
| `robinhood-holder-summary-worker.js` | fallback e refresh do ultimo valor conhecido |
| `robinhood-token-holder-summary.js` / Stage 111 | store publicado consumido pelas superficies atuais |
| Stage 112 e endpoint historico | snapshots diarios e sticks de total/delta |
| `robinhood-holders.js` | lista paginada autenticada; nao depende do ledger por wallet |
| UI de monitored/recent/old/manual | continua consumindo o mesmo contrato de summary |
| ledger RT2 | nova fonte shadow/live que alimentara summary e reconciliacao |

Portanto, o realtime complementa a entrega inicial; ele nao descarta provider,
scheduler, summaries, snapshots, rotas ou superficies ja implementadas.

### Corte 1 - Provider Blockscout e contrato puro

Status: implementado, validado e commitado em `574ad326`.

Estimativa: 350 a 480 linhas.

Arquivos previstos:

- novo `src/services/robinhood-blockscout-holders.js`;
- novo ou extensao de teste unitario dedicado;
- possivel fixture pequena reutilizavel de payload Blockscout.

Entrega:

- normalizar summary e pagina;
- validar identidade do token e wallets;
- preservar inteiros grandes como string;
- classificar erros de transporte/timeout/HTTP/payload;
- cursor normalizado sem dependencia do frontend;
- nenhum schema, rota ou worker ainda.

Validacao:

- `npm run lint`;
- `node --test tests/robinhood-blockscout-holders.test.js`;
- revisao integral do diff.

### Corte 2 - Scheduler, retry e circuit breaker

Status: implementado, validado e commitado em `574ad326`.

Estimativa: 350 a 500 linhas.

Arquivos previstos:

- novo scheduler/policy de holders;
- `config/index.js` e `.env.example` apenas para wiring/config;
- testes unitarios de rate limit, retry, `Retry-After` e circuit breaker.

Entrega:

- max 2 rps/concurrency 2 por default;
- retry transitorio com jitter;
- circuit breaker com rejeicao rapida enquanto aberto e probe unico em half-open;
- metricas operacionais basicas.

Validacao:

- `npm run lint`;
- testes unitarios afetados via `node --test ...`;
- revisao integral do diff.

### Corte 3 - Schema e repositorio de summary

Status: implementado, validado e commitado em `574ad326`.

Estimativa: 350 a 490 linhas.

Arquivos previstos:

- novo `src/utils/db-init-stage111.js`;
- `src/utils/runtime-schema.js`;
- novo model/repository de holder summary;
- testes de schema e repository.

Entrega:

- tabela nova idempotente;
- upsert de sucesso que preserva monotonicidade temporal;
- registro de falha sem apagar ultimo valor;
- leitura batch por enderecos;
- claim/selecionador seguro se necessario para concorrencia de worker.

Validacao:

- `npm run lint`;
- `npm run db:schema-check`;
- testes unitarios/integracao afetados via `node --test ...`;
- revisao integral do diff.

### Corte 4 - Worker de summaries hot/cold

Status: implementado, validado e commitado em `574ad326`.

Estimativa: 350 a 500 linhas.

Arquivos previstos:

- worker/service dedicado;
- selector/repository de candidatos;
- wiring minimo no grupo `robinhood-derived`;
- testes do worker e config.

Entrega:

- priorizacao hot/cold;
- lease unico;
- processamento isolado por token;
- backoff persistido;
- telemetria;
- nenhuma alteracao no pipeline de swaps.

Validacao:

- `npm run lint`;
- testes afetados via `node --test ...`;
- teste de runtime worker/config relevante;
- revisao integral do diff.

### Corte 5 - Rota paginada de holders

Status: implementado, validado e commitado em `574ad326`.

Estimativa: 300 a 450 linhas.

Arquivos previstos:

- nova rota RH ou modulo de rota dedicado;
- wiring minimo em `src/server.js`;
- testes de auth, visibilidade, validacao, cursor e falha externa.

Entrega:

- pagina de 50 holders;
- summary junto da pagina;
- refresh prioritario controlado;
- 503 seguro quando pagina nao esta disponivel;
- nenhuma mensagem externa crua.

Validacao:

- `npm run lint`;
- testes de rota/contrato via `node --test ...`;
- revisao integral do diff.

### Corte 6 - Holder count nos payloads e listas

Status: implementado, validado e commitado em `e7b1de26`.

Estimativa: 400 a 500 linhas.

Arquivos previstos:

- readers/responses RH do dashboard/history;
- tipos e normalizacao frontend;
- `frontend/src/ui/sections/monitored-section.ts`;
- `frontend/src/ui/sections/shared.ts`;
- testes de contrato e apresentacao existentes estendidos.

Entrega:

- count em monitored/recent/old/manual;
- `-` para outras chains/sem dado;
- freshness/tooltip;
- sem N+1 externo.

Validacao:

- `npm run lint`;
- `npm --prefix frontend run build`;
- testes afetados via `node --test ...`;
- smoke focal se a mudanca de layout justificar;
- revisao integral do diff.

### Fase 2 - Holder count realtime por eventos `Transfer`

Status: macros 1 e 2 implementados no codigo; migrations 116-118 nao aplicadas
em producao e nenhum runner realtime ligado. Macros 3 a 7 permanecem pendentes.

#### Por que o worker atual nao resolve realtime

`ROBINHOOD_HOLDER_SUMMARY_INTERVAL_MS=30000` controla apenas a frequencia de
selecao. Com os defaults atuais, um token hot fica elegivel a cada cinco minutos,
e a origem continua sendo um contador Blockscout sujeito a atraso e rate limit.
Reduzir esses intervalos faria polling mais agressivo, mas nao criaria captura
realtime confiavel e competiria com outras leituras externas.

O worker existente deve permanecer como bootstrap, fallback e reconciliacao. A
fonte live sera a ingestao compartilhada de logs ERC-20, nunca uma assinatura RPC
ou um polling Blockscout independente por token.

#### Contrato do ledger

- definir holder como endereco nao-zero com saldo positivo, preservando pools,
  contratos e burn addresses comuns na mesma semantica usada pelo contador;
- persistir saldo inteiro como `NUMERIC(78,0)` ou representacao equivalente, sem
  `Number` e sem arredondamento;
- chave unica por `chain + token + wallet`; saldo zero remove ou desativa a linha;
- manter total materializado por token, cursor live e bloco/hash aplicado;
- processar cada bloco atomicamente e publicar somente depois do commit;
- `0 -> positivo` incrementa o total; `positivo -> 0` decrementa;
- mint/burn pelo zero address altera apenas o outro participante;
- deduplicar por bloco, transaction hash e log index;
- suportar rollback de reorg antes de avançar o cursor canônico.

Tokens rebasing, fee-on-transfer ou contratos que nao expressem saldos somente
pelos eventos padrao precisam ser detectados. Divergencia nao pode ser corrigida
silenciosamente: o token fica marcado para reconciliacao/resync.

#### Bootstrap sem lacuna

Para token novo:

1. capturar o bloco de criacao/admissao no catalogo;
2. reprocessar `Transfer` desde o deployment ate o cursor live;
3. aplicar os logs que chegaram durante o catch-up;
4. publicar o primeiro count apenas quando catch-up e cursor se encontrarem.

Para token antigo:

1. descobrir deployment block confiavel;
2. reprocessar todo o historico de `Transfer` em ranges limitados e com checkpoint;
3. construir saldos e total em tabelas shadow;
4. comparar com Blockscout e promover somente dentro da tolerancia definida;
5. continuar do bloco de corte sem janela perdida.

Apenas os top 50 holders nao servem como baseline. Uma alternativa ao replay
integral so e valida se o provider entregar todos os holders ancorados a um bloco
conhecido; caso contrario existe uma corrida impossivel de reconciliar exatamente.

#### Integracao live e frontend

- estender a fronteira de ingestao RH para o topico `Transfer`, sem espalhar
  branches por decoder, server e rotas centrais;
- usar fila limitada e batch de writes; nunca executar `balanceOf` por evento;
- emitir evento sequenciado de holder count apos commit e manter REST como
  bootstrap/recovery do browser;
- criar snapshot diario a partir do total live confirmado;
- atualizar superficies visiveis sem fan-out externo por linha;
- decidir o layout do expanded chart antes de ligar seu consumidor realtime.

#### Reconciliacao e observabilidade

- comparar periodicamente o total local com Blockscout;
- medir lag em blocos/segundos, logs processados, wallets tocadas, tamanho do
  ledger, reorgs, drift e resyncs;
- circuit breaker e backpressure devem degradar somente holders;
- nenhuma fila de holders pode atrasar swaps, candles ou alertas;
- manter worker/grupo de processo isolavel caso o probe mostre carga relevante.

#### Cortes obrigatorios antes do rollout

1. Probe read-only: medir `Transfer` por bloco/dia, tokens ativos, wallets unicas,
   disponibilidade de deployment block e capacidade de replay do RPC.
2. Schema e ledger shadow: balances, total, cursor e suporte a reorg, sem publicar.
3. Backfill de tokens novos: catch-up desde deployment e comparacao Blockscout.
4. Live incremental: aplicar logs aceitos e medir lag/drift em shadow.
5. Backfill frio: tokens antigos com checkpoint, throttle e promocao atomica.
6. Publicacao: REST/socket sequenciado para counts; snapshots usam o total live.
7. Frontend: somente apos decisao explicita de layout do expanded chart.

#### Corte RT1 - Probe read-only de capacidade

Status: implementado, commitado e executado no node proprio da VPS.

Comando: `npm run robinhood:holder-transfer-probe`.

O probe consulta somente `eth_chainId`, head/blocos e `eth_getLogs` para o topico
global `Transfer`. O default cobre 2.000 blocos confirmados em chunks de 250,
divide ranges rejeitados e nao grava banco, cursor ou arquivo. O relatorio inclui
eventos, tokens, wallets e pares `token + wallet` tocados, mint/burn, throughput
RPC e upper bounds diarios de ledger/cauda live. A cobertura de mint no sample e
evidencia parcial; nao substitui um deployment block confiavel.

Variaveis operacionais opcionais:

- `ROBINHOOD_HOLDER_TRANSFER_PROBE_RPC_URL` (prefere dRPC quando ausente);
- `ROBINHOOD_HOLDER_TRANSFER_PROBE_BLOCKS` (1 a 50.000);
- `ROBINHOOD_HOLDER_TRANSFER_PROBE_CHUNK_BLOCKS` (1 a 5.000);
- `ROBINHOOD_HOLDER_TRANSFER_PROBE_FROM_BLOCK`;
- `ROBINHOOD_HOLDER_TRANSFER_PROBE_TIMEOUT_MS`.

#### Corte RT1B - Probe filtrado pelo catalogo

Status: implementado, commitado e executado no node proprio da VPS.

Comando: `npm run robinhood:holder-catalog-transfer-probe`. O modo consulta o
PostgreSQL apenas com `SELECT`, escolhe por default os 1.000 tokens Robinhood mais
recentemente vistos e divide o filtro RPC em lotes de 100 enderecos. O relatorio
mostra `selectedTokens/catalogTotal` e nao extrapola a amostra para tokens que nao
foram consultados. Limites opcionais:

- `ROBINHOOD_HOLDER_TRANSFER_PROBE_CATALOG_LIMIT` (1 a 50.000);
- `ROBINHOOD_HOLDER_TRANSFER_PROBE_ADDRESS_BATCH_SIZE` (1 a 500).

O endpoint explicito continua tendo prioridade; na ausencia dele, o probe agora
usa `ROBINHOOD_RPC_URL` antes da dRPC para refletir o transporte principal do bot.

#### Corte RT2A - Fundacao do ledger shadow

Status: implementado e commitado; migration ainda nao aplicada em producao.

A Stage 116 cria quatro estruturas sem ligar writer ou publicacao: balances
positivos `token + wallet` em `NUMERIC(78,0)`, estado/total e progresso por token,
cursor live independente e journal curto de eventos com balances antes/depois para
deduplicacao e rollback de reorg. O journal possui indices separados para drain de
pendentes e rollback/prune por bloco; ele nao e um historico permanente.

O proximo corte implementa as operacoes atomicas do repositorio shadow. Criar as
tabelas isoladamente nao altera o count Blockscout atualmente publicado.

#### Corte RT2B1 - Captura transacional shadow

Status: implementado e commitado; nenhum runner ligado.

O repositorio captura ranges normalizados no journal e avanca o cursor live na
mesma transacao. Repetir evidencia identica e idempotente; a mesma identidade com
payload divergente falha como conflito, e cursor com versao stale causa rollback
do range inteiro. O `rangeStart` precisa coincidir com o cursor persistido e o
checkpoint precisa ser exatamente `nextBlock - 1`, impedindo salto de blocos.

O RT2B2 aplicara eventos pendentes aos balances/totais e marcara no journal os
valores antes/depois. Ate la, esta captura nao deve ser iniciada em producao.

#### Corte RT2B2 - Aplicacao atomica shadow

Status: implementado e commitado; nenhum runner ligado.

A aplicacao trava o cursor global para serializar consumidores, escolhe o proximo
evento elegivel em ordem on-chain e trava estado/balances do token. Mint, burn,
transfer e self-transfer atualizam balances positivos, total e journal na mesma
transacao. Saldo de origem insuficiente marca o token `drifted` e deixa o evento
pendente para resync, sem bloquear tokens ainda saudaveis.

O proximo corte cobre rollback de reorg. Captura/aplicacao continuam desligadas.

#### Corte RT2C1 - Procedencia reversivel do journal

Status: implementado e commitado; migration ainda nao aplicada em producao.

A Stage 117 acrescenta ao journal a procedencia anterior de bloco, transacao e
log das wallets de origem/destino. A aplicacao atomica salva essa evidencia antes
de substituir ou apagar o balance, permitindo ao rollback restaurar tambem o
ultimo evento conhecido. Esses campos pertencem ao journal curto e serao podados
fora da janela de reorg; nao constituem historico permanente de wallets.

O proximo corte implementa a reversao atomica e o rewind do cursor. Nenhum runner
ou publicacao foi ligado.

#### Corte RT2C2 - Rollback atomico de reorg

Status: implementado e commitado; nenhum runner ligado.

O repositorio recebe o novo `nextBlock` e o checkpoint canonico imediatamente
anterior, trava o cursor, reverte eventos aplicados em ordem on-chain inversa,
restaura balances/procedencia e subtrai os deltas de holders. Depois remove todo
o journal orfao, incluindo eventos ainda pendentes, e faz rewind do cursor na
mesma transacao. Divergencia entre o balance atual e a evidencia esperada aborta
todo o rollback; tokens ja `drifted` permanecem assim para reconciliacao segura.

Captura, rollback e publicacao continuam sem runner e desligados.

#### Corte RT2C3 - Floor duravel do journal

Status: implementado e commitado; migration ainda nao aplicada em producao.

A Stage 118 acrescenta `journal_floor_block` nullable ao cursor live. `NULL`
significa que nenhuma fronteira de retencao foi inicializada e deve bloquear poda
ou rollback que dependa dela. Quando inicializado, o floor nunca pode ficar acima
de `next_block`. O corte seguinte ligara essa fronteira a uma janela configuravel
com default de 20.000 blocos e fara deletes limitados somente no journal holder.

Nenhuma linha e removida por esta migration e o retention geral permanece
independente.

#### Corte RT2C4 - Poda limitada do journal holder

Status: implementado e commitado; nenhum scheduler ligado.

A primeira captura inicializa o floor no `rangeStart`. A operacao independente
de poda usa 20.000 blocos por default e remove somente eventos aplicados abaixo
do cutoff, em lotes de ate 5.000 linhas. Evento pendente antigo bloqueia todo o
lote; o floor avanca apenas quando nao resta nenhuma linha abaixo do cutoff.
Rollback abaixo do floor falha antes de tocar balances ou cursor.

A operacao nao depende do retention geral. O RT4F2 abaixo adiciona um scheduler
dedicado, opt-in, no grupo isolado de holders.

#### Corte RT3A - Admissao de tokens novos com deployment exato

Status: implementado localmente; nenhum worker ligado.

O repository usa `token_catalog.first_seen_at` somente como cutoff duravel da
coorte admitida depois do rollout. O inicio do replay vem exclusivamente de
`robinhood_token_attributions.attribution_block` com source `rpc_direct` ou
`launchpad_event`; discovery block e atribuicao apenas Blockscout nao sao aceitos
como deployment. A admissao idempotente cria o estado `backfilling` com
`deployment_block = backfill_next_block` e nao sobrescreve token ja inicializado.

Este corte depende das Stages 113-118 em producao. Os cortes RT3B1-RT3B3 farao o
replay limitado de `Transfer` pelo RPC proprio da VPS; nenhum request RPC ocorre
no RT3A.

#### Corte RT3B1 - Reader RPC limitado de Transfer

Status: implementado localmente; nenhum worker ligado.

O reader exige chain ID 4663, filtra `eth_getLogs` por um unico token e pelo
topico ERC-20 `Transfer`, limita cada chamada logica a 5.000 blocos e subdivide
falhas adaptativas sem ampliar a janela. Cada log e validado integralmente e
normalizado no contrato do ledger; a saida fica ordenada por bloco/transacao/log
e inclui hash de checkpoint confirmado no ultimo bloco do range.

Este subcorte recebe um RPC client injetado e nao escolhe provider nem grava no
banco. RT3B2 implementara commit atomico e cursor por token; RT3B3 conectara
reader e persistencia usando exclusivamente `ROBINHOOD_RPC_URL`, sem fallback
implicito para dRPC/public RPC.

#### Corte RT3B2 - Commit atomico do range por token

Status: implementado localmente; nenhum worker ligado.

O repository trava um token `backfilling` no `backfill_next_block` esperado,
calcula todos os eventos do range em memoria e somente depois grava os saldos em
lote. Saldos zero sao removidos, o total materializado e atualizado uma vez e o
cursor/checkpoint do token avancam na mesma transacao. Retry de range ja avancado
falha fechado; saldo negativo nao grava o range e marca somente o token `drifted`.

Ranges historicos de catch-up nao entram no journal live de 20.000 blocos. O
RT3B3 valida o checkpoint anterior e alcanca uma barreira confirmada, mas o
handoff atomico e qualquer promocao para `shadow` continuam pendentes.

#### Corte RT3B3 - Executor de um range e barreira confirmada

Status: implementado localmente; nenhum worker ligado.

Cada chamada calcula safe head com 12 confirmacoes por default, seleciona somente
token `backfilling` com trabalho confirmado, valida o checkpoint anterior e
processa no maximo um range de 250 blocos. Checkpoint orfao isola o token como
`resyncing`; chegar ao safe head apenas retorna `at-barrier`, sem promover o
estado para `shadow` nem bloquear o catch-up dos demais tokens.

O factory configurado exige `ROBINHOOD_RPC_URL` e nao consulta dRPC ou RPC publico
como fallback. Scheduler, lease entre instancias e handoff atomico com a captura
live pertencem ao macro realtime 4 e continuam desligados.

#### Corte RT3C - Worker global de backfill para tokens novos

Status: implementado localmente, opt-in e sem wiring no servidor.

Cada tick primeiro admite ate 100 tokens novos com deployment exato e depois
executa exatamente um range confirmado de ate 250 blocos. O cutoff
`admittedAfter` e obrigatorio ao habilitar e fica normalizado como timestamp
duravel; nao e derivado do horario de restart. O loop e single-flight, aplica
backoff exponencial limitado e isola falhas ao pipeline holder.

O runtime usa exclusivamente `ROBINHOOD_RPC_URL` pelo executor RT3B3. Este corte
nasceu sem config, import em `server.js` ou lease; o RT4F1 abaixo adiciona esse
wiring mantendo o worker opt-in e desligado por default.

#### Corte RT4A - Handoff atomico para shadow

Status: implementado localmente; nenhum worker ligado.

O handoff trava cursor live e estado do token e exige que `journal_floor_block`
cubra o `backfill_next_block`. O RT4E1 abaixo substitui a igualdade com o cursor
movel por uma barreira retida e verificada no RPC. Eventos anteriores a barreira
sao descartados como overlap ja aplicado pelo backfill; a cauda posterior fica no
journal para aplicacao depois da promocao atomica para `shadow`.

A operacao pressupoe que o cursor `live` represente captura global do topico
`Transfer`. Captura e loop existem nos RT4B/RT4D2, mas seguem sem wiring; portanto
o handoff nao deve ser chamado em producao fora do coordenador verificado.

#### Corte RT4B - Captura global de um range confirmado

Status: implementado localmente; nenhum loop ligado.

A operacao valida o checkpoint persistido, le no maximo 250 blocos ate o safe
head e grava transfers/cursor atomicamente pelo ledger existente. A primeira
execucao ancora o cursor no safe head atual; concorrencia continua protegida pela
versao otimista do cursor. Checkpoint divergente retorna `reorg-detected` sem write.

O request RPC usa o topico global sem filtro de address, mas decodifica somente
contratos presentes nos estados holder ativos. Isso ignora ERC-721 e outros logs
homonimos observados no probe sem multiplicar chamadas por 100 mil tokens. Loop,
lease, rollback automatico, aplicador e scheduler da poda continuam pendentes.

#### Corte RT4C1 - Fronteira segura para rollback

Status: implementado localmente; nenhum loop ou worker ligado.

O handoff preserva `backfill_next_block` depois da promocao para `shadow`. Nesse
estado o campo deixa de ser cursor mutavel e passa a representar a primeira
altura coberta pela cauda live reversivel; o baseline historico termina no bloco
anterior. Um rewind ate essa altura continua seguro pelo journal. Se o novo
`next_block` ficar abaixo dela, o rollback atravessou o baseline e marca o token
como `resyncing` na mesma transacao, em vez de publicar um total possivelmente
corrompido. Estados antigos sem fronteira conhecida tambem falham de forma
conservadora para `resyncing`.

Este corte somente tornou o primitive de rewind seguro. O RT4C2 abaixo conecta
a deteccao e a chamada automatica; o loop com lease continua pendente.

#### Corte RT4C2 - Deteccao e rewind automaticos

Status: implementado localmente; nenhum loop ou worker ligado.

Quando o checkpoint live diverge do RPC, a captura consulta os blocos distintos
com `Transfer` ainda retidos no journal e faz busca binaria pelo ultimo hash que
continua canonico. O rewind atomico recomeca no bloco seguinte a essa evidencia,
mesmo que isso recue alem do fork exato, evitando lacunas. Versao otimista do
cursor protege contra captura concorrente durante a busca.

O journal nao guarda hashes de blocos sem eventos. Se nenhum bloco retido puder
provar um ancestral, a operacao retorna `reorg-unrecoverable` sem tocar balances,
journal ou cursor. Persistir checkpoints de ranges vazios seria uma extensao de
schema separada; o loop, lease, aplicador continuo e scheduler da poda ainda nao
foram ligados.

#### Corte RT4D1 - Tick live bounded

Status: implementado localmente; nenhum loop, lease ou worker ligado.

O coordenador executa uma captura confirmada por tick e depois aplica no maximo
5.000 eventos elegiveis por default (limite configuravel entre 1 e 50.000).
Eventos que isolam um token como `drifted` contam no budget; `idle` encerra cedo.
Rewind concluido ou ausencia de evidencia canonica encerram o tick sem aplicar
mais eventos, impedindo que balances sejam alterados durante recuperacao.

Status desconhecido das dependencias falha fechado como erro de contrato. O
RT4E2 adiciona um handoff por tick; timer e lease continuam responsabilidades do
loop e do `worker-lease-manager` central no wiring posterior, sem uma segunda
camada de coordenacao.

#### Corte RT4D2 - Runtime e loop live

Status: implementado localmente e desligado por default; sem wiring no servidor.

O worker compoe ledger, reader, captura e runner sobre um unico provider criado
exclusivamente de `ROBINHOOD_RPC_URL`; `ROBINHOOD_DRPC_RPC_URL` nao e fallback.
O primeiro tick valida chain ID 4663. O loop tem intervalo default de 500 ms,
single-flight, backoff exponencial limitado e telemetria compacta sem expor URL.

`reorg-unrecoverable` interrompe o loop e propaga erro fatal para o futuro lease.
O modulo nao e importado por `server.js`, nao possui entrada em `config` e nao
pode iniciar em producao neste corte. O RT4E1 entrega o seletor e o RT4E2 o compoe
no tick; wiring, lease central e scheduler da poda continuam pendentes.

#### Corte RT4E1 - Seletor e handoff em barreira retida

Status: implementado localmente; ainda nao integrado ao loop live.

O repository seleciona um token `backfilling` cuja fronteira esteja entre o
`journal_floor_block` e o cursor live. O coordenador valida no RPC o checkpoint
do backfill imediatamente anterior; divergencia marca somente esse token como
`resyncing`. Checkpoint valido permite promover mesmo que o cursor live ja tenha
avancado, eliminando a perseguicao de uma barreira movel.

A transacao remove somente eventos anteriores a `backfill_next_block`, ja
incorporados ao baseline, e preserva os eventos posteriores pendentes para o
aplicador. O RT4E2 abaixo compoe esse coordenador no tick; wiring, lease e poda
continuam desligados.

#### Corte RT4E2 - Handoff composto no tick live

Status: implementado localmente; worker ainda sem wiring e desligado por default.

Depois de uma captura canonica (`captured` ou `idle`), o tick tenta exatamente um
handoff antes de aplicar o journal. Assim, a cauda de um token promovido pode ser
aplicada no mesmo tick. Recuperacao de reorg ou ausencia de evidencia pula tanto
handoff quanto aplicacao. Status desconhecido falha fechado como erro fatal de
contrato.

O runtime usa o mesmo database e o mesmo reader/RPC do capture para repository e
coordenador de handoff. Telemetria separa promocoes e tokens isolados. O RT4F1
abaixo adiciona config, grupo e lease sem RPC alternativo nem ativacao default.

#### Corte RT4F1 - Grupo isolado, config e leases

Status: implementado no codigo e desligado por default.

Backfill de tokens novos e live holder pertencem ao novo grupo isolado
`robinhood-holders`, com leases distintas. Ambos exigem opt-in; se qualquer um
for habilitado, `ROBINHOOD_RPC_URL` e obrigatorio. O backfill tambem exige
`ROBINHOOD_HOLDER_BACKFILL_ADMITTED_AFTER` valido e duravel. Config invalida
interrompe o boot em vez de escolher cutoff ou RPC implicitamente.

O wiring registra telemetria, propaga fatal para a lease e para os dois workers
no shutdown gracioso. `all` nao inclui grupos Robinhood isolados. Pull, migrations
ou mera presenca de `ROBINHOOD_RPC_URL` nao habilitam holders; e necessario usar
o grupo `robinhood-holders` e ativar cada flag explicitamente. No rollout, ligar
primeiro `ROBINHOOD_HOLDER_LIVE_ENABLED` e somente depois o backfill.

#### Corte RT4F2 - Scheduler isolado da poda holder

Status: implementado no codigo e desligado por default.

Uma terceira lease no grupo `robinhood-holders` executa somente a poda do journal
holder; ela nao usa RPC nem depende de `ROBINHOOD_RETENTION_ENABLED`. O default
mantem 20.000 blocos e, a cada minuto, drena no maximo 5 lotes de 5.000 eventos.
`blocked` ou `idle` encerram o tick; backlog apos o budget fica explicitamente na
telemetria e continua no tick seguinte.

A flag e `ROBINHOOD_HOLDER_JOURNAL_PRUNE_ENABLED`, false por default. O worker
propaga contrato invalido para sua lease, aplica backoff em falha transiente e
participa do shutdown gracioso. Pull e o grupo isolado, sozinhos, nao ligam a poda.

#### Corte RT5A - Admissao fria limitada com deployment exato

Status: implementado no codigo; nenhum runner ligado.

O mesmo repository de bootstrap agora admite uma coorte anterior ao cutoff
duravel, em lote limitado e ordenada dos tokens antigos mais recentes para os
mais antigos. Repeticoes sao idempotentes porque tokens ja presentes no estado
holder deixam de ser candidatos. O bloco inicial continua vindo exclusivamente
de `rpc_direct` ou `launchpad_event` com `attribution_block`; uma atribuicao apenas
Blockscout nao e promovida a evidencia exata.

O corte apenas cria estados `backfilling`, reutilizando o executor checkpointado
existente. Scheduler frio, throttle operacional e descoberta historica exata de
deployments diretos ainda estao pendentes; nenhuma consulta RPC ou externa foi
ligada pelo RT5A.

#### Corte RT5B1 - Verificacao RPC do deployment direto historico

Status: implementado no codigo; nenhum runner ligado.

O endpoint Blockscout `getcontractcreation` tambem fornece o hash da transacao,
que antes era descartado pelo adapter. Esse hash permanece apenas um hint: o novo
verificador exige chain ID 4663 no RPC, transacao top-level de criacao (`to =
null`), creator coincidente, receipt bem-sucedido, `contractAddress` igual ao
token e bloco ainda canonico. Somente essa evidencia completa produz source
`rpc_direct` com bloco exato.

O repository persiste a atribuicao historica verificada em transacao propria, sem
avancar ou reutilizar o cursor live de creators. Factory/internal deployments que
nao aparecam como `receipt.contractAddress` continuam rejeitados; launchpads
conhecidos permanecem cobertos por `launchpad_event`. Este corte ainda nao busca
candidatos nem executa RPC automaticamente; runner, throttle e checkpoint da
campanha fria pertencem aos proximos subcortes.

#### Corte RT5B2 - Tick frio limitado e retomavel

Status: implementado no codigo; nenhum timer, lease ou wiring ligado.

O repository seleciona no maximo dez tokens antigos ainda sem estado holder cuja
proveniencia continua apenas `blockscout`. `last_attempted_at` e a ausencia de
`attribution_block` formam o checkpoint da descoberta: falhas preservam o creator,
salvam um codigo seguro e so voltam a ser elegiveis depois da janela de retry;
sucessos viram `rpc_direct` e deixam definitivamente essa fila.

Cada tick faz no maximo um batch Blockscout protegido pelo scheduler, verifica os
hints serialmente no RPC e executa no maximo um range do replay existente. O
backlog e consultado antes da admissao: um novo token frio so entra, sozinho,
quando o executor esta idle. Indisponibilidade/circuit breaker do Blockscout e
reportada sem bloquear tokens que ja possuem deployment exato. Chain incorreta e
contratos internos invalidos continuam fail-closed.

O modulo one-shot recebe todas as dependencias por adapter. O RT5B3 abaixo cria
seu runtime, timer, configuracao opt-in e lease no grupo `robinhood-holders`.

#### Corte RT5B3 - Runtime frio isolado e opt-in

Status: implementado no codigo e desligado por default.

O grupo `robinhood-holders` agora pode iniciar o tick frio sob lease exclusiva,
timer single-flight e backoff limitado. A ativacao exige
`ROBINHOOD_HOLDER_COLD_ENABLED=true`, cutoff duravel
`ROBINHOOD_HOLDER_COLD_ADMITTED_BEFORE` e `ROBINHOOD_RPC_URL`; configuracao
incompleta interrompe o boot. O shutdown gracioso aguarda o tick em andamento e
a telemetria aparece no status operacional.

O runtime compartilha o mesmo client do RPC proprio entre verificador e executor,
sem fallback dRPC/publico. O scheduler Blockscout frio e separado, com default de
0,25 request/s, concorrencia 1 e no maximo um retry; seus limites absolutos sao
0,5 request/s e um retry. Pull, grupo isolado ou apenas configurar o RPC nao ligam
o worker. Com esse wiring, o macro realtime 5 esta concluido no codigo; migrations
116-118 e rollout operacional continuam pendentes. No rollout, live deve estar
saudavel antes de habilitar o worker frio.

#### Corte RT6A - Reconciliacao transitoria e promocao para live

Status: implementado no codigo; sem worker, wiring ou publicacao.

O reconciliador acompanha somente um token `shadow` por vez em memoria e exige
tres observacoes Blockscout exatas, com timestamps crescentes, antes de promover
o estado para `live`. Mismatch, indisponibilidade ou restart descartam a sequencia
transitoria e fazem a validacao recomecar, de modo que nenhuma tabela ou coluna
foi criada apenas para guardar o streak. A selecao ignora tokens com eventos live
pendentes, e a gravacao usa status, count e version otimista para impedir promocao
de um estado alterado durante a consulta externa.

Este corte entrega apenas repository e politica one-shot por dependencia
injetada. Blockscout automatico, scheduler/lease, deteccao de drift depois da
promocao e publicacao do ledger no summary/REST/socket permanecem pendentes.

#### Corte RT6B - Runtime isolado da reconciliacao

Status: implementado no codigo, opt-in e sem wiring no servidor.

O worker compoe o provider Blockscout, scheduler limitado, repository de
reconciliacao e store de summaries. Cada tick processa uma unica observacao; um
sucesso tambem atualiza o fallback/snapshot existente antes da comparacao. O
default e 0,25 request/s, concorrencia 1, um retry e intervalo de 30 segundos,
com single-flight, backoff e telemetria de promocoes/mismatches/indisponibilidade.

O modulo somente inicia com `enabled: true`, mas ainda nao e importado por
`server.js` nem possui flag/lease em config. Portanto, pull ou deploy nao executa
consultas nem promocoes. Wiring opt-in, reconciliacao continua de estados `live`
e publicacao permanecem para os proximos subcortes.

#### Corte RT6C - Wiring opt-in e lease de reconciliacao

Status: implementado no codigo e desligado por default.

O runtime entra no grupo isolado `robinhood-holders` sob a lease exclusiva
`robinhood-holder-reconciliation-worker`, participa do health operacional e do
shutdown gracioso. A flag `ROBINHOOD_HOLDER_RECONCILIATION_ENABLED` permanece
false por default; habilita-la sem `ROBINHOOD_HOLDER_LIVE_ENABLED=true` falha o
boot. Mesmo com ambas ligadas, cada tick espera o worker live estar running, sem
erro/halt e com ao menos um tick concluido antes de consultar ou promover.

Pull, deploy e o grupo isolado sozinhos nao iniciam o reconciliador. Deteccao de
drift depois da promocao e publicacao do count local continuam pendentes.

Cada item acima deve ser repartido novamente se estimar mais de 500 linhas. O
probe e a estimativa de storage sao pre-condicoes; “outros terminais fazem” nao
substitui evidencia de volume, limites de RPC e custo de banco desta chain.

#### Validacao minima da fase realtime

- unit: zero/positivo, mint, burn, self-transfer, duplicata e saldo acima de 64 bits;
- integration: commit atomico, restart no cursor, reorg e duas instancias;
- replay: total final deterministico ao variar tamanho dos ranges;
- shadow: comparacao amostral com Blockscout e explicacao de toda divergencia;
- load: lag e crescimento do banco sem degradar o pipeline de mercado;
- smoke: count REST inicial seguido por update sequenciado, sem regressao visual.

### Corte 7 - Snapshots diarios e endpoint historico

Status: implementado, validado e commitado em `574ad326`.

Estimativa: 400 a 500 linhas.

Entrega:

- um fechamento por token e dia UTC, atualizado somente por sucesso mais novo;
- persistencia atomica junto do summary corrente;
- baseline mais pontos diarios com total e delta liquido de holders;
- lacuna explicita quando nao existe o dia imediatamente anterior;
- endpoint autenticado `GET /api/robinhood/holder-history`, somente PostgreSQL.

Validacao:

- `npm run lint`;
- `npm run db:schema-check`;
- testes unitarios, de rota e integracao afetados;
- revisao integral do diff.

### Corte 8 - Aba HOLDERS e sticks no expanded chart

Status: prototipo implementado e validado localmente em 2026-08-10, mas excluido
dos commits aprovados; layout nao aprovado para rollout.

Estimativa: 400 a 500 linhas.

Arquivos previstos:

- novo client API frontend de holders;
- novo modulo UI isolado do expanded holders;
- wiring minimo em `frontend/src/ui/sections/layout-sections.ts`;
- `frontend/src/styles/app.css`;
- testes de formatacao/estado e smoke focal;
- `docs/bot-reference.md`.

Entrega:

- tabs `CHART | HOLDERS`;
- tabela full-width;
- mini chart com sticks flutuantes entre o total anterior e o atual;
- tooltip com total, delta liquido e percentual de 24h;
- paginacao cursor;
- loading/error/retry/stale;
- cleanup correto ao trocar aba/fechar modal;
- documentacao do comportamento efetivamente entregue.

Validacao:

- `npm run lint`;
- `npm --prefix frontend run build`;
- testes afetados via `node --test ...`;
- `npm run test:smoke` ou spec focal aplicavel;
- revisao integral do diff.

## Estrategia de Testes por Risco

### Unit

- normalizacao de holder count e pagina;
- endereco/token divergente;
- inteiro acima de `Number.MAX_SAFE_INTEGER`;
- cursor malformado/excessivo;
- classificacao wallet/contract/pool/burn;
- percentuais com supply zero/ausente;
- retry apenas em falha transitoria;
- rate limit, jitter e circuit breaker;
- stale/fresh/unavailable;
- formatacao compacta no frontend.

### Integration

- schema idempotente;
- sucesso seguido de falha preserva ultimo valor;
- leitura batch sem N+1;
- rota exige auth e visibilidade RH;
- pagina valida e cursor seguinte;
- falha externa vira contrato seguro;
- payload dashboard inclui count sem depender de rede.

### Smoke/E2E

- monitored RH mostra `HOLDERS` junto de liquidez;
- recent/old/manual RH preenchem `HLD`;
- Solana permanece `-`;
- expanded RH abre em `CHART`;
- clicar `HOLDERS` carrega tabela;
- `Next` usa cursor e troca a pagina;
- falha mostra retry sem fechar modal;
- voltar para `CHART` preserva o fluxo atual de trades/grafico.

Nao duplicar todas as variacoes unitarias no smoke. O smoke protege somente o
fluxo visivel montado.

## Criterios de Aceite Globais

1. Dashboard e bot continuam funcionais com Blockscout totalmente offline.
2. Nenhum request de lista/dashboard dispara fan-out externo por linha.
3. Counts RH aparecem nas tres superficies previstas.
4. Counts ausentes nao aparecem como zero.
5. Last-known value sobrevive a timeout/429/5xx.
6. Lista pagina corretamente sem converter saldos brutos para `Number`.
7. Pools, contracts e burn sao identificados, nao silenciosamente removidos.
8. O modal default e o chart atual.
9. Wallet tracking nao entra no diff.
10. Lint, builds, testes afetados e schema check aplicaveis passam.
11. Cada corte possui no maximo 500 linhas alteradas.
12. O diff integral de cada corte confirma que o escopo nao expandiu.

## Rollout Operacional

1. Implantar schema antes de habilitar o worker.
2. Manter capacidade de holders oculta no frontend ate summary worker e rota
   estarem saudaveis.
3. Iniciar worker com defaults conservadores e observar 429/timeout/latencia.
4. Confirmar que swaps/candles/alertas nao mudaram de latencia.
5. Preencher uma amostra de tokens monitored/manual.
6. Comparar count armazenado com a pagina Blockscout de tokens conhecidos.
7. Liberar counts nas listas.
8. Liberar aba expanded depois da rota estabilizar.
9. Se 429 crescer, reduzir rps/concurrency; nao aumentar retries.
10. Se endpoint por instancia mudar, trocar apenas o provider.

## Rollback

- esconder holder count e aba via capacidade/feature flag de frontend;
- parar somente o holder summary worker;
- preservar a tabela de summaries para diagnostico e retorno;
- nenhuma reversao do pipeline RH e necessaria;
- nao apagar summaries como parte do rollback imediato;
- se a rota falhar, chart/trades continuam sendo a aba default.

## Pendencias Futuras Deliberadas

- migrar para Blockscout PRO quando necessario;
- avaliar provider alternativo;
- wallet profile sob demanda;
- tracking persistente por usuario;
- alertas de whale wallet;
- holdings e PnL historicos;
- snapshots/concentracao de top holders;
- execucao dos cortes da Fase 2 realtime apos o probe de capacidade;
- Solana holders em projeto separado.

## Referencias Externas

- Blockscout requests e rate limits:
  `https://docs.blockscout.com/devs/apis/requests-and-limits`;
- Blockscout token holders:
  `https://docs.blockscout.com/api-reference/get-token-holders`;
- Blockscout REST/keyset pagination:
  `https://docs.blockscout.com/devs/apis/rest`;
- API docs da instancia Robinhood Chain:
  `https://robinhoodchain.blockscout.com/api-docs`.

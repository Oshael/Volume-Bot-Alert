# Robinhood Holders - Plano do Backfill Global Frio

Atualizado em 2026-08-11. Este documento e o handoff para substituir o cold
backfill serial por token. Ele descreve trabalho futuro; nao representa uma
feature ja ligada em producao.

## Objetivo

Construir o ledger exato de holders dos tokens RH antigos o mais rapido possivel
dentro dos limites seguros do node proprio e do PostgreSQL. O historico global de
`Transfer` deve ser lido uma vez, em vez de repetir os mesmos blocos para cada
token.

O resultado precisa entrar no pipeline live atual sem gap, duplicata ou dependencia
do Blockscout para o count publicado.

## Estado atual

- RPC principal na VPS: `http://127.0.0.1:8547`, chain ID 4663.
- Live global, backfill de tokens novos, reconciliacao, snapshot e poda holder ja
  existem e continuam sendo reutilizados.
- Retencao do journal live: 20.000 blocos.
- O frontend expanded nao faz parte deste projeto.
- O cold atual deve permanecer desligado:
  `ROBINHOOD_HOLDER_COLD_ENABLED=false`.
- Ultima amostra operacional informada pelo usuario: 46 `backfilling`, 5
  `drifted`, 75 `live` e 324 `shadow`. Esses numeros mudam em runtime.
- Os cinco `drifted` existentes ficam isolados; a campanha global nao deve
  reprocessar tokens que ja possuem state.

Commits recentes relevantes:

- `235669d4`: hardening do drift no tail live;
- `07597e0f`: referencia operacional desse hardening;
- `06ac027f`: recovery de drift por receipts;
- `2068fb23`: comparacao do probe com receipts.

Ha mudancas locais de frontend fora deste escopo. Antes de editar, revisar
`git status` e nao incluir `app.css`, `layout-sections.ts`, o smoke do chain
selector ou os arquivos locais do expanded holders.

## Por que o cold atual nao serve

O fluxo atual em `robinhood-holder-cold-tick.js`:

1. verifica no maximo dez hints de deployment;
2. executa somente um range do executor per-token;
3. admite no maximo um token antigo apenas quando o replay inteiro esta idle;
4. repete `eth_getLogs` desde o deployment para cada token.

Com aproximadamente 102 mil tokens, o default de uma admissao por minuto tem piso
teorico de cerca de 71 dias apenas para admitir a fila. Um token com dezenas de
milhoes de blocos impede a admissao do seguinte. O gargalo real e repetir o mesmo
historico por contrato.

O cold existente nao deve ser apagado no primeiro rollout. Mantê-lo desligado
preserva rollback e evita misturar a troca de arquitetura com remocao de codigo.

## Componentes que serao reutilizados

- `robinhood-holder-transfer-reader.js`: `readGlobalRange` ja consulta o topico
  global e filtra contratos localmente.
- `robinhood_holder_balances`: ledger final token + wallet.
- `robinhood_holder_token_states`: fronteira publicada depois do handoff.
- live cursor, journal, rollback de reorg e poda existentes.
- handoff `backfilling -> shadow`, reconciliacao `shadow -> live` e publicacao.
- snapshots diarios, REST e socket.
- leases e grupo isolado `robinhood-holders`.

Nao espalhar logica de campanha em `server.js` ou `config/index.js`; esses arquivos
recebem somente wiring/configuracao.

## Arquitetura alvo

### 1. Campanha e coorte duraveis

A Stage 120 deve criar uma campanha global unica e uma tabela de tokens da coorte.
Nomes sugeridos:

- `robinhood_holder_global_backfill_runs`;
- `robinhood_holder_global_backfill_tokens`.

A campanha guarda status, `next_block`, ultimo checkpoint, cutoff do catalogo,
barreira de attach, versao e telemetria resumida. A coorte guarda token, count
provisorio, status e eventual motivo de exclusao.

Ao congelar a coorte:

- selecionar tokens RH anteriores ao cutoff;
- excluir qualquer token que ja exista em `robinhood_holder_token_states`;
- nunca adicionar silenciosamente tokens descobertos depois do freeze;
- permitir somente uma campanha ativa.

Balances provisorios podem usar `robinhood_holder_balances`, pois a campanha ainda
nao cria token state e, portanto, nada e publicado. A coorte guarda o holder count
provisorio.

### 2. Scan global e commit ordenado

- Comecar do bloco 0; transfers anteriores ao deployment simplesmente nao existem.
- Consultar `Transfer` sem filtro de address.
- Filtrar em memoria pelo conjunto congelado da coorte.
- Buscar ranges RPC em paralelo, mas aplicar/commitá-los estritamente em ordem.
- Um restart descarta somente prefetch nao commitado e retoma do cursor duravel.
- Cada commit atualiza balances positivos, counts dos tokens tocados, checkpoint e
  cursor na mesma transacao.
- Nao gravar o journal historico completo.

Defaults iniciais propostos:

- range: 250 blocos;
- prefetch concorrente: 4;
- limite configuravel: 1 a 8;
- timeout RPC: 15 segundos com split adaptativo existente;
- margem historica de finality antes do attach: pelo menos 2.000 blocos.

O prefetch deve reduzir automaticamente se aumentarem timeout, split, latencia do
banco ou lag do live. O backfill global nunca pode atrasar swaps, candles, alertas
ou o cursor holder live.

### 3. Eventos invalidos e deficit

Nao ignorar silenciosamente um log do contrato permitido:

- log fora do formato ERC-20 deve excluir o token inteiro da campanha e apagar seu
  baseline provisorio, sem publicar count parcial;
- saldo negativo deve parar o commit do range;
- usar receipts apenas no bloco/range suspeito para diferenciar omissao do
  `eth_getLogs` de token invalido;
- falha nao confirmada deve ficar retomavel, sem avancar cursor.

### 4. Attach ao live sem lacuna

Nao manter 5-10 dias de journal enquanto o scan historico roda. O attach so comeca
quando o cursor global estiver dentro de uma janela curta do cursor live, sugerida
em 10.000 blocos e obrigatoriamente menor que a retencao de 20.000.

Sequencia:

1. travar o live cursor;
2. registrar `barrier_block = live.next_block` e o checkpoint anterior;
3. ativar a coorte como escopo adicional da captura live;
4. incrementar a versao do live cursor sem avancar bloco;
5. qualquer captura em voo com o escopo antigo falha no compare-and-swap e repete;
6. a captura live passa a guardar eventos da coorte a partir da barreira;
7. o scanner historico termina ate `barrier_block - 1`;
8. materializar os token states com count/checkpoint exatos;
9. liberar os tokens para o handoff atual e depois para reconciliacao.

Enquanto a campanha estiver anexada, o executor per-token deve excluir seus
membros. O journal posterior a barreira permanece pendente ate o state chegar a
`shadow`; assim, os eventos sao aplicados uma unica vez pelo live existente.

Antes de materializar states, exigir que o checkpoint da barreira continue
canonico e tenha a margem de finality definida. Divergencia falha fechado.

### 5. Publicacao e conclusao

Um token so sai da campanha quando:

- o baseline global chegou exatamente a barreira;
- o checkpoint foi validado;
- o state foi criado com count e cursor coerentes;
- o handoff removeu overlap pendente, se houver;
- reconciliacao promoveu o token normalmente.

Tokens excluidos/invalidos continuam usando o fallback ja existente e nunca
aparecem como `ledger_live`.

## Throughput e armazenamento

Probe executado no node da VPS:

- 2.000 blocos em aproximadamente 201 segundos;
- 20.186 eventos globais;
- 417 tokens e 5.920 pares token-wallet tocados;
- projecao superior de ledger: aproximadamente 407 MB por dia de chain time;
- projecao de journal: aproximadamente 1,9 GB por dia, motivo para nao persistir
  o historico bruto.

No ritmo sequencial, 33 milhoes de blocos representam aproximadamente 38 dias.
Prefetch 4-8 sugere alvo inicial de 5-10 dias, mas isso nao e SLA. RPC, commits,
WAL, indexes e pressao de disco precisam ser medidos na VPS.

Provisionar margem antes do rollout. O upper bound bruto do ledger para todo o
historico fica na ordem de 15-20 GB; considerar 40-60 GB livres durante a campanha
para indexes, WAL e margem operacional ate existir medicao real.

## Cortes obrigatorios

Estimativa total: 1.900-2.400 linhas de codigo/testes, mais documentacao. Cada
corte para, valida, revisa diff e cria commits antes do seguinte.

| Corte | Entrega | Estimativa |
|---|---|---:|
| G1 | Stage 120, campanha/coorte/cursor e lifecycle repository | 430-490 |
| G2 | Aplicacao atomica global em balances/counts | 420-490 |
| G3 | Scanner com prefetch concorrente e commit ordenado | 400-480 |
| G4 | Fence do live cursor, escopo de attach e handoff sem gap | 430-500 |
| G5 | Worker opt-in, config, lease, telemetria e rollout | 350-450 |

### Primeiro corte: G1

Arquivos previstos:

- novo `src/utils/db-init-stage120.js`;
- `src/utils/runtime-schema.js`;
- novo `src/models/robinhood-holder-global-backfill.js`;
- teste focal de schema;
- integracao PostgreSQL do lifecycle campanha/coorte/cursor.

O G1 nao chama RPC, nao grava balances e nao inicia worker.

Validacao do G1:

- `npm run lint`;
- testes focais via `node --test ...`;
- integracao PostgreSQL afetada;
- `npm run db:schema-check`;
- `git diff --check` e revisao integral;
- commit de codigo/testes e commit de docs separados.

## Telemetria minima

- blocos por segundo e ETA;
- ranges fetched/committed e prefetch atual;
- eventos observados, aceitos e malformados;
- tokens e wallets tocados;
- RPC requests, splits, erros, bytes e p50/p95/p99;
- duracao p50/p95 dos commits;
- WAL/disco e crescimento de balances;
- distancia ate a barreira;
- lag do cursor live antes/depois de cada ajuste;
- tokens concluidos, excluidos e falhos.

## Rollout

Flag proposta: `ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ENABLED=false` por default.

1. Aplicar Stage 120 com todos os workers globais desligados.
2. Validar schema e criar campanha em dry-run/preview.
3. Rodar amostra global read-only em ranges antigos e recentes.
4. Ligar com prefetch 1, medir RPC/PostgreSQL/live lag.
5. Subir para 2 e depois 4 somente com evidencia estavel.
6. Avaliar 6-8 apenas se node, WAL e live continuarem saudaveis.
7. Fazer attach automatico somente dentro da janela configurada.
8. Conferir amostra contra Blockscout apenas como auditoria externa.
9. Manter o cold serial desligado durante toda a campanha.

## Rollback

- desligar somente `ROBINHOOD_HOLDER_GLOBAL_BACKFILL_ENABLED`;
- preservar campanha/cursor para diagnostico e retomada;
- states existentes e live continuam funcionando;
- tokens ainda sem state continuam no fallback;
- nao apagar balances/campanha automaticamente no rollback;
- se o attach ja iniciou, falhar fechado e retomar do checkpoint, sem promover
  baseline incompleto.

## Criterios de aceite

1. Cada bloco historico e consultado uma vez por campanha, salvo retry/split.
2. RPC pode buscar fora de ordem; PostgreSQL nunca commita fora de ordem.
3. Restart retoma sem duplicar balance/count.
4. Nenhum count global incompleto e publicado.
5. Attach nao perde nem duplica eventos na fronteira.
6. Reorg/checkpoint divergente impede promocao.
7. Historico bruto nao ocupa o journal permanente.
8. Live lag e pipelines de mercado nao degradam.
9. Tokens com state anterior permanecem intactos.
10. Feature continua opt-in e reversivel.

## Instrucao para o proximo chat

1. Ler `AGENTS.md` e este documento inteiro.
2. Rodar `git status` e preservar as mudancas locais de frontend.
3. Validar o desenho contra os arquivos citados; nao voltar ao replay per-token.
4. Implementar somente o G1.
5. Parar apos validacao, diff e commits; aguardar autorizacao para o G2.

Ponto importante: o objetivo continua sendo cobrir todo o catalogo antigo. A
otimizacao central e globalizar a leitura historica, nao reduzir silenciosamente o
escopo para apenas tokens monitorados.

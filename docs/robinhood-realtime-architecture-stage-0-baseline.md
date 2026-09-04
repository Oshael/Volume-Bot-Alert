# Arquitetura realtime Robinhood — baseline da Etapa 0

Status: baseline parcial; não autoriza backfill, cutover ou alteração de runtime.
Data da coleta: 2026-09-04.
Fonte operacional: resultados de consultas somente leitura e metadata de leases
fornecidos pelo operador. O agente não possui acesso direto à VPS.

## 1. Objetivo e limites

Este documento registra a fotografia usada para preparar a primeira fatia da
[arquitetura realtime](robinhood-realtime-architecture-execution-plan.md). Ele
separa fatos medidos, interpretação e pendências. Não substitui o
[bot-reference](bot-reference.md), que continua descrevendo a operação vigente.

O baseline cobre prioritariamente captura canônica, holders e liquidity porque
esses três caminhos apresentaram atraso. A matriz estática também registra as
dependências Robinhood que precisam permanecer no inventário antes de declarar
o gate G0 concluído.

Não foram executados comandos de escrita, seeds, repairs ou backfills. Uma
consulta exata ao journal holder foi cancelada pelo operador após apresentar
custo excessivo. Seu resultado não é usado neste documento e ela não deve ser
repetida na VPS.

**Ponto importante:** os valores abaixo são uma fotografia, não configuração nem
meta. Metadata de lease expirada é evidência histórica e não prova que o processo
continua ativo.

## 2. Resultado executivo

O estado observado não permite iniciar backfill amplo. Captura canônica,
holder live/apply e liquidity estavam sem lease ativa no instante consultado.
Os dois backlogs informados existem, continuam crescendo quando seus produtores
param e possuem causas diferentes:

- holders acumula atraso tanto na captura quanto no apply por token;
- liquidity acumula atraso no scan legado e falha de valoração por pool;
- a captura canônica shadow também está atrás e sua própria referência de head
  estava congelada, subestimando o atraso exibido;
- executar manutenção agora competiria com a recuperação do live e não criaria
  a evidência perecível que ainda falta ao caminho novo.

A prioridade permanece: proteger eventos futuros, recuperar uma captura
contínua, separar as fronteiras por domínio e somente então construir bases
mínimas por token/pool. Histórico amplo permanece posterior aos gates G0–G9.

## 3. Fotografia operacional recebida

### 3.1 Frontiers

| Componente | Próximo bloco | Checkpoint | Head de referência gravado | Lag informado | Idade do cursor |
|---|---:|---:|---:|---:|---:|
| Captura canônica shadow | 53.989.741 | 53.989.740 | 54.199.470 | 209.730 | 12h33m |
| Holder live | 54.110.771 | 54.110.770 | 54.628.387 | 517.617 | 16m56s |
| Liquidity | 53.754.644 | 53.754.643 | 54.601.398 | 846.755 | 42m50s |

O head da captura canônica também estava 12 horas desatualizado. Usando apenas
como aproximação o head mais recente observado pelo holder, a distância da
captura canônica era de aproximadamente 638.647 blocos. Esse valor não substitui
uma leitura simultânea do node; demonstra apenas que `lagBlocks=209730` não era
um indicador atual.

Os heads diferem porque vieram de processos e instantes distintos. Eles não
devem ser comparados como se fossem uma amostra atômica nem usados para escolher
o bloco `C`.

### 3.2 Leases e recursos

Todas as leases solicitadas retornaram `active = false`:

- `robinhood-chain-capture-worker`;
- `robinhood-holder-live-worker`;
- `robinhood-holder-live-apply-worker`;
- `robinhood-holder-backfill-worker`;
- `robinhood-holder-global-backfill-worker`;
- `robinhood-pool-liquidity-worker`.

Os campos `running`/`inFlight` presentes na metadata não contradizem esse fato:
eram o último heartbeat persistido. As idades variavam entre cerca de 16 minutos
e três dias.

A última metadata da captura canônica mostrou somente 5,7% de disco livre. Uma
amostra posterior de outro processo no mesmo hostname mostrou 16,5%. Como as
amostras não são simultâneas, o baseline registra risco de capacidade, não um
valor atual confiável. Retenção não pode ser ampliada antes de conferir espaço,
WAL e crescimento por bloco no host real.

### 3.3 Captura canônica shadow

Última evidência disponível:

- modo `shadow_receipts`;
- transporte em `polling_fallback`, sem `newHeads` ativo naquele heartbeat;
- 9.911 blocos, 143.470 transações e 809.264 eventos acumulados na sessão;
- último bloco commitado com 16 transações, 52 eventos e 23 trabalhos;
- 11 ms de fetch e 18 ms de commit no último bloco;
- zero snapshots V3 persistidos e 21.584 pools V3 puladas por estarem fora da
  janela configurada;
- lease expirada havia mais de 12 horas.

Os tempos do último bloco mostram que um bloco isolado foi barato, mas não
comprovam capacidade de catch-up, estabilidade ou cobertura de estado. O número
de pools V3 puladas confirma que simplesmente drenar o journal bruto não recupera
a evidência V3 perecível.

### 3.4 Holders

Estados por token:

| Estado | Tokens | Menor frontier de backfill | Menor frontier live | Maior frontier live |
|---|---:|---:|---:|---:|
| `backfilling` | 5 | 51.012.789 | 52.761.671 | 53.640.543 |
| `drifted` | 71 | 33.321.584 | 33.325.668 | 53.827.394 |
| `live` | 136.313 | 33.321.559 | 33.321.568 | 54.091.270 |
| `shadow` | 205 | 38.409.987 | 38.692.314 | 38.692.314 |

Um frontier antigo em token `live` não prova atraso quando o token não recebe
transferências. A evidência relevante para trabalho pendente vem da hot queue e
do apply, não do mínimo global dessa coluna.

Última telemetria do apply:

- 2.374 tokens pendentes;
- 2.370 tokens `live` e quatro `shadow` classificados como stale;
- pior lag de 15.935.996 blocos;
- evento pendente mais antigo com aproximadamente 18,9 dias;
- zero eventos aplicados na última rodada;
- uma tentativa de apply, uma suspeita de drift e budget esgotado;
- timeout ao tentar obter conexão durante `hot_selection`;
- 1.250 eventos aplicados no acumulado daquela sessão.

Última telemetria da captura holder:

- 22.538 transfers capturados na última rodada;
- 1.489.906 transfers capturados no acumulado da sessão;
- frontier ainda 517.617 blocos atrás do safe head;
- lease expirada cerca de 16 minutos antes da consulta.

O apply observado não sustenta a entrada produzida pela captura. Trocar somente
a fonte do journal manteria esse gargalo e poderia aumentar a pressão no banco.

O backfill incremental tinha concorrência configurada em quatro, mas a última
sessão gravou somente oito ranges antes de sua lease ficar inativa. O backfill
global permanecia marcado `inFlight`, sem rodada concluída, porém sua lease
estava expirada havia três dias. Esse estado deve ser tratado como campanha
interrompida até revalidação; não como worker em execução.

### 3.5 Liquidity

| Protocolo | Pools ativas | Linhas snapshot | Pools com base/valor | Pools com falha | Cobertura valorada |
|---|---:|---:|---:|---:|---:|
| Uniswap V2 | 14.871 | 7.584 | 6.413 | 1.542 | 43,1% |
| Uniswap V3 | 423.470 | 248.433 | 89.582 | 182.758 | 21,2% |
| Uniswap V4 | 556.903 | 264.650 | 195.598 | 76.807 | 35,1% |
| Total | 995.244 | 520.667 | 291.593 | 261.107 | 29,3% |

`snapshot_rows` não equivale a valor disponível: uma linha pode registrar falha
ou indisponibilidade sem `liquidity_usd`. A cobertura total valorada é 29,3%;
52,3% das pools têm alguma linha de snapshot e 26,2% das pools ativas aparecem
com falha acumulada.

Última telemetria do worker:

- 846.799 blocos de lag no heartbeat;
- quatro polls e quatro erros;
- erro mais recente `eth_getLogs timeout`;
- range reduzido para dez blocos;
- 50 blocos processados na sessão;
- 180 pools afetadas, zero salvas e 180 falhas no acumulado da sessão;
- no último lote, 33 pools afetadas, zero salvas e 33 falhas;
- 2,77 s dos 2,96 s do último lote atribuídos ao prefetch V4;
- lease expirada cerca de 41 minutos antes da consulta.

O replay V4 histórico estava `completed` até o bloco 26.210.402. Isso prova o
encerramento daquela campanha, não a suficiência da base atual nem cobertura
posterior. O estado da materialização V4 não foi incluído na evidência recebida e
fica pendente para o gate específico, sem bloquear a decisão imediata de não
iniciar backfill.

A cardinalidade de 995.244 pools ativas é também um multiplicador de custo. A
Etapa 0 não presume que todas são inválidas nem que todas precisam de valoração
imediata; exige definir elegibilidade e ausência por produto antes de reservar
recursos.

## 4. Matriz estática de fontes e consumidores

| Domínio | Gatilho/fonte live atual | Estado/leitura complementar | Projeção/consumidor | Lacuna para o alvo |
|---|---|---|---|---|
| Captura EVM | blocos e receipts do node local | snapshots V3 dentro da janela | journal e outbox discovery/market | captura parada; estado perecível incompleto; reorg ainda não centralizado integralmente |
| Discovery | poller/head legado ou outbox canônica shadow | metadata ERC-20, code e validações de launchpad | registry e catálogo | canário não é produtor; ordem mínima precisa permanecer causal |
| Market | poller/head legado ou outbox canônica shadow | supply, quote USD e estado por protocolo | captures, processing, observações e buckets | waits/polling e evidência de estado ainda precisam do contrato comum |
| Liquidity | `eth_getLogs` em ranges próprios | V2/V3 por calls; V4 por ranges materializados | snapshot corrente por pool | cursor atrasado, timeouts e falhas por pool; ainda não consome journal comum |
| Holder capture | `eth_getLogs` topics-only por range | catálogo e fronteiras do ledger | journal holder | cursor atrasado; leitura duplica captura da cadeia |
| Holder apply | journal e hot queue | balances, checkpoint e receipts para drift | ledger, count e publicação | apply abaixo da entrada e pressão de conexão no banco |
| Holder bootstrap | backfill por token ou campanha global | deployment comprovado, staging e hash | handoff para shadow/live | campanhas interrompidas; bases largas continuam incompletas |
| Wallet transfer | scan de transfers e posição própria | code/classificação por endpoint | transferências de wallets | deve compartilhar eventos e manter cursor independente |
| Wallet swap | observação aceita e releitura de transação/bloco | `tx.from` e posição | swaps/posições por wallet | contexto já existe no journal novo, mas consumidor ainda não migrou |
| Deployment/creator | receipt, `tx.from`, Blockscout e code histórico | trace quando disponível | atribuição e classificações | criação interna pode exigir evidência que receipt não contém |
| FRESH/first buy | swaps, nonce, timestamp e lookback | archive/seed anterior à captura v2 | classificação de wallet | lookback ausente deve ser `unknown`, não negativo |
| Funding/BUNDLED | value nativo, transfers e relações | lookback e contexto de transação | classificação e redistribuição | retenção mínima ainda não foi dimensionada |
| Derived/alertas | projeções e outboxes PostgreSQL | regras, autorização e dedupe | Telegram/socket | confirmar durabilidade por consumidor e correções de reorg |
| Interface | REST inicial e eventos socket | sequências, frontier e freshness | cards, chart e holders | qualidade/fonte ainda não é uniforme por campo |
| Metadata social/imagens | Blockscout, DexScreener, URI/IPFS | filas e caches assíncronos | catálogo/interface | adapter externo separado; não pertence ao journal EVM |

Solana, X/callouts e outras fontes externas permanecem fora do journal EVM.
Elas precisam de inventário e aceite próprios para qualquer afirmação sobre
“todos os dados do bot”, mas não fazem parte do primeiro cutover Robinhood.

## 5. Fronteiras necessárias

Nenhuma das fronteiras abaixo está autorizada com os números desta fotografia:

- `C`: primeiro bloco integralmente coberto pela captura nova, com versão, hash,
  tópicos e estados obrigatórios preservados;
- `H_domínio`: último bloco assumido pelo writer antigo antes da exclusão;
- `B_token`: base holder completa e verificada para um token;
- `B_pool`: base suficiente e verificada para uma pool/protocolo;
- `P_domínio`: último bloco efetivamente aplicado pela projeção daquele domínio.

O cursor canônico existente não pode ser usado como `C` porque houve interrupção
e snapshots V3 pulados. Os cursores holder/liquidity existentes não podem ser
movidos para o head para esconder seus intervalos faltantes.

Para holders, `B_token` exige staging, checkpoint/hash e cobertura contígua até o
handoff. Para liquidity, `B_pool` varia por protocolo: V2 pode derivar reservas
quando o contrato do evento permitir; V3 requer saldos/estado ancorados; V4 exige
ranges/ticks materializados e replay compatível.

## 6. Orçamento e SLO ainda pendentes

Antes de habilitar qualquer produtor novo, medir no mesmo intervalo:

- blocos e bytes capturados por segundo;
- entrada e apply de transfers por segundo, incluindo commits e filas de conexão;
- pools afetadas, valoradas e salvas por segundo por protocolo;
- crescimento de journal, outbox, WAL e disco por hora;
- head do node e todos os frontiers usando a mesma amostra temporal;
- p50/p95/p99 do receipt observado à projeção, separados do node e do browser.

A meta proposta pelo plano permanece p95 até 500 ms e p99 até 1 s em regime
saudável para entidades com base válida. Ela ainda não foi comprovada nem deve
ser usada durante catch-up.

Medições futuras na VPS devem usar índices e limites já conhecidos. Evitar
`COUNT(*)`/`COUNT(DISTINCT ...)` exatos sobre journals volumosos. Preferir hot
queue, cursores, telemetry persistida, amostra limitada ou `EXPLAIN` sem
`ANALYZE` antes de qualquer agregação nova.

## 7. Decisões e gates desta fatia

- Etapa 0: parcialmente concluída; inventário estático e baseline dos três
  componentes críticos estão registrados.
- G0: não aprovado; capacidades do node, materialização V4, retenção e fontes
  externas ainda não têm evidência final.
- G1: não aprovado; captura não estava contínua e a evidência perecível V3 tinha
  skips conhecidos.
- G4: não aprovado; holders e liquidity ainda usam leitores próprios e grande
  parte das entidades não possui base atual validada.
- G7/G8: não aprovados; apply holder, liquidity e leases não demonstraram
  estabilidade ou capacidade superior à entrada.

Decisões vigentes:

1. não iniciar backfill amplo;
2. não avançar nem apagar cursores legados;
3. não ativar fan-out holder/liquidity enquanto captura, retenção e budget de
   armazenamento não estiverem protegidos;
4. tratar metadata expirada como diagnóstico histórico;
5. separar recuperação do live, bootstrap mínimo e histórico de produto;
6. manter qualquer repair/archive fora do caminho live e subordinado ao budget.

## 8. Próximo checkpoint

A próxima fatia de código deve ser pequena e anterior ao fan-out de holders ou
liquidity. Ela precisa tornar a continuidade da captura observável e impedir que
head/lag congelados pareçam saúde atual, mantendo o modo shadow e sem mudar
projeções públicas.

Antes de implementá-la, delimitar os arquivos de captura, health/readiness e
testes que já possuem esse contrato. A fatia deve permanecer abaixo de 500 linhas,
usar flags desligadas por default quando adicionar comportamento e não depender
de uma operação na VPS para seus testes locais.

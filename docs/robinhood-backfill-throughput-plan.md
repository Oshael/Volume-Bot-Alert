# Plano de throughput do backfill da Robinhood

Status: proposta para execucao por cortes

Data-base: 2026-07-23

Escopo: discovery e market backfill historico da Robinhood Chain

## 1. Objetivo

Fazer o backfill usar de fato a capacidade dos provedores pagos e conseguir
alcancar a ponta da chain em prazo previsivel, sem perder:

- ordem deterministica;
- idempotencia por log;
- cobertura continua, sem buracos silenciosos;
- recuperacao apos restart;
- validacao de reorg;
- compatibilidade com as observacoes, buckets e agregados atuais.

O objetivo operacional inicial e:

- levar o scanner de discovery a pelo menos `9.000 blocos/min`;
- levar o scanner de market a pelo menos `12.500 blocos/min`;
- manter o enriquecimento drenando mais rapido do que o scan produz trabalho;
- alcançar a ponta historica em aproximadamente 24 horas, se a densidade de
  eventos e os limites reais do provedor permitirem;
- caso a meta nao seja sustentavel, produzir uma ETA confiavel e mostrar
  exatamente qual recurso limita a execucao.

Essas metas devem ser recalculadas na hora do rollout. Elas nao podem ficar
fixas no codigo.

## 2. Diagnostico confirmado no codigo

O problema atual nao e simplesmente `RANGE_SIZE`, PostgreSQL ou falta de
concorrencia em uma funcao.

### 2.1 O cursor de market espera todo o enriquecimento

Hoje, para cada faixa:

1. o poller executa `eth_getLogs`;
2. carrega timestamps;
3. decodifica os swaps;
4. executa chamadas historicas para supply e cotacao;
5. monta observacoes;
6. grava observacoes e buckets;
7. somente entao atualiza o cursor.

Portanto, enquanto os requests sobem, o cursor pode ficar parado por muitos
minutos. Isso nao significa necessariamente deadlock; significa que a unidade
de commit e grande e inclui trabalho remoto caro.

### 2.2 Aumentar `OBSERVATION_CONCURRENCY` nao resolve o gargalo

A concorrencia atual apenas permite mais observacoes em construcao ao mesmo
tempo. Ela nao:

- agrupa chamadas iguais;
- faz batch de `totalSupply` por bloco;
- separa captura de enriquecimento;
- permite que o cursor de scan avance antes das chamadas historicas;
- garante paralelismo eficiente para o mesmo token.

O pipeline ainda serializa resolucoes de supply do mesmo token para proteger a
reconstrucao historica. Isso explica por que subir a concorrencia de `2` para
`8` consumiu mais requests sem melhorar o resultado medido.

### 2.3 O dRPC nao recebe o scan historico atual

O roteador atual envia para os provedores archive apenas:

- `eth_call`;
- `eth_getCode`;
- `eth_getStorageAt`;

quando o block tag e historico.

`eth_getLogs`, `eth_getBlockByNumber` e `eth_blockNumber` continuam no RPC
publico da Robinhood. Logo, habilitar o dRPC hoje acelera somente parte do
enriquecimento. Ele nao o transforma automaticamente no provedor primario de
varredura.

### 2.4 Discovery e market executam em serie

O runner aguarda o poll de discovery terminar e depois executa market. Market
tambem fica limitado ao ultimo bloco concluido por discovery.

Esse limite de seguranca e correto, porque market precisa do catalogo de pools.
O problema e executar os dois trabalhos caros no mesmo ciclo, em vez de manter
frontiers independentes.

### 2.5 O poller processa faixas sequencialmente

Mesmo que o endpoint aceite varias requisicoes simultaneas, o desenho atual
busca, processa e confirma uma faixa antes de iniciar a seguinte.

Para usar um provedor pago, o scanner historico precisa permitir varias leituras
em voo e manter o commit em ordem.

### 2.6 O schema atual nao e uma fila duravel de enriquecimento

`robinhood_processed_logs` guarda uma identidade compacta, mas nao guarda o
payload bruto completo (`address`, `topics` e `data`). Ele nao permite adiar a
decodificacao/enriquecimento e reconstruir o evento depois de um restart.

Tambem nao possui:

- status de processamento;
- lease por item;
- numero de tentativas;
- erro;
- proxima tentativa;
- associacao com uma faixa capturada.

Uma fila em memoria nao serve para este backfill.

### 2.7 A retencao existente e de tres dias

O ledger compacto e as observacoes atuais expiram em tres dias. A nova fila nao
pode apagar trabalho pendente com base nessa retencao.

Linhas de staging so poderao ser removidas depois de:

1. enriquecimento terminal;
2. persistencia das saidas;
3. avanço do watermark continuo;
4. janela adicional de seguranca.

## 3. Evidencia de producao usada como baseline

Medicoes observadas em 2026-07-23:

| Cenario | Avanco de market | Tempo | Throughput aproximado |
|---|---:|---:|---:|
| Execucao anterior | 5.000 blocos | ~20 min | ~245 blocos/min |
| dRPC, faixa de 5.000 | 20.000 blocos | ~84m55s | ~236 blocos/min |
| Concorrencia 8 | 5.000 blocos | ~27m03s | ~185 blocos/min |

No ultimo ponto medido:

- head da chain: aproximadamente `17.668.660`;
- cursor de market: aproximadamente `981.041`;
- gap estatico: aproximadamente `16,69 milhoes` de blocos;
- taxa necessaria para zerar somente esse gap em 24h:
  aproximadamente `11.600 blocos/min`;
- com crescimento observado da chain, a meta pratica fica proxima de
  `12.200 blocos/min`.

Conclusao: e necessario um ganho de aproximadamente 50 vezes sobre o throughput
medido de market. Ajustar apenas variaveis nao entrega essa ordem de grandeza.

## 4. Arquitetura-alvo

O backfill sera dividido em frontiers duraveis e observaveis.

```text
                    +----------------------+
                    |  Provedor de scan    |
                    | dRPC/Alchemy/public  |
                    +----------+-----------+
                               |
                 leituras paralelas, commit ordenado
                               |
          +--------------------+--------------------+
          |                                         |
+---------v----------+                    +---------v----------+
| Discovery scanner  |                    | Market scanner     |
| pools + watermark  |------------------->| raw logs + ranges  |
+---------+----------+  limite seguro      +---------+----------+
          |                                         |
          |                              PostgreSQL durable queue
          |                                         |
          |                              +----------v-----------+
          |                              | Enrichment workers   |
          |                              | batch + dedupe + RPC |
          |                              +----------+-----------+
          |                                         |
          |                              observations + buckets 1m
          |                                         |
          |                              +----------v-----------+
          +----------------------------->| Contiguous finalizer |
                                         +----------+-----------+
                                                    |
                                     market enriched watermark
                                                    |
                                         agregados assincronos
```

### 4.1 Frontier de discovery

Responsabilidades:

- buscar logs de factories/managers;
- decodificar criacoes de pools;
- persistir o catalogo;
- avançar um cursor proprio;
- publicar o maior bloco seguro disponivel para market.

Mudancas:

- roda independente de market;
- usa provedor de scan configuravel;
- permite varias faixas em voo;
- confirma faixas em ordem;
- publica progresso durante uma faixa longa;
- aplica backpressure independente.

O comportamento de validacao especial do Noxa deve ser medido separadamente.
Se ele aparecer como gargalo, sua chamada on-chain sera movida para uma fila
propria sem bloquear a descoberta basica do pool.

### 4.2 Frontier de captura de market

Responsabilidades:

- executar `eth_getLogs`;
- filtrar emissores conhecidos;
- validar e normalizar o payload;
- persistir os logs brutos rastreados;
- registrar a faixa, inclusive quando ela nao possui nenhum log;
- avançar `market_scan` somente depois do commit.

Essa etapa nao pode executar:

- `totalSupply`;
- leitura historica de metadata;
- cotacao do WETH;
- escrita de observacoes finais;
- refresh de buckets agregados.

O scanner persiste, no minimo:

- chain;
- transaction hash;
- log index;
- block number;
- block hash;
- transaction index;
- address;
- topics;
- data;
- protocolo/market identity quando resolvidos localmente;
- id da faixa;
- status de enriquecimento;
- tentativas, lease e erro.

Idempotencia primaria:

`(chain, transaction_hash, log_index)`.

### 4.3 Manifesto de faixas

Uma tabela de faixas e obrigatoria. Apenas olhar a fila de logs nao diferencia:

- uma faixa corretamente vazia;
- uma faixa ainda nao lida;
- uma faixa lida parcialmente;
- uma faixa cujo commit falhou.

Cada faixa deve guardar:

- `from_block` e `to_block`;
- stream;
- provider;
- status;
- quantidade bruta e quantidade rastreada;
- hash/checkpoint do fim;
- inicio e fim da leitura;
- tentativas e ultimo erro;
- versao do decoder;
- timestamps de criacao e conclusao.

Faixas podem ser buscadas fora de ordem, mas so podem ser confirmadas no
watermark de scan em ordem.

### 4.4 Frontier de enriquecimento

Workers independentes reclamam trabalho com:

`FOR UPDATE SKIP LOCKED`.

Cada claim possui:

- `lease_owner`;
- `lease_until`;
- `attempt_count`;
- `next_attempt_at`;
- `last_error`.

O worker:

1. reclama um lote pequeno;
2. decodifica os swaps localmente;
3. agrupa dependencias RPC;
4. remove chamadas duplicadas;
5. executa JSON-RPC batch;
6. monta observacoes;
7. grava ledger, observacoes e buckets de 1 minuto;
8. marca os itens como terminais na mesma transacao.

O cliente RPC ja suporta batches de ate 100 requests. O plano deve reutilizar
essa capacidade, nao criar outro transporte.

Agrupamentos minimos:

- `totalSupply` por `(token, block_number)`;
- metadata imutavel por token;
- cotacao do WETH por `block_number`;
- timestamp por `block_number`;
- leituras de codigo/storage quando realmente necessarias.

Resultados de negocio como swap rejeitado sao terminais e auditaveis. Falha de
RPC nao e rejeicao de negocio.

### 4.5 Ordem por token

A reconstrucao de supply pode depender de checkpoints anteriores e posteriores.
Nao e seguro processar blocos do mesmo token em ordem arbitraria.

O planner deve:

- ordenar cada particao por `token_address`, `block_number`, `log_index`;
- manter apenas um owner ativo por token, ou particionar tokens de forma
  deterministica entre workers;
- permitir paralelismo entre tokens diferentes;
- fazer batch entre tokens sem violar a ordem dentro de cada token.

Subir a concorrencia global sem esse contrato apenas aumenta custo e disputa.

### 4.6 Frontier de finalizacao

Precisamos de watermarks diferentes:

- `discovery_scan`: pools conhecidos ate o bloco;
- `market_scan`: logs capturados ate o bloco;
- `market_enriched`: todas as saidas terminais ate o bloco;
- cobertura dos agregados: granularidades derivadas verificadas.

Os novos watermarks devem ficar em uma tabela propria de controle do backfill.
`robinhood_ingestion_cursors` hoje aceita somente os streams `discovery` e
`market`; ampliar silenciosamente esse contrato aumentaria o risco para os
consumidores atuais.

O cursor `market` atual deve continuar sendo a cobertura autoritativa para os
consumidores existentes durante a migracao. Ele nao sera reinterpretado como
“apenas escaneado”.

Ao finalizar uma faixa continua, o novo finalizador atualiza o watermark de
enriquecimento e o cursor `market` atual na mesma transacao. Discovery pode
continuar usando seu cursor atual, pois sua semantica permanece “persistido e
confirmado”.

O finalizador avanca `market_enriched` somente por faixas contiguas em que:

- o manifesto esta concluido;
- todos os logs rastreados estao terminais;
- observacoes e buckets obrigatorios foram persistidos;
- nao existe item expirado, perdido ou dead-letter sem resolucao.

Uma faixa vazia concluida tambem permite avanço.

### 4.7 Agregados

O refresh de agregados continua fora do hot path, conforme a otimizacao de
PostgreSQL ja implementada.

O scanner nao espera agregados. O enriquecedor publica alvos, e o worker de
agregacao trabalha em lote.

Cobertura de scan, enriquecimento e agregados nao deve ser exibida como se
fosse um unico status.

## 5. Provedores e uso do dRPC

Serao criados papeis explicitos:

- `head provider`: head atual e verificacoes pequenas;
- `scan provider`: `eth_getLogs` historico;
- `archive provider`: `eth_call` historico e leituras equivalentes;
- `verification provider`: amostras de auditoria, preferencialmente diferente
  do provedor principal.

O dRPC so sera usado para `eth_getLogs` depois de um probe confirmar:

- suporte ao intervalo pretendido;
- limite de resposta;
- comportamento para “too many results”;
- batch suportado;
- latencia p50/p95;
- taxa sustentada sem 429;
- consistencia contra outro provedor.

Configuracao planejada, nao ainda implementada:

```dotenv
ROBINHOOD_SCAN_PROVIDER=drpc
ROBINHOOD_ARCHIVE_PROVIDER=drpc
ROBINHOOD_VERIFICATION_PROVIDER=alchemy
ROBINHOOD_TIMESTAMP_PROVIDER=alchemy

ROBINHOOD_ALCHEMY_MONTHLY_CU_BUDGET=27000000
ROBINHOOD_ALCHEMY_MONTHLY_CU_RESERVE=3000000
ROBINHOOD_ALCHEMY_VERIFICATION_RANGE_SIZE=10

ROBINHOOD_SCAN_RANGE_SIZE=10000
ROBINHOOD_SCAN_IN_FLIGHT_RANGES=4
ROBINHOOD_SCAN_TARGET_BLOCKS_PER_MINUTE=12500

ROBINHOOD_ENRICHMENT_WORKERS=4
ROBINHOOD_ENRICHMENT_CLAIM_SIZE=200
ROBINHOOD_RPC_BATCH_SIZE=100
ROBINHOOD_PROVIDER_MAX_IN_FLIGHT=8
```

Esses numeros sao valores iniciais de canario, nao recomendacao cega para
producao. O controlador deve reduzir concorrencia ao receber 429/timeouts e
recupera-la gradualmente.

`RANGE_SIZE=10000` ajuda a reduzir overhead por request, mas nao substitui
paralelismo e desacoplamento. Uma faixa muito densa deve ser repartida
automaticamente.

## 6. Controle de custo

Requests nao sao uma unidade suficiente porque metodos podem consumir CUs
diferentes.

Devem ser medidos:

- CUs por milhao de blocos escaneados;
- CUs por log bruto;
- CUs por swap rastreado;
- CUs por observacao aceita;
- calls por metodo;
- tamanho medio dos batches;
- retries e fallbacks;
- gasto estimado por hora;
- credito restante, quando a API do provedor expuser esse dado.

Circuit breakers:

- limite de CU/hora;
- limite de custo/dia;
- pausa quando a fila ultrapassar o teto de disco;
- pausa quando o provedor entrar em 429 sustentado;
- pausa quando a auditoria encontrar divergencia.

O objetivo e gastar mais depressa somente quando isso compra throughput util.

### 6.1 Orcamento dedicado do Alchemy Free

A conta Alchemy esta dedicada a Robinhood. Considerando a franquia atual de
`30.000.000 CU` por ciclo mensal, o backfill podera consumir no maximo
`27.000.000 CU`. Os `3.000.000 CU` restantes formam uma reserva obrigatoria
para picos, diagnosticos, divergencia entre a contabilidade local e o painel e
operacao ate a virada do ciclo.

O limite de `27.000.000 CU` e teto, nao meta de consumo. A capacidade gratuita
nao deve ser gasta em trabalho que o dRPC executa de forma mais eficiente.

Prioridade de uso do Alchemy:

1. timestamps deduplicados por bloco com `eth_getBlockByNumber` em batch;
2. verificacao amostral de identidades com `eth_getLogs` em janelas de no
   maximo 10 blocos;
3. chamadas historicas de estado como capacidade auxiliar, somente enquanto
   houver budget e sem substituir o dRPC como provedor archive principal;
4. diagnosticos e verificacoes manuais dentro da reserva operacional.

O Alchemy Free nao sera usado como scanner historico principal. O limite
observado e documentado de 10 blocos por `eth_getLogs` fragmentaria o gap em
milhoes de requests e consumiria a franquia com throughput inferior ao dRPC.

Decisao operacional de 2026-07-24: nao criar ledger local de CU. O operador
acompanha o ciclo real diretamente no painel Alchemy e desliga
`ROBINHOOD_BACKFILL_ALCHEMY_TIMESTAMPS_ENABLED` ao atingir `27.000.000 CU`.
O processo precisa ser reiniciado para aplicar a mudanca. Erro transitorio,
429 ou quota do Alchemy faz fallback automatico para dRPC, sem interromper o
backfill. Essa decisao aceita que nao havera alertas locais em 80%, 90% e 100%.

## 7. Telemetria obrigatoria

O heartbeat atual nao pode ficar em `warming-up` sem explicar a fase.

Cada worker deve atualizar durante execucao:

- fase atual;
- faixa atual;
- faixas em voo;
- blocos/minuto em 1, 5 e 15 minutos;
- cursor de scan;
- cursor de enriquecimento;
- profundidade da fila;
- idade do item pendente mais antigo;
- itens reclamados/processados/falhos;
- retries e dead letters;
- requests e batches por metodo;
- provider usado e fallback;
- latencia p50/p95;
- 429, timeout e erro por provedor;
- ETA do scan;
- ETA do enriquecimento;
- gap entre discovery, scan e enrichment.

O status precisa ser atualizado durante um lote, e nao somente quando todo
`pollOnce` termina.

## 8. Falhas e recuperacao

### 8.1 Restart

- Faixa buscada mas nao commitada e refeita.
- Faixa commitada nao e buscada novamente no fluxo normal.
- Claim com lease expirado volta a ficar disponivel.
- Saida persistida e status nao marcado deve ser segura para retry por
  idempotencia.

### 8.2 Poison item

Depois do numero maximo de tentativas:

- mover para estado `blocked`, nao descartar;
- registrar erro e payload;
- impedir avanço de `market_enriched`;
- permitir retry manual ou correcao por versao do decoder.

### 8.3 Reorg

- guardar block hash/checkpoint por faixa;
- verificar continuidade antes de confirmar;
- tratar divergencia persistente como fatal;
- nao apagar staging automaticamente;
- manter o caminho live atual ate o historico estar proximo da ponta.

### 8.4 Backpressure

O scanner reduz ou pausa quando:

- a fila passa do limite configurado;
- o item mais antigo passa do SLA;
- o banco entra em saturacao;
- o enriquecimento fica consistentemente mais lento do que a captura.

O objetivo nao e trocar um cursor travado por um disco lotado.

## 9. Estrategia de testes

### Unitarios

- agrupamento e deduplicacao de chamadas RPC;
- ordem por token/bloco/log;
- particionamento deterministico;
- controlador adaptativo de concorrencia;
- calculo de watermarks;
- range finalizer com faixas vazias e fora de ordem;
- classificacao entre rejeicao de negocio e falha recuperavel;
- calculo de ETA e throughput.

### Integracao

- criar, reclamar, renovar e liberar leases;
- dois workers usando `SKIP LOCKED` sem duplicar trabalho;
- crash entre captura e cursor;
- crash entre persistencia e conclusao do item;
- retry idempotente;
- faixa vazia;
- faixa parcialmente enriquecida;
- poison item bloqueando watermark;
- restart com lease expirado;
- cursor continuo sem saltar buracos;
- schema/runtime schema parity;
- retencao sem remover pendencias.

### Paridade

Em janelas conhecidas, comparar pipeline antigo e novo:

- identidades de logs;
- swaps decodificados por protocolo;
- aceitos e rejeitados por motivo;
- volume e numero de swaps por bucket de 1 minuto;
- supply provenance;
- cotacao e FDV;
- gaps inexplicados.

Nao e necessario teste E2E de frontend para esses cortes. Schema e persistencia
exigem `npm run db:schema-check`, teste de schema de teste e suites direcionadas.

## 10. Rollout seguro

### Fase A - Baseline e probes

- medir separadamente discovery scan, market scan e enriquecimento;
- testar `eth_getLogs` no dRPC em faixas de 1k, 5k e 10k;
- medir faixas vazias e densas;
- registrar 429, latencia, payload e CUs;
- escolher concorrencia inicial pelo resultado, nao por intuicao.

Saida: tabela de capacidade por metodo e provedor.

### Fase B - Shadow capture

- nova captura grava staging e manifesto;
- cursor atual continua autoritativo;
- nenhuma observacao nova e publicada pelo caminho shadow;
- auditor compara identidades de logs em janelas amostradas.

Gate:

- zero gaps inexplicados;
- zero divergencia de identidade;
- restart comprovadamente idempotente.

### Fase C - Enriquecimento canario

- liberar uma janela historica pequena;
- comparar observacoes e buckets com o pipeline atual;
- testar falha e retomada;
- medir calls e CUs por observacao.

Gate:

- paridade funcional;
- nenhuma duplicacao;
- fila drenando;
- custo dentro do budget.

### Fase D - Substituir o market historico

- parar o consumidor historico antigo em um checkpoint confirmado;
- iniciar scan novo a partir desse `next_block`;
- manter discovery independente;
- aumentar faixas em voo gradualmente;
- manter alertas e visibilidade desligados durante o backfill.

Rollback:

- desligar scanner/enricher novos;
- preservar staging;
- retomar o cursor antigo;
- nunca editar cursor manualmente sem auditoria da faixa.

### Fase E - Escala

Escada sugerida:

1. 1 faixa em voo / 1 enrichment worker;
2. 2 faixas / 2 workers;
3. 4 faixas / 4 workers;
4. 8 faixas / numero de workers comprovado pelo banco e provedor.

Cada degrau deve rodar tempo suficiente para observar ao menos:

- 20 faixas;
- uma faixa densa;
- uma faixa vazia;
- um retry, se ocorrer naturalmente;
- taxa estabilizada por 15 minutos.

So sobe se:

- throughput util aumentar;
- erro/429 nao degradar;
- custo por observacao nao piorar de forma material;
- PostgreSQL permanecer com folga;
- fila nao envelhecer.

### Fase F - Aproximacao da ponta

Quando o gap ficar pequeno:

- reduzir tamanho das faixas;
- elevar protecao de reorg;
- manter historico e live separados;
- somente fundir os caminhos depois de uma janela de estabilidade.

## 11. Cortes de implementacao

Cada corte de codigo fica limitado a 500 linhas alteradas e termina com lint,
testes direcionados, revisao de diff e nova autorizacao.

### Corte 1 - Medicao e probe de provedores

Escopo:

- probe comparativo de `eth_getLogs` e timestamps;
- metricas por metodo/provedor;
- relatorio de blocos/min, latencia, erro e payload;
- sem mudar o worker de producao.

Estimativa: 300-450 linhas.

Validacao:

- testes unitarios do probe/config;
- `npm run lint`.

Gate: confirmar que dRPC pode assumir o papel de scan.

### Corte 2 - Schema de captura duravel

Escopo:

- tabela de manifesto de faixas;
- tabela de staging dos logs de market;
- tabela de watermarks do backfill;
- status, retry, lease e indices;
- runtime schema e migration stage;
- politica que nunca expira pendencia.

Estimativa: 350-500 linhas.

Validacao:

- testes de schema;
- `npm run db:schema-check`;
- `npm run db:schema-check:test`;
- `npm run lint`.

### Corte 3 - Repositorio de captura

Escopo:

- insert set-based de logs;
- idempotencia;
- conclusao de faixa e cursor de scan na mesma transacao;
- consultas de backlog.

Estimativa: 350-500 linhas.

Validacao:

- integracao de duplicata, faixa vazia, rollback e restart;
- `npm run lint`.

### Corte 4 - Scanner historico de market

Escopo:

- scanner sem enriquecimento;
- provedor de scan explicito;
- uma faixa em voo inicialmente;
- telemetry durante a faixa;
- feature flag shadow.

Estimativa: 350-500 linhas.

Validacao:

- testes do worker e roteamento;
- dry-run/shadow local;
- `npm run lint`.

### Corte 5 - Prefetch paralelo e commit ordenado

Escopo:

- varias faixas em voo;
- reorder buffer limitado;
- split adaptativo;
- backpressure;
- commit estritamente contiguo.

Estimativa: 350-500 linhas.

Validacao:

- respostas fora de ordem;
- falha intermediaria;
- faixa densa repartida;
- limite de memoria;
- `npm run lint`.

### Corte 6 - Discovery independente

Escopo:

- separar discovery do ciclo de market;
- lease e telemetria proprios;
- provedor de scan configuravel;
- publicar watermark seguro para market.

Estimativa: 350-500 linhas.

Validacao:

- dependencia market/discovery;
- restart;
- reorg/checkpoint;
- `npm run lint`.

### Corte 7 - Planner de enriquecimento em batch

Escopo:

- agrupamento e deduplicacao;
- ordem por token;
- batches de ate 100;
- adaptacao aos limites do provedor;
- sem ainda escrever observacoes.

Estimativa: 350-500 linhas.

Validacao:

- testes unitarios tabelados;
- paridade das respostas individuais e batch;
- `npm run lint`.

### Corte 8 - Claims duraveis de enriquecimento

Escopo:

- claim com `SKIP LOCKED`;
- lease, retry, cooldown e blocked;
- renovacao de claims longos;
- metricas de fila.

Estimativa: 350-500 linhas.

Validacao:

- integracao com dois owners;
- lease expirado;
- poison item;
- graceful shutdown;
- `npm run lint`.

### Corte 9 - Worker de enriquecimento

Escopo:

- executar planner;
- persistir processed log, observacao e bucket 1m;
- marcar terminal na mesma transacao;
- publicar alvos para agregacao.

Estimativa: 400-500 linhas.

Validacao:

- crash/retry idempotente;
- accepted/rejected;
- falha RPC recuperavel;
- paridade em janela;
- `npm run lint`.

### Corte 10 - Finalizador continuo

Escopo:

- `market_enriched`;
- avanço somente por manifests completos;
- bloqueio por gap/dead letter;
- ETA e lag por frontier.

Estimativa: 300-450 linhas.

Validacao:

- faixas vazias;
- fora de ordem;
- buraco;
- item bloqueado;
- retomada;
- `npm run lint`.

### Corte 11 - Unidades operacionais e rollout

Escopo:

- scripts/config para scanner, discovery e enrichment;
- leases separados;
- exemplos systemd;
- comandos de auditoria e rollback;
- roteamento auxiliar de timestamps pelo Alchemy, fallback para dRPC e
  monitoramento manual do teto de 27 milhoes de CUs, preservando 3 milhoes.

Estimativa de codigo: 250-400 linhas. Documentacao operacional nao entra no
limite de 500 linhas.

Validacao:

- config tests;
- start/stop controlado;
- `npm run lint`.

### Corte 12 - Canary, escala e aposentadoria do hot path antigo

Escopo:

- executar shadow;
- validar gates;
- virar o market historico;
- escalar por degraus;
- remover o acoplamento antigo apenas depois da estabilidade.

Qualquer remocao sera um corte proprio se o diff ultrapassar 500 linhas.

## 12. Criterios de sucesso

### Corretude

- zero gaps inexplicados;
- cursor nunca ultrapassa faixa nao confirmada;
- zero duplicacao de volume em restart/retry;
- paridade dos eventos e buckets dentro do contrato atual;
- reorg persistente interrompe avanço;
- item blocked e visivel, nunca descartado.

### Performance

- discovery scan sustentado >= `9.000 blocos/min`;
- market scan sustentado >= `12.500 blocos/min`;
- p95 medido em janelas de pelo menos 15 minutos;
- enrichment throughput maior que a taxa de entrada;
- backlog nao cresce por 30 minutos sob carga estabilizada.

### Operacao

- heartbeat util durante processamento;
- ETA por frontier;
- custo/CU observavel;
- rollback sem perda do staging;
- deploy sem edicao manual de cursor.

## 13. Pontos importantes

1. **“Escaneado” nao significa “analisado”.** A interface e os comandos precisam
   mostrar scan, enrichment e aggregates separadamente.
2. **O dRPC nao e hoje o provedor primario de `eth_getLogs`.** Isso so muda com
   roteamento explicito e probe aprovado.
3. **A meta de 24 horas nao pode ser garantida antes do probe.** O plano cria os
   mecanismos para usar a capacidade comprada e medir a ETA real.
4. **A fila duravel aumenta uso de disco.** Backpressure, indices e retencao
   pos-finalizacao sao parte do desenho, nao trabalho opcional.
5. **A ordem por token e um requisito de corretude.** Concorrencia ilimitada
   pode produzir supply historico errado.
6. **O cursor atual nao sera reaproveitado com semantica diferente.** Isso
   evitaria mostrar cobertura falsa aos consumidores existentes.
7. **O caminho live permanece protegido durante o rollout.** O historico novo
   entra primeiro em shadow e canario.
8. **Os ganhos anteriores de PostgreSQL continuam validos.** Eles reduzem custo
   de persistencia/agregacao, mas nao resolvem o bloqueio RPC do pipeline atual.
9. **Nao se escala por numero de requests.** So se escala quando aumentam
   blocos/min e observacoes/min sem piorar custo, erro e backlog.
10. **Nenhuma pendencia pode obedecer a retencao de tres dias.** Staging so e
    limpo depois da finalizacao continua e da janela de seguranca.
11. **Alchemy ajuda, mas dRPC continua sendo o provedor de carga principal.**
    A conta Alchemy dedicada pode usar ate 27 milhoes de CUs por ciclo, com
    reserva de 3 milhoes. O limite e um teto, nao uma meta, e nunca justifica
    fragmentar o scan principal em ranges de 10 blocos.

## 14. Primeira decisao de execucao

O primeiro corte deve ser o probe comparativo, porque ele responde antes de uma
migration:

- qual provedor deve receber `eth_getLogs`;
- quantas faixas simultaneas cada provedor suporta;
- se 10k e melhor do que 5k;
- qual throughput de scan e realisticamente compravel;
- quanto CU o scan consome.

Depois do probe, os parametros iniciais dos cortes de scanner deixam de ser
suposicoes e passam a ser dados medidos.

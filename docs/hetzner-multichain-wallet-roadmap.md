# Roadmap de infraestrutura Hetzner e wallet tracking multichain

Data da decisão: 2026-07-27.

Este documento registra o plano de migração da infraestrutura para a Hetzner
na Alemanha, a estabilização do node da Robinhood Chain e a implantação do
wallet tracking. Ele deve ser usado como referência para evitar reabrir todas
as decisões a cada nova etapa.

O plano é adaptativo: a ordem abaixo permanece estável, mas capacidade,
provedores e separação de servidores podem mudar quando métricas reais
justificarem a mudança.

## Resumo executivo

Arquitetura inicial:

```text
Hetzner Alemanha

Servidor 1 — produto
  Bot + API + frontend + PostgreSQL

Servidor 2 — ingestão
  Robinhood node + worker Robinhood
  consumidor SHYFT/Yellowstone
  futuros workers multichain

Serviços externos
  SHYFT Build
  RPCs de fallback
  object storage para backups
```

Ordem de execução:

1. terminar e validar o backfill atual da Robinhood;
2. preparar os dois servidores na Hetzner;
3. migrar bot e PostgreSQL com estratégia blue/green;
4. colocar o node Robinhood no head e validar o fluxo live;
5. abandonar o archive permanente e operar com node pruned validado;
6. criar a fundação multichain do wallet tracking;
7. lançar wallet tracking da Robinhood;
8. integrar SHYFT e adicionar wallets Solana;
9. adicionar novas redes uma por vez;
10. separar banco, workers ou nodes apenas quando métricas exigirem.

## Decisões congeladas

- Os dois servidores ficam na mesma região alemã para manter baixa latência
  entre bot, PostgreSQL, workers e node.
- O PostgreSQL permanece no servidor do bot nesta fase.
- O banco não será exposto publicamente; workers acessam por rede privada.
- O worker Robinhood fica na mesma máquina do node e usa RPC por loopback.
- O archive Robinhood é temporário: serve para concluir/validar o histórico.
- O node pruned é o perfil permanente para acompanhamento do head.
- O SHYFT é um serviço externo. No servidor roda apenas nosso consumidor gRPC.
- Serão persistidas por 30 dias todas as ações de swap normalizadas às quais o
  parser conseguir atribuir uma wallet econômica nas DEXs monitoradas.
- Payload RPC bruto, account lists completas e instruções cruas não entram
  nessa retenção.
- Buckets, swaps normalizados atribuídos e signals de wallets são dados do
  produto; o firehose bruto continua sendo descartado.
- O wallet tracking nasce multichain, mesmo que a primeira entrega seja apenas
  Robinhood.
- Robinhood vem antes de Solana no wallet tracking.
- ClickHouse, PostgreSQL gerenciado e servidores adicionais não entram agora.

## Requisito central: wallet tracking deve nascer multichain

Este requisito não é uma otimização futura. Ele define o contrato da primeira
implementação.

Não devemos criar uma tabela ou serviço chamado `robinhood_wallets` e depois
tentar adaptar para Solana. Robinhood será apenas o primeiro adapter de uma
pipeline que já reconhece redes e famílias de endereços diferentes.

O fluxo deve ser:

```text
fonte específica da rede
  -> adapter Robinhood/EVM ou Solana
  -> evento de wallet normalizado
  -> deduplicação e persistência comuns
  -> API/realtime comuns
  -> marker comum no chart
```

### Separação do `user_wallets` existente

O repositório já possui `user_wallets`, criado na Stage 44, mas essa estrutura
é destinada a login com wallet e token gate. O serviço atual valida
exclusivamente endereços Solana/Ed25519.

Essa tabela não deve receber wallets arbitrárias de tracking. Misturar os dois
domínios criaria conflitos entre:

- wallet usada para autenticar um usuário;
- wallet que um usuário decidiu acompanhar;
- wallet curada e classificada como Smart Money;
- wallet pertencente à mesma entidade em redes diferentes.

O wallet tracking precisa de estruturas próprias.

### Identidade multichain

Toda wallet monitorada deve possuir, no mínimo:

- `chain_key`: identificador interno da rede, por exemplo `robinhood`,
  `solana`, `base`, `bsc` ou `stable`;
- `chain_family`: inicialmente `evm` ou `solana`;
- `address`: endereço original para exibição;
- `normalized_address`: forma usada para comparação e unicidade;
- `tracking_started_at`: instante a partir do qual prometemos cobertura;
- `status`: ativa, pausada ou removida;
- `label`: nome exibido, quando existir;
- `category`: por exemplo Smart Money, insider, deployer ou custom;
- referência opcional a uma entidade que agrupe wallets relacionadas.

A identidade nunca pode ser somente o endereço.

Chave lógica:

```text
(chain_key, normalized_address)
```

Isso evita tratar o mesmo texto de endereço em duas redes como se fosse uma
única fonte de eventos.

### Normalização por família

EVM:

- validar endereço hexadecimal de 20 bytes;
- comparar usando uma forma canônica em lowercase;
- preservar uma forma amigável/checksummed apenas para exibição;
- registrar a rede separadamente, mesmo quando o endereço se repete.

Solana:

- validar base58 e chave pública de 32 bytes;
- preservar o valor base58;
- nunca aplicar lowercase, porque endereços Solana são case-sensitive.

Nenhum normalizador genérico pode alterar endereços de todas as redes da mesma
forma.

### Entidades conceituais previstas

Os nomes finais das tabelas serão decididos no bloco de schema, mas o domínio
deve separar:

1. **perfil/entidade da wallet**
   - identidade humana ou classificação curada;
   - label, categoria, descrição e status;
2. **endereço monitorado**
   - rede, família, endereço, início da cobertura e configuração;
3. **assinatura/follow**
   - quais usuários ou workspaces acompanham aquele endereço;
4. **evento normalizado**
   - compra ou venda atribuída à wallet;
5. **cursor de ingestão**
   - último bloco/slot processado por rede e fonte;
6. **estado operacional**
   - erro, atraso, última atividade e versão do parser.

Essa separação permite que uma wallet seja processada uma vez e exibida para
vários usuários sem duplicar eventos.

## Contrato do evento de wallet

Robinhood e Solana devem produzir o mesmo formato lógico:

```text
chain_key
chain_family
wallet_address
normalized_wallet_address
tracked_wallet_id (opcional)
transaction_id
action_index
block_or_slot
block_time
token_address
quote_address
side
token_amount_raw
token_decimals
quote_amount_raw
quote_decimals
execution_price
source_protocol
label_snapshot
category_snapshot
confidence
parser_version
observed_at
```

Regras:

- `side` é sempre `buy` ou `sell` da perspectiva da wallet monitorada;
- `wallet_address` é persistido mesmo que essa wallet ainda não esteja na lista
  de tracking;
- `tracked_wallet_id` é opcional e liga o evento a um cadastro já existente;
- valores inteiros onchain devem ser preservados sem conversão prematura para
  ponto flutuante;
- `action_index` identifica uma ação dentro da transação;
- `label_snapshot` preserva o texto exibido no momento do signal;
- `parser_version` permite diagnosticar ou reprocessar eventos;
- `confidence` diferencia atribuição comprovada de heurísticas;
- evento sem atribuição segura não vira signal Smart Money automaticamente.

Chave de idempotência proposta:

```text
(chain_key, normalized_wallet_address, transaction_id, action_index)
```

Replays, reconnects ou execução simultânea de workers não podem criar markers
duplicados.

Guardar o endereço econômico no próprio evento é o que permite cadastrar uma
wallet amanhã e consultar até 30 dias anteriores sem reprocessar a blockchain.
Guardar apenas o swap do pool, sem atribuição de wallet, não atende esse
objetivo.

## Diferenças de parsing que não podem ser escondidas

### Robinhood/EVM

Um log `Swap` identifica a atividade do pool, mas não prova sozinho que a
wallet monitorada comprou ou vendeu.

O adapter EVM pode precisar combinar:

- remetente da transação;
- receipt e logs;
- transferências de tokens;
- router ou agregador utilizado;
- posição do evento dentro da transação;
- traces, apenas quando realmente necessários.

A atribuição deve ser feita antes de produzir o evento normalizado.

### Solana

O parser Solana atual do repositório calcula deltas de token no nível global da
transação. Isso serve como base para volume e preço, mas não é suficiente para
atribuir compra/venda a uma wallet específica.

O adapter de wallet Solana deve:

- localizar a wallet nas account keys;
- relacionar token accounts ao owner correto;
- calcular pre/post balances apenas das contas pertencentes à wallet;
- lidar com account creation/closure;
- distinguir fee payer, signer, router e beneficiário;
- produzir o lado da operação pela perspectiva da wallet monitorada.

O filtro `accountInclude` do Yellowstone reduz o universo de transações, mas
não substitui essa atribuição.

## Retenção e markers no chart

Política inicial:

- janela visível do wallet tracking: 30 dias;
- retenção física dos swaps normalizados: 30 dias completos mais a partição do
  dia corrente;
- implementação por partições diárias, removendo a partição expirada em vez de
  executar `DELETE` massivo;
- payload bruto: não persistir por padrão;
- payload bruto temporário para diagnóstico: no máximo 24–72 horas, fora da
  tabela principal e com expiração própria;
- signals curados de Smart Money podem ser derivados para uma tabela muito
  menor e ter retenção superior;
- buckets seguem sua política própria e não dependem da retenção dos swaps.

Esta decisão substitui, para o wallet tracking, a orientação anterior de
persistir somente buckets no pipeline Solana. Continuamos sem persistir o
firehose bruto: persistimos somente a representação compacta e atribuída do
swap.

O marker de Smart Money não deve ser gravado dentro do candle.

Consulta esperada:

```text
buscar candles do período
  + buscar eventos de wallet do mesmo período
  -> alinhar pelo timestamp
  -> desenhar markers sobre os candles
```

Enquanto o evento normalizado existir, o marker poderá ser reconstruído. Não é
necessário guardar todos os swaps da rede para manter o signal.

## Backfill de wallet tracking

Contrato de lançamento:

- uma wallet passa a ter cobertura garantida a partir de
  `tracking_started_at`;
- o tracking padrão é forward-only;
- quando houver swaps normalizados atribuídos no banco, uma wallet nova poderá
  exibir até 30 dias anteriores imediatamente;
- essa recuperação não é garantida para swaps anteriores ao início da retenção,
  períodos com ingestão desligada ou ações cuja wallet não pôde ser atribuída;
- backfill pela blockchain continua opcional para cobrir buracos;
- ausência desse backfill não bloqueia o lançamento da Robinhood.

Isso permite remover a dependência permanente do archive node.

O backfill histórico atual da Robinhood tem outro objetivo: construir e
enriquecer os dados de mercado já definidos. Ele não deve ser confundido com
um futuro backfill de wallets.

## Arquitetura Hetzner

### Servidor 1 — produto

Responsabilidades:

- bot e processos de publicação;
- API e frontend;
- PostgreSQL;
- autenticação e configurações;
- buckets dos charts;
- catálogo e cursores persistentes;
- wallets monitoradas e eventos normalizados;
- realtime para os clientes.

O dimensionamento deve considerar o tamanho atual do banco e margem para
crescimento, não o tamanho do archive node.

### Servidor 2 — ingestão

Responsabilidades:

- node Robinhood;
- worker Robinhood em loopback;
- consumidor Yellowstone/SHYFT;
- adapters de wallet por rede;
- agregação e escrita em lotes;
- filas temporárias e telemetria local;
- futuros workers que usem provedores externos.

Não é compromisso deste roadmap colocar vários full nodes nessa máquina.

### Comunicação

- os servidores devem ficar na mesma região;
- PostgreSQL aceita conexões apenas pela rede privada;
- workers usam usuário de banco com permissões mínimas;
- escritas devem ser agrupadas em lotes;
- o bot não acessa RPCs de blockchain para montar charts;
- o servidor de ingestão não publica diretamente para usuários finais.

### Latência

A medição feita a partir da localização atual foi de aproximadamente 150 ms
até a Alemanha.

Esse nível é aceitável para:

- charts;
- alertas;
- wallet tracking;
- atualizações por WebSocket;
- operação manual do terminal.

Este desenho não promete latência de infraestrutura HFT ou sniper. Se execução
automatizada sensível a dezenas de milissegundos virar requisito, região e
arquitetura precisarão de uma avaliação própria.

## Armazenamento

### PostgreSQL

Guardar:

- dados do produto;
- buckets;
- wallets e relações de follow;
- ações de swap normalizadas e atribuídas por 30 dias;
- signals derivados relevantes;
- cursores;
- estado de publicação e idempotência.

Não guardar:

- payload RPC bruto de todas as redes;
- firehose completo de swaps;
- account lists e instruções completas de cada transação;
- cópia integral de blocos;
- dados internos do node.

### Estimativa de capacidade para 30 dias

O cálculo detalhado está em
`docs/normalized-swap-retention-capacity-plan.md`.

Faixa inicial baseada nas medições existentes:

- Robinhood: aproximadamente 5–11 swaps/s;
- Solana: planejar 50–150 swaps/s até o soak do SHYFT substituir a estimativa;
- total combinado: aproximadamente 145–417 milhões de ações em 30 dias;
- registro compacto mais índices: aproximadamente 0,8–1,5 KB por ação;
- dados e índices: aproximadamente 116–626 GB;
- com WAL, bloat, partições ativas e margem operacional: aproximadamente
  **150–800 GB**;
- faixa mais provável para o início: **300–600 GB**.

Um disco de 1 TB pode atender o piloto, mas não deve operar próximo de 100%.
Para retenção integral da Solana, 2 TB utilizáveis no servidor do PostgreSQL
oferecem margem muito mais segura.

Os discos das duas VPS não formam um único volume. O espaço do servidor do
node não aumenta a capacidade do PostgreSQL. Para essa retenção, importa o
disco disponível no servidor do produto.

### Disco do node

Guardar:

- datadir do node;
- snapshot durante instalação;
- índices necessários para o live;
- arquivos temporários estritamente operacionais.

Depois da validação:

- remover com segurança o arquivo compactado do snapshot;
- operar com node pruned;
- medir crescimento real do datadir;
- não apagar arquivos internos manualmente.

### Backups

Política mínima:

- backup completo periódico do PostgreSQL;
- cópia em object storage fora das duas VPS;
- retenção de múltiplas versões;
- backup separado de configurações e secrets;
- teste real de restauração antes de desligar a VPS antiga;
- node não precisa de backup integral se puder ser reconstruído.

## Roadmap de execução

### Fase 1 — concluir o backfill Robinhood

Objetivo:

- terminar a construção histórica já em andamento;
- confirmar que enrichment, buckets, cursores e filas convergiram.

Critérios de saída:

- nenhum intervalo obrigatório pendente;
- outbox/filas drenadas;
- buckets conferidos por amostragem;
- cursores coerentes;
- backup restaurável do PostgreSQL.

### Fase 2 — preparar a Hetzner

Objetivo:

- provisionar os dois servidores na mesma região;
- configurar rede privada, firewall, observabilidade e backups.

Critérios de saída:

- conectividade privada validada;
- PostgreSQL não exposto publicamente;
- servidor do node atende CPU, RAM e NVMe mínimos validados no plano do node;
- métricas de CPU, RAM, disco e processos disponíveis.

### Fase 3 — migrar bot e PostgreSQL

Estratégia blue/green:

1. manter a VPS antiga ativa;
2. instalar aplicação e dependências na nova VPS;
3. copiar configurações, secrets, Nginx, serviços e schedules;
4. restaurar uma cópia do PostgreSQL;
5. validar frontend, API, auth e publicação sem tráfego real;
6. pausar escritas por uma janela curta;
7. executar sincronização final;
8. trocar DNS/IP;
9. ativar apenas uma instância publicadora;
10. manter a VPS antiga como rollback por aproximadamente sete dias.

Critérios de saída:

- smoke funcional aprovado;
- ausência de publicação duplicada;
- jobs executando uma única vez;
- métricas e logs normais;
- rollback documentado e testável.

### Fase 4 — estabilizar o node Robinhood

Objetivo:

- iniciar/restaurar o archive;
- alcançar o head;
- validar as leituras exigidas pelo pipeline;
- iniciar processamento live sem buracos.

Antes de abandonar o archive:

- node no head;
- backfill e enrichment concluídos;
- cursores persistidos;
- banco com backup;
- RPC archive externo mantido como fallback;
- caminho de node pruned testado em cópia ou nova instância.

Nunca podar manualmente arquivos do datadir.

### Fase 5 — fundação multichain do wallet tracking

Esta fase acontece depois da estabilidade do node e antes do tracking
Robinhood.

Entregas:

- schema próprio de tracking, separado de `user_wallets`;
- normalizadores EVM e Solana;
- contrato comum de evento;
- idempotência multichain;
- tabela de ações atribuídas particionada por dia;
- retenção automática de 30 dias por remoção de partição;
- cursor e estado operacional;
- API/realtime agnósticos de rede;
- autorização/follow por usuário ou workspace;
- marker de chart consumindo eventos normalizados.

Critérios de saída:

- o schema aceita Robinhood e Solana sem colunas específicas de protocolo;
- endereço EVM e endereço Solana seguem validações diferentes;
- dois eventos iguais reprocessados geram um único registro;
- uma wallet ainda não cadastrada pode ser localizada pelo endereço nos swaps
  retidos;
- partições expiradas são removidas sem `DELETE` massivo;
- marker pode ser reconstruído por intervalo;
- nenhuma dependência do archive para tracking forward-only.

### Fase 6 — wallet tracking Robinhood

Entregas:

- adapter EVM da Robinhood;
- identificação confiável de buy/sell pela perspectiva da wallet;
- cadastro, pausa e remoção de wallet;
- persistência dos eventos;
- realtime e marker no chart;
- telemetria de atraso e falhas.

Rollout:

1. dry-run sem publicação;
2. comparação manual com transações conhecidas;
3. conjunto pequeno de wallets internas;
4. soak;
5. ativação gradual para usuários.

### Fase 7 — SHYFT e wallet tracking Solana

Entregas:

- contratar e validar SHYFT Build;
- implementar transporte Yellowstone conforme o plano existente;
- manter buckets agregados, sem persistir o firehose bruto;
- criar adapter Solana centrado na wallet;
- reutilizar schema, API, realtime, retenção e markers da Robinhood.

O que deve mudar para adicionar Solana:

- transporte;
- normalizador de endereço;
- parser/atribuição da wallet;
- cursor de slot/finalidade.

O que não deve mudar:

- modelo de follow;
- formato lógico do evento;
- política de retenção;
- API do produto;
- renderização do marker.

### Fase 8 — outras redes

Ordem inicial:

1. Stable;
2. BSC;
3. Base;
4. demais redes conforme demanda.

Cada rede entra com:

- `chain_key` registrado;
- normalizador;
- adapter;
- fonte live;
- cursor;
- testes de atribuição;
- soak antes da publicação.

Usar provedores externos inicialmente. Um full node novo exige decisão de
infraestrutura própria e não é consequência automática de adicionar uma rede.

## Observabilidade obrigatória

Por rede:

- último bloco/slot observado;
- último bloco/slot persistido;
- atraso até o head;
- reconnects;
- eventos recebidos, aceitos e rejeitados;
- deduplicações;
- eventos sem atribuição segura;
- tempo entre evento onchain e publicação.

PostgreSQL:

- tamanho total e crescimento diário;
- tamanho por tabela/índice;
- CPU e I/O;
- conexões;
- duração dos inserts em lote;
- queries lentas;
- execução e idade dos backups.

Node:

- distância até o head;
- uso e crescimento de disco;
- CPU, RAM e I/O;
- erros RPC;
- tempo de resposta;
- disponibilidade do fallback externo.

## Gatilhos de escala

Não escalar por ansiedade ou apenas porque existe espaço disponível. Escalar
quando houver evidência, como:

- disco com tendência real de esgotamento;
- PostgreSQL sustentadamente limitado por CPU ou I/O;
- inserts afetando leitura do produto;
- fila crescendo mais rápido do que é processada;
- atraso de ingestão fora do SLA;
- workers competindo por recursos com o node;
- volume analítico que torne consultas históricas impraticáveis.

Respostas possíveis:

- aumentar verticalmente a VPS do produto;
- mover PostgreSQL para máquina com redundância ou serviço gerenciado;
- separar workers por rede;
- adicionar read replica/cache;
- introduzir ClickHouse para fatos históricos em grande escala;
- mover uma região específica para perto do provedor ou dos usuários.

ClickHouse não substitui PostgreSQL como fonte transacional do produto.

## O que não precisa ser decidido agora

- banco definitivo para centenas de milhões de eventos;
- número de servidores para todas as redes futuras;
- execução de full nodes de BSC, Base ou Stable;
- retenção permanente de todo swap;
- região ideal para trading automatizado;
- backfill histórico automático de toda wallet recém-cadastrada;
- migração do PostgreSQL para o servidor do node.

Essas decisões permanecem abertas sem bloquear o roadmap atual.

## Riscos e respostas

| Risco | Resposta planejada |
|---|---|
| Migração do bot falha | manter VPS antiga como rollback |
| Dois bots publicam simultaneamente | ativação exclusiva e lease/idempotência |
| Node perde o disco | reconstruir node e usar RPC fallback |
| PostgreSQL perde a máquina | restaurar backup externo testado |
| Worker perde conexão | retomar pelo cursor e deduplicar |
| Parser atribui lado incorreto | confidence, dry-run e casos conhecidos |
| Solana produz mention-only | validar owner/deltas antes do evento |
| Archive cresce rapidamente | concluir validação e migrar para pruned |
| Uma rede sobrecarrega o servidor | separar somente o worker daquela rede |
| Latência alemã vira gargalo | medir SLA e avaliar edge/região específica |

## Pontos importantes

- **Wallet tracking multichain é requisito da primeira versão**, não refactor
  posterior.
- `user_wallets` continua sendo autenticação/token gate e não tracking.
- Side de compra/venda é calculado da perspectiva da wallet, não do pool.
- Robinhood e Solana exigem adapters diferentes, mesmo produzindo o mesmo
  evento final.
- O parser Solana atual não deve ser reutilizado como atribuidor de wallet sem
  escopo por owner/token account.
- O marker do chart depende do evento normalizado persistido, não do swap
  bruto nem do candle.
- Uma wallet nova pode receber até 30 dias de histórico quando já houver ações
  atribuídas a ela na retenção; isso não cobre eventos não atribuíveis ou
  períodos sem ingestão.
- Trinta dias limitam o crescimento lógico, mas vacuum, WAL e partições exigem
  margem de disco e monitoramento.
- Ter mais de 1 TB em cada VPS não soma capacidade: a retenção usa o disco da
  VPS onde o PostgreSQL estiver.
- Archive é ferramenta temporária de construção/validação; pruned é o modo de
  operação live.
- PostgreSQL e node permanecem separados para que uma falha do node não leve
  junto a fonte de verdade do produto.
- Rede privada e backups externos são requisitos de produção, não melhorias
  futuras.
- A ordem deste roadmap só deve mudar por bloqueio concreto, evidência técnica
  ou nova prioridade explícita do produto.

## Referências internas

- `docs/robinhood-node-validation-plan.md`
- `docs/robinhood-chain-onchain-monitoring-plan.md`
- `docs/solana-yellowstone-grpc-firehose-plan.md`
- `docs/normalized-swap-retention-capacity-plan.md`
- `docs/robinhood-vps-history-rollout-plan.md`
- `src/services/robinhood-ingestion-worker.js`
- `src/utils/quicknode-transaction-probe.js`
- `src/services/quicknode-onchain-event.js`
- `src/services/wallet-auth-service.js`
- `src/utils/db-init-stage44.js`

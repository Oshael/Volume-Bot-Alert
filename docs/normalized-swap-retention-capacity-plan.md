# Retenção de swaps normalizados por 30 dias

Data da decisão: 2026-07-27.

Este documento registra a decisão de manter 30 dias de ações de swap
normalizadas e atribuídas a wallets. Ele complementa
`docs/hetzner-multichain-wallet-roadmap.md`.

## Objetivo

Permitir que:

- uma wallet recém-adicionada ao tracking encontre atividade recente;
- charts mostrem markers históricos de Smart Money;
- o produto consulte compras e vendas sem reprocessar a blockchain;
- o armazenamento tenha crescimento limitado por uma janela móvel.

## O que será persistido

Uma linha representa uma ação econômica atribuída a uma wallet:

```text
rede
wallet normalizada
transação
índice da ação
bloco ou slot
timestamp
token e quote
buy ou sell
amounts crus e decimals
preço executado
protocolo
confidence
versão do parser
```

O endereço da wallet é obrigatório mesmo quando ela ainda não estiver
cadastrada no tracking. O vínculo com um perfil monitorado é opcional.

Isso é diferente de guardar apenas o evento `Swap` do pool. Um evento sem
wallet econômica atribuída não permite reconstruir o histórico de uma wallet
adicionada posteriormente.

## O que não será persistido

- JSON RPC completo;
- protobuf bruto do Yellowstone;
- transação inteira serializada;
- lista completa de accounts por transação;
- instruções internas completas;
- todos os logs do token program;
- blocos completos.

Payload bruto temporário pode existir por 24–72 horas para diagnóstico, em
armazenamento separado e com expiração própria.

## Regra de retenção

- partição por dia usando o timestamp onchain;
- manter 30 dias completos e a partição corrente;
- criar partições futuras antecipadamente;
- remover a partição mais antiga quando ela expirar;
- não executar `DELETE` linha a linha para centenas de milhões de registros;
- signals curados podem ser derivados antes da expiração e mantidos por mais
  tempo em tabela menor.

O uso não fica matematicamente constante a cada segundo. WAL, vacuum,
partições em transição e operações de manutenção criam variação temporária.

## Base das estimativas

### Robinhood

Os soaks registrados no plano Robinhood observaram:

- 13.160 swaps aceitos em 30 minutos em uma rodada;
- 19.747 swaps aceitos em aproximadamente 30 minutos no soak final;
- parte do processamento estava recuperando ranges mais rápido que o avanço da
  chain.

Para capacidade inicial, usar uma faixa de **5–11 swaps/s**.

Em 30 dias:

```text
5 swaps/s  = 12.960.000 ações
11 swaps/s = 28.512.000 ações
```

### Solana

O smoke `transactionSubscribe` de cinco programas observou:

- 589 swaps aceitos em 5 segundos;
- aproximadamente 118 swaps/s naquela amostra curta.

Uma amostra de cinco segundos não representa média mensal. Até o soak real do
SHYFT, planejar três cenários:

```text
50 swaps/s  = 129.600.000 ações em 30 dias
100 swaps/s = 259.200.000 ações em 30 dias
150 swaps/s = 388.800.000 ações em 30 dias
```

Picos de centenas de eventos por segundo não devem ser usados diretamente como
média mensal, mas precisam entrar no dimensionamento de escrita.

## Tamanho estimado por ação

Com IDs compactos, endereços binários/canônicos e poucos índices:

```text
linha PostgreSQL normalizada: aproximadamente 400–800 bytes
índices necessários:          aproximadamente 300–700 bytes
total planejado:              aproximadamente 0,8–1,5 KB por ação
```

Essa faixa deve ser comprovada com `pg_total_relation_size` depois do primeiro
milhão de registros reais.

Guardar JSON ou account lists pode elevar uma ação para vários KB e quebrar o
dimensionamento.

## Cenários de 30 dias

| Cenário | Robinhood | Solana | Ações totais | Dados + índices | Com margem operacional |
|---|---:|---:|---:|---:|---:|
| Baixo | 5/s | 50/s | ~143 milhões | ~114–215 GB | ~150–300 GB |
| Provável | 8/s | 100/s | ~280 milhões | ~224–420 GB | ~300–600 GB |
| Alto | 11/s | 150/s | ~417 milhões | ~334–626 GB | ~450–800 GB |

A margem operacional cobre:

- WAL;
- bloat normal;
- partição atual e partição em expiração;
- índices;
- migrations/reindex;
- demais tabelas do produto;
- espaço reservado para o sistema operacional.

Backups completos não devem permanecer apenas nesse mesmo disco.

## Consequência para as VPS

Os discos das duas VPS são independentes.

```text
VPS do produto
  PostgreSQL
  retenção de swaps
  buckets e signals

VPS de ingestão
  datadir do node
  workers
  buffers temporários
```

Ter 1 TB em cada VPS não equivale a 2 TB para o PostgreSQL. A retenção usa o
disco da VPS do produto.

Recomendação:

- 1 TB utilizável: suficiente para piloto, com alerta e medição desde o início;
- 2 TB utilizáveis: recomendação mais segura para guardar todos os swaps
  atribuídos dos cinco programas Solana;
- alertar antes de 70% de uso;
- não iniciar reindex/migration pesada sem espaço temporário calculado.

## Índices mínimos

Evitar indexar cada coluna.

Índices conceituais:

```text
UNIQUE (chain_key, normalized_wallet_address, transaction_id, action_index)
(chain_key, normalized_wallet_address, block_time DESC)
(chain_key, token_address, block_time DESC)
(chain_key, block_time DESC)
```

Índices adicionais só entram depois de `EXPLAIN ANALYZE` provar necessidade.

## Validação antes de confirmar capacidade

No soak SHYFT:

1. medir swaps atribuídos/s, não apenas mensagens recebidas;
2. medir quantas ações uma transação produz;
3. inserir pelo menos um milhão de ações no schema real;
4. consultar `pg_total_relation_size` da partição e dos índices;
5. projetar 30 dias com p50, p95 e pico;
6. medir WAL gerado por hora;
7. testar remoção de partição;
8. confirmar que queries por wallet e token usam índices.

Decisão após o soak:

- projeção abaixo de 600 GB: 1 TB pode continuar;
- projeção entre 600 e 800 GB: aumentar para 2 TB antes do rollout completo;
- projeção acima de 800 GB: reduzir bytes por ação, rever índices ou separar o
  armazenamento antes da retenção integral.

## Pontos importantes

- Guardar todos os swaps só ajuda wallets futuras quando a wallet econômica é
  atribuída e persistida.
- A retenção é de dados normalizados, não do firehose bruto.
- O limite de 30 dias impede crescimento infinito, mas não elimina WAL, bloat
  e necessidade de headroom.
- Particionamento diário é requisito operacional, não otimização opcional.
- O número definitivo só existe depois do soak SHYFT e da medição do schema
  real.
- Signals importantes podem sobreviver à expiração dos swaps em uma tabela
  derivada muito menor.

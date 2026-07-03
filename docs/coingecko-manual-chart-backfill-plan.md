# CoinGecko manual chart backfill plan

## Objetivo

Criar um fluxo manual para recuperar ou substituir o historico de chart de um token usando CoinGecko, sem transformar CoinGecko na fonte principal do bot.

Uso esperado:

- token velho sem historico suficiente na VPS
- token banido/removido por engano, com historico local apagado
- chart local corrompido ou com buracos grandes
- investigacao manual antes de restaurar um token

Nao objetivo:

- trocar todos os charts para CoinGecko
- chamar CoinGecko automaticamente para qualquer token novo
- depender de arquivos JSON em `data/coingecko` no fluxo final
- sobrescrever dados bons da VPS sem uma decisao manual explicita

## Fonte principal

A VPS continua sendo a fonte principal para dados recentes e operacao normal.

O CoinGecko entra como backfill manual e seletivo. Depois do backfill, o bot deve continuar gravando snapshots normalmente pela VPS a partir do ponto mais recente disponivel.

## Estado real do codigo hoje

- `token_market_buckets_1m` tem chave primaria em `(token_address, bucket_ts)`.
- `token_market_buckets_agg` tem chave primaria em `(token_address, granularity_minutes, bucket_ts)`.
- O writer live usa `upsertSnapshotBucket()` em `src/models/token-market-bucket-1m.js`.
- O writer live faz `ON CONFLICT (token_address, bucket_ts) DO UPDATE`.
- O writer live invalida cache e recalcula agregados quando habilitado.
- As rotas de chart leem das tabelas persistidas:
  - compact sparkline: `/api/catalog/sparklines`
  - expanded chart: `/api/catalog/sparklines/expanded`
- O teste visual atual com CoinGecko ainda usa override local para expanded chart; isso deve ser removido antes de virar feature real.

## Decisao de arquitetura

O fluxo final deve gravar os candles CoinGecko no backend persistido.

Depois disso:

- compact sparkline e expanded chart leem a mesma base
- nao existe divergencia entre tabela e modal
- live updates da VPS continuam usando o writer normal
- caches podem ser invalidados pelo mesmo caminho usado pelo backend atual

## Modelo operacional manual

Comando alvo:

```bash
node src/utils/import-coingecko-chart-backfill.js --token <TOKEN_ADDRESS> --mode replace-chart --days 31 --granularity 5m
```

Modo inicial recomendado:

```bash
node src/utils/import-coingecko-chart-backfill.js --token <TOKEN_ADDRESS> --mode dry-run --days 31 --granularity 5m
```

## Fluxo do comando

1. Normalizar e validar o token address.
2. Localizar o pool address:
   - usar `token_catalog.last_pair_address` quando existir
   - permitir `--pool <POOL_ADDRESS>` como override manual
3. Consultar CoinGecko Onchain OHLCV para o pool.
4. Validar se veio historico suficiente:
   - quantidade de candles
   - primeiro bucket
   - ultimo bucket
   - gaps relevantes
   - OHLC numerico valido
5. Calcular multiplicador para market cap:
   - preferir mcap local mais recente perto do ultimo candle CoinGecko
   - fallback manual: `--mcap-multiplier`
   - registrar no resumo do import
6. Converter price OHLC para market-cap OHLC.
7. Executar dry-run ou replace.
8. Recriar agregados no range afetado.
9. Invalidar caches de sparkline do token.
10. Exibir resumo final.

## Regra de replace

O replace deve ser restrito ao token e ao range importado.

Range:

- `from = firstBucketAt` do payload CoinGecko
- `to = latestBucketAt` do payload CoinGecko

No modo `replace-chart`:

1. escolher a tabela pelo timeframe (`1m` na base; `5m+` nos agregados)
2. apagar somente o mesmo timeframe do token no range
3. inserir candles CoinGecko com `source = 'coingecko_backfill'`
4. recalcular agregados para o range

Nao apagar dados depois de `latestBucketAt`, porque esse trecho pertence ao writer normal da VPS.

Protecao obrigatoria:

- imports `1m` nunca podem sobrescrever os ultimos 14 dias
- imports `5m+` nao usam essa janela de protecao e podem substituir todo o range confirmado
- candles `5m` nunca devem ser inseridos em `token_market_buckets_1m`

## Sincronizacao com a VPS depois do replace

A sincronizacao funciona pelo proprio upsert atual.

Depois do import:

- a VPS continua trackeando o token normalmente
- o proximo snapshot entra em `token_market_buckets_1m`
- se o bucket ainda nao existe, ele insere
- se o bucket ja existe, ele atualiza via `ON CONFLICT`
- agregados recentes sao recalculados pelo fluxo normal

O ponto critico e o bucket de fronteira.

Exemplo:

- CoinGecko importou ate `2026-07-02T18:15:00Z`
- VPS recebe snapshot tambem em `18:15`
- o writer pode atualizar esse mesmo bucket

Isso e aceitavel para o bucket atual/aberto. Para evitar briga em buckets historicos, o comando deve importar apenas ate o ultimo candle fechado ou aceitar explicitamente que a VPS pode ajustar o ultimo bucket.

Regra recomendada:

- importar CoinGecko ate `latestBucketAt`
- tratar `latestBucketAt` como bucket de fronteira
- permitir que a VPS atualize esse bucket se ele ainda estiver dentro da janela live
- nunca pausar tracking do token por causa do import

## Onde gravar os candles CoinGecko

Decisao: gravar `5m` em `token_market_buckets_agg` com `granularity_minutes = 5`.

Vantagens:

- CoinGecko entrega OHLCV 5m, entao combina naturalmente com `granularity_minutes = 5`
- nao finge que dado 5m e dado 1m
- expanded chart ja sabe ler agregados
- 15m, 30m, 1h, 4h e 24h podem ser gerados a partir do 5m

Consequencias:

- compact sparkline precisa garantir que usa agregados quando disponiveis
- live writer da VPS grava em `token_market_buckets_1m`, entao a continuidade mistura base 5m historica com 1m recente
- 15m, 30m, 1h, 4h e 24h precisam ser reconstruidos a partir da base 5m importada

## Modos do comando

### `dry-run`

Nao escreve no banco.

Deve exibir:

- token
- symbol quando disponivel
- pool address
- range CoinGecko
- candles recebidos
- gaps detectados
- mcap multiplier
- quantidade de buckets locais que seriam apagados
- quantidade de buckets que seriam inseridos
- granularidades agregadas que seriam recalculadas

### `replace-chart`

Escreve no banco.

Exige confirmacao explicita:

```bash
--confirm-replace
```

Sem `--confirm-replace`, o comando deve abortar depois do plano.

### `fill-missing`

Insere apenas buckets ausentes. Nao sobrescreve dados da VPS.

```bash
node src/utils/import-coingecko-chart-backfill.js --token <TOKEN_ADDRESS> --mode fill-missing --confirm-fill
```

Se nenhum bucket for inserido, os agregados nao sao recalculados.
Quando existem buckets ausentes, o modo salva backup antes de inserir e recalcular agregados.

### `replace-bad-buckets`

Substitui apenas buckets considerados ruins por regras deterministicas:

- qualquer campo OHLC de market cap ausente ou nao positivo
- `high_mcap < max(open_mcap, close_mcap)`
- `low_mcap > min(open_mcap, close_mcap)`
- `high_mcap < low_mcap`

```bash
node src/utils/import-coingecko-chart-backfill.js --token <TOKEN_ADDRESS> --mode replace-bad-buckets --confirm-replace-bad
```

O modo nao tenta classificar outlier isolado por heuristica subjetiva.

## Rollback

Antes de substituir, salvar backup local ou tabela temporaria do range afetado.

MVP simples:

- exportar os buckets atuais do token/range para `data/coingecko/backups`
- incluir timestamp e token address no nome do arquivo

Rollback manual alvo:

```bash
node src/utils/import-coingecko-chart-backfill.js --token <TOKEN_ADDRESS> --restore-backup <BACKUP_FILE> --confirm-restore
```

Sem `--confirm-restore`, o CLI apenas valida o backup e imprime o plano de restauracao.
Backups sem `granularityMinutes` explicito sao rejeitados para evitar restauracao em tabela errada.

## Validacao pos-import

Depois de um replace real:

1. consultar compact sparkline
2. consultar expanded chart em `5m`
3. consultar expanded chart em `15m`, `30m`, `1h`, `4h`, `24h`
4. confirmar:
   - `firstBucketAt`
   - `latestBucketAt`
   - `bucketCount`
   - ultimo market cap aproximado
   - ausencia de fake candles
5. abrir UI e verificar:
   - sparkline pequena
   - modal expanded
   - troca de granularidade
   - live update sem truncar historico

## Testes necessarios

Unitarios:

- normalizacao de candles CoinGecko
- conversao price para market cap
- deteccao de gaps
- calculo de range
- montagem do plano `dry-run`
- regra de bucket de fronteira

Integracao/model:

- replace apaga apenas o token/range correto
- replace insere `source = 'coingecko_backfill'`
- replace nao apaga buckets posteriores ao `latestBucketAt`
- agregados sao recalculados para o range
- compact e expanded retornam dados consistentes depois do import

Smoke/UI:

- abrir token restaurado
- ver sparkline pequena
- abrir expanded chart
- alternar granularidades

## Pontos importantes

- Esse fluxo deve ser admin/manual, nao automatico no worker.
- CoinGecko deve recuperar historico, nao virar fonte principal do bot.
- Nunca apagar dados fora do range importado.
- Nunca substituir dados da VPS sem `--confirm-replace`.
- Nunca substituir candles `1m` dos ultimos 14 dias.
- A protecao de 14 dias nao se aplica a `5m+`.
- Nunca armazenar candle CoinGecko `5m` como se fosse `1m`.
- O ultimo bucket importado pode ser atualizado pela VPS se ainda estiver aberto.
- `source = 'coingecko_backfill'` e essencial para auditoria.

## Implementacao em blocos

### Bloco 1: importador dry-run

- reaproveitar `coingecko-onchain`
- resolver pool address
- baixar candles
- converter para formato interno
- imprimir plano sem escrever no banco

### Bloco 2: escrita com backup

- exportar buckets atuais do range
- apagar range do token
- inserir candles CoinGecko
- marcar source

### Bloco 3: agregados e cache

- recalcular agregados do range na mesma transacao do replace
- gerar `15m+` a partir do `5m` CoinGecko, sem usar ou alterar o `1m` nativo
- validar leitura compact/expanded com cache desabilitado
- aceitar ate 30 segundos de cache antigo no processo web, conforme TTL atual

O cache e local ao processo web. O CLI nao consegue invalida-lo diretamente; invalidacao imediata
entre processos exigiria um canal dedicado, como Postgres `NOTIFY`.

### Bloco 4: rollback e modos seguros

- restaurar backup validado em uma transacao
- adicionar `fill-missing` com `ON CONFLICT DO NOTHING`
- adicionar `replace-bad-buckets` com criterios deterministas e backup proprio

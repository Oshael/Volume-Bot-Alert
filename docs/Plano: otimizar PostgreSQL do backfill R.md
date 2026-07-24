Plano: otimizar PostgreSQL do backfill Robinhood
Objetivo: maximizar a velocidade do backfill sem perder swaps, precisão dos candles, idempotência ou capacidade de auditoria.
Diagnóstico atual
A persistência básica já usa SQL em lote:
jsonb_to_recordset
insert das observações
criação dos buckets 1m
ON CONFLICT
cursor atualizado na mesma transação
O principal problema PostgreSQL encontrado está nos agregados:
O backfill cria milhares de alvos em JavaScript.
Para cada alvo, executa um SELECT.
Depois executa um UPSERT.
Isso gera padrão N+1, muitos round-trips e releitura repetida dos mesmos buckets.
Arquivos principais:
src/models/robinhood-persistence.js
src/models/robinhood-market-aggregate.js
src/utils/backfill-robinhood-market-aggregates.js
src/models/robinhood-market-history-read.js
src/utils/db-init-stage66.js
src/utils/db-init-stage78.js
Ordem dos cortes
Cada corte deve ter no máximo 500 linhas alteradas e ser autorizado separadamente.
Corte 1 — Tirar agregação histórica do hot path
Para ranges históricos:
Persistir logs processados, observações, buckets 1m e cursor.
Evitar reconstruir buckets 1h repetidamente dentro de cada transação histórica.
Manter o comportamento atual para ranges recentes/live.
O agregado histórico será produzido depois por SQL em lote.
Mitigações:
Só tratar como histórico ranges seguramente fechados.
Cursor só avança depois da persistência básica concluir.
Não alterar idempotência de (transaction_hash, log_index).
Não afetar buckets live usados pelos alertas.
Corte 2 — Agregação set-based em SQL
Substituir o loop que chama refreshBucket() individualmente por comandos semelhantes a:
INSERT INTO robinhood_market_buckets_agg (...)
SELECT ...
FROM robinhood_market_buckets_1m
WHERE bucket_ts >= $from
  AND bucket_ts < $to
GROUP BY token_address, date_bin(...)
ON CONFLICT (...) DO UPDATE ...
Fazer por janelas fechadas:
1m → 5m, 15m, 30m
1m → 1h
1h → 60m, 240m, 1440m
Requisitos:
Open/close ordenados por bloco, log, protocolo e mercado.
High/low corretos.
Volume e contadores somados.
Sem conversões intermediárias para Number em JavaScript.
Tudo calculado como NUMERIC/BIGINT no PostgreSQL.
ON CONFLICT ... DO UPDATE somente quando valores diferirem.
Corte 3 — Backfill paginado e retomável
Atualizar o utilitário de backfill para trabalhar com:
janelas de tempo;
keyset/checkpoint persistente;
quantidade configurável de tokens ou linhas;
statement_timeout;
lock_timeout;
pausa limpa em SIGTERM;
métricas de linhas lidas, gravadas e tempo por lote.
Evitar:
OFFSET;
carregar milhares de buckets em JavaScript;
transações gigantes;
concorrência sem limite.
Corte 4 — Verificação de cobertura
Criar um auditor read-only que compare fonte e agregado.
Para cada token, janela e granularidade, verificar:
quantidade de buckets-fonte;
volume total;
swaps, buys, sells e transações;
open/high/low/close;
primeiro e último bloco/log;
protocolos e mercados envolvidos;
intervalos sem agregado;
agregados órfãos ou divergentes.
A verificação deve produzir um watermark: até qual timestamp os agregados estão comprovadamente completos.
Não considerar apenas COUNT(*), porque minutos sem swaps são lacunas legítimas.
Corte 5 — Leituras conscientes de cobertura
Hoje encontrar alguma linha agregada para um token pode impedir o fallback, mesmo que existam buracos no intervalo.
Antes de apagar 1m:
usar agregados somente dentro do intervalo verificado;
fazer fallback para 1m fora dele;
ativar ROBINHOOD_MARKET_AGGREGATE_READS_ENABLED=true primeiro em canário;
comparar respostas legacy e agregadas;
acompanhar divergências e latência.
Corte 6 — Exclusão dos buckets 1m
Apagar somente buckets:
mais antigos que a retenção;
abaixo do watermark verificado;
já representados em 1h e 5m/15m/30m;
pertencentes a janelas fechadas.
Usar batches pequenos com keyset ou ctid, commits frequentes e limite de duração.
Manter pelo menos os 14 dias recentes, conforme o expires_at atual, porque dashboard e alertas ainda consultam 1m.
Depois:
VACUUM (ANALYZE);
acompanhar autovacuum e bloat;
não executar VACUUM FULL em produção sem janela de manutenção.
Corte 7 — Índices orientados por EXPLAIN
Antes de criar índices, executar EXPLAIN (ANALYZE, BUFFERS) nos SQLs em lote.
Avaliar índices para:
scans por chain + bucket_ts;
agrupamento por token_address + bucket_ts;
limpeza por expires_at/bucket_ts;
leitura de agregados por token, granularidade e tempo.
Não adicionar índices cegamente: cada índice também deixa a ingestão mais cara e aumenta WAL.
Métricas de sucesso
Medir antes e depois:
blocos/minuto dos cursores;
swaps persistidos/segundo;
buckets agregados/segundo;
duração das transações;
tempo esperando locks;
CPU, I/O e memória do PostgreSQL;
WAL gerado;
tamanho e bloat das tabelas;
divergências encontradas pelo auditor;
latência do dashboard.
Pontos importantes
A otimização PostgreSQL não elimina o gargalo do RPC histórico.
Apagar 1m não acelera diretamente eth_call ou eth_getLogs.
O maior ganho esperado no banco é remover o N+1 dos agregados e tirar agregação histórica repetitiva do hot path.
Não apagar 1m até cobertura e leitura agregada estarem comprovadas.
O limite de FDV de US$30 bi protege catálogo/alertas, mas não valida os buckets armazenados.
Preservar robinhood_market_observations, porque é o ledger auditável swap por swap.
Depois dessas otimizações, usar um archive RPC pago continua sendo o próximo passo para aumentar a velocidade do backfill da chain.
Validação obrigatória por corte
Verificar git status antes de editar.
Preservar mudanças preexistentes não relacionadas.
Rodar npm run lint.
Rodar os testes Robinhood afetados com node --test ....
Se houver schema/init: rodar npm run db:schema-check.
Revisar o git diff completo.
Informar arquivos, linhas alteradas, riscos e pendências.
Parar após um único corte e aguardar autorização.
Mudanças preexistentes atualmente observadas e que não devem ser misturadas:
CLAUDE.md
arquivos de frontend
teste smoke do chain selector
documento do Yellowstone gRPC
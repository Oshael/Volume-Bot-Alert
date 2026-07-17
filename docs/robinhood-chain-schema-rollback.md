# Robinhood chain schema rollback

Rollback dos stages 51 a 56. Os stages 51/52 sao aditivos; os stages 53-56
promovem identidades compostas no catalogo, preferencias, blocklists e risco.

## Rollback recomendado

O rollback mais seguro e reverter o codigo sem apagar colunas/indexes. Depois
do stage 53, codigo antigo que usa `ON CONFLICT (address)` nao e compativel e
exige restaurar temporariamente a unique legada, apenas se nao houver enderecos
duplicados entre chains.

Validacao obrigatoria antes de restaurar a unique address-only:

```sql
SELECT address, COUNT(*)
FROM token_catalog
GROUP BY address
HAVING COUNT(*) > 1;
```

Se a consulta retornar qualquer row, nao recriar a constraint legada.

Para reverter o stage 54, repetir a mesma auditoria por `user_id,address` em
manual, starred, pinned e bootstrap. Folder items exigem ainda confirmar zero
duplicatas por `user_id,folder_id,address`. Nunca restaurar FK address-only se
existir a mesma identidade em mais de uma chain.

O stage 55 exige auditoria por `user_id,address` em `user_blocklist` e por
`address` em `admin_blocked_tokens`. Se qualquer endereco aparecer em mais de
uma chain, nao restaurar unique/PK address-only. Evidencias devem ser preservadas
mesmo durante rollback funcional.

O stage 56 exige auditoria por `token_address` nas tabelas de enrichment/review
e por `token_address,assessment_fingerprint` em junk evidence. Se houver mais
de uma chain, nao restaurar PK/unique address-only. Desligar writers automaticos
antes de qualquer rollback funcional.

## Pre-condicoes para rollback destrutivo

Somente remover colunas depois de confirmar:

```sql
SELECT chain, COUNT(*) FROM token_catalog GROUP BY chain;
```

- todas as tabelas dos stages 51/52 possuem apenas `chain='solana'`;
- nenhum modelo do Bloco 9C foi publicado;
- nenhum dado Robinhood foi persistido;
- backup e janela de manutencao foram confirmados.

## Ordem destrutiva

1. Derrubar primeiro indexes `*_chain_*` e
   `idx_admin_review_alerts_open_chain_token_kind`.
2. Remover `chain` das tabelas do stage 52.
3. Remover `chain` somente dos três buckets do stage 51.
4. Nao remover `token_catalog.chain`: a coluna existia antes do Bloco 9B.
5. Rodar `npm run db:schema-check` com o codigo anterior.

Os nomes completos dos indexes estao versionados nos stages 51/52. O stage 53
esta em `src/utils/db-init-stage53.js`. Gerar o SQL de drop a partir dessa
versao reduz risco de remover indexes legados com nomes parecidos.

Os três indexes de buckets do stage 51 são parciais para `chain <> 'solana'`.
Não os substituir por indexes completos enquanto as tabelas tiverem dezenas de
milhões de rows e o orçamento de disco não estiver documentado.

## Rollback depois do 9C

Depois que modelos escreverem identidades multi-chain, rollback destrutivo nao
e permitido. O procedimento passa a ser:

- desligar feature flags Robinhood;
- interromper writers;
- preservar rows Robinhood;
- voltar leitores para Solana usando `WHERE chain='solana'`;
- executar migracao reversa de dados revisada, nunca `DROP COLUMN` direto.

## Stage 63 - storage Robinhood dedicado

O rollback funcional seguro e manter as tabelas, desligar o writer Robinhood e
voltar o runner ao modo read-only. Registry, cursores e ledger de logs nao
alteram tabelas Solana e podem permanecer sem efeito colateral.

Um rollback destrutivo so e permitido antes da ativacao do writer ou depois de
backup explicito. A ordem e: `robinhood_processed_logs`,
`robinhood_ingestion_cursors`, `robinhood_pool_registry`. Nunca apagar cursores
isoladamente com o writer ativo, pois o restart repetiria o range sem o mesmo
checkpoint transacional.

A Stage 64 adiciona `robinhood_market_observations` com FK para o ledger. Em
rollback destrutivo, remover observacoes antes de qualquer tabela da Stage 63.
No rollback funcional, preservar observacoes e apenas desligar o writer; isso
mantem os raw amounts disponiveis para diagnostico ou reprocessamento.

A Stage 65 adiciona `robinhood_market_buckets_1m` sem alterar tabelas Solana.
No rollback funcional, desligar o writer e preservar os candles. Em rollback
destrutivo autorizado, remover primeiro os buckets da Stage 65, depois as
observacoes da Stage 64 e so entao seguir a ordem da Stage 63. Apagar candles
antes do backup elimina o historico agregado que sobrevive a retencao curta dos
swaps brutos.

A Stage 66 adiciona `robinhood_market_buckets_1h` como historico permanente.
No rollback funcional, preservar a tabela e apenas desligar o writer. Em
rollback destrutivo autorizado, remover primeiro a tabela horaria da Stage 66,
depois os buckets de 1 minuto da Stage 65, observacoes da Stage 64 e finalmente
seguir a ordem da Stage 63. O drop da Stage 66 perde o unico historico que
sobrevive depois de 14 dias e exige backup explicito.

A Stage 67 adiciona somente evidencias de liquidez as observacoes exatas. No
rollback funcional, manter as colunas e desligar o writer e suficiente. Um
rollback destrutivo exige backup, remocao primeiro das constraints
`robinhood_market_observations_liquidity_values_check` e
`robinhood_market_observations_liquidity_protocol_check`, seguida das cinco
colunas `liquidity_*`. Nunca converter `liquidity_raw` de Uniswap v3/v4 em USD:
esse escalar nao representa a distribuicao de liquidez por ticks/posicoes.

A Stage 68 replica o ultimo snapshot de liquidez nas tabelas de 1 minuto e 1
hora. As colunas sao nullable para manter buckets antigos em estado fail-closed.
No rollback funcional, preservar as colunas nao muda a leitura legada. Para um
rollback destrutivo autorizado, remover primeiro as constraints
`robinhood_market_buckets_1m_liquidity_check` e
`robinhood_market_buckets_1h_liquidity_check`, depois as cinco colunas
`close_liquidity_*` de cada tabela. Remover a Stage 68 antes da Stage 67.

A Stage 69 adiciona somente `token_catalog.last_fdv`, nullable e sem backfill,
para impedir que a avaliacao totalmente diluida seja gravada como market cap
circulante. O rollback funcional seguro e preservar a coluna e voltar os
leitores; ela nao altera linhas Solana nem writers legados. Um rollback
destrutivo exige primeiro desligar o staging Robinhood, confirmar backup e
entao executar `ALTER TABLE token_catalog DROP COLUMN last_fdv`. Remover a
coluna com staging ativo faz o proximo lote autorizado falhar.

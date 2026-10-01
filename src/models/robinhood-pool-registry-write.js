async function upsertPool(client, pool, { preserveExistingState = false } = {}) {
  await client.query(
    `INSERT INTO robinhood_pool_registry (
       chain, protocol, market_key, pool_address, pool_id, origin_address,
       token_address, quote_address, currency0, currency1, fee, tick_spacing,
       hooks_address, discovery_block, discovery_block_hash, discovery_tx_hash,
       discovery_log_index, discovered_at, metadata
     ) VALUES (
       'robinhood', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18::jsonb
     )
     ON CONFLICT (chain, protocol, market_key) DO UPDATE SET
       pool_address = EXCLUDED.pool_address,
       pool_id = EXCLUDED.pool_id,
       origin_address = EXCLUDED.origin_address,
       token_address = EXCLUDED.token_address,
       quote_address = EXCLUDED.quote_address,
       currency0 = EXCLUDED.currency0,
       currency1 = EXCLUDED.currency1,
       fee = EXCLUDED.fee,
       tick_spacing = EXCLUDED.tick_spacing,
       hooks_address = EXCLUDED.hooks_address,
       discovery_block = EXCLUDED.discovery_block,
       discovery_block_hash = EXCLUDED.discovery_block_hash,
       discovery_tx_hash = EXCLUDED.discovery_tx_hash,
       discovery_log_index = EXCLUDED.discovery_log_index,
       discovered_at = EXCLUDED.discovered_at,
       active = CASE WHEN $19::boolean THEN robinhood_pool_registry.active ELSE true END,
       metadata = CASE WHEN $19::boolean
         THEN robinhood_pool_registry.metadata || jsonb_strip_nulls(EXCLUDED.metadata)
         ELSE EXCLUDED.metadata END,
       updated_at = NOW()`,
    [
      pool.protocol, pool.marketKey, pool.poolAddress, pool.poolId, pool.originAddress,
      pool.tokenAddress, pool.quoteAddress, pool.currency0, pool.currency1,
      pool.fee, pool.tickSpacing, pool.hooksAddress, pool.discoveryBlock,
      pool.discoveryBlockHash, pool.discoveryTxHash, pool.discoveryLogIndex,
      pool.discoveredAt, pool.metadata, preserveExistingState,
    ]
  );
}

module.exports = { upsertPool };

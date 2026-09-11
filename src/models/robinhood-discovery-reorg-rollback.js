'use strict';

const CHAIN = 'robinhood';

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function normalizeRange(input = {}) {
  const fromBlock = quantity(input.fromBlock, 'discovery rollback fromBlock');
  const throughBlock = quantity(input.throughBlock, 'discovery rollback throughBlock');
  if (BigInt(fromBlock) > BigInt(throughBlock)) {
    throw new Error('discovery rollback range is inverted');
  }
  return { fromBlock, throughBlock };
}

function createRobinhoodDiscoveryReorgRollback() {
  async function rollback(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('discovery rollback requires a transaction client');
    }
    const range = normalizeRange(input);
    await client.query('LOCK TABLE robinhood_processed_logs IN SHARE ROW EXCLUSIVE MODE');
    await client.query('LOCK TABLE robinhood_pool_registry IN SHARE ROW EXCLUSIVE MODE');
    await client.query(
      `CREATE TEMP TABLE rh_reorg_discovery_logs ON COMMIT DROP AS
       SELECT processed.transaction_hash, processed.log_index, processed.block_number,
              processed.block_hash, processed.event_kind, processed.protocol,
              processed.market_key
         FROM robinhood_processed_logs processed
         INNER JOIN robinhood_chain_blocks block
           ON block.chain=processed.chain AND block.canonical
          AND block.block_number=processed.block_number
          AND block.block_hash=processed.block_hash
        WHERE processed.chain=$1 AND processed.stream='discovery'
          AND processed.block_number BETWEEN $2::bigint AND $3::bigint`,
      [CHAIN, range.fromBlock, range.throughBlock]
    );
    await client.query(
      'CREATE UNIQUE INDEX ON rh_reorg_discovery_logs(transaction_hash, log_index)'
    );
    const noxa = await client.query(
      `UPDATE robinhood_pool_registry registry
          SET metadata=registry.metadata - 'noxa', updated_at=NOW()
         FROM rh_reorg_discovery_logs orphan
        WHERE registry.chain=$1 AND orphan.event_kind='token-launched'
          AND orphan.protocol=registry.protocol AND orphan.market_key=registry.market_key
          AND registry.metadata ? 'noxa'`, [CHAIN]
    );
    const pools = await client.query(
      `UPDATE robinhood_pool_registry registry SET active=FALSE, updated_at=NOW()
         FROM robinhood_chain_blocks block
        WHERE registry.chain=$1 AND block.chain=registry.chain AND block.canonical
          AND block.block_number=registry.discovery_block
          AND block.block_hash=registry.discovery_block_hash
          AND registry.discovery_block BETWEEN $2::bigint AND $3::bigint
          AND registry.active`, [CHAIN, range.fromBlock, range.throughBlock]
    );
    const logs = await client.query(
      `DELETE FROM robinhood_processed_logs processed
        USING rh_reorg_discovery_logs orphan
        WHERE processed.chain=$1
          AND processed.transaction_hash=orphan.transaction_hash
          AND processed.log_index=orphan.log_index`, [CHAIN]
    );
    return Object.freeze({
      invalidatedPools: pools.rowCount || 0,
      clearedNoxaMetadata: noxa.rowCount || 0,
      deletedProcessedLogs: logs.rowCount || 0,
    });
  }

  return Object.freeze({ rollback });
}

module.exports = {
  createRobinhoodDiscoveryReorgRollback,
  __private: { normalizeRange },
};

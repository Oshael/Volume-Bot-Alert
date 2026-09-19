'use strict';

const db = require('./db');
const {
  CANONICAL_CONTRACTS, ROBINHOOD_TOKENIZED_ASSETS,
} = require('../services/robinhood-market-policy');
const v2 = require('../services/uniswap-v2-decoder');
const v3 = require('../services/uniswap-v3-decoder');
const v4 = require('../services/uniswap-v4-decoder');

const CHAIN = 'robinhood';
const COVERAGE_TABLE = 'robinhood_stock_usd_reference_coverage';
const STOCKS = Object.freeze(Object.values(ROBINHOOD_TOKENIZED_ASSETS));
const REFERENCE_TOPICS = new Set([v2.TOPICS.sync, v3.TOPICS.swap, v4.TOPICS.swap]);

function branches(source, usdgParameter, stocksParameter, wethParameter) {
  const branch = (protocol, emitter, topic, poolId = '') => `
    SELECT registry.protocol, registry.market_key,
           registry.token_address AS stock_address, event.block_number,
           event.block_hash, event.transaction_hash, event.transaction_index,
           event.log_index, event.address, event.topics, event.data
      FROM ${source} event
      INNER JOIN robinhood_pool_registry registry
        ON registry.chain='${CHAIN}' AND registry.active=TRUE
       AND registry.protocol='${protocol}'
       AND registry.quote_address=${usdgParameter}
       AND registry.token_address=ANY(${stocksParameter}::varchar[])
       AND registry.discovery_block<=event.block_number
       AND registry.${emitter}=event.address
       ${poolId}
     WHERE event.topic0='${topic}'`;
  return [
    branch('uniswap-v2', 'pool_address', v2.TOPICS.sync),
    branch('uniswap-v3', 'pool_address', v3.TOPICS.swap),
    branch('uniswap-v4', 'origin_address', v4.TOPICS.swap,
      'AND event.topics->>1=registry.pool_id'),
    `SELECT 'uniswap-v3', 'robinhood:uniswap-v3:' || pool.pool_address,
            ${wethParameter}, event.block_number, event.block_hash,
            event.transaction_hash, event.transaction_index, event.log_index,
            event.address, event.topics, event.data
       FROM ${source} event
       INNER JOIN robinhood_weth_usd_reference_pools pool
         ON pool.chain='${CHAIN}' AND pool.active=TRUE
        AND pool.pool_address=event.address
        AND pool.deployment_block<=event.block_number
      WHERE event.topic0='${v3.TOPICS.swap}'`,
  ].join('\nUNION ALL\n');
}

function insertSql(sourceSql, usdgParameter, stocksParameter, wethParameter) {
  return `${sourceSql}, matched AS MATERIALIZED (${branches(
    'candidate_events', usdgParameter, stocksParameter, wethParameter
  )})
  INSERT INTO robinhood_stock_usd_reference_events(
    chain, protocol, market_key, stock_address, block_number, block_hash,
    transaction_hash, transaction_index, log_index, address, topics, data
  ) SELECT '${CHAIN}', protocol, market_key, stock_address, block_number, block_hash,
           transaction_hash, transaction_index, log_index, address, topics, data
      FROM matched
  ON CONFLICT DO NOTHING`;
}

async function appendCapturedEvents(executor, events = []) {
  const candidates = events.filter((event) => REFERENCE_TOPICS.has(event.topic0));
  if (!candidates.length) return 0;
  const result = await executor.query(insertSql(
    `WITH candidate_events AS MATERIALIZED (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS event(
         block_number BIGINT, block_hash TEXT, transaction_hash TEXT,
         transaction_index INTEGER, log_index INTEGER, address TEXT,
         topic0 TEXT, topics JSONB, data TEXT
       )
     )`, '$2', '$3', '$4'
  ), [JSON.stringify(candidates), CANONICAL_CONTRACTS.USDG, STOCKS, CANONICAL_CONTRACTS.WETH]);
  return result.rowCount;
}

async function backfillRange(input = {}, options = {}) {
  const database = options.database || db;
  const fromBlock = BigInt(input.fromBlock);
  const throughBlock = BigInt(input.throughBlock);
  if (fromBlock < 0n || throughBlock < fromBlock) throw new Error('backfill range is invalid');
  const result = await database.query(insertSql(
    `WITH candidate_events AS MATERIALIZED (
       SELECT event.* FROM robinhood_chain_events event
       INNER JOIN robinhood_chain_blocks block
         ON block.chain=event.chain AND block.block_hash=event.block_hash
        AND block.canonical=TRUE
      WHERE event.chain='${CHAIN}'
        AND event.block_number BETWEEN $1::bigint AND $2::bigint
        AND event.topic0 IN (
          '${v2.TOPICS.sync}', '${v3.TOPICS.swap}', '${v4.TOPICS.swap}'
        )
     )`, '$3', '$4', '$5'
  ), [fromBlock.toString(), throughBlock.toString(),
    CANONICAL_CONTRACTS.USDG, STOCKS, CANONICAL_CONTRACTS.WETH]);
  await recordBackfillCoverage(database, { fromBlock, throughBlock });
  return result.rowCount;
}

async function recordBackfillCoverage(executor, input = {}) {
  const fromBlock = BigInt(input.fromBlock);
  const nextBlock = BigInt(input.throughBlock) + 1n;
  if (fromBlock < 0n || nextBlock <= fromBlock) throw new Error('coverage range is invalid');
  const result = await executor.query(
    `INSERT INTO ${COVERAGE_TABLE}(chain, coverage_start_block, next_block)
     VALUES ('${CHAIN}', $1, $2)
     ON CONFLICT (chain) DO UPDATE SET
       coverage_start_block=LEAST(${COVERAGE_TABLE}.coverage_start_block,
                                  EXCLUDED.coverage_start_block),
       next_block=GREATEST(${COVERAGE_TABLE}.next_block, EXCLUDED.next_block),
       updated_at=NOW()
     WHERE EXCLUDED.coverage_start_block<=${COVERAGE_TABLE}.next_block
       AND EXCLUDED.next_block>=${COVERAGE_TABLE}.coverage_start_block`,
    [fromBlock.toString(), nextBlock.toString()]
  );
  if (result.rowCount !== 1) {
    const error = new Error('stock/USD reference backfill would create a coverage gap');
    error.code = 'stock_usd_reference_coverage_gap';
    throw error;
  }
}

async function advanceLiveCoverage(executor, input = {}) {
  const fromBlock = BigInt(input.fromBlock);
  const nextBlock = BigInt(input.throughBlock) + 1n;
  if (fromBlock < 0n || nextBlock <= fromBlock) throw new Error('coverage range is invalid');
  await executor.query(
    `UPDATE ${COVERAGE_TABLE}
        SET next_block=$2, updated_at=NOW()
      WHERE chain='${CHAIN}' AND next_block=$1`,
    [fromBlock.toString(), nextBlock.toString()]
  );
}

module.exports = {
  advanceLiveCoverage, appendCapturedEvents, backfillRange, recordBackfillCoverage,
};

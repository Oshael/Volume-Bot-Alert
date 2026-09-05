'use strict';

const db = require('./db');
const { LIQUIDITY_EVENT_TOPICS } = require('../services/robinhood-pool-liquidity-events');

const CHAIN = 'robinhood';

function block(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized);
}

function batchSize(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new RangeError('maxBlocks must be between 1 and 1000');
  }
  return parsed;
}

function timestampMs(value) {
  if (value == null) return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error('checkpoint timestamp is invalid');
  return parsed;
}

function logFromRow(row) {
  return Object.freeze({
    blockNumber: String(row.block_number),
    blockHash: row.block_hash,
    transactionHash: row.transaction_hash,
    transactionIndex: String(row.transaction_index),
    logIndex: String(row.log_index),
    address: row.address,
    topics: row.topics,
    data: row.data,
    removed: false,
  });
}

function sourceGap(message) {
  const error = new Error(message);
  error.code = 'canonical_liquidity_source_gap';
  return error;
}

function resultFrom(state, fromBlock, rows) {
  const journalStart = state.journal_start_block == null
    ? null : BigInt(state.journal_start_block);
  if (journalStart == null || fromBlock < journalStart) {
    throw sourceGap(`canonical journal does not cover liquidity block ${fromBlock}`);
  }
  const safeHead = state.safe_head == null ? null : String(state.safe_head);
  if (state.to_block == null) {
    return Object.freeze({
      status: 'caught_up', fromBlock: fromBlock.toString(), toBlock: null,
      safeHead, logs: Object.freeze([]), checkpoint: null,
    });
  }
  if (!state.checkpoint_hash) {
    throw sourceGap(`canonical checkpoint ${state.to_block} is missing`);
  }
  return Object.freeze({
    status: 'available',
    fromBlock: fromBlock.toString(),
    toBlock: String(state.to_block),
    safeHead,
    logs: Object.freeze(rows.map(logFromRow)),
    checkpoint: Object.freeze({
      number: String(state.to_block),
      hash: state.checkpoint_hash,
      timestampMs: timestampMs(state.checkpoint_timestamp),
    }),
  });
}

function createRobinhoodCanonicalLiquiditySource(options = {}) {
  const database = options.database || db;

  async function readNextRange(input = {}) {
    const fromBlock = block(input.fromBlock, 'fromBlock');
    const maxBlocks = batchSize(input.maxBlocks);
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const stateResult = await client.query(
        `WITH pending AS MATERIALIZED (
           SELECT outbox.block_number
             FROM robinhood_chain_domain_outbox outbox
            WHERE outbox.chain=$1 AND outbox.status<>'complete'
            ORDER BY outbox.block_number, outbox.status, outbox.domain,
                     outbox.transaction_index, outbox.log_index LIMIT 1
         ), frontier AS (
           SELECT capture.checkpoint_block AS journal_through,
                  (SELECT block_number FROM robinhood_chain_blocks
                    WHERE chain=$1 AND canonical=TRUE
                    ORDER BY block_number LIMIT 1) AS journal_start_block,
                  CASE WHEN pending.block_number IS NULL THEN capture.checkpoint_block
                       ELSE LEAST(capture.checkpoint_block, pending.block_number-1) END AS safe_head
             FROM robinhood_chain_capture_cursor capture
             LEFT JOIN pending ON TRUE
            WHERE capture.chain=$1
         ), target AS (
           SELECT frontier.*,
                  CASE WHEN safe_head IS NULL OR journal_through IS NULL
                              OR safe_head < $2::bigint THEN NULL
                       ELSE LEAST(safe_head, journal_through,
                                  $2::bigint+$3::bigint-1) END AS to_block
             FROM frontier
         )
         SELECT target.journal_start_block, target.journal_through,
                target.safe_head, target.to_block,
                checkpoint.block_hash AS checkpoint_hash,
                checkpoint.block_timestamp AS checkpoint_timestamp
           FROM target
           LEFT JOIN robinhood_chain_blocks checkpoint
             ON checkpoint.chain=$1 AND checkpoint.canonical=TRUE
            AND checkpoint.block_number=target.to_block`,
        [CHAIN, fromBlock.toString(), maxBlocks]
      );
      const state = stateResult.rows[0];
      if (!state) throw sourceGap('canonical capture cursor is missing');
      let rows = [];
      if (state.to_block != null) {
        const events = await client.query(
          `SELECT event.block_number, event.block_hash, event.transaction_hash,
                  event.transaction_index, event.log_index, event.address,
                  event.topics, event.data
             FROM robinhood_chain_events event
             JOIN robinhood_chain_blocks block
               ON block.chain=event.chain AND block.block_hash=event.block_hash
              AND block.canonical=TRUE
            WHERE event.chain=$1 AND event.block_number BETWEEN $2::bigint AND $3::bigint
              AND event.topic0=ANY($4::varchar[])
            ORDER BY event.block_number, event.transaction_index, event.log_index`,
          [CHAIN, fromBlock.toString(), String(state.to_block), LIQUIDITY_EVENT_TOPICS]
        );
        rows = events.rows;
      }
      const result = resultFrom(state, fromBlock, rows);
      await client.query('ROLLBACK');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ readNextRange });
}

module.exports = {
  createRobinhoodCanonicalLiquiditySource,
  __private: { logFromRow, resultFrom },
};

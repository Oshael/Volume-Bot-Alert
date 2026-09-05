'use strict';

const db = require('./db');
const {
  FACTORIES, decodeLaunchpadCreatorLog,
} = require('../services/robinhood-launchpad-creator-adapter');

const CHAIN = 'robinhood';

function sourceGap(message) {
  return Object.assign(new Error(message), {
    code: 'canonical_creator_source_gap', fatal: true,
  });
}

function confirmedHead(row, confirmations) {
  if (!row || row.node_head == null || row.checkpoint_block == null) {
    throw sourceGap('canonical capture frontier is unavailable');
  }
  const head = BigInt(row.node_head);
  const checkpoint = BigInt(row.checkpoint_block);
  const confirmed = head >= BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
  return checkpoint < confirmed ? checkpoint : confirmed;
}

function createRobinhoodCanonicalDirectCreatorSource(options = {}) {
  const database = options.database || db;

  async function readFrontier(client = database) {
    const result = await client.query(
      `SELECT node_head, checkpoint_block
         FROM robinhood_chain_capture_cursor WHERE chain=$1`,
      [CHAIN]
    );
    if (!result.rowCount) throw sourceGap('canonical capture cursor is missing');
    return result.rows[0];
  }

  async function assertChain() {
    await readFrontier();
    return '4663';
  }

  async function getSafeHead(confirmations = 2) {
    const parsed = Number(confirmations);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1000) {
      throw new Error('confirmations must be between 0 and 1000');
    }
    const row = await readFrontier();
    return Object.freeze({
      head: String(row.node_head), safeHead: confirmedHead(row, parsed).toString(),
    });
  }

  async function matchesCheckpoint(checkpoint = {}) {
    const number = BigInt(String(checkpoint.number)).toString();
    const hash = String(checkpoint.hash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('checkpoint.hash is invalid');
    const result = await database.query(
      `SELECT EXISTS (
         SELECT 1 FROM robinhood_chain_blocks
          WHERE chain=$1 AND block_number=$2::bigint AND block_hash=$3 AND canonical=TRUE
       ) AS matches`,
      [CHAIN, number, hash]
    );
    return result.rows[0]?.matches === true;
  }

  async function readRange(fromBlock, toBlock) {
    const from = BigInt(String(fromBlock));
    const to = BigInt(String(toBlock));
    if (from > to || to - from + 1n > 2000n) throw new Error('creator range is invalid');
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const frontier = await readFrontier(client);
      if (to > BigInt(frontier.checkpoint_block)) {
        throw sourceGap(`canonical journal does not cover creator range ${from}-${to}`);
      }
      const params = [CHAIN, from.toString(), to.toString()];
      const headers = await client.query(
        `SELECT block_number, block_hash, block_timestamp FROM robinhood_chain_blocks
          WHERE chain=$1 AND canonical=TRUE
            AND block_number BETWEEN $2::bigint AND $3::bigint
          ORDER BY block_number`, params
      );
      const direct = await client.query(
        `SELECT block.block_number, block.block_hash, transaction.transaction_hash,
                transaction.from_address, transaction.contract_address
           FROM robinhood_chain_transactions transaction
           JOIN robinhood_chain_blocks block
             ON block.chain=transaction.chain AND block.block_hash=transaction.block_hash
          WHERE block.chain=$1 AND block.canonical=TRUE
            AND block.block_number BETWEEN $2::bigint AND $3::bigint
            AND transaction.to_address IS NULL
            AND transaction.contract_address IS NOT NULL`, params
      );
      const events = await client.query(
        `SELECT event.block_number, event.block_hash, event.transaction_hash,
                event.address, event.topics, event.data
           FROM robinhood_chain_events event
           JOIN robinhood_chain_blocks block
             ON block.chain=event.chain AND block.block_hash=event.block_hash
          WHERE block.chain=$1 AND block.canonical=TRUE
            AND event.block_number BETWEEN $2::bigint AND $3::bigint
            AND event.address=ANY($4::varchar[]) AND event.topic0=ANY($5::varchar[])
          ORDER BY event.block_number, event.transaction_index, event.log_index`,
        [...params, [...FACTORIES.keys()],
          [...new Set([...FACTORIES.values()].map(({ topic }) => topic))]]
      );
      const blocks = new Map(headers.rows.map((row) => [String(row.block_number), {
        blockNumber: String(row.block_number), blockHash: row.block_hash,
        blockTimestamp: new Date(row.block_timestamp).toISOString(), deployments: [],
      }]));
      for (const row of direct.rows) blocks.get(String(row.block_number))?.deployments.push({
        tokenAddress: row.contract_address, creatorAddress: row.from_address,
        transactionHash: row.transaction_hash, blockNumber: String(row.block_number),
        blockHash: row.block_hash, factoryAddress: null, launchpadId: null,
        source: 'rpc_direct',
      });
      for (const row of events.rows) blocks.get(String(row.block_number))?.deployments.push(
        decodeLaunchpadCreatorLog({
          ...row, blockNumber: String(row.block_number), blockHash: row.block_hash,
          transactionHash: row.transaction_hash,
        })
      );
      await client.query('ROLLBACK');
      return blocks;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ assertChain, getSafeHead, matchesCheckpoint, readRange });
}

module.exports = { createRobinhoodCanonicalDirectCreatorSource };

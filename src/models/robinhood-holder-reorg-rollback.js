'use strict';

const {
  acquireRobinhoodHolderReorgFence,
  createRobinhoodHolderLedgerRepository,
} = require('./robinhood-holder-ledger');

const CHAIN = 'robinhood';

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function hash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizeRange(input = {}) {
  const range = {
    ancestorBlock: quantity(input.ancestorBlock, 'ancestorBlock'),
    ancestorHash: hash(input.ancestorHash, 'ancestorHash'),
    fromBlock: quantity(input.fromBlock, 'fromBlock'),
    throughBlock: quantity(input.throughBlock, 'throughBlock'),
  };
  if (BigInt(range.fromBlock) !== BigInt(range.ancestorBlock) + 1n
      || BigInt(range.throughBlock) < BigInt(range.fromBlock)) {
    throw new Error('holder rollback range is inconsistent');
  }
  return range;
}

function conflict(message) {
  return Object.assign(new Error(message), { code: 'holder_recovery_fence_conflict' });
}

async function lockCursor(client) {
  const result = await client.query(
    `SELECT next_block::text, safe_head::text, checkpoint_block::text,
            checkpoint_hash, journal_floor_block::text, version::text
       FROM robinhood_holder_cursors
      WHERE chain=$1 AND stream='live' FOR UPDATE`, [CHAIN]
  );
  if (!result.rowCount) throw conflict('holder LIVE cursor is missing');
  return result.rows[0];
}

async function assertCanonicalEvidence(client, range, cursor) {
  const nextBlock = BigInt(cursor.next_block);
  const fromBlock = BigInt(range.fromBlock);
  const throughBlock = BigInt(range.throughBlock);
  if (nextBlock > throughBlock + 1n) {
    throw conflict('holder frontier is ahead of the recovery range');
  }
  const evidence = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM robinhood_holder_transfer_journal journal
         WHERE journal.chain=$1 AND journal.block_number >= $2::bigint
           AND journal.block_number < $3::bigint) AS affected,
       (SELECT COUNT(*)::int FROM robinhood_holder_transfer_journal journal
         LEFT JOIN robinhood_chain_blocks block
           ON block.chain=journal.chain AND block.canonical
          AND block.block_number=journal.block_number AND block.block_hash=journal.block_hash
        WHERE journal.chain=$1 AND journal.block_number >= $2::bigint
          AND journal.block_number < $3::bigint AND block.block_hash IS NULL) AS unanchored,
       (SELECT COUNT(*)::int FROM robinhood_holder_token_states state
         WHERE state.chain=$1 AND state.live_through_block >= $2::bigint) AS advanced_states`,
    [CHAIN, range.fromBlock, cursor.next_block]
  );
  const facts = evidence.rows[0] || {};
  if (Number(facts.unanchored || 0)) {
    throw conflict('holder journal is not anchored to the canonical branch');
  }
  if (nextBlock <= fromBlock) {
    if (Number(facts.affected || 0) || Number(facts.advanced_states || 0)) {
      throw conflict('holder state is ahead of its LIVE cursor');
    }
    return false;
  }
  if (cursor.checkpoint_block == null
      || BigInt(cursor.checkpoint_block) + 1n !== nextBlock) {
    throw conflict('holder LIVE checkpoint is inconsistent');
  }
  const checkpoint = await client.query(
    `SELECT 1 FROM robinhood_chain_blocks
      WHERE chain=$1 AND canonical AND block_number=$2::bigint AND block_hash=$3`,
    [CHAIN, cursor.checkpoint_block, cursor.checkpoint_hash]
  );
  if (!checkpoint.rowCount) throw conflict('holder LIVE checkpoint is not canonical');
  return true;
}

function createRobinhoodHolderReorgRollback(options = {}) {
  const ledger = options.ledger || createRobinhoodHolderLedgerRepository(options);

  async function rollback(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('holder rollback requires a transaction client');
    }
    const range = normalizeRange(input);
    await acquireRobinhoodHolderReorgFence(client, 'exclusive');
    const cursor = await lockCursor(client);
    if (!await assertCanonicalEvidence(client, range, cursor)) {
      return Object.freeze({ status: 'unaffected', cursorRewound: false });
    }
    const result = await ledger.rewindOrphanedRangeInTransaction(client, {
      nextBlock: range.fromBlock, safeHead: range.ancestorBlock,
      expectedVersion: Number(cursor.version),
      checkpoint: { number: range.ancestorBlock, hash: range.ancestorHash },
    });
    return Object.freeze({ ...result, cursorRewound: true });
  }

  return Object.freeze({ rollback });
}

module.exports = { createRobinhoodHolderReorgRollback, __private: { normalizeRange } };

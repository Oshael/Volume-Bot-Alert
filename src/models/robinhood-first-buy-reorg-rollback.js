'use strict';

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

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(String(value || ''));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function normalizeRange(input = {}) {
  const range = {
    ancestorBlock: quantity(input.ancestorBlock, 'ancestorBlock'),
    ancestorHash: hash(input.ancestorHash, 'ancestorHash'),
    ancestorTimestamp: timestamp(input.ancestorTimestamp, 'ancestorTimestamp'),
    fromBlock: quantity(input.fromBlock, 'fromBlock'),
    throughBlock: quantity(input.throughBlock, 'throughBlock'),
  };
  if (BigInt(range.fromBlock) !== BigInt(range.ancestorBlock) + 1n
      || BigInt(range.throughBlock) < BigInt(range.fromBlock)) {
    throw new Error('first-buy rollback range is inconsistent');
  }
  return range;
}

function conflict(message) {
  return Object.assign(new Error(message), { code: 'first_buy_recovery_fence_conflict' });
}

async function inspectFirstBuys(client, range) {
  await client.query(
    'LOCK TABLE robinhood_wallet_token_first_buys IN SHARE ROW EXCLUSIVE MODE'
  );
  const result = await client.query(
    `SELECT COUNT(*)::int AS affected,
            COUNT(*) FILTER (WHERE block.block_hash IS NULL)::int AS unanchored
       FROM robinhood_wallet_token_first_buys first_buy
       LEFT JOIN robinhood_chain_blocks block
         ON block.chain=first_buy.chain AND block.canonical
        AND block.block_number=first_buy.block_number
        AND block.block_hash=first_buy.block_hash
        AND block.block_timestamp=first_buy.block_time
      WHERE first_buy.chain=$1
        AND first_buy.block_number BETWEEN $2::bigint AND $3::bigint`,
    [CHAIN, range.fromBlock, range.throughBlock]
  );
  return result.rows[0] || { affected: 0, unanchored: 0 };
}

async function loadFrontiers(client) {
  const result = await client.query(
    `SELECT first_buy.*, seed.status AS seed_status,
            wallet.next_block::text AS wallet_next_block,
            wallet.checkpoint_block::text AS wallet_checkpoint_block,
            wallet.checkpoint_hash AS wallet_checkpoint_hash,
            wallet.checkpoint_timestamp AS wallet_checkpoint_timestamp
       FROM robinhood_first_buy_live_cursors first_buy
       INNER JOIN robinhood_first_buy_backfill_runs seed
         ON seed.chain=first_buy.chain AND seed.id=first_buy.seed_run_id
       LEFT JOIN robinhood_wallet_swap_cursors wallet
         ON wallet.chain=first_buy.chain AND wallet.stream='live'
      WHERE first_buy.chain=$1 FOR UPDATE OF first_buy`, [CHAIN]
  );
  return result.rows[0] || null;
}

function shouldRewind(cursor, range) {
  const ancestorTime = Date.parse(range.ancestorTimestamp);
  const nextTime = new Date(cursor.next_time).getTime();
  const sourceThrough = new Date(cursor.source_through).getTime();
  return nextTime > ancestorTime || sourceThrough > ancestorTime + 1
    || (cursor.source_next_block != null
      && BigInt(cursor.source_next_block) > BigInt(range.fromBlock));
}

function assertFrontiers(cursor, range, facts) {
  const affected = Number(facts.affected || 0);
  if (Number(facts.unanchored || 0)) {
    throw conflict('first-buy evidence is not anchored to the canonical branch');
  }
  if (!cursor) {
    if (affected) throw conflict('first-buy evidence exists without a LIVE cursor');
    return false;
  }
  if (cursor.seed_status !== 'completed'
      || cursor.wallet_next_block !== range.fromBlock
      || cursor.wallet_checkpoint_block !== range.ancestorBlock
      || cursor.wallet_checkpoint_hash !== range.ancestorHash
      || Date.parse(cursor.wallet_checkpoint_timestamp) !== Date.parse(range.ancestorTimestamp)) {
    throw conflict('first-buy source was not rewound to the canonical ancestor');
  }
  if (cursor.source_next_block != null
      && BigInt(cursor.source_next_block) > BigInt(range.throughBlock) + 1n) {
    throw conflict('first-buy block frontier is ahead of the recovery range');
  }
  const rewind = shouldRewind(cursor, range);
  if (!rewind && affected) throw conflict('first-buy evidence is ahead of its LIVE cursor');
  return rewind;
}

async function deleteFirstBuys(client, range) {
  return client.query(
    `DELETE FROM robinhood_wallet_token_first_buys first_buy
      USING robinhood_chain_blocks block
      WHERE first_buy.chain=$1 AND block.chain=first_buy.chain AND block.canonical
        AND block.block_number=first_buy.block_number
        AND block.block_hash=first_buy.block_hash
        AND block.block_timestamp=first_buy.block_time
        AND first_buy.block_number BETWEEN $2::bigint AND $3::bigint`,
    [CHAIN, range.fromBlock, range.throughBlock]
  );
}

async function rewindCursor(client, cursor, range) {
  const result = await client.query(
    `UPDATE robinhood_first_buy_live_cursors SET
       next_time=LEAST(next_time,$2::timestamptz),
       source_through=LEAST(source_through,$2::timestamptz + INTERVAL '1 millisecond'),
       source_next_block=CASE WHEN source_next_block IS NULL THEN NULL
         ELSE LEAST(source_next_block,$3::bigint) END,
       version=version+1, updated_at=NOW()
     WHERE chain=$1 AND version=$4 AND next_time=$5::timestamptz
       AND source_through=$6::timestamptz
       AND source_next_block IS NOT DISTINCT FROM $7::bigint`,
    [CHAIN, range.ancestorTimestamp, range.fromBlock, cursor.version,
      cursor.next_time, cursor.source_through, cursor.source_next_block]
  );
  if (result.rowCount !== 1) throw conflict('first-buy LIVE cursor changed during recovery');
}

function createRobinhoodFirstBuyReorgRollback() {
  async function rollback(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('first-buy rollback requires a transaction client');
    }
    const range = normalizeRange(input);
    const facts = await inspectFirstBuys(client, range);
    const cursor = await loadFrontiers(client);
    const cursorRewound = assertFrontiers(cursor, range, facts);
    if (!cursorRewound) return { deletedFirstBuys: 0, cursorRewound: false };
    const deleted = await deleteFirstBuys(client, range);
    await rewindCursor(client, cursor, range);
    return { deletedFirstBuys: deleted.rowCount || 0, cursorRewound: true };
  }
  return Object.freeze({ rollback });
}

module.exports = { createRobinhoodFirstBuyReorgRollback, __private: { normalizeRange } };

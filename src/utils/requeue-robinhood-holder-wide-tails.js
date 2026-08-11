require('dotenv').config();

const db = require('../models/db');

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function candidateRow(row) {
  return Object.freeze({
    tokenAddress: row.token_address,
    backfillNextBlock: String(row.backfill_next_block),
    liveThroughBlock: String(row.live_through_block),
    liveThroughHash: row.live_through_hash,
    version: String(row.version),
    pendingEvents: Number(row.pending_events) || 0,
    oldestBlock: String(row.oldest_block),
    newestBlock: String(row.newest_block),
    receiptBlocks: String(row.receipt_blocks),
  });
}

async function loadCandidates(database, options) {
  const result = await database.query(
    `WITH pending AS MATERIALIZED (
       SELECT token_address, COUNT(*)::int AS pending_events,
              MIN(block_number) AS oldest_block, MAX(block_number) AS newest_block
         FROM robinhood_holder_transfer_journal
        WHERE chain = 'robinhood' AND applied = false
        GROUP BY token_address
     )
     SELECT state.token_address, state.backfill_next_block,
            state.live_through_block, state.live_through_hash, state.version,
            pending.pending_events, pending.oldest_block, pending.newest_block,
            pending.oldest_block - state.backfill_next_block + 1 AS receipt_blocks
       FROM robinhood_holder_token_states state
       INNER JOIN pending ON pending.token_address = state.token_address
      WHERE state.chain = 'robinhood' AND state.ledger_status = 'shadow'
        AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
        AND state.live_through_block + 1 = state.backfill_next_block
        AND pending.oldest_block - state.backfill_next_block + 1 > $1::bigint
        AND NOT EXISTS (
          SELECT 1 FROM robinhood_holder_transfer_journal applied
           WHERE applied.chain = state.chain
             AND applied.token_address = state.token_address
             AND applied.applied = true
             AND applied.block_number >= state.backfill_next_block
        )
      ORDER BY pending.oldest_block, state.token_address
      LIMIT $2::int`,
    [options.receiptBlockLimit, options.limit]
  );
  return result.rows.map(candidateRow);
}

async function lockCandidate(client, candidate) {
  const result = await client.query(
    `SELECT token_address, backfill_next_block, live_through_block,
            live_through_hash, version
       FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status = 'shadow' AND version = $2::bigint
        AND backfill_next_block = $3::bigint
        AND live_through_block = $4::bigint AND live_through_hash = $5
        AND live_through_block + 1 = backfill_next_block
      FOR UPDATE`,
    [candidate.tokenAddress, candidate.version, candidate.backfillNextBlock,
      candidate.liveThroughBlock, candidate.liveThroughHash]
  );
  return result.rows[0] || null;
}

async function verifyPendingGap(client, candidate, receiptBlockLimit) {
  const result = await client.query(
    `SELECT COUNT(*) FILTER (WHERE applied = false)::int AS pending_events,
            COUNT(*) FILTER (
              WHERE applied = true AND block_number >= $2::bigint
            )::int AS applied_tail_events,
            MIN(block_number) FILTER (WHERE applied = false) AS oldest_block
       FROM robinhood_holder_transfer_journal
      WHERE chain = 'robinhood' AND token_address = $1`,
    [candidate.tokenAddress, candidate.backfillNextBlock]
  );
  const row = result.rows[0];
  return Number(row?.pending_events) > 0
    && Number(row?.applied_tail_events) === 0
    && BigInt(row.oldest_block) - BigInt(candidate.backfillNextBlock) + 1n
      > BigInt(receiptBlockLimit);
}

async function requeueCandidate(database, candidate, receiptBlockLimit) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    if (!await lockCandidate(client, candidate)
        || !await verifyPendingGap(client, candidate, receiptBlockLimit)) {
      await client.query('ROLLBACK');
      return null;
    }
    const result = await client.query(
      `UPDATE robinhood_holder_token_states
          SET ledger_status = 'backfilling', version = version + 1, updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = $1
          AND ledger_status = 'shadow' AND version = $2::bigint
        RETURNING backfill_next_block, live_through_block, version`,
      [candidate.tokenAddress, candidate.version]
    );
    if (!result.rowCount) throw new Error('holder wide-tail requeue lost its state lock');
    await client.query('COMMIT');
    return Object.freeze({
      tokenAddress: candidate.tokenAddress,
      backfillNextBlock: String(result.rows[0].backfill_next_block),
      liveThroughBlock: String(result.rows[0].live_through_block),
      version: String(result.rows[0].version),
      preservedPendingEvents: candidate.pendingEvents,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runWideTailRequeue(input = {}) {
  const database = input.database || db;
  const options = Object.freeze({
    limit: boundedInteger(input.limit, 100, 1, 1000, 'requeue limit'),
    receiptBlockLimit: boundedInteger(
      input.receiptBlockLimit, 250, 1, 1000, 'receipt block limit'
    ),
  });
  const candidates = await loadCandidates(database, options);
  if (input.confirm !== true) {
    return Object.freeze({ mode: 'dry-run', receiptBlockLimit: options.receiptBlockLimit,
      candidates: Object.freeze(candidates) });
  }
  const requeued = [];
  const staleTokens = [];
  for (const candidate of candidates) {
    const result = await requeueCandidate(database, candidate, options.receiptBlockLimit);
    if (result) requeued.push(result);
    else staleTokens.push(candidate.tokenAddress);
  }
  return Object.freeze({
    mode: 'confirmed', receiptBlockLimit: options.receiptBlockLimit,
    candidates: Object.freeze(candidates), requeued: Object.freeze(requeued),
    staleTokens: Object.freeze(staleTokens),
  });
}

async function main() {
  try {
    console.log(JSON.stringify(await runWideTailRequeue({
      confirm: process.argv.includes('--confirm-requeue'),
      limit: process.env.ROBINHOOD_HOLDER_TAIL_REQUEUE_LIMIT,
      receiptBlockLimit: process.env.ROBINHOOD_HOLDER_TAIL_REQUEUE_RECEIPT_BLOCK_LIMIT,
    }), null, 2));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodHolderWideTailRequeue] Failed:', error.message);
  process.exitCode = 1;
});

module.exports = {
  runWideTailRequeue,
  __private: { loadCandidates, requeueCandidate, verifyPendingGap },
};

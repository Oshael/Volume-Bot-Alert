'use strict';

const CHAIN = 'robinhood';
// Separate recovery exclusion from the hot capture cursor. Ordinary canonical appends
// never take this lock; only recovery activation takes the exclusive counterpart.
const CANONICAL_RECOVERY_FENCE_LOCK_ID = '8241992116082027';

async function lockRobinhoodCanonicalRecovery(client, mode = 'shared') {
  if (!['shared', 'exclusive'].includes(mode)) {
    throw new Error('canonical recovery fence mode is invalid');
  }
  const suffix = mode === 'shared' ? '_shared' : '';
  await client.query(
    `SELECT pg_advisory_xact_lock${suffix}($1::bigint)`,
    [CANONICAL_RECOVERY_FENCE_LOCK_ID]
  );
}

const lockRobinhoodCanonicalRecoveryShared = (client) => (
  lockRobinhoodCanonicalRecovery(client, 'shared')
);
const lockRobinhoodCanonicalRecoveryExclusive = (client) => (
  lockRobinhoodCanonicalRecovery(client, 'exclusive')
);

function conflict(label, reason) {
  return Object.assign(new Error(`${label} write ${reason}`), {
    code: 'canonical_projection_fence_conflict',
  });
}

function normalizeFrontiers(input) {
  const values = Array.isArray(input) ? input : [input];
  const unique = new Map();
  for (const value of values) {
    if (!value) continue;
    const number = String(value.blockNumber ?? value.throughBlockNumber ?? '').trim();
    const hash = String(value.blockHash ?? value.throughBlockHash ?? '').trim().toLowerCase();
    if (!/^\d+$/.test(number) || !/^0x[0-9a-f]{64}$/.test(hash)) {
      throw new Error('canonical projection frontier is invalid');
    }
    unique.set(`${BigInt(number)}:${hash}`, {
      block_number: BigInt(number).toString(), block_hash: hash,
    });
  }
  return [...unique.values()];
}

async function lockRobinhoodCanonicalProjection(client, frontiers, label = 'projection') {
  await lockRobinhoodCanonicalRecoveryShared(client);
  const cursor = await client.query(
    `SELECT recovery_state FROM robinhood_chain_capture_cursor
      WHERE chain=$1`, [CHAIN]
  );
  if (!cursor.rowCount || cursor.rows[0].recovery_state !== 'running') {
    throw conflict(label, 'is fenced by canonical recovery');
  }
  const normalized = normalizeFrontiers(frontiers);
  if (!normalized.length) return;
  const result = await client.query(
    `SELECT COUNT(*)::int AS matched
       FROM jsonb_to_recordset($1::jsonb)
         AS frontier(block_number bigint, block_hash text)
      WHERE EXISTS (
        SELECT 1 FROM robinhood_chain_blocks block
         WHERE block.chain=$2 AND block.canonical
           AND block.block_number=frontier.block_number
           AND block.block_hash=frontier.block_hash
      )`, [JSON.stringify(normalized), CHAIN]
  );
  if (Number(result.rows[0]?.matched || 0) !== normalized.length) {
    throw conflict(label, 'is not anchored to the canonical branch');
  }
}

module.exports = {
  CANONICAL_RECOVERY_FENCE_LOCK_ID,
  lockRobinhoodCanonicalProjection,
  lockRobinhoodCanonicalRecoveryExclusive,
  lockRobinhoodCanonicalRecoveryShared,
  __private: { lockRobinhoodCanonicalRecovery, normalizeFrontiers },
};

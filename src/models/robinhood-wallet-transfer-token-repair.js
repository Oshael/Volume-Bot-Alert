const db = require('./db');
const { persistTransferProjection } = require('./robinhood-wallet-transfer-projection');

const CHAIN = 'robinhood';
const TARGET_VERSION = 'rh_transfer_v1';
const SHADOW_VERSION = 'rh_transfer_token_repair_v1';

function address(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error('tokenAddress is invalid');
  return normalized;
}

function uint(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function owner(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 128) throw new Error('owner is invalid');
  return normalized;
}

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function task(row) {
  return row ? Object.freeze({
    tokenAddress: row.token_address, sourceFromBlock: String(row.source_from_block),
    nextBlock: String(row.next_block), sourceThroughBlock: String(row.source_through_block),
    sourceThroughHash: row.source_through_hash, status: row.status,
    attemptCount: Number(row.attempt_count), leaseOwner: row.lease_owner || null,
  }) : null;
}

function validateFrontier(rows) {
  const seed = rows.find((row) => row.stream === 'seed');
  const live = rows.find((row) => row.stream === 'live');
  if (!seed || seed.lifecycle_state !== 'complete') throw new Error('transfer seed is incomplete');
  if (!live || live.lifecycle_state !== 'running') throw new Error('transfer LIVE is not running');
  if (seed.origin_block == null || live.origin_block == null
      || String(seed.next_block) !== String(live.origin_block)) {
    throw new Error('transfer seed/LIVE handoff is invalid');
  }
  if (live.checkpoint_block == null || live.checkpoint_hash == null) {
    throw new Error('transfer LIVE checkpoint is unavailable');
  }
  return { seed, live };
}

function createRobinhoodWalletTransferTokenRepairRepository(options = {}) {
  const database = options.database || db;
  const persistProjection = options.persistProjection || persistTransferProjection;

  async function initialize() {
    const cursors = await database.query(
      `SELECT stream, origin_block, next_block, checkpoint_block, checkpoint_hash,
              lifecycle_state, created_at
         FROM robinhood_wallet_transfer_cursors
        WHERE chain = $1 AND projection_version = $2 AND stream IN ('seed', 'live')`,
      [CHAIN, TARGET_VERSION]
    );
    const { seed, live } = validateFrontier(cursors.rows);
    const result = await database.query(
      `INSERT INTO robinhood_wallet_transfer_token_coverage (
         chain, projection_version, token_address, source_from_block, next_block,
         source_through_block, source_through_hash, status, completed_at
       ) SELECT $1, $2, state.token_address, $3::bigint,
           CASE WHEN state.created_at <= $6::timestamptz
             THEN $4::bigint + 1 ELSE $3::bigint END,
           $4::bigint, $5,
           CASE WHEN state.created_at <= $6::timestamptz THEN 'complete' ELSE 'pending' END,
           CASE WHEN state.created_at <= $6::timestamptz THEN NOW() ELSE NULL END
         FROM robinhood_holder_token_states state
        WHERE state.chain = $1 AND state.ledger_status IN ('backfilling', 'shadow', 'live')
       ON CONFLICT (chain, projection_version, token_address) DO NOTHING
       RETURNING status`,
      [CHAIN, TARGET_VERSION, String(seed.origin_block), String(live.checkpoint_block),
        live.checkpoint_hash, seed.created_at]
    );
    return Object.freeze({
      inserted: result.rowCount,
      complete: result.rows.filter((row) => row.status === 'complete').length,
      pending: result.rows.filter((row) => row.status === 'pending').length,
      sourceFromBlock: String(seed.origin_block),
      sourceThroughBlock: String(live.checkpoint_block),
      sourceThroughHash: live.checkpoint_hash,
    });
  }

  async function claim(input = {}) {
    const leaseOwner = owner(input.owner);
    const leaseMs = bounded(input.leaseMs, 1_200_000, 120_001, 1_200_000, 'leaseMs');
    const result = await database.query(
      `WITH candidate AS (
         SELECT token_address FROM robinhood_wallet_transfer_token_coverage
          WHERE chain = $1 AND projection_version = $2 AND status = 'pending'
            AND next_attempt_at <= NOW()
          ORDER BY source_from_block, token_address LIMIT 1 FOR UPDATE SKIP LOCKED
       ) UPDATE robinhood_wallet_transfer_token_coverage coverage SET
           status = 'leased', lease_owner = $3,
           lease_until = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
           attempt_count = attempt_count + 1, version = version + 1, updated_at = NOW()
         FROM candidate WHERE coverage.chain = $1 AND coverage.projection_version = $2
           AND coverage.token_address = candidate.token_address RETURNING coverage.*`,
      [CHAIN, TARGET_VERSION, leaseOwner, leaseMs]
    );
    return task(result.rows[0]);
  }

  async function commitShadowRange(input = {}) {
    const tokenAddress = address(input.tokenAddress);
    const leaseOwner = owner(input.owner);
    const fromBlock = uint(input.fromBlock, 'fromBlock');
    const toBlock = uint(input.toBlock, 'toBlock');
    if (BigInt(toBlock) < BigInt(fromBlock)) throw new Error('repair range is inverted');
    if (!Array.isArray(input.events)) throw new Error('events must be a list');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT * FROM robinhood_wallet_transfer_token_coverage
          WHERE chain = $1 AND projection_version = $2 AND token_address = $3
            AND status = 'leased' AND lease_owner = $4 AND lease_until > NOW()
          FOR UPDATE`,
        [CHAIN, TARGET_VERSION, tokenAddress, leaseOwner]
      );
      const current = locked.rows[0];
      if (!current) throw new Error('token repair lease is stale');
      if (String(current.next_block) !== fromBlock
          || BigInt(toBlock) > BigInt(current.source_through_block)) {
        throw new Error('token repair range conflicts with coverage cursor');
      }
      const events = input.events.map((event) => ({
        ...event, tokenAddress, classificationVersion: SHADOW_VERSION,
      }));
      const projected = await persistProjection(client, SHADOW_VERSION, events);
      const nextBlock = (BigInt(toBlock) + 1n).toString();
      const complete = BigInt(nextBlock) > BigInt(current.source_through_block);
      const advanced = await client.query(
        `UPDATE robinhood_wallet_transfer_token_coverage SET
           next_block = $5::bigint, status = CASE WHEN $6 THEN 'complete' ELSE 'pending' END,
           lease_owner = NULL, lease_until = NULL,
           completed_at = CASE WHEN $6 THEN NOW() ELSE NULL END,
           last_error_code = NULL, last_error_message = NULL,
           version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2 AND token_address = $3
           AND status = 'leased' AND lease_owner = $4 RETURNING *`,
        [CHAIN, TARGET_VERSION, tokenAddress, leaseOwner, nextBlock, complete]
      );
      await client.query('COMMIT');
      return Object.freeze({ task: task(advanced.rows[0]), projected, complete });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function retry(input = {}) {
    const tokenAddress = address(input.tokenAddress);
    const leaseOwner = owner(input.owner);
    const maxAttempts = bounded(input.maxAttempts, 5, 1, 20, 'maxAttempts');
    const message = String(input.error?.message || 'token repair failed').slice(0, 500);
    const code = String(input.error?.code || 'token_repair_failed').toLowerCase()
      .replace(/[^a-z0-9_:-]/g, '_').slice(0, 64);
    const result = await database.query(
      `UPDATE robinhood_wallet_transfer_token_coverage SET
         status = CASE WHEN attempt_count >= $5 THEN 'failed' ELSE 'pending' END,
         lease_owner = NULL, lease_until = NULL, next_attempt_at = NOW() + INTERVAL '5 seconds',
         last_error_code = $6, last_error_message = $7,
         version = version + 1, updated_at = NOW()
       WHERE chain = $1 AND projection_version = $2 AND token_address = $3
         AND status = 'leased' AND lease_owner = $4 AND lease_until > NOW()
       RETURNING status`,
      [CHAIN, TARGET_VERSION, tokenAddress, leaseOwner, maxAttempts, code, message]
    );
    if (!result.rowCount) throw new Error('token repair lease is stale');
    return result.rows[0].status;
  }

  return Object.freeze({ initialize, claim, commitShadowRange, retry });
}

module.exports = {
  SHADOW_VERSION, TARGET_VERSION, createRobinhoodWalletTransferTokenRepairRepository,
  __private: { validateFrontier },
};

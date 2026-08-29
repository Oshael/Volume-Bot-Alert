const db = require('./db');

const CHAIN = 'robinhood';
const TARGET_VERSION = 'unified_transfer_v1';
const SHADOW_VERSION = 'unified_transfer_token_repair_v1';
const SOURCE_VERSION = 'rh_transfer_v1';

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function task(row) {
  return row ? Object.freeze({
    tokenAddress: row.token_address,
    sourceFromBlock: String(row.source_from_block), nextBlock: String(row.next_block),
    sourceThroughBlock: String(row.source_through_block),
    sourceThroughHash: row.source_through_hash, status: row.status,
    attemptCount: Number(row.attempt_count), leaseOwner: row.lease_owner || null,
    publishedAt: row.published_at == null ? null : new Date(row.published_at).toISOString(),
  }) : null;
}

function createRobinhoodWalletPositionTokenRepairRepository(options = {}) {
  const database = options.database || db;
  const targetVersion = options.targetVersion || TARGET_VERSION;
  const shadowVersion = options.shadowVersion || SHADOW_VERSION;
  const sourceVersion = options.sourceVersion || SOURCE_VERSION;

  async function initialize() {
    const result = await database.query(
      `INSERT INTO robinhood_wallet_position_token_coverage (
         chain, projection_version, shadow_projection_version, source_transfer_version,
         token_address, source_from_block, next_block,
         source_through_block, source_through_hash
       ) SELECT transfer.chain, $2, $3, transfer.projection_version,
                transfer.token_address, transfer.source_from_block,
                transfer.source_from_block, transfer.source_through_block,
                transfer.source_through_hash
           FROM robinhood_wallet_transfer_token_coverage transfer
           JOIN robinhood_holder_token_states state
             ON state.chain = transfer.chain AND state.token_address = transfer.token_address
           JOIN robinhood_wallet_position_cursors seed
             ON seed.chain = transfer.chain AND seed.projection_version = $2
            AND seed.stream = 'seed' AND seed.lifecycle_state = 'complete'
          WHERE transfer.chain = $1 AND transfer.projection_version = $4
            AND transfer.status = 'complete' AND transfer.published_at IS NOT NULL
            AND state.created_at > seed.created_at
          ON CONFLICT (chain, projection_version, token_address) DO NOTHING
       RETURNING token_address`,
      [CHAIN, targetVersion, shadowVersion, sourceVersion]
    );
    return Object.freeze({ inserted: result.rowCount });
  }

  async function plan() {
    const result = await database.query(
      `SELECT COUNT(*)::integer AS candidates,
              COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
              COUNT(*) FILTER (WHERE status = 'leased')::integer AS leased,
              COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
              COUNT(*) FILTER (WHERE status = 'complete'
                AND published_at IS NULL)::integer AS shadow_complete,
              COUNT(*) FILTER (WHERE published_at IS NOT NULL)::integer AS published,
              COALESCE(SUM(source_through_block - next_block + 1)
                FILTER (WHERE published_at IS NULL), 0)::text AS remaining_block_span
         FROM robinhood_wallet_position_token_coverage
        WHERE chain = $1 AND projection_version = $2`,
      [CHAIN, targetVersion]
    );
    return Object.freeze(result.rows[0]);
  }

  async function claim(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('owner is invalid');
    const leaseMs = bounded(input.leaseMs, 1_200_000, 120_001, 1_200_000, 'leaseMs');
    const result = await database.query(
      `WITH candidate AS (
         SELECT token_address FROM robinhood_wallet_position_token_coverage
          WHERE chain = $1 AND projection_version = $2 AND status = 'pending'
            AND next_attempt_at <= NOW()
          ORDER BY source_from_block, token_address LIMIT 1 FOR UPDATE SKIP LOCKED
       ) UPDATE robinhood_wallet_position_token_coverage coverage SET
           status = 'leased', lease_owner = $3,
           lease_until = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
           attempt_count = attempt_count + 1, version = version + 1, updated_at = NOW()
         FROM candidate WHERE coverage.chain = $1 AND coverage.projection_version = $2
           AND coverage.token_address = candidate.token_address RETURNING coverage.*`,
      [CHAIN, targetVersion, owner, leaseMs]
    );
    return task(result.rows[0]);
  }

  async function recover(input = {}) {
    const result = await database.query(
      `WITH recoverable AS (
         SELECT token_address, status AS previous_status
           FROM robinhood_wallet_position_token_coverage
          WHERE chain = $1 AND projection_version = $2
            AND ((status = 'leased' AND lease_until <= NOW())
              OR ($3::boolean AND status = 'failed'))
          FOR UPDATE SKIP LOCKED
       ) UPDATE robinhood_wallet_position_token_coverage coverage SET
           status = 'pending', lease_owner = NULL, lease_until = NULL,
           attempt_count = CASE WHEN recoverable.previous_status = 'failed'
             THEN 0 ELSE coverage.attempt_count END,
           next_attempt_at = NOW(), last_error_code = NULL, last_error_message = NULL,
           version = version + 1, updated_at = NOW()
         FROM recoverable WHERE coverage.chain = $1 AND coverage.projection_version = $2
           AND coverage.token_address = recoverable.token_address
       RETURNING recoverable.previous_status`,
      [CHAIN, targetVersion, input.retryFailed === true]
    );
    return Object.freeze({
      staleLeases: result.rows.filter(({ previous_status: value }) => value === 'leased').length,
      failed: result.rows.filter(({ previous_status: value }) => value === 'failed').length,
    });
  }

  return Object.freeze({ claim, initialize, plan, recover });
}

module.exports = {
  SHADOW_VERSION, SOURCE_VERSION, TARGET_VERSION,
  createRobinhoodWalletPositionTokenRepairRepository,
};

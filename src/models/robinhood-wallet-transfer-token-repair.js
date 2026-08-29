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
    publishedAt: row.published_at == null ? null : new Date(row.published_at).toISOString(),
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
  const targetVersion = options.targetVersion || TARGET_VERSION;
  const shadowVersion = options.shadowVersion || SHADOW_VERSION;

  async function loadFrontier() {
    const cursors = await database.query(
      `SELECT stream, origin_block, next_block, checkpoint_block, checkpoint_hash,
              lifecycle_state, created_at
         FROM robinhood_wallet_transfer_cursors
        WHERE chain = $1 AND projection_version = $2 AND stream IN ('seed', 'live')`,
      [CHAIN, targetVersion]
    );
    return validateFrontier(cursors.rows);
  }

  async function plan() {
    const { live } = await loadFrontier();
    const result = await database.query(
      `SELECT COUNT(*)::integer AS candidates,
              COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
              COUNT(*) FILTER (WHERE status = 'leased')::integer AS leased,
              COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
              COUNT(*) FILTER (WHERE status = 'complete'
                AND published_at IS NULL)::integer AS shadow_complete,
              COUNT(*) FILTER (WHERE published_at IS NOT NULL)::integer AS published,
              MIN(source_from_block)::text AS earliest_source_block,
              MAX(source_through_block)::text AS latest_source_block,
              MIN(next_block) FILTER (WHERE published_at IS NULL)::text AS earliest_pending_block,
              MAX(source_through_block) FILTER (WHERE published_at IS NULL)::text
                AS latest_pending_block,
              COALESCE(SUM(source_through_block - source_from_block + 1)
                FILTER (WHERE published_at IS NULL), 0)::text AS remaining_block_span
         FROM robinhood_wallet_transfer_token_coverage
        WHERE chain = $1 AND projection_version = $2`,
      [CHAIN, targetVersion]
    );
    return Object.freeze({
      ...result.rows[0],
      sourceThroughBlock: String(live.checkpoint_block), sourceThroughHash: live.checkpoint_hash,
    });
  }

  async function initialize() {
    return Object.freeze({ inserted: 0, source: 'directional_replay_edge_missing' });
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
      [CHAIN, targetVersion, leaseOwner, leaseMs]
    );
    return task(result.rows[0]);
  }

  async function claimBatch(input = {}) {
    const leaseOwner = owner(input.owner);
    const leaseMs = bounded(input.leaseMs, 1_200_000, 120_001, 1_200_000, 'leaseMs');
    const maxBlocks = bounded(input.maxBlocks, 500, 1, 80_000, 'maxBlocks');
    const limit = bounded(input.limit, 500, 1, 500, 'limit');
    const result = await database.query(
      `WITH frontier AS MATERIALIZED (
         SELECT next_block,
                GREATEST(0, next_block - $5::bigint + 1) AS lower_block,
                LEAST(source_through_block, next_block + $5::bigint - 1) AS upper_block
           FROM robinhood_wallet_transfer_token_coverage
          WHERE chain = $1 AND projection_version = $2 AND status = 'pending'
            AND next_attempt_at <= NOW()
          ORDER BY source_through_block - next_block, token_address LIMIT 1
       ), candidates AS MATERIALIZED (
         SELECT coverage.token_address
           FROM robinhood_wallet_transfer_token_coverage coverage
           CROSS JOIN frontier
          WHERE coverage.chain = $1 AND coverage.projection_version = $2
            AND coverage.status = 'pending' AND coverage.next_attempt_at <= NOW()
            AND coverage.next_block >= frontier.lower_block
            AND coverage.next_block <= frontier.upper_block
            AND coverage.source_through_block >= frontier.upper_block
          ORDER BY coverage.source_through_block - coverage.next_block,
                   coverage.next_block DESC, coverage.token_address
          LIMIT $6 FOR UPDATE OF coverage SKIP LOCKED
       ) UPDATE robinhood_wallet_transfer_token_coverage coverage SET
           status = 'leased', lease_owner = $3,
           lease_until = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
           attempt_count = attempt_count + 1, version = version + 1, updated_at = NOW()
         FROM candidates WHERE coverage.chain = $1 AND coverage.projection_version = $2
           AND coverage.token_address = candidates.token_address RETURNING coverage.*`,
      [CHAIN, targetVersion, leaseOwner, leaseMs, maxBlocks, limit]
    );
    return Object.freeze(result.rows.map(task).sort((left, right) => (
      BigInt(left.nextBlock) < BigInt(right.nextBlock) ? -1
        : BigInt(left.nextBlock) > BigInt(right.nextBlock) ? 1
          : left.tokenAddress.localeCompare(right.tokenAddress)
    )));
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
        [CHAIN, targetVersion, tokenAddress, leaseOwner]
      );
      const current = locked.rows[0];
      if (!current) throw new Error('token repair lease is stale');
      if (String(current.next_block) !== fromBlock
          || BigInt(toBlock) > BigInt(current.source_through_block)) {
        throw new Error('token repair range conflicts with coverage cursor');
      }
      const events = input.events.map((event) => ({
        ...event, tokenAddress, classificationVersion: shadowVersion,
      }));
      const projected = await persistProjection(client, shadowVersion, events);
      const nextBlock = (BigInt(toBlock) + 1n).toString();
      const complete = BigInt(nextBlock) > BigInt(current.source_through_block);
      const advanced = await client.query(
        `UPDATE robinhood_wallet_transfer_token_coverage SET
           next_block = $5::bigint, status = CASE WHEN $6 THEN 'complete' ELSE 'pending' END,
           lease_owner = NULL, lease_until = NULL,
           attempt_count = 1,
           completed_at = CASE WHEN $6 THEN NOW() ELSE NULL END,
           last_error_code = NULL, last_error_message = NULL,
           version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2 AND token_address = $3
           AND status = 'leased' AND lease_owner = $4 RETURNING *`,
        [CHAIN, targetVersion, tokenAddress, leaseOwner, nextBlock, complete]
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

  async function commitShadowBatch(input = {}) {
    const leaseOwner = owner(input.owner);
    const toBlock = uint(input.toBlock, 'toBlock');
    if (!Array.isArray(input.tasks) || !input.tasks.length) {
      throw new Error('tasks must be a non-empty list');
    }
    if (!Array.isArray(input.events)) throw new Error('events must be a list');
    const tasks = input.tasks.map((item) => ({
      tokenAddress: address(item.tokenAddress),
      fromBlock: uint(item.nextBlock, 'nextBlock'),
    }));
    if (new Set(tasks.map(({ tokenAddress }) => tokenAddress)).size !== tasks.length) {
      throw new Error('tasks contain duplicate tokens');
    }
    const tokenAddresses = tasks.map(({ tokenAddress }) => tokenAddress);
    const expectedCursors = new Map(tasks.map((item) => [item.tokenAddress, item.fromBlock]));
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT token_address, next_block, source_through_block
           FROM robinhood_wallet_transfer_token_coverage
          WHERE chain = $1 AND projection_version = $2
            AND token_address = ANY($3::varchar[]) AND status = 'leased'
            AND lease_owner = $4 AND lease_until > NOW() FOR UPDATE`,
        [CHAIN, targetVersion, tokenAddresses, leaseOwner]
      );
      if (locked.rowCount !== tasks.length) throw new Error('token repair batch lease is stale');
      for (const current of locked.rows) {
        if (String(current.next_block) !== expectedCursors.get(current.token_address)
            || BigInt(toBlock) > BigInt(current.source_through_block)) {
          throw new Error('token repair batch conflicts with coverage cursor');
        }
      }
      const allowed = new Set(tokenAddresses);
      const events = input.events.map((event) => {
        const tokenAddress = address(event.tokenAddress);
        if (!allowed.has(tokenAddress)) throw new Error('event is outside token repair batch');
        if (BigInt(event.blockNumber) < BigInt(expectedCursors.get(tokenAddress))) {
          throw new Error('event precedes token repair cursor');
        }
        return { ...event, tokenAddress, classificationVersion: shadowVersion };
      });
      const projected = await persistProjection(client, shadowVersion, events);
      const nextBlock = (BigInt(toBlock) + 1n).toString();
      const advanced = await client.query(
        `UPDATE robinhood_wallet_transfer_token_coverage SET
           next_block = $5::bigint,
           status = CASE WHEN source_through_block < $5::bigint THEN 'complete' ELSE 'pending' END,
           lease_owner = NULL, lease_until = NULL,
           attempt_count = 1,
           completed_at = CASE WHEN source_through_block < $5::bigint THEN NOW() ELSE NULL END,
           last_error_code = NULL, last_error_message = NULL,
           version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2
           AND token_address = ANY($3::varchar[]) AND status = 'leased' AND lease_owner = $4
         RETURNING status`,
        [CHAIN, targetVersion, tokenAddresses, leaseOwner, nextBlock]
      );
      if (advanced.rowCount !== tasks.length) throw new Error('token repair batch advance is stale');
      await client.query('COMMIT');
      return Object.freeze({
        projected, tokens: advanced.rowCount,
        complete: advanced.rows.filter(({ status }) => status === 'complete').length,
        pending: advanced.rows.filter(({ status }) => status === 'pending').length,
      });
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
      [CHAIN, targetVersion, tokenAddress, leaseOwner, maxAttempts, code, message]
    );
    if (!result.rowCount) throw new Error('token repair lease is stale');
    return result.rows[0].status;
  }

  async function recover(input = {}) {
    const result = await database.query(
      `WITH recoverable AS (
         SELECT token_address, status AS previous_status
           FROM robinhood_wallet_transfer_token_coverage
          WHERE chain = $1 AND projection_version = $2
            AND ((status = 'leased' AND lease_until <= NOW())
              OR ($3::boolean AND status = 'failed'))
          FOR UPDATE SKIP LOCKED
       ) UPDATE robinhood_wallet_transfer_token_coverage coverage SET
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
      staleLeases: result.rows.filter((row) => row.previous_status === 'leased').length,
      failed: result.rows.filter((row) => row.previous_status === 'failed').length,
    });
  }

  async function promoteNext() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT * FROM robinhood_wallet_transfer_token_coverage
          WHERE chain = $1 AND projection_version = $2 AND status = 'complete'
            AND published_at IS NULL AND attempt_count > 0
          ORDER BY source_through_block, token_address LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [CHAIN, targetVersion]
      );
      const current = selected.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return null;
      }
      const cursor = await client.query(
        `SELECT next_block, checkpoint_block, checkpoint_hash, lifecycle_state
           FROM robinhood_wallet_transfer_cursors
          WHERE chain = $1 AND projection_version = $2 AND stream = 'live' FOR UPDATE`,
        [CHAIN, targetVersion]
      );
      const live = cursor.rows[0];
      if (!live || live.lifecycle_state !== 'running' || live.checkpoint_block == null
          || BigInt(live.next_block) !== BigInt(live.checkpoint_block) + 1n) {
        throw new Error('transfer LIVE publication frontier is unavailable');
      }
      const covered = BigInt(current.source_through_block);
      const frontier = BigInt(live.checkpoint_block);
      if (frontier < covered || (frontier === covered
          && live.checkpoint_hash !== current.source_through_hash)) {
        throw new Error('transfer LIVE publication frontier regressed');
      }
      if (frontier > covered) {
        const extended = await client.query(
          `UPDATE robinhood_wallet_transfer_token_coverage SET
             source_through_block = $4::bigint, source_through_hash = $5,
             status = 'pending', completed_at = NULL, published_at = NULL,
             version = version + 1, updated_at = NOW()
           WHERE chain = $1 AND projection_version = $2 AND token_address = $3 RETURNING *`,
          [CHAIN, targetVersion, current.token_address,
            String(live.checkpoint_block), live.checkpoint_hash]
        );
        await client.query('COMMIT');
        return Object.freeze({ status: 'extended', task: task(extended.rows[0]) });
      }
      const tables = [
        ['robinhood_wallet_relationship_evidence', 'algorithm_version'],
        ['robinhood_wallet_transfer_daily_summaries', 'projection_version'],
        ['robinhood_wallet_transfer_edges', 'classification_version'],
      ];
      const promoted = {};
      for (const [table, column] of tables) {
        await client.query(
          `DELETE FROM ${table} WHERE chain = $1 AND ${column} = $2 AND token_address = $3`,
          [CHAIN, targetVersion, current.token_address]
        );
        const moved = await client.query(
          `UPDATE ${table} SET ${column} = $2 WHERE chain = $1 AND ${column} = $4
            AND token_address = $3`,
          [CHAIN, targetVersion, current.token_address, shadowVersion]
        );
        promoted[table] = moved.rowCount;
      }
      const published = await client.query(
        `UPDATE robinhood_wallet_transfer_token_coverage SET
           published_at = NOW(), version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2 AND token_address = $3 RETURNING *`,
        [CHAIN, targetVersion, current.token_address]
      );
      await client.query('COMMIT');
      return Object.freeze({
        status: 'published', task: task(published.rows[0]), promoted: Object.freeze(promoted),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function getProgress() {
    const result = await database.query(
      `SELECT COUNT(*)::integer AS total,
              COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
              COUNT(*) FILTER (WHERE status = 'leased')::integer AS leased,
              COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
              COUNT(*) FILTER (WHERE status = 'complete' AND published_at IS NULL)::integer AS shadow_complete,
              COUNT(*) FILTER (WHERE published_at IS NOT NULL)::integer AS published
         FROM robinhood_wallet_transfer_token_coverage
        WHERE chain = $1 AND projection_version = $2`,
      [CHAIN, targetVersion]
    );
    return Object.freeze(result.rows[0]);
  }

  return Object.freeze({
    plan, initialize, claim, claimBatch,
    commitShadowRange, commitShadowBatch, retry, recover, promoteNext, getProgress,
  });
}

module.exports = {
  SHADOW_VERSION, TARGET_VERSION, createRobinhoodWalletTransferTokenRepairRepository,
  __private: { validateFrontier },
};

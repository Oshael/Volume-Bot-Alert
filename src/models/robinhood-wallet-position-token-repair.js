const db = require('./db');
const { createWalletPosition } = require('../services/robinhood-wallet-position-domain');

const CHAIN = 'robinhood';
const TARGET_VERSION = 'unified_transfer_v1';
const SHADOW_VERSION = 'unified_transfer_token_repair_v1';
const SOURCE_VERSION = 'rh_transfer_v1';
const LIVE_LEASE_KEYS = Object.freeze([
  'robinhood-wallet-position-live-worker', 'robinhood-wallet-transfer-live-worker',
]);

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function address(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function uint(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function positionRow(input, projectionVersion, nextBlock, tokenAddress) {
  const state = createWalletPosition(input);
  const throughBlock = uint(input.throughBlock, 'throughBlock');
  const normalizedToken = address(input.tokenAddress, 'position tokenAddress');
  if (normalizedToken !== tokenAddress) throw new Error('position is outside the repair token');
  if (BigInt(throughBlock) >= BigInt(nextBlock)) throw new Error('position exceeds repair range');
  return {
    projection_version: projectionVersion,
    token_address: normalizedToken,
    wallet_address: address(input.walletAddress, 'position walletAddress'),
    quantity_raw: state.quantityRaw, cost_basis_usd: state.costBasisUsd,
    realized_pnl_usd: state.realizedPnlUsd, buy_volume_usd: state.buyVolumeUsd,
    sell_proceeds_usd: state.sellProceedsUsd,
    buy_mcap_weighted_sum: state.buyMcapWeightedSum,
    buy_mcap_weight_usd: state.buyMcapWeightUsd,
    sell_mcap_weighted_sum: state.sellMcapWeightedSum,
    sell_mcap_weight_usd: state.sellMcapWeightUsd,
    buy_tx_count: String(state.buyTxCount), sell_tx_count: String(state.sellTxCount),
    zero_cost_received_raw: state.zeroCostReceivedRaw,
    zero_cost_sold_raw: state.zeroCostSoldRaw,
    cost_basis_source: state.costBasisSource, quality: state.quality,
    through_block: throughBlock,
    through_log_index: uint(input.throughLogIndex, 'throughLogIndex'),
  };
}

async function writePositions(client, rows) {
  if (!rows.length) return;
  const result = await client.query(
    `INSERT INTO robinhood_wallet_token_positions (
       chain, projection_version, token_address, wallet_address, quantity_raw,
       cost_basis_usd, realized_pnl_usd, buy_volume_usd, sell_proceeds_usd,
       buy_mcap_weighted_sum, buy_mcap_weight_usd, sell_mcap_weighted_sum,
       sell_mcap_weight_usd, buy_tx_count, sell_tx_count, zero_cost_received_raw,
       zero_cost_sold_raw, cost_basis_source, quality, through_block, through_log_index
     ) SELECT $1, item.projection_version, item.token_address, item.wallet_address,
       item.quantity_raw::numeric, item.cost_basis_usd::numeric,
       item.realized_pnl_usd::numeric, item.buy_volume_usd::numeric,
       item.sell_proceeds_usd::numeric, item.buy_mcap_weighted_sum::numeric,
       item.buy_mcap_weight_usd::numeric, item.sell_mcap_weighted_sum::numeric,
       item.sell_mcap_weight_usd::numeric, item.buy_tx_count::bigint,
       item.sell_tx_count::bigint, item.zero_cost_received_raw::numeric,
       item.zero_cost_sold_raw::numeric, item.cost_basis_source, item.quality,
       item.through_block::bigint, item.through_log_index::bigint
     FROM jsonb_to_recordset($2::jsonb) AS item(
       projection_version text, token_address text, wallet_address text,
       quantity_raw text, cost_basis_usd text, realized_pnl_usd text,
       buy_volume_usd text, sell_proceeds_usd text, buy_mcap_weighted_sum text,
       buy_mcap_weight_usd text, sell_mcap_weighted_sum text,
       sell_mcap_weight_usd text, buy_tx_count text, sell_tx_count text,
       zero_cost_received_raw text, zero_cost_sold_raw text,
       cost_basis_source text, quality text, through_block text, through_log_index text
     ) ON CONFLICT (chain, projection_version, token_address, wallet_address)
     DO UPDATE SET quantity_raw = EXCLUDED.quantity_raw,
       cost_basis_usd = EXCLUDED.cost_basis_usd,
       realized_pnl_usd = EXCLUDED.realized_pnl_usd,
       buy_volume_usd = EXCLUDED.buy_volume_usd,
       sell_proceeds_usd = EXCLUDED.sell_proceeds_usd,
       buy_mcap_weighted_sum = EXCLUDED.buy_mcap_weighted_sum,
       buy_mcap_weight_usd = EXCLUDED.buy_mcap_weight_usd,
       sell_mcap_weighted_sum = EXCLUDED.sell_mcap_weighted_sum,
       sell_mcap_weight_usd = EXCLUDED.sell_mcap_weight_usd,
       buy_tx_count = EXCLUDED.buy_tx_count, sell_tx_count = EXCLUDED.sell_tx_count,
       zero_cost_received_raw = EXCLUDED.zero_cost_received_raw,
       zero_cost_sold_raw = EXCLUDED.zero_cost_sold_raw,
       cost_basis_source = EXCLUDED.cost_basis_source, quality = EXCLUDED.quality,
       through_block = EXCLUDED.through_block,
       through_log_index = EXCLUDED.through_log_index, updated_at = NOW()
     WHERE (robinhood_wallet_token_positions.through_block,
            robinhood_wallet_token_positions.through_log_index)
       < (EXCLUDED.through_block, EXCLUDED.through_log_index)`,
    [CHAIN, JSON.stringify(rows)]
  );
  if (result.rowCount !== rows.length) throw new Error('shadow position frontier regressed');
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

function promotionFrontier(row) {
  const transferNext = row.transfer_next_block == null ? null : String(row.transfer_next_block);
  const positionNext = row.position_next_block == null ? null : String(row.position_next_block);
  const frontierBlock = row.position_checkpoint_block == null
    ? null : String(row.position_checkpoint_block);
  const aligned = Boolean(transferNext && positionNext && frontierBlock != null
    && transferNext === positionNext
    && BigInt(positionNext) === BigInt(frontierBlock) + 1n
    && row.transfer_checkpoint_hash === row.position_checkpoint_hash);
  return Object.freeze({
    aligned, block: frontierBlock, hash: row.position_checkpoint_hash,
  });
}

function shadowIsIncomplete(row) {
  return [row.pending, row.leased, row.failed].some((value) => Number(value) > 0);
}

function promotionReport(row) {
  const frontier = promotionFrontier(row);
  const behind = Number(row.behind_frontier || 0);
  const blockers = [
    [Number(row.active_writers) > 0, 'live_position_writers_active'],
    [!frontier.aligned, 'live_position_transfer_frontier_mismatch'],
    [shadowIsIncomplete(row), 'position_shadow_incomplete'],
    [Number(row.candidates || 0) === 0, 'position_shadow_not_found'],
    [behind > 0, 'position_shadow_tail_required'],
    [Number(row.ahead_frontier || 0) > 0, 'position_shadow_ahead_of_live'],
    [Number(row.hash_mismatch || 0) > 0, 'position_shadow_hash_mismatch'],
  ];
  const reasons = blockers.filter(([blocked]) => blocked).map(([, reason]) => reason);
  return Object.freeze({
    candidates: Number(row.candidates || 0), pending: Number(row.pending || 0),
    leased: Number(row.leased || 0), failed: Number(row.failed || 0),
    shadowComplete: Number(row.shadow_complete || 0), published: Number(row.published || 0),
    behindFrontier: behind, aheadFrontier: Number(row.ahead_frontier || 0),
    hashMismatch: Number(row.hash_mismatch || 0),
    activeWriters: Number(row.active_writers || 0),
    shadowPositions: Number(row.shadow_positions || 0),
    targetPositions: Number(row.target_positions || 0),
    frontier: frontier.block == null ? null : Object.freeze({
      block: frontier.block, hash: frontier.hash,
    }),
    readyToPrepare: reasons.every((reason) => reason === 'position_shadow_tail_required'),
    readyToPromote: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
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
              MIN(source_from_block)::text AS earliest_source_block,
              MAX(source_through_block)::text AS latest_source_block,
              MIN(next_block) FILTER (WHERE published_at IS NULL)::text
                AS earliest_pending_block,
              MAX(source_through_block) FILTER (WHERE published_at IS NULL)::text
                AS latest_pending_block,
              COALESCE(SUM(source_through_block - next_block + 1)
                FILTER (WHERE published_at IS NULL), 0)::text AS remaining_block_span
         FROM robinhood_wallet_position_token_coverage
        WHERE chain = $1 AND projection_version = $2`,
      [CHAIN, targetVersion]
    );
    return Object.freeze(result.rows[0]);
  }

  async function preview() {
    const result = await database.query(
      `SELECT COUNT(*)::integer AS eligible,
              COUNT(coverage.token_address)::integer AS initialized,
              (COUNT(*) - COUNT(coverage.token_address))::integer AS missing,
              MIN(transfer.source_from_block)::text AS earliest_source_block,
              MAX(transfer.source_through_block)::text AS latest_source_block
         FROM robinhood_wallet_transfer_token_coverage transfer
         JOIN robinhood_holder_token_states state
           ON state.chain = transfer.chain AND state.token_address = transfer.token_address
         JOIN robinhood_wallet_position_cursors seed
           ON seed.chain = transfer.chain AND seed.projection_version = $2
          AND seed.stream = 'seed' AND seed.lifecycle_state = 'complete'
         LEFT JOIN robinhood_wallet_position_token_coverage coverage
           ON coverage.chain = transfer.chain AND coverage.projection_version = $2
          AND coverage.token_address = transfer.token_address
        WHERE transfer.chain = $1 AND transfer.projection_version = $3
          AND transfer.status = 'complete' AND transfer.published_at IS NOT NULL
          AND state.created_at > seed.created_at`,
      [CHAIN, targetVersion, sourceVersion]
    );
    return Object.freeze(result.rows[0]);
  }

  async function promotionPlan(runner = database) {
    const result = await runner.query(
      `WITH transfer AS MATERIALIZED (
         SELECT next_block, checkpoint_block, checkpoint_hash
           FROM robinhood_wallet_transfer_cursors
          WHERE chain = $1 AND projection_version = $4 AND stream = 'live'
            AND lifecycle_state = 'running'
       ), position AS MATERIALIZED (
         SELECT next_block, checkpoint_block, checkpoint_hash
           FROM robinhood_wallet_position_cursors
          WHERE chain = $1 AND projection_version = $2 AND stream = 'live'
            AND lifecycle_state = 'running'
       ), coverage AS MATERIALIZED (
         SELECT COUNT(*)::integer AS candidates,
                COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
                COUNT(*) FILTER (WHERE status = 'leased')::integer AS leased,
                COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
                COUNT(*) FILTER (WHERE status = 'complete'
                  AND published_at IS NULL)::integer AS shadow_complete,
                COUNT(*) FILTER (WHERE published_at IS NOT NULL)::integer AS published,
                COUNT(*) FILTER (WHERE published_at IS NULL AND position.checkpoint_block IS NOT NULL
                  AND source_through_block < position.checkpoint_block)::integer AS behind_frontier,
                COUNT(*) FILTER (WHERE published_at IS NULL AND position.checkpoint_block IS NOT NULL
                  AND source_through_block > position.checkpoint_block)::integer AS ahead_frontier,
                COUNT(*) FILTER (WHERE published_at IS NULL AND position.checkpoint_block IS NOT NULL
                  AND source_through_block = position.checkpoint_block
                  AND LOWER(source_through_hash) <> LOWER(position.checkpoint_hash))::integer
                  AS hash_mismatch
           FROM robinhood_wallet_position_token_coverage CROSS JOIN position
          WHERE chain = $1 AND projection_version = $2
       ) SELECT coverage.*,
                transfer.next_block AS transfer_next_block,
                transfer.checkpoint_hash AS transfer_checkpoint_hash,
                position.next_block AS position_next_block,
                position.checkpoint_block AS position_checkpoint_block,
                position.checkpoint_hash AS position_checkpoint_hash,
                (SELECT COUNT(*)::integer FROM worker_leases
                  WHERE lease_key = ANY($5::varchar[]) AND lease_until > NOW()) AS active_writers,
                (SELECT COUNT(*)::integer FROM robinhood_wallet_token_positions
                  WHERE chain = $1 AND projection_version = $3) AS shadow_positions,
                (SELECT COUNT(*)::integer FROM robinhood_wallet_token_positions target
                  JOIN robinhood_wallet_position_token_coverage item
                    ON item.chain = target.chain AND item.token_address = target.token_address
                   AND item.projection_version = $2
                 WHERE target.chain = $1 AND target.projection_version = $2) AS target_positions
           FROM transfer CROSS JOIN position CROSS JOIN coverage`,
      [CHAIN, targetVersion, shadowVersion, sourceVersion, LIVE_LEASE_KEYS]
    );
    return promotionReport(result.rows[0] || {});
  }

  async function preparePromotion() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT lease_key FROM worker_leases
          WHERE lease_key = ANY($1::varchar[]) FOR UPDATE`, [LIVE_LEASE_KEYS]
      );
      const before = await promotionPlan(client);
      if (!before.readyToPrepare && !before.readyToPromote) {
        const error = new Error(`position promotion blocked: ${before.reasons.join(',')}`);
        error.code = 'POSITION_PROMOTION_BLOCKED';
        throw error;
      }
      const extended = await client.query(
        `UPDATE robinhood_wallet_position_token_coverage SET
           source_through_block = $3::bigint, source_through_hash = $4,
           status = 'pending', completed_at = NULL, next_attempt_at = NOW(),
           version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2 AND published_at IS NULL
           AND status = 'complete' AND source_through_block < $3::bigint`,
        [CHAIN, targetVersion, before.frontier.block, before.frontier.hash]
      );
      await client.query('COMMIT');
      return Object.freeze({ extended: extended.rowCount, frontier: before.frontier });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function promoteNext(input = {}) {
    const expectedBlock = uint(input.frontier?.block, 'frontier.block');
    const expectedHash = String(input.frontier?.hash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(expectedHash)) throw new Error('frontier.hash is invalid');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT lease_key FROM worker_leases
          WHERE lease_key = ANY($1::varchar[]) FOR UPDATE`, [LIVE_LEASE_KEYS]
      );
      const plan = await promotionPlan(client);
      if (!plan.readyToPromote || plan.frontier?.block !== expectedBlock
          || plan.frontier?.hash !== expectedHash) {
        const error = new Error(`position promotion frontier changed: ${plan.reasons.join(',')}`);
        error.code = 'POSITION_PROMOTION_FRONTIER_CHANGED';
        throw error;
      }
      const selected = await client.query(
        `SELECT * FROM robinhood_wallet_position_token_coverage
          WHERE chain = $1 AND projection_version = $2 AND status = 'complete'
            AND published_at IS NULL AND source_through_block = $3::bigint
            AND source_through_hash = $4
          ORDER BY token_address LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [CHAIN, targetVersion, expectedBlock, expectedHash]
      );
      const current = selected.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return null;
      }
      const counts = await client.query(
        `SELECT COUNT(*) FILTER (WHERE projection_version = $2)::integer AS target,
                COUNT(*) FILTER (WHERE projection_version = $3)::integer AS shadow
           FROM robinhood_wallet_token_positions
          WHERE chain = $1 AND token_address = $4
            AND projection_version IN ($2, $3)`,
        [CHAIN, targetVersion, shadowVersion, current.token_address]
      );
      if (counts.rows[0].target > 0 && counts.rows[0].shadow === 0) {
        throw new Error('position shadow is empty while target positions exist');
      }
      const removed = await client.query(
        `DELETE FROM robinhood_wallet_token_positions
          WHERE chain = $1 AND projection_version = $2 AND token_address = $3`,
        [CHAIN, targetVersion, current.token_address]
      );
      const promoted = await client.query(
        `UPDATE robinhood_wallet_token_positions SET
           projection_version = $2, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $3 AND token_address = $4`,
        [CHAIN, targetVersion, shadowVersion, current.token_address]
      );
      await client.query(
        `UPDATE robinhood_wallet_position_token_coverage SET
           published_at = NOW(), version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2 AND token_address = $3`,
        [CHAIN, targetVersion, current.token_address]
      );
      await client.query('COMMIT');
      return Object.freeze({
        tokenAddress: current.token_address, removed: removed.rowCount,
        promoted: promoted.rowCount,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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

  async function claimBatch(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('owner is invalid');
    const leaseMs = bounded(input.leaseMs, 1_200_000, 120_001, 1_200_000, 'leaseMs');
    const maxBlocks = bounded(input.maxBlocks, 2_000, 1, 80_000, 'maxBlocks');
    const limit = bounded(input.limit, 100, 1, 500, 'limit');
    const result = await database.query(
      `WITH frontier AS MATERIALIZED (
         SELECT next_block,
                LEAST(source_through_block, next_block + $5::bigint - 1) AS upper_block
           FROM robinhood_wallet_position_token_coverage
          WHERE chain = $1 AND projection_version = $2 AND status = 'pending'
            AND next_attempt_at <= NOW()
          ORDER BY next_block, token_address LIMIT 1
       ), candidates AS MATERIALIZED (
         SELECT coverage.token_address
           FROM robinhood_wallet_position_token_coverage coverage
           CROSS JOIN frontier
          WHERE coverage.chain = $1 AND coverage.projection_version = $2
            AND coverage.status = 'pending' AND coverage.next_attempt_at <= NOW()
            AND coverage.next_block <= frontier.upper_block
            AND coverage.source_through_block >= frontier.upper_block
          ORDER BY coverage.next_block, coverage.token_address
          LIMIT $6 FOR UPDATE OF coverage SKIP LOCKED
       ) UPDATE robinhood_wallet_position_token_coverage coverage SET
           status = 'leased', lease_owner = $3,
           lease_until = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
           attempt_count = attempt_count + 1, version = version + 1, updated_at = NOW()
         FROM candidates WHERE coverage.chain = $1 AND coverage.projection_version = $2
           AND coverage.token_address = candidates.token_address RETURNING coverage.*`,
      [CHAIN, targetVersion, owner, leaseMs, maxBlocks, limit]
    );
    return Object.freeze(result.rows.map(task).sort((left, right) => (
      BigInt(left.nextBlock) < BigInt(right.nextBlock) ? -1
        : BigInt(left.nextBlock) > BigInt(right.nextBlock) ? 1
          : left.tokenAddress.localeCompare(right.tokenAddress)
    )));
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

  async function commitShadowRange(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('owner is invalid');
    const tokenAddress = address(input.tokenAddress, 'tokenAddress');
    const fromBlock = uint(input.fromBlock, 'fromBlock');
    const toBlock = uint(input.toBlock, 'toBlock');
    if (BigInt(fromBlock) > BigInt(toBlock)) throw new Error('repair range is inverted');
    const nextBlock = (BigInt(toBlock) + 1n).toString();
    const rows = (input.positions || []).map((item) => (
      positionRow(item, shadowVersion, nextBlock, tokenAddress)
    ));
    const identities = new Set(rows.map(({ wallet_address: wallet }) => wallet));
    if (identities.size !== rows.length) throw new Error('positions must be unique');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT * FROM robinhood_wallet_position_token_coverage
          WHERE chain = $1 AND projection_version = $2 AND token_address = $3
            AND status = 'leased' AND lease_owner = $4 FOR UPDATE`,
        [CHAIN, targetVersion, tokenAddress, owner]
      );
      const current = locked.rows[0];
      if (!current || String(current.next_block) !== fromBlock
        || BigInt(toBlock) > BigInt(current.source_through_block)) {
        const error = new Error('position token repair lease or frontier changed');
        error.code = 'POSITION_TOKEN_REPAIR_CONFLICT';
        throw error;
      }
      await writePositions(client, rows);
      const advanced = await client.query(
        `UPDATE robinhood_wallet_position_token_coverage SET
           next_block = $5::bigint,
           status = CASE WHEN $5::bigint > source_through_block
             THEN 'complete' ELSE 'pending' END,
           lease_owner = NULL, lease_until = NULL, attempt_count = 0,
           next_attempt_at = NOW(), last_error_code = NULL, last_error_message = NULL,
           completed_at = CASE WHEN $5::bigint > source_through_block THEN NOW() ELSE NULL END,
           version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2 AND token_address = $3
           AND status = 'leased' AND lease_owner = $4 RETURNING *`,
        [CHAIN, targetVersion, tokenAddress, owner, nextBlock]
      );
      await client.query('COMMIT');
      return Object.freeze({
        complete: advanced.rows[0].status === 'complete', positions: rows.length,
        task: task(advanced.rows[0]),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function commitShadowBatch(input = {}) {
    const owner = String(input.owner || '').trim();
    if (!owner || owner.length > 128) throw new Error('owner is invalid');
    if (!Array.isArray(input.tasks) || !input.tasks.length) {
      throw new Error('tasks must be a non-empty list');
    }
    const toBlock = uint(input.toBlock, 'toBlock');
    const nextBlock = (BigInt(toBlock) + 1n).toString();
    const tasks = input.tasks.map((item) => ({
      tokenAddress: address(item.tokenAddress, 'tokenAddress'),
      nextBlock: uint(item.nextBlock, 'nextBlock'),
    }));
    const expected = new Map(tasks.map((item) => [item.tokenAddress, item.nextBlock]));
    if (expected.size !== tasks.length) throw new Error('tasks contain duplicate tokens');
    const rows = (input.positions || []).map((item) => {
      const tokenAddress = address(item.tokenAddress, 'position tokenAddress');
      if (!expected.has(tokenAddress)) throw new Error('position is outside repair batch');
      if (BigInt(item.throughBlock) < BigInt(expected.get(tokenAddress))) {
        throw new Error('position precedes token repair cursor');
      }
      return positionRow(item, shadowVersion, nextBlock, tokenAddress);
    });
    const identities = new Set(rows.map((row) => (
      `${row.token_address}:${row.wallet_address}`
    )));
    if (identities.size !== rows.length) throw new Error('positions must be unique');
    const tokenAddresses = [...expected.keys()];
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT token_address, next_block, source_through_block
           FROM robinhood_wallet_position_token_coverage
          WHERE chain = $1 AND projection_version = $2
            AND token_address = ANY($3::varchar[]) AND status = 'leased'
            AND lease_owner = $4 FOR UPDATE`,
        [CHAIN, targetVersion, tokenAddresses, owner]
      );
      if (locked.rowCount !== tasks.length) {
        throw new Error('position token repair batch lease changed');
      }
      for (const current of locked.rows) {
        if (String(current.next_block) !== expected.get(current.token_address)
          || BigInt(toBlock) > BigInt(current.source_through_block)) {
          throw new Error('position token repair batch frontier changed');
        }
      }
      await writePositions(client, rows);
      const advanced = await client.query(
        `UPDATE robinhood_wallet_position_token_coverage SET
           next_block = $5::bigint,
           status = CASE WHEN $5::bigint > source_through_block
             THEN 'complete' ELSE 'pending' END,
           lease_owner = NULL, lease_until = NULL, attempt_count = 0,
           next_attempt_at = NOW(), last_error_code = NULL, last_error_message = NULL,
           completed_at = CASE WHEN $5::bigint > source_through_block THEN NOW() ELSE NULL END,
           version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2
           AND token_address = ANY($3::varchar[]) AND status = 'leased'
           AND lease_owner = $4 RETURNING status`,
        [CHAIN, targetVersion, tokenAddresses, owner, nextBlock]
      );
      if (advanced.rowCount !== tasks.length) {
        throw new Error('position token repair batch advance changed');
      }
      await client.query('COMMIT');
      return Object.freeze({
        tokens: advanced.rowCount, positions: rows.length,
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
    const owner = String(input.owner || '').trim();
    const tokenAddress = address(input.tokenAddress, 'tokenAddress');
    const maxAttempts = bounded(input.maxAttempts, 5, 1, 100, 'maxAttempts');
    const retryMs = bounded(input.retryMs, 60_000, 1_000, 86_400_000, 'retryMs');
    const code = String(input.error?.code || 'position_token_repair_failed').toLowerCase()
      .replace(/[^a-z0-9_:-]/g, '_').slice(0, 64);
    const message = String(input.error?.message || input.error || code).slice(0, 500);
    const result = await database.query(
      `UPDATE robinhood_wallet_position_token_coverage SET
         status = CASE WHEN attempt_count >= $5::integer THEN 'failed' ELSE 'pending' END,
         lease_owner = NULL, lease_until = NULL,
         next_attempt_at = CASE WHEN attempt_count >= $5::integer THEN next_attempt_at
           ELSE NOW() + ($6::bigint * INTERVAL '1 millisecond') END,
         last_error_code = $7, last_error_message = $8,
         version = version + 1, updated_at = NOW()
       WHERE chain = $1 AND projection_version = $2 AND token_address = $3
         AND status = 'leased' AND lease_owner = $4 RETURNING status`,
      [CHAIN, targetVersion, tokenAddress, owner, maxAttempts, retryMs, code, message]
    );
    return result.rows[0]?.status || 'lease-lost';
  }

  return Object.freeze({
    claim, claimBatch, commitShadowBatch, commitShadowRange,
    initialize, plan, preparePromotion, preview, promoteNext, promotionPlan, recover, retry,
  });
}

module.exports = {
  LIVE_LEASE_KEYS, SHADOW_VERSION, SOURCE_VERSION, TARGET_VERSION,
  createRobinhoodWalletPositionTokenRepairRepository,
};

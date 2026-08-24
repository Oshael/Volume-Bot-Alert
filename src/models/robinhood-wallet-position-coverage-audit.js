const db = require('./db');

const CHAIN = 'robinhood';
const TRANSFER_VERSION = 'rh_transfer_v1';
const POSITION_VERSION = 'unified_transfer_v1';

function identifier(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function cursor(row, prefix) {
  const origin = row[`${prefix}_origin_block`];
  const next = row[`${prefix}_next_block`];
  return Object.freeze({
    lifecycleState: row[`${prefix}_state`] || null,
    originBlock: origin == null ? null : String(origin),
    nextBlock: next == null ? null : String(next),
    createdAt: row[`${prefix}_created_at`]
      ? new Date(row[`${prefix}_created_at`]).toISOString() : null,
  });
}

function aligned(left, right) {
  return left != null && right != null && left === right;
}

function areFrontiersAligned(cursors) {
  const { transferSeed, transferLive, positionSeed, positionLive } = cursors;
  return transferSeed.lifecycleState === 'complete'
    && transferLive.lifecycleState === 'running'
    && positionSeed.lifecycleState === 'complete'
    && positionLive.lifecycleState === 'running'
    && aligned(transferSeed.originBlock, positionSeed.originBlock)
    && aligned(transferSeed.nextBlock, positionSeed.nextBlock)
    && aligned(transferLive.originBlock, positionLive.originBlock)
    && aligned(transferLive.nextBlock, positionLive.nextBlock);
}

function coverageState(repair, positionSeed) {
  const transferRepairReady = repair.repairedTokens > 0 && repair.unpublishedTokens === 0;
  const historicalCoverageProven = positionSeed.createdAt != null
    && repair.missingCatalogState === 0
    && repair.addedAfterPositionSeed === 0;
  return Object.freeze({
    transferRepairReady, historicalCoverageProven,
    repairRequired: repair.missingCatalogState > 0 || repair.addedAfterPositionSeed > 0,
  });
}

function failureReasons(frontiersAligned, repair, positionSeed) {
  const reasons = [];
  if (!frontiersAligned) reasons.push('position_transfer_frontiers_not_aligned');
  if (repair.repairedTokens === 0) reasons.push('token_transfer_repair_not_found');
  if (repair.unpublishedTokens > 0) reasons.push('token_transfer_repair_not_published');
  if (positionSeed.createdAt == null) reasons.push('position_seed_start_unavailable');
  if (repair.missingCatalogState > 0) reasons.push('repaired_token_catalog_state_missing');
  if (repair.addedAfterPositionSeed > 0) reasons.push('position_token_repair_required');
  return Object.freeze(reasons);
}

function report(row, versions) {
  const transferSeed = cursor(row, 'transfer_seed');
  const transferLive = cursor(row, 'transfer_live');
  const positionSeed = cursor(row, 'position_seed');
  const positionLive = cursor(row, 'position_live');
  const repair = Object.freeze({
    repairedTokens: Number(row.repaired_tokens || 0),
    publishedTokens: Number(row.published_tokens || 0),
    unpublishedTokens: Number(row.unpublished_tokens || 0),
    missingCatalogState: Number(row.missing_catalog_state || 0),
    addedAfterPositionSeed: Number(row.added_after_position_seed || 0),
  });
  const cursors = Object.freeze({ transferSeed, transferLive, positionSeed, positionLive });
  const frontiersAligned = areFrontiersAligned(cursors);
  const state = coverageState(repair, positionSeed);
  return Object.freeze({
    mode: 'read-only', chain: CHAIN, versions: Object.freeze(versions),
    cursors, repair, frontiersAligned, ...state,
    ready: frontiersAligned && state.transferRepairReady && state.historicalCoverageProven,
    reasons: failureReasons(frontiersAligned, repair, positionSeed),
  });
}

function createRobinhoodWalletPositionCoverageAuditor(options = {}) {
  const database = options.database || db;
  const versions = Object.freeze({
    transfer: identifier(options.transferVersion || TRANSFER_VERSION, 'transferVersion'),
    position: identifier(options.positionVersion || POSITION_VERSION, 'positionVersion'),
  });

  async function audit() {
    const result = await database.query(
      `WITH transfer AS MATERIALIZED (
         SELECT
           MAX(lifecycle_state) FILTER (WHERE stream = 'seed') AS transfer_seed_state,
           MAX(origin_block) FILTER (WHERE stream = 'seed') AS transfer_seed_origin_block,
           MAX(next_block) FILTER (WHERE stream = 'seed') AS transfer_seed_next_block,
           MAX(created_at) FILTER (WHERE stream = 'seed') AS transfer_seed_created_at,
           MAX(lifecycle_state) FILTER (WHERE stream = 'live') AS transfer_live_state,
           MAX(origin_block) FILTER (WHERE stream = 'live') AS transfer_live_origin_block,
           MAX(next_block) FILTER (WHERE stream = 'live') AS transfer_live_next_block,
           MAX(created_at) FILTER (WHERE stream = 'live') AS transfer_live_created_at
         FROM robinhood_wallet_transfer_cursors
         WHERE chain = $1 AND projection_version = $2
       ), position AS MATERIALIZED (
         SELECT
           MAX(lifecycle_state) FILTER (WHERE stream = 'seed') AS position_seed_state,
           MAX(origin_block) FILTER (WHERE stream = 'seed') AS position_seed_origin_block,
           MAX(next_block) FILTER (WHERE stream = 'seed') AS position_seed_next_block,
           MAX(created_at) FILTER (WHERE stream = 'seed') AS position_seed_created_at,
           MAX(lifecycle_state) FILTER (WHERE stream = 'live') AS position_live_state,
           MAX(origin_block) FILTER (WHERE stream = 'live') AS position_live_origin_block,
           MAX(next_block) FILTER (WHERE stream = 'live') AS position_live_next_block,
           MAX(created_at) FILTER (WHERE stream = 'live') AS position_live_created_at
         FROM robinhood_wallet_position_cursors
         WHERE chain = $1 AND projection_version = $3
       ), repaired AS MATERIALIZED (
         SELECT
           COUNT(*)::integer AS repaired_tokens,
           COUNT(*) FILTER (WHERE coverage.published_at IS NOT NULL)::integer
             AS published_tokens,
           COUNT(*) FILTER (WHERE coverage.published_at IS NULL
             OR coverage.status <> 'complete')::integer AS unpublished_tokens,
           COUNT(*) FILTER (WHERE coverage.published_at IS NOT NULL
             AND state.token_address IS NULL)::integer AS missing_catalog_state,
           COUNT(*) FILTER (WHERE coverage.published_at IS NOT NULL
             AND state.created_at > position.position_seed_created_at)::integer
             AS added_after_position_seed
         FROM robinhood_wallet_transfer_token_coverage coverage
         CROSS JOIN position
         LEFT JOIN robinhood_holder_token_states state
           ON state.chain = coverage.chain AND state.token_address = coverage.token_address
         WHERE coverage.chain = $1 AND coverage.projection_version = $2
           AND coverage.attempt_count > 0
       )
       SELECT transfer.*, position.*, repaired.*
       FROM transfer CROSS JOIN position CROSS JOIN repaired`,
      [CHAIN, versions.transfer, versions.position]
    );
    return report(result.rows[0] || {}, versions);
  }

  return Object.freeze({ audit });
}

module.exports = {
  POSITION_VERSION, TRANSFER_VERSION, createRobinhoodWalletPositionCoverageAuditor,
  __private: { report },
};

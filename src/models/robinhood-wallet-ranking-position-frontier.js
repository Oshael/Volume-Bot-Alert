const db = require('./db');

const CHAIN = 'robinhood';
const TIMEOUT_MS = 5000;
const LATEST_AS_OF_SQL = `SELECT next_block_time FROM robinhood_wallet_position_cursors
  WHERE chain='${CHAIN}' AND projection_version=$1 AND stream='live'`;

const FRONTIER_SQL = `SELECT cursor.stream, cursor.lifecycle_state,
    cursor.origin_block, cursor.next_block, cursor.safe_head,
    cursor.next_block_time, cursor.completed_at,
    cursor.checkpoint_block, cursor.checkpoint_hash,
    block.block_timestamp AS checkpoint_time,
    COALESCE(block.canonical AND block.block_hash = cursor.checkpoint_hash,
      false) AS checkpoint_canonical
  FROM robinhood_wallet_position_cursors cursor
  LEFT JOIN robinhood_chain_blocks block
    ON block.chain = cursor.chain AND block.block_number = cursor.checkpoint_block
      AND block.block_hash = cursor.checkpoint_hash
  WHERE cursor.chain = '${CHAIN}' AND cursor.projection_version = $1
    AND cursor.stream IN ('seed', 'live')
  ORDER BY cursor.stream`;

function version(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('projectionVersion is invalid');
  }
  return normalized;
}

function block(value) {
  return value == null ? null : BigInt(value);
}

function isRobinhoodWalletRankingPositionAligned(position, frontier) {
  return frontier.frontierChecksPassed === true && frontier.frontierBlock != null
    && position.throughBlock != null
    && block(position.throughBlock) <= block(frontier.frontierBlock);
}

function seedReady(seed) {
  return !!seed && seed.lifecycle_state === 'complete' && !!seed.completed_at
    && block(seed.origin_block) != null && block(seed.next_block) != null;
}

function liveReady(live) {
  return !!live && live.lifecycle_state === 'running'
    && block(live.origin_block) != null && block(live.next_block) != null;
}

function checkpointReady(live) {
  return !!live && block(live.next_block) != null && block(live.next_block) > 0n
    && block(live.safe_head) != null
    && block(live.checkpoint_block) === block(live.next_block) - 1n
    && block(live.safe_head) >= block(live.checkpoint_block)
    && live.checkpoint_canonical === true
    && live.next_block_time != null && live.checkpoint_time != null
    && new Date(live.next_block_time).getTime()
      === new Date(live.checkpoint_time).getTime();
}

function assess(seed, live, asOf) {
  const reasons = [];
  if (!seedReady(seed)) reasons.push('position_seed_incomplete');
  if (!liveReady(live)) reasons.push('position_live_unavailable');
  if (seed && live && block(seed.next_block) != null
    && block(live.origin_block) != null
    && block(seed.next_block) !== block(live.origin_block)) {
    reasons.push('position_seed_live_gap');
  }
  if (!checkpointReady(live)) reasons.push('position_checkpoint_unproven');
  const frontierTime = live?.next_block_time == null
    ? null : new Date(live.next_block_time);
  if (!frontierTime || !Number.isFinite(frontierTime.getTime())
    || frontierTime.getTime() !== asOf.getTime()) {
    reasons.push('position_as_of_mismatch');
  }
  return {
    asOf: asOf.toISOString(),
    frontierTime: frontierTime && Number.isFinite(frontierTime.getTime())
      ? frontierTime.toISOString() : null,
    frontierBlock: checkpointReady(live) ? String(live.checkpoint_block) : null,
    frontierChecksPassed: reasons.length === 0,
    reasons,
  };
}

function createRobinhoodWalletRankingPositionFrontierRepository(options = {}) {
  const database = options.database || db;
  return {
    async latestAsOf(projectionVersion) {
      const result = await database.queryWithStatementTimeout(
        LATEST_AS_OF_SQL, [version(projectionVersion)], TIMEOUT_MS,
      );
      const value = result.rows[0]?.next_block_time;
      return value == null ? null : new Date(value).toISOString();
    },
    async inspectAsOf(input = {}) {
      const projectionVersion = version(input.projectionVersion);
      const asOf = new Date(input.asOf);
      if (!Number.isFinite(asOf.getTime())) throw new Error('asOf is invalid');
      const result = await database.queryWithStatementTimeout(
        FRONTIER_SQL, [projectionVersion], TIMEOUT_MS,
      );
      const cursors = new Map(result.rows.map((row) => [row.stream, row]));
      return { projectionVersion, ...assess(cursors.get('seed'), cursors.get('live'), asOf) };
    },
  };
}

module.exports = {
  createRobinhoodWalletRankingPositionFrontierRepository,
  isRobinhoodWalletRankingPositionAligned,
};

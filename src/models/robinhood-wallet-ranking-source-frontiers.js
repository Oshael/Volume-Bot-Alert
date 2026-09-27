const db = require('./db');

const CHAIN = 'robinhood';
const TRANSFER_VERSION = 'rh_transfer_v1';
const TIMEOUT_MS = 5000;

const FRONTIERS_SQL = `WITH cursors AS (
    SELECT 'swap'::text AS source, stream, lifecycle_state, origin_block,
      next_block, safe_head, checkpoint_block, checkpoint_hash,
      checkpoint_timestamp AS frontier_time, completed_at
    FROM robinhood_wallet_swap_cursors
    WHERE chain = '${CHAIN}' AND stream IN ('seed', 'live')
    UNION ALL
    SELECT 'transfer'::text AS source, stream, lifecycle_state, origin_block,
      next_block, safe_head, checkpoint_block, checkpoint_hash,
      next_block_time AS frontier_time, completed_at
    FROM robinhood_wallet_transfer_cursors
    WHERE chain = '${CHAIN}' AND projection_version = $1
      AND stream IN ('seed', 'live')
  )
  SELECT cursors.*,
    COALESCE(block.canonical AND block.block_hash = cursors.checkpoint_hash,
      false) AS checkpoint_canonical
  FROM cursors
  LEFT JOIN robinhood_chain_blocks block
    ON block.chain = '${CHAIN}' AND block.block_number = cursors.checkpoint_block
  ORDER BY source, stream`;

function transferVersion(value) {
  const normalized = String(value ?? TRANSFER_VERSION).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error('transferVersion is invalid');
  }
  return normalized;
}

function block(value) {
  return value == null ? null : BigInt(value);
}

function seedComplete(seed) {
  return !!seed && seed.lifecycle_state === 'complete' && !!seed.completed_at
    && block(seed.origin_block) != null && block(seed.next_block) != null;
}

function liveAvailable(live) {
  return !!live && live.lifecycle_state === 'running'
    && block(live.origin_block) != null && block(live.next_block) != null;
}

function seedLiveGap(seed, live) {
  return !!seed && !!live && block(seed.next_block) != null
    && block(live.origin_block) != null
    && block(seed.next_block) < block(live.origin_block);
}

function frontierProven(live) {
  return !!live && block(live.next_block) != null && block(live.next_block) > 0n
    && block(live.safe_head) != null
    && block(live.next_block) - 1n <= block(live.safe_head);
}

function checkpointProven(live) {
  return !!live && live.checkpoint_canonical === true
    && block(live.checkpoint_block) != null
    && block(live.next_block) != null
    && block(live.checkpoint_block) < block(live.next_block);
}

function frontierTime(live) {
  const value = live?.frontier_time == null ? null : new Date(live.frontier_time);
  return value && Number.isFinite(value.getTime()) ? value : null;
}

function sourceReport(source, seed, live, time, reasons) {
  return {
    source,
    seedOriginBlock: seed?.origin_block == null ? null : String(seed.origin_block),
    seedNextBlock: seed?.next_block == null ? null : String(seed.next_block),
    liveOriginBlock: live?.origin_block == null ? null : String(live.origin_block),
    liveNextBlock: live?.next_block == null ? null : String(live.next_block),
    frontierTime: time?.toISOString() || null,
    checksPassed: reasons.length === 0,
    reasons,
  };
}

function assessSource(source, seed, live, asOf) {
  const reasons = [];
  if (!seedComplete(seed)) reasons.push(`${source}_seed_incomplete`);
  if (!liveAvailable(live)) reasons.push(`${source}_live_unavailable`);
  if (seedLiveGap(seed, live)) reasons.push(`${source}_seed_live_gap`);
  if (!frontierProven(live)) reasons.push(`${source}_frontier_unproven`);
  if (!checkpointProven(live)) reasons.push(`${source}_checkpoint_unproven`);
  const time = frontierTime(live);
  if (!time || time <= asOf) {
    reasons.push(`${source}_behind_as_of`);
  }
  return sourceReport(source, seed, live, time, reasons);
}

function createRobinhoodWalletRankingSourceFrontiersRepository(options = {}) {
  const database = options.database || db;
  return {
    async inspectAsOf(input = {}) {
      const asOf = new Date(input.asOf);
      if (!Number.isFinite(asOf.getTime())) throw new Error('asOf is invalid');
      const version = transferVersion(input.transferVersion);
      const result = await database.queryWithStatementTimeout(
        FRONTIERS_SQL, [version], TIMEOUT_MS,
      );
      const rows = new Map(result.rows.map((row) => [`${row.source}:${row.stream}`, row]));
      const sources = ['swap', 'transfer'].map((source) => assessSource(
        source, rows.get(`${source}:seed`), rows.get(`${source}:live`), asOf,
      ));
      return {
        chain: CHAIN, transferVersion: version, asOf: asOf.toISOString(), sources,
        cursorChecksPassed: sources.every((source) => source.checksPassed),
        sourceCoverageVerified: false,
      };
    },
  };
}

module.exports = { createRobinhoodWalletRankingSourceFrontiersRepository };

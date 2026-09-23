const db = require('./db');
const {
  createRobinhoodWalletTransferRetentionPlanner,
} = require('./robinhood-wallet-transfer-retention-plan');

const CHAIN = 'robinhood';
const QUERY_TIMEOUT_MS = 5_000;
const EVIDENCE_COVERAGE_TIMEOUT_MS = 60_000;

function partitionName(candidate) {
  const expected = `robinhood_token_transfer_events_${candidate.partitionDay.replace(/-/g, '_')}`;
  if (!/^robinhood_token_transfer_events_\d{4}_\d{2}_\d{2}$/.test(expected)
      || candidate.actualPartition !== expected || candidate.expectedPartition !== expected) {
    throw new Error('retention partition identity mismatch');
  }
  return `public.${expected}`;
}

function probeSql(partition, from, to, rawLastBlock) {
  const queuedSql = `WITH queued AS MATERIALIZED (
    SELECT chain, token_address, observation_from_block, source_through_block,
           source_requested_version, requested_version
    FROM robinhood_bundle_redistribution_queue
    WHERE chain = $1 AND status IN ('pending', 'leased')
      AND last_error_code = 'redistribution_source_not_ready'
      AND last_error_message LIKE '%transaction_position_missing%'
      AND ($4::bigint IS NULL OR observation_from_block <= $4::bigint)
  )`;
  return {
    unpreservedUnknown: { sql: `SELECT EXISTS (
      SELECT 1 FROM ${partition} raw
      WHERE raw.chain = $1 AND raw.transfer_kind = 'unknown'
        AND NOT EXISTS (
          SELECT 1 FROM robinhood_wallet_transfer_pending_evidence evidence
          WHERE evidence.chain = raw.chain
            AND evidence.transaction_hash = raw.transaction_hash
            AND evidence.log_index = raw.log_index
            AND evidence.block_time = raw.block_time
            AND evidence.block_number = raw.block_number
            AND evidence.block_hash = raw.block_hash
            AND evidence.transaction_index = raw.transaction_index
            AND evidence.token_address = raw.token_address
            AND evidence.from_wallet = raw.from_wallet
            AND evidence.to_wallet = raw.to_wallet
            AND evidence.amount_raw = raw.amount_raw
            AND evidence.classification_version = raw.classification_version
            AND NOT EXISTS (
              SELECT 1 FROM robinhood_wallet_transfer_evidence_dispositions disposition
              WHERE disposition.chain = evidence.chain
                AND disposition.transaction_hash = evidence.transaction_hash
                AND disposition.log_index = evidence.log_index
                AND disposition.block_time = evidence.block_time
                AND disposition.disposition IN ('orphaned', 'reclassified')
            )
        )
    ) AS present`, params: [CHAIN], timeoutMs: EVIDENCE_COVERAGE_TIMEOUT_MS },
    endpointRoleGapOnUnknown: { sql: `SELECT EXISTS (
      SELECT 1 FROM ${partition} raw
      CROSS JOIN LATERAL (VALUES (raw.from_wallet), (raw.to_wallet)) endpoint(address)
      WHERE raw.chain = $1 AND raw.transfer_kind = 'unknown'
        AND endpoint.address NOT IN (
          '0x0000000000000000000000000000000000000000',
          '0x000000000000000000000000000000000000dead'
        )
        AND endpoint.address !~ '^0x0{39}[1-9a]$'
        AND NOT EXISTS (
          SELECT 1 FROM robinhood_wallet_endpoint_roles role
          WHERE role.chain = raw.chain AND role.endpoint_address = endpoint.address
            AND raw.block_number BETWEEN role.observed_from_block AND role.observed_through_block
        )
    ) AS present`, params: [CHAIN] },
    transferPositionRepairCandidate: { sql: `${queuedSql}
      SELECT EXISTS (
        SELECT 1 FROM queued queue
        JOIN robinhood_wallet_transfer_edges edge
          ON edge.chain = queue.chain AND edge.token_address = queue.token_address
         AND edge.classification_version = 'rh_transfer_v1'
        LEFT JOIN robinhood_transaction_positions position
          ON position.chain = edge.chain
         AND position.transaction_hash = edge.first_wallet_transfer_transaction_hash
         AND position.block_number = edge.first_wallet_transfer_block
        WHERE edge.first_wallet_transfer_block >= queue.observation_from_block
          AND (queue.source_through_block IS NULL
            OR queue.source_requested_version IS DISTINCT FROM queue.requested_version
            OR edge.first_wallet_transfer_block <= queue.source_through_block)
          AND edge.first_wallet_transfer_at >= $2::timestamptz
          AND edge.first_wallet_transfer_at < $3::timestamptz
          AND position.transaction_hash IS NULL
      ) AS present`, params: [CHAIN, from, to, rawLastBlock] },
    sellPositionRepairCandidate: { sql: `${queuedSql}
      SELECT EXISTS (
        SELECT 1 FROM queued queue
        JOIN robinhood_wallet_transfer_edges edge
          ON edge.chain = queue.chain AND edge.token_address = queue.token_address
         AND edge.classification_version = 'rh_transfer_v1'
        JOIN robinhood_wallet_swaps swap
          ON swap.chain = edge.chain AND swap.token_address = edge.token_address
         AND swap.wallet_address = edge.to_wallet AND swap.side = 'sell'
         AND swap.block_number > edge.first_wallet_transfer_block
        LEFT JOIN robinhood_transaction_positions position
          ON position.chain = swap.chain AND position.transaction_hash = swap.transaction_hash
         AND position.block_number = swap.block_number
        WHERE edge.first_wallet_transfer_block >= queue.observation_from_block
          AND (queue.source_through_block IS NULL
            OR queue.source_requested_version IS DISTINCT FROM queue.requested_version
            OR swap.block_number <= queue.source_through_block)
          AND swap.block_time >= $2::timestamptz
          AND swap.block_time < $3::timestamptz
          AND position.transaction_index IS NULL
      ) AS present`, params: [CHAIN, from, to, rawLastBlock] },
  };
}

function canonicalCheckpointProbe(candidate, projectionVersion) {
  return {
    sql: `SELECT NOT EXISTS (
      SELECT 1
        FROM robinhood_wallet_transfer_compaction_watermarks watermark
        JOIN robinhood_chain_capture_cursor capture ON capture.chain=watermark.chain
        JOIN robinhood_chain_blocks block
          ON block.chain=watermark.chain
         AND block.block_number=watermark.checkpoint_block
         AND block.block_hash=watermark.checkpoint_hash
         AND block.canonical
       WHERE watermark.chain=$1 AND watermark.projection_version=$2
         AND watermark.partition_day=$3::date
         AND watermark.version=$4::bigint
         AND watermark.lifecycle_state='verified' AND watermark.dropped_at IS NULL
         AND capture.recovery_state='running'
         AND capture.finalized_head >= watermark.checkpoint_block
    ) AS present`,
    params: [CHAIN, projectionVersion, candidate.partitionDay, candidate.watermarkVersion],
  };
}

async function runProbe(database, sql, params, timeoutMs = QUERY_TIMEOUT_MS) {
  const startedAt = Date.now();
  try {
    const { rows } = await database.queryWithStatementTimeout(sql, params, timeoutMs);
    if (typeof rows[0]?.present !== 'boolean') {
      throw new Error('dependency probe returned an incomplete result');
    }
    return { status: rows[0].present ? 'candidate' : 'absent', elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { status: 'unknown', elapsedMs: Date.now() - startedAt,
      errorCode: error.code || null, error: error.message };
  }
}

function createRobinhoodWalletTransferRetentionReadiness(options = {}) {
  const database = options.database || db;
  const planner = options.planner || createRobinhoodWalletTransferRetentionPlanner({ database });

  async function inspect(input = {}) {
    const plan = await planner.plan(input);
    const candidates = [];
    for (const candidate of plan.candidates) {
      const blockedReasons = [...candidate.blockedReasons];
      const deferredReasons = [];
      let dependencies = null;
      if (candidate.catalogReady) {
        const partition = partitionName(candidate);
        const from = `${candidate.partitionDay}T00:00:00.000Z`;
        const to = new Date(Date.parse(from) + 86_400_000).toISOString();
        dependencies = {};
        const probes = {
          ...probeSql(partition, from, to, candidate.rawLastBlock ?? null),
          canonicalCheckpointNotProven: canonicalCheckpointProbe(
            candidate, input.projectionVersion
          ),
        };
        for (const [name, probe] of Object.entries(probes)) {
          const result = await runProbe(database, probe.sql, probe.params, probe.timeoutMs);
          dependencies[name] = result;
        }
        for (const [name, result] of Object.entries(dependencies)) {
          if (result.status === 'absent') continue;
          const reason = `${name}_${result.status}`;
          if (name === 'endpointRoleGapOnUnknown' && result.status === 'candidate'
              && dependencies.unpreservedUnknown.status === 'absent') {
            deferredReasons.push(reason);
          } else blockedReasons.push(reason);
        }
      }
      candidates.push({
        ...candidate, dependencies, blockedReasons, deferredReasons,
        provisionalGatesClear: blockedReasons.length === 0,
        readyForDrop: false,
      });
    }
    return {
      mode: 'read-only', retentionDays: plan.retentionDays,
      cutoffDay: plan.cutoffDay, limit: plan.limit, hasMore: plan.hasMore,
      candidates,
      provisionalGatesClear: candidates.filter((item) => item.provisionalGatesClear).length,
      blocked: candidates.filter((item) => !item.provisionalGatesClear).length,
      requiresCanonicalRevalidation: true,
      destructive: false,
    };
  }

  return { inspect };
}

module.exports = { createRobinhoodWalletTransferRetentionReadiness };

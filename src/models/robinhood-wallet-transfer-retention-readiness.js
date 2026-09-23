const db = require('./db');
const {
  createRobinhoodWalletTransferRetentionPlanner,
} = require('./robinhood-wallet-transfer-retention-plan');

const CHAIN = 'robinhood';
const QUERY_TIMEOUT_MS = 5_000;

function partitionName(candidate) {
  const expected = `robinhood_token_transfer_events_${candidate.partitionDay.replace(/-/g, '_')}`;
  if (!/^robinhood_token_transfer_events_\d{4}_\d{2}_\d{2}$/.test(expected)
      || candidate.actualPartition !== expected || candidate.expectedPartition !== expected) {
    throw new Error('retention partition identity mismatch');
  }
  return `public.${expected}`;
}

function probeSql(partition) {
  return {
    unknownTransfer: `SELECT EXISTS (
      SELECT 1 FROM ${partition} raw
      WHERE raw.chain = $1 AND raw.transfer_kind = 'unknown'
    ) AS present`,
    endpointRoleGapOnUnknown: `SELECT EXISTS (
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
    ) AS present`,
    positionRepairCandidate: `WITH queued AS MATERIALIZED (
      SELECT chain, token_address, observation_from_block
      FROM robinhood_bundle_redistribution_queue
      WHERE chain = $1 AND status IN ('pending', 'leased')
        AND last_error_code = 'redistribution_source_not_ready'
        AND last_error_message LIKE '%transaction_position_missing%'
    )
    SELECT (
      EXISTS (
        SELECT 1 FROM queued queue
        JOIN robinhood_wallet_transfer_edges edge
          ON edge.chain = queue.chain AND edge.token_address = queue.token_address
         AND edge.classification_version = 'rh_transfer_v1'
        LEFT JOIN robinhood_transaction_positions position
          ON position.chain = edge.chain
         AND position.transaction_hash = edge.first_wallet_transfer_transaction_hash
         AND position.block_number = edge.first_wallet_transfer_block
        WHERE edge.first_wallet_transfer_block >= queue.observation_from_block
          AND edge.first_wallet_transfer_at >= $2::timestamptz
          AND edge.first_wallet_transfer_at < $3::timestamptz
          AND position.transaction_hash IS NULL
      ) OR EXISTS (
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
          AND swap.block_time >= $2::timestamptz
          AND swap.block_time < $3::timestamptz
          AND position.transaction_index IS NULL
      )
    ) AS present`,
  };
}

async function runProbe(database, sql, params) {
  const startedAt = Date.now();
  try {
    const { rows } = await database.queryWithStatementTimeout(sql, params, QUERY_TIMEOUT_MS);
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
      let dependencies = null;
      if (candidate.catalogReady) {
        const partition = partitionName(candidate);
        const from = `${candidate.partitionDay}T00:00:00.000Z`;
        const to = new Date(Date.parse(from) + 86_400_000).toISOString();
        dependencies = {};
        for (const [name, sql] of Object.entries(probeSql(partition))) {
          const result = await runProbe(database, sql, [CHAIN, from, to]);
          dependencies[name] = result;
          if (result.status !== 'absent') {
            blockedReasons.push(`${name}_${result.status}`);
          }
        }
      }
      candidates.push({
        ...candidate, dependencies, blockedReasons,
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

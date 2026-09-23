const db = require('./db');
const {
  createRobinhoodWalletTransferRetentionPlanner,
} = require('./robinhood-wallet-transfer-retention-plan');

const CHAIN = 'robinhood';
const QUERY_TIMEOUT_MS = 30_000;

function partitionName(candidate) {
  const expected = `robinhood_token_transfer_events_${candidate.partitionDay.replace(/-/g, '_')}`;
  if (!/^robinhood_token_transfer_events_\d{4}_\d{2}_\d{2}$/.test(expected)
      || candidate.actualPartition !== expected || candidate.expectedPartition !== expected) {
    throw new Error('retention partition identity mismatch');
  }
  return `public.${expected}`;
}

function dependencySql(partition) {
  return `SELECT
    EXISTS (
      SELECT 1 FROM ${partition} raw
      CROSS JOIN LATERAL (VALUES (raw.from_wallet), (raw.to_wallet)) endpoint(address)
      WHERE raw.chain = $1
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
      LIMIT 1
    ) AS endpoint_role_missing,
    EXISTS (
      SELECT 1 FROM ${partition} raw
      WHERE raw.chain = $1 AND raw.transfer_kind = 'unknown'
      LIMIT 1
    ) AS unknown_transfer_present,
    EXISTS (
      SELECT 1 FROM robinhood_bundle_redistribution_queue queue
      WHERE queue.chain = $1 AND queue.status IN ('pending', 'leased')
        AND (
          EXISTS (
            SELECT 1 FROM robinhood_wallet_transfer_edges edge
            WHERE edge.chain = queue.chain AND edge.token_address = queue.token_address
              AND edge.first_wallet_transfer_at >= $2::timestamptz
              AND edge.first_wallet_transfer_at < $3::timestamptz
          ) OR EXISTS (
            SELECT 1 FROM robinhood_wallet_swaps swap
            WHERE swap.chain = queue.chain AND swap.token_address = queue.token_address
              AND swap.side = 'sell' AND swap.block_time >= $2::timestamptz
              AND swap.block_time < $3::timestamptz
          )
        )
      LIMIT 1
    ) AS redistribution_raw_dependency`;
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
        try {
          const result = await database.queryWithStatementTimeout(
            dependencySql(partition), [CHAIN, from, to], QUERY_TIMEOUT_MS
          );
          const row = result.rows[0];
          if (!row || [row.endpoint_role_missing, row.unknown_transfer_present,
            row.redistribution_raw_dependency].some((value) => typeof value !== 'boolean')) {
            throw new Error('dependency audit returned an incomplete result');
          }
          dependencies = {
            endpointRoleMissing: row.endpoint_role_missing,
            unknownTransferPresent: row.unknown_transfer_present,
            redistributionRawDependency: row.redistribution_raw_dependency,
          };
          if (dependencies.endpointRoleMissing) blockedReasons.push('endpoint_role_missing');
          if (dependencies.unknownTransferPresent) blockedReasons.push('unknown_transfer_present');
          if (dependencies.redistributionRawDependency) blockedReasons.push('redistribution_raw_dependency');
        } catch (error) {
          blockedReasons.push('dependency_audit_failed');
          dependencies = { error: error.message };
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

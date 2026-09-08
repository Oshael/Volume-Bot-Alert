require('dotenv').config();

const db = require('../models/db');
const { runDriftProbe } = require('./robinhood-holder-drift-probe');

const MAX_UINT256 = (1n << 256n) - 1n;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    confirm: input.confirm === true,
    batchSize: boundedInteger(input.batchSize, 25, 1, 100, 'repair batchSize'),
    rangeSize: boundedInteger(input.rangeSize, 5000, 1, 5000, 'repair rangeSize'),
    confirmations: boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations'),
    timeoutMs: boundedInteger(input.timeoutMs, 15_000, 1000, 60_000, 'RPC timeout'),
    maxReplayBlocks: boundedInteger(
      input.maxReplayBlocks, 250_000, 1, 5_000_000, 'max replay blocks'
    ),
    maxTotalReplayBlocks: boundedInteger(
      input.maxTotalReplayBlocks, 1_000_000, 1, 20_000_000, 'max total replay blocks'
    ),
  });
}

function validAddress(value) {
  return ADDRESS_PATTERN.test(String(value || '').toLowerCase());
}

function repairEvidence(result, safeHead) {
  if (result.status !== 'deficit-found'
      || result.classification !== 'missing-or-implicit-credit-before-block') {
    return Object.freeze({ eligible: false, reason: 'unproven_drift' });
  }
  const historical = BigInt(result.historicalBalanceAtPrecedingBlock);
  const local = BigInt(result.localBalanceAtBlockStart);
  const nextBlock = BigInt(result.backfillNextBlock);
  const failedBlock = BigInt(result.failedBlock);
  const head = BigInt(safeHead);
  const receipt = result.receiptEvidence;
  if (!validAddress(result.sender) || historical <= local || historical > MAX_UINT256
      || receipt?.status !== 'match'
      || BigInt(receipt.fromBlock) !== nextBlock
      || BigInt(receipt.toBlock) !== failedBlock) {
    return Object.freeze({ eligible: false, reason: 'incomplete_repair_evidence' });
  }
  return Object.freeze({
    eligible: true,
    creditRaw: (historical - local).toString(),
    replayBlocks: head >= nextBlock ? Number(head - nextBlock + 1n) : 0,
  });
}

function chooseAction(result, safeHead, options, budgetUsed) {
  let evidence;
  try {
    evidence = repairEvidence(result, safeHead);
  } catch (_) {
    evidence = Object.freeze({ eligible: false, reason: 'invalid_repair_evidence' });
  }
  if (!evidence.eligible) return Object.freeze({ action: 'suppress', reason: evidence.reason });
  if (evidence.replayBlocks > options.maxReplayBlocks) {
    return Object.freeze({ action: 'suppress', reason: 'token_replay_limit_exceeded' });
  }
  if (budgetUsed + evidence.replayBlocks > options.maxTotalReplayBlocks) {
    return Object.freeze({ action: 'suppress', reason: 'total_replay_limit_exceeded' });
  }
  return Object.freeze({ action: 'repair', ...evidence });
}

async function withTransaction(database, operation) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await operation(client);
    await client.query(result == null ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function lockCandidate(client, candidate) {
  const result = await client.query(
    `SELECT token_address FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status = 'drifted' AND version = $2::bigint
        AND backfill_next_block = $3::bigint
      FOR UPDATE`,
    [candidate.tokenAddress, candidate.version, candidate.backfillNextBlock]
  );
  return result.rowCount === 1;
}

async function anchorCandidate(database, candidate, action) {
  return withTransaction(database, async (client) => {
    if (!await lockCandidate(client, candidate)) return null;
    const balance = await client.query(
      `SELECT balance_raw FROM robinhood_holder_balances
        WHERE chain = 'robinhood' AND token_address = $1 AND wallet_address = $2
        FOR UPDATE`, [candidate.tokenAddress, candidate.sender]
    );
    if (!balance.rowCount
        || BigInt(balance.rows[0].balance_raw) + BigInt(action.creditRaw) > MAX_UINT256) {
      return Object.freeze({ status: 'unavailable', reason: 'anchor_balance_unavailable' });
    }
    await client.query(
      `UPDATE robinhood_holder_balances
          SET balance_raw = balance_raw + $3::numeric, updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = $1 AND wallet_address = $2`,
      [candidate.tokenAddress, candidate.sender, action.creditRaw]
    );
    const state = await client.query(
      `UPDATE robinhood_holder_token_states
          SET ledger_status = 'backfilling', last_reconciled_at = NOW(),
              version = version + 1, updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = $1
          AND ledger_status = 'drifted' AND version = $2::bigint
        RETURNING version`, [candidate.tokenAddress, candidate.version]
    );
    if (!state.rowCount) throw new Error('bounded drift repair lost its state lock');
    return Object.freeze({
      status: 'repaired', tokenAddress: candidate.tokenAddress,
      creditRaw: action.creditRaw, replayBlocks: action.replayBlocks,
    });
  });
}

async function suppressCandidate(database, candidate, reason) {
  return withTransaction(database, async (client) => {
    if (!await lockCandidate(client, candidate)) return null;
    await client.query(
      `INSERT INTO admin_blocked_tokens (chain, address, label, created_by)
       VALUES ('robinhood', $1, 'holder-drift-unrecoverable', NULL)
       ON CONFLICT (chain, address) DO UPDATE SET
         label = EXCLUDED.label`, [candidate.tokenAddress]
    );
    const catalog = await client.query(
      `UPDATE token_catalog
          SET source = 'admin-blocked', is_active_monitor_candidate = FALSE,
              eligible_for_monitoring = FALSE, eligibility_state = 'admin-blocked',
              suppressed_reason = 'admin_blocked', monitor_priority = 'dormant',
              last_evaluated_at = NOW(), next_evaluation_at = NOW() + INTERVAL '10 years',
              last_evaluation_error = NULL, evaluation_error_count = 0,
              metadata_updated_at = NOW()
        WHERE chain = 'robinhood' AND address = $1`, [candidate.tokenAddress]
    );
    const cohort = await client.query(
      `UPDATE robinhood_holder_global_backfill_tokens
          SET holder_count = 0, status = 'excluded',
              exclusion_reason = 'holder_drift_unrecoverable', updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = $1 AND status = 'active'`,
      [candidate.tokenAddress]
    );
    const balances = await client.query(
      `DELETE FROM robinhood_holder_balances
        WHERE chain = 'robinhood' AND token_address = $1`, [candidate.tokenAddress]
    );
    const state = await client.query(
      `DELETE FROM robinhood_holder_token_states
        WHERE chain = 'robinhood' AND token_address = $1
          AND ledger_status = 'drifted' AND version = $2::bigint`,
      [candidate.tokenAddress, candidate.version]
    );
    if (!state.rowCount) throw new Error('bounded drift suppression lost its state lock');
    return Object.freeze({
      status: 'suppressed', tokenAddress: candidate.tokenAddress, reason,
      catalogRows: catalog.rowCount, deletedBalances: balances.rowCount,
      excludedCohortRows: cohort.rowCount,
    });
  });
}

function nextPageCursor(results, batchSize, currentCursor) {
  if (results.length < batchSize) return null;
  const next = results.at(-1)?.tokenAddress;
  if (!next || next === currentCursor) throw new Error('bounded drift pagination did not advance');
  return next;
}

async function countRemaining(database) {
  const result = await database.query(
    `SELECT COUNT(*)::int AS count FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND ledger_status = 'drifted'`
  );
  return Number(result.rows[0]?.count) || 0;
}

async function runBoundedDriftRepair(input = {}) {
  const options = normalizeOptions(input);
  const database = input.database || db;
  const probe = input.probe || runDriftProbe;
  const summary = { inspected: 0, repairable: 0, suppressible: 0, repaired: 0,
    suppressed: 0, stale: 0, failed: 0, scheduledReplayBlocks: 0 };
  const samples = { repair: [], suppress: [], stale: [], failed: [] };
  let afterTokenAddress = null;
  let provider = null;
  let safeHead = null;
  let budgetUsed = 0;
  while (true) {
    const page = await probe({
      database, env: input.env || process.env, afterTokenAddress, limit: options.batchSize,
      rangeSize: options.rangeSize, confirmations: options.confirmations,
      timeoutMs: options.timeoutMs,
    });
    if (!Array.isArray(page?.results) || page.safeHead == null) {
      throw new Error('bounded drift probe result is invalid');
    }
    provider ||= page.provider || null;
    safeHead = page.safeHead;
    for (const candidate of page.results) {
      summary.inspected += 1;
      const action = chooseAction(candidate, safeHead, options, budgetUsed);
      summary[action.action === 'repair' ? 'repairable' : 'suppressible'] += 1;
      if (samples[action.action].length < 10) {
        samples[action.action].push({ tokenAddress: candidate.tokenAddress,
          reason: action.reason || null, replayBlocks: action.replayBlocks || 0 });
      }
      if (action.action === 'repair') {
        budgetUsed += action.replayBlocks;
        summary.scheduledReplayBlocks += action.replayBlocks;
      }
      if (!options.confirm) continue;
      let applied;
      try {
        applied = action.action === 'repair'
          ? await anchorCandidate(database, candidate, action)
          : await suppressCandidate(database, candidate, action.reason);
        if (applied?.status === 'unavailable') {
          applied = await suppressCandidate(database, candidate, applied.reason);
        }
      } catch (error) {
        summary.failed += 1;
        if (samples.failed.length < 10) samples.failed.push({
          tokenAddress: candidate.tokenAddress,
          error: String(error?.code || error?.message || error).slice(0, 160),
        });
        continue;
      }
      if (!applied) {
        summary.stale += 1;
        if (samples.stale.length < 10) samples.stale.push(candidate.tokenAddress);
      } else if (applied.status === 'repaired') summary.repaired += 1;
      else summary.suppressed += 1;
    }
    const next = nextPageCursor(page.results, options.batchSize, afterTokenAddress);
    if (next == null) break;
    afterTokenAddress = next;
  }
  return Object.freeze({
    mode: options.confirm ? 'confirmed' : 'dry-run', provider, safeHead,
    limits: Object.freeze({ maxReplayBlocks: options.maxReplayBlocks,
      maxTotalReplayBlocks: options.maxTotalReplayBlocks }),
    summary: Object.freeze(summary), samples: Object.freeze(samples),
    remainingDrifted: await countRemaining(database),
  });
}

async function main() {
  try {
    console.log(JSON.stringify(await runBoundedDriftRepair({
      confirm: process.argv.includes('--confirm-repair-or-suppress'),
      batchSize: process.env.ROBINHOOD_HOLDER_DRIFT_RECOVERY_BATCH_SIZE,
      rangeSize: process.env.ROBINHOOD_HOLDER_DRIFT_PROBE_RANGE_SIZE,
      confirmations: process.env.ROBINHOOD_HOLDER_BACKFILL_CONFIRMATIONS,
      timeoutMs: process.env.ROBINHOOD_RPC_TIMEOUT_MS,
      maxReplayBlocks: process.env.ROBINHOOD_HOLDER_DRIFT_REPAIR_MAX_REPLAY_BLOCKS,
      maxTotalReplayBlocks: process.env.ROBINHOOD_HOLDER_DRIFT_REPAIR_MAX_TOTAL_REPLAY_BLOCKS,
    }), null, 2));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodHolderDriftBoundedRepair] Failed:', error.message);
  process.exitCode = 1;
});

module.exports = {
  runBoundedDriftRepair,
  __private: { anchorCandidate, chooseAction, normalizeOptions, repairEvidence,
    suppressCandidate },
};

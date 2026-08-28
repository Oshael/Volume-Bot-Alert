require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodHolderLedgerRepository,
} = require('../models/robinhood-holder-ledger');
const { runDriftProbe } = require('./robinhood-holder-drift-probe');

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
    batchSize: boundedInteger(input.batchSize, 25, 1, 100, 'recovery batchSize'),
    rangeSize: boundedInteger(input.rangeSize, 5000, 1, 5000, 'recovery rangeSize'),
    confirmations: boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations'),
    timeoutMs: boundedInteger(input.timeoutMs, 15_000, 1000, 60_000, 'RPC timeout'),
  });
}

async function requeueCandidate(database, candidate) {
  const result = await database.query(
    `UPDATE robinhood_holder_token_states
        SET ledger_status = 'backfilling', version = version + 1, updated_at = NOW()
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status = 'drifted' AND version = $2::bigint
        AND backfill_next_block = $3::bigint
        AND (live_through_block IS NULL OR live_through_block + 1 = backfill_next_block)
      RETURNING token_address, version`,
    [candidate.tokenAddress, candidate.version, candidate.backfillNextBlock]
  );
  return result.rowCount === 1;
}

function hasReplayCheckpoint(candidate) {
  return candidate.liveThroughBlock == null
    || BigInt(candidate.liveThroughBlock) + 1n === BigInt(candidate.backfillNextBlock);
}

async function countRemaining(database) {
  const { rows } = await database.query(
    `SELECT COUNT(*)::int AS tokens
       FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND ledger_status = 'drifted'`
  );
  return Number(rows[0]?.tokens) || 0;
}

function diagnostic(result) {
  return Object.freeze({
    tokenAddress: result.tokenAddress,
    status: result.status,
    classification: result.classification || null,
    backfillNextBlock: result.backfillNextBlock,
    liveThroughBlock: result.liveThroughBlock ?? null,
    version: result.version,
  });
}

async function processPage(results, context) {
  for (const result of results) {
    context.diagnostics.push(diagnostic(result));
    if (result.status !== 'not-reproduced') continue;
    if (!hasReplayCheckpoint(result)) {
      const preview = await context.tailRecovery.inspectDriftedAppliedTail({
        tokenAddress: result.tokenAddress,
        backfillNextBlock: result.backfillNextBlock,
        expectedVersion: result.version,
      });
      if (!preview.eligible) {
        context.unsafeTokens.push(result.tokenAddress);
        context.unsafeDiagnostics.push(Object.freeze({
          tokenAddress: result.tokenAddress, reason: preview.reason,
        }));
        continue;
      }
      context.tailRollbackTokens.push(result.tokenAddress);
      if (!context.confirm) continue;
      try {
        await context.tailRecovery.rollbackDriftedAppliedTail({
          tokenAddress: result.tokenAddress,
          backfillNextBlock: result.backfillNextBlock,
          expectedVersion: result.version,
        });
        context.rolledBackTailTokens.push(result.tokenAddress);
      } catch (error) {
        if (!['holder_tail_rollback_stale', 'holder_tail_rollback_unavailable']
          .includes(error?.code)) throw error;
        context.staleTokens.push(result.tokenAddress);
      }
      continue;
    }
    context.eligibleTokens.push(result.tokenAddress);
    if (!context.confirm) continue;
    if (await requeueCandidate(context.database, result)) {
      context.requeuedTokens.push(result.tokenAddress);
    } else {
      context.staleTokens.push(result.tokenAddress);
    }
  }
}

function nextPageCursor(results, batchSize, currentCursor) {
  if (results.length < batchSize) return null;
  const nextCursor = results.at(-1)?.tokenAddress;
  if (!nextCursor || nextCursor === currentCursor) {
    throw new Error('drift recovery pagination did not advance');
  }
  return nextCursor;
}

async function runDriftRecovery(input = {}) {
  const options = normalizeOptions(input);
  const database = input.database || db;
  const probe = input.probe || runDriftProbe;
  const tailRecovery = input.tailRecovery
    || createRobinhoodHolderLedgerRepository({ database });
  const diagnostics = [];
  const eligibleTokens = [];
  const tailRollbackTokens = [];
  const rolledBackTailTokens = [];
  const requeuedTokens = [];
  const staleTokens = [];
  const unsafeTokens = [];
  const unsafeDiagnostics = [];
  let afterTokenAddress = null;
  let provider = null;
  let safeHead = null;

  while (true) {
    const page = await probe({
      database, env: input.env || process.env,
      afterTokenAddress, limit: options.batchSize,
      rangeSize: options.rangeSize, confirmations: options.confirmations,
      timeoutMs: options.timeoutMs,
    });
    if (!Array.isArray(page?.results)) throw new Error('drift recovery probe result is invalid');
    provider ||= page.provider || null;
    safeHead = page.safeHead ?? safeHead;
    await processPage(page.results, {
      database, confirm: options.confirm, diagnostics, eligibleTokens,
      tailRecovery, tailRollbackTokens, rolledBackTailTokens,
      requeuedTokens, staleTokens, unsafeTokens, unsafeDiagnostics,
    });
    const nextCursor = nextPageCursor(page.results, options.batchSize, afterTokenAddress);
    if (nextCursor == null) break;
    afterTokenAddress = nextCursor;
  }

  return Object.freeze({
    mode: options.confirm ? 'confirmed' : 'dry-run', provider, safeHead,
    inspectedTokens: diagnostics.length, eligibleTokens: Object.freeze(eligibleTokens),
    tailRollbackTokens: Object.freeze(tailRollbackTokens),
    rolledBackTailTokens: Object.freeze(rolledBackTailTokens),
    unsafeTokens: Object.freeze(unsafeTokens),
    unsafeDiagnostics: Object.freeze(unsafeDiagnostics),
    requeuedTokens: Object.freeze(requeuedTokens), staleTokens: Object.freeze(staleTokens),
    remainingDrifted: await countRemaining(database),
    diagnostics: Object.freeze(diagnostics),
  });
}

async function main() {
  try {
    const result = await runDriftRecovery({
      confirm: process.argv.includes('--confirm-requeue'),
      batchSize: process.env.ROBINHOOD_HOLDER_DRIFT_RECOVERY_BATCH_SIZE,
      rangeSize: process.env.ROBINHOOD_HOLDER_DRIFT_PROBE_RANGE_SIZE,
      confirmations: process.env.ROBINHOOD_HOLDER_BACKFILL_CONFIRMATIONS,
      timeoutMs: process.env.ROBINHOOD_RPC_TIMEOUT_MS,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodHolderDriftRecovery] Failed:', error.message);
  process.exitCode = 1;
});

module.exports = {
  runDriftRecovery,
  __private: { hasReplayCheckpoint, nextPageCursor, normalizeOptions, requeueCandidate },
};

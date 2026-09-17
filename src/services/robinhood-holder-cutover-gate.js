'use strict';

const db = require('../models/db');
const { TRANSFER_TOPIC } = require('./evm-erc20-supply-delta');
const { __private: { decodeTransferLog } } = require('./robinhood-holder-transfer-reader');
const {
  acquireRobinhoodHolderReorgFence, buildHolderCaptureReceipts, normalizeHolderTransfer,
} = require('../models/robinhood-holder-ledger');
const { createRobinhoodHolderCutoverRetention } = require('./robinhood-holder-cutover-retention');

const CHAIN = 'robinhood';
const SAMPLE_BLOCKS = 10n;
const MAX_EVENTS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const MAX_STATEMENT_TIMEOUT_MS = 60_000;

function statementTimeout(value) {
  const timeout = value == null ? DEFAULT_STATEMENT_TIMEOUT_MS : Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < DEFAULT_STATEMENT_TIMEOUT_MS
      || timeout > MAX_STATEMENT_TIMEOUT_MS) {
    throw new Error(`holder cutover statement timeout must be between ${DEFAULT_STATEMENT_TIMEOUT_MS}`
      + ` and ${MAX_STATEMENT_TIMEOUT_MS} ms`);
  }
  return timeout;
}

async function withPhase(phase, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!error.cutoverPhase) error.cutoverPhase = phase;
    throw error;
  }
}

function fail(code) {
  const error = new Error(`holder cutover gate: ${code}`);
  error.code = 'holder_cutover_not_ready';
  error.reason = code;
  return error;
}

function add(blockers, condition, code) {
  if (condition) blockers.push(code);
}

function contextBlockers(policy, cursor, capture, checkpointCanonical) {
  const blockers = [];
  add(blockers, policy?.capture_mode !== 'legacy', 'legacy_policy_required');
  add(blockers, !cursor || cursor.checkpoint_block == null || !cursor.checkpoint_hash
    || BigInt(cursor.next_block) !== BigInt(cursor.checkpoint_block) + 1n,
  'holder_cursor_invalid');
  add(blockers, !capture || capture.checkpoint_block == null || cursor?.checkpoint_block == null
    || BigInt(capture.checkpoint_block) < BigInt(cursor.checkpoint_block),
  'canonical_capture_behind_holder');
  add(blockers, checkpointCanonical !== true, 'holder_checkpoint_not_canonical');
  add(blockers, cursor?.journal_floor_block == null || cursor?.buffer_floor_block == null,
    'legacy_floors_missing');
  return blockers;
}

function decodeRaw(row, from, through, checkpointHash) {
  return normalizeHolderTransfer(decodeTransferLog({
    blockNumber: String(row.block_number), blockHash: row.block_hash,
    transactionHash: row.transaction_hash, transactionIndex: row.transaction_index,
    logIndex: row.log_index, address: row.address, topics: row.topics, data: row.data,
  }, { tokenAddress: null, fromBlock: from, toBlock: through, checkpointHash }));
}

function decodeReceipt(row) {
  return Object.freeze({
    blockNumber: String(row.block_number), blockHash: row.block_hash,
    transferCount: Number(row.transfer_count), evidenceHash: row.evidence_hash,
  });
}

function compareReceipts(expected, actual) {
  const expectedByBlock = new Map(expected.map((receipt) => [receipt.blockNumber, receipt]));
  const actualByBlock = new Map(actual.map((receipt) => [receipt.blockNumber, receipt]));
  let missing = 0;
  let excess = 0;
  let divergent = 0;
  for (const [blockNumber, receipt] of expectedByBlock) {
    const stored = actualByBlock.get(blockNumber);
    if (!stored) missing += receipt.transferCount;
    else if (stored.blockHash !== receipt.blockHash
        || stored.transferCount !== receipt.transferCount
        || stored.evidenceHash !== receipt.evidenceHash) divergent += 1;
  }
  for (const [blockNumber, receipt] of actualByBlock) {
    if (!expectedByBlock.has(blockNumber)) excess += receipt.transferCount;
  }
  return { missing, excess, divergent };
}

async function recentParity(client, cursor) {
  const through = BigInt(cursor.checkpoint_block);
  const from = through >= SAMPLE_BLOCKS - 1n ? through - SAMPLE_BLOCKS + 1n : 0n;
  if (BigInt(cursor.journal_floor_block) > from || BigInt(cursor.buffer_floor_block) > from) {
    throw fail('recent_window_below_legacy_floor');
  }
  const blocks = (await client.query(
    `SELECT COUNT(*)::int AS total FROM robinhood_chain_blocks
      WHERE chain=$1 AND canonical=TRUE AND block_number BETWEEN $2::bigint AND $3::bigint`,
    [CHAIN, from.toString(), through.toString()]
  )).rows[0];
  if (Number(blocks?.total) !== Number(through - from + 1n)) {
    throw fail('recent_canonical_blocks_incomplete');
  }
  const raw = (await client.query(
    `SELECT event.block_number, event.block_hash, event.transaction_hash,
            event.transaction_index, event.log_index, event.address,
            event.topics, event.data
       FROM robinhood_chain_events event
       JOIN robinhood_chain_blocks block
         ON block.chain=event.chain AND block.block_hash=event.block_hash AND block.canonical=TRUE
      WHERE event.chain=$1 AND event.topic0=$4
        AND event.block_number BETWEEN $2::bigint AND $3::bigint
      ORDER BY event.block_number, event.transaction_index, event.log_index LIMIT $5`,
    [CHAIN, from.toString(), through.toString(), TRANSFER_TOPIC, MAX_EVENTS + 1]
  )).rows;
  if (!raw.length || raw.length > MAX_EVENTS) {
    throw fail('recent_sample_empty_or_over_limit');
  }
  const normalizedRaw = raw.map((row) => decodeRaw(row, from, through, cursor.checkpoint_hash));
  const expectedReceipts = buildHolderCaptureReceipts(normalizedRaw);
  const stored = (await client.query(
    `SELECT block_number, block_hash, transfer_count, evidence_hash
       FROM robinhood_holder_capture_receipts
      WHERE chain=$1 AND block_number BETWEEN $2::bigint AND $3::bigint
      ORDER BY block_number`,
    [CHAIN, from.toString(), through.toString()]
  )).rows;
  const receipts = stored.map(decodeReceipt);
  const compared = compareReceipts(expectedReceipts, receipts);
  return { fromBlock: from.toString(), throughBlock: through.toString(),
    rawTransfers: raw.length,
    journalTransfers: receipts.reduce((total, receipt) => total + receipt.transferCount, 0),
    receiptBlocks: receipts.length,
    missing: compared.missing, excess: compared.excess, divergent: compared.divergent };
}

async function coverage(client, holderCheckpoint) {
  const result = await client.query(
    `SELECT COUNT(*) FILTER (WHERE state.ledger_status IN ('live','shadow')
              AND state.tail_capture_from_block IS NULL)::int AS legacy_states,
            COUNT(*) FILTER (WHERE state.ledger_status IN ('live','shadow')
              AND state.tail_capture_from_block IS NULL
              AND (manifest.token_address IS NULL
                OR manifest.coverage_generation<>state.coverage_generation))::int
              AS missing_or_stale_manifest,
            COUNT(*) FILTER (WHERE state.ledger_status='backfilling'
              AND state.tail_capture_from_block IS NULL)::int AS legacy_backfilling,
            COUNT(*) FILTER (WHERE state.ledger_status IN ('backfilling','live','shadow')
              AND state.tail_capture_from_block IS NOT NULL AND (
                state.deployment_block IS NULL OR state.backfill_next_block IS NULL
                OR state.tail_capture_from_block < state.deployment_block
                OR state.backfill_next_block < state.deployment_block
                OR state.live_through_block > $2::bigint
                OR (state.ledger_status IN ('live','shadow') AND (
                  state.live_through_block IS NULL
                  OR state.backfill_next_block < state.tail_capture_from_block
                  OR state.live_through_block < state.tail_capture_from_block-1
                ))))::int AS incoherent_tail
       FROM robinhood_holder_token_states state
       LEFT JOIN robinhood_holder_legacy_coverage_manifest manifest
         ON manifest.chain=state.chain AND manifest.token_address=state.token_address
      WHERE state.chain=$1`, [CHAIN, holderCheckpoint]
  );
  const global = await client.query(
    `SELECT COUNT(*)::int AS active FROM robinhood_holder_global_backfill_tokens token
       JOIN robinhood_holder_global_backfill_runs run
         ON run.id=token.run_id AND run.chain=token.chain
      WHERE token.chain=$1 AND token.status='active' AND run.status<>'completed'`, [CHAIN]
  );
  const progress = await client.query(
    `SELECT completed_at IS NOT NULL AS complete
       FROM robinhood_holder_legacy_coverage_builds WHERE chain=$1`, [CHAIN]
  );
  return { ...result.rows[0], global_active: global.rows[0].active,
    manifest_pass_complete: progress.rows[0]?.complete === true };
}

function coverageBlockers(value) {
  const blockers = [];
  add(blockers, !value.manifest_pass_complete, 'manifest_pass_incomplete');
  add(blockers, Number(value.legacy_states) === 0, 'legacy_cohort_empty');
  add(blockers, Number(value.missing_or_stale_manifest) !== 0, 'manifest_incomplete');
  add(blockers, Number(value.legacy_backfilling) !== 0, 'legacy_backfilling_present');
  add(blockers, Number(value.incoherent_tail) !== 0, 'tail_incoherent');
  add(blockers, Number(value.global_active) !== 0, 'global_backfill_active');
  return blockers;
}

async function readContext(client, apply) {
  const lock = apply ? ' FOR UPDATE' : '';
  const cursor = (await client.query(
    `SELECT next_block, checkpoint_block, checkpoint_hash, version,
            journal_floor_block, buffer_floor_block
       FROM robinhood_holder_cursors
      WHERE chain=$1 AND stream='live'${lock}`, [CHAIN]
  )).rows[0];
  const policy = (await client.query(
    `SELECT capture_mode, coverage_generation, version
       FROM robinhood_holder_capture_policy WHERE chain=$1${lock}`, [CHAIN]
  )).rows[0];
  const capture = (await client.query(
    `SELECT checkpoint_block FROM robinhood_chain_capture_cursor WHERE chain=$1`, [CHAIN]
  )).rows[0];
  const canonical = cursor?.checkpoint_block == null ? false : (await client.query(
    `SELECT EXISTS (SELECT 1 FROM robinhood_chain_blocks
      WHERE chain=$1 AND canonical=TRUE AND block_number=$2::bigint
        AND block_hash=$3) AS matches`,
    [CHAIN, cursor.checkpoint_block, cursor.checkpoint_hash]
  )).rows[0].matches;
  return { cursor, policy, capture, canonical };
}

async function assess(client, context, retentionGuard) {
  const { cursor, policy, capture, canonical } = context;
  const blockers = contextBlockers(policy, cursor, capture, canonical);
  let stateCoverage = null;
  let parity = null;
  let protection = null;
  if (!blockers.length) {
    stateCoverage = await withPhase(
      'coverage', () => coverage(client, cursor.checkpoint_block)
    );
    blockers.push(...coverageBlockers(stateCoverage));
    try {
      parity = await withPhase('recent-parity', () => recentParity(client, cursor));
    } catch (error) {
      if (error.code !== 'holder_cutover_not_ready') throw error;
      blockers.push(error.reason);
    }
    if (parity && (parity.missing || parity.excess || parity.divergent)) {
      blockers.push('recent_parity_divergent');
    }
    try {
      protection = await withPhase('retention', () => retentionGuard.assertProtected(client, {
        nextBlock: String(cursor.next_block), checkpointBlock: String(cursor.checkpoint_block),
        checkpointHash: cursor.checkpoint_hash,
      }));
    } catch (error) {
      if (error.code !== 'holder_cutover_retention_unavailable') throw error;
      blockers.push(error.reason);
    }
  }
  return { blockers, stateCoverage, parity, protection };
}

async function applyCutover(client, context) {
  const { cursor, policy } = context;
  const updatedCursor = await client.query(
    `UPDATE robinhood_holder_cursors SET version=version+1, updated_at=NOW()
      WHERE chain=$1 AND stream='live' AND version=$2::bigint RETURNING version`,
    [CHAIN, cursor.version]
  );
  if (updatedCursor.rowCount !== 1) throw fail('cursor_changed');
  const updatedPolicy = await client.query(
    `UPDATE robinhood_holder_capture_policy SET capture_mode='tracked',
        coverage_generation=coverage_generation+1,
        cutover_next_block=$2::bigint, cutover_checkpoint_block=$3::bigint,
        cutover_checkpoint_hash=$4, version=version+1, updated_at=NOW()
      WHERE chain=$1 AND version=$5::bigint AND capture_mode='legacy'
      RETURNING version`,
    [CHAIN, cursor.next_block, cursor.checkpoint_block, cursor.checkpoint_hash,
      policy.version]
  );
  if (updatedPolicy.rowCount !== 1) throw fail('policy_changed');
}

function createRobinhoodHolderCutoverGate(options = {}) {
  const database = options.database || db;
  const retentionGuard = options.retentionGuard || createRobinhoodHolderCutoverRetention();

  async function inspect(input = {}) {
    const apply = input.apply === true;
    const statementTimeoutMs = statementTimeout(input.statementTimeoutMs);
    const client = await database.getClient();
    try {
      await client.query(apply ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      if (apply) await acquireRobinhoodHolderReorgFence(client, 'shared');
      const context = await withPhase('context', () => readContext(client, apply));
      const { blockers, stateCoverage, parity, protection } = await assess(
        client, context, retentionGuard
      );
      if (apply) {
        if (blockers.length) throw fail(blockers[0]);
        if (String(input.expectedNextBlock) !== String(context.cursor.next_block)
            || String(input.expectedCheckpointHash) !== context.cursor.checkpoint_hash) {
          throw fail('expected_anchor_changed_or_missing');
        }
        await withPhase('apply', () => applyCutover(client, context));
        await client.query('COMMIT');
      } else await client.query('ROLLBACK');
      const { cursor, policy } = context;
      return Object.freeze({ mode: apply ? 'apply' : 'read-only',
        readyForGate: blockers.length === 0, blockers,
        snapshot: { nextBlock: cursor == null ? null : String(cursor.next_block),
          checkpointBlock: cursor?.checkpoint_block == null
            ? null : String(cursor.checkpoint_block), checkpointHash: cursor?.checkpoint_hash,
          policyVersion: policy == null ? null : String(policy.version) },
        coverage: stateCoverage, recentParity: parity,
        recoveryWindowUntil: protection?.recoveryWindowUntil || null });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ inspect });
}

module.exports = {
  createRobinhoodHolderCutoverGate,
  __private: { statementTimeout },
};

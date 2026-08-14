const db = require('./db');
const { dayBounds, partitionName } = require('./robinhood-token-transfer-persistence');

const CHAIN = 'robinhood';
const STREAM = 'live';
const EDGE_KINDS = ['wallet_transfer', 'dex_flow'];

function identifier(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}
function hash(value) {
  const result = String(value ?? '').trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(result) ? result : null;
}
function rowSnapshot(raw, summary, transferCursor, positionCursor) {
  return {
    rawEventCount: String(raw.raw_event_count),
    targetClassifiedEventCount: String(raw.target_classified_event_count),
    eligibleTransferCount: String(raw.eligible_transfer_count),
    eligibleAmountRaw: String(raw.eligible_amount_raw),
    summaryTransferCount: String(summary.summary_transfer_count),
    summaryAmountRaw: String(summary.summary_amount_raw),
    summaryMismatchCount: Number(summary.mismatch_count),
    rawLastBlock: raw.raw_last_block == null ? null : String(raw.raw_last_block),
    rawLastTransactionIndex: raw.raw_last_transaction_index,
    rawLastLogIndex: raw.raw_last_log_index,
    transferCursor: transferCursor || null,
    positionCursor: positionCursor || null,
  };
}
async function readAuditSnapshot(database, input) {
  const client = await database.getClient();
  const { from, to } = dayBounds(input.partitionDay);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const partition = await client.query(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [partitionName(input.partitionDay)]
    );
    const raw = await client.query(
        `SELECT COUNT(*)::text AS raw_event_count,
                COUNT(*) FILTER (WHERE classification_version = $4)::text
                  AS target_classified_event_count,
                COUNT(*) FILTER (WHERE classification_version = $4
                  AND transfer_kind = ANY($5::text[]))::text AS eligible_transfer_count,
                COALESCE(SUM(amount_raw) FILTER (WHERE classification_version = $4
                  AND transfer_kind = ANY($5::text[])), 0)::text AS eligible_amount_raw,
                (ARRAY_AGG(block_number ORDER BY block_number DESC,
                  transaction_index DESC, log_index DESC))[1] AS raw_last_block,
                (ARRAY_AGG(transaction_index ORDER BY block_number DESC,
                  transaction_index DESC, log_index DESC))[1] AS raw_last_transaction_index,
                (ARRAY_AGG(log_index ORDER BY block_number DESC,
                  transaction_index DESC, log_index DESC))[1] AS raw_last_log_index
         FROM robinhood_token_transfer_events
         WHERE chain = $1 AND block_time >= $2::timestamptz AND block_time < $3::timestamptz`,
        [CHAIN, from, to, input.projectionVersion, EDGE_KINDS]
    );
    const summary = await client.query(
        `WITH raw AS (
           SELECT token_address, COUNT(*)::bigint AS transfer_count,
                  COALESCE(SUM(amount_raw), 0) AS total_amount_raw
           FROM robinhood_token_transfer_events
           WHERE chain = $1 AND block_time >= $2::timestamptz AND block_time < $3::timestamptz
             AND classification_version = $4 AND transfer_kind = ANY($5::text[])
           GROUP BY token_address
         ), summarized AS (
           SELECT token_address, transfer_count, total_amount_raw
           FROM robinhood_wallet_transfer_daily_summaries
           WHERE chain = $1 AND projection_version = $4 AND summary_day = $6::date
         )
         SELECT COALESCE(SUM(summarized.transfer_count), 0)::text AS summary_transfer_count,
                COALESCE(SUM(summarized.total_amount_raw), 0)::text AS summary_amount_raw,
                COUNT(*) FILTER (WHERE raw.token_address IS NULL OR summarized.token_address IS NULL
                  OR raw.transfer_count <> summarized.transfer_count
                  OR raw.total_amount_raw <> summarized.total_amount_raw)::integer AS mismatch_count
         FROM raw FULL JOIN summarized USING (token_address)`,
        [CHAIN, from, to, input.projectionVersion, EDGE_KINDS, input.partitionDay]
    );
    const transferCursor = await client.query(
        `SELECT next_block::text, next_transaction_index, next_log_index,
                next_block_time, checkpoint_block::text, checkpoint_hash, lifecycle_state
         FROM robinhood_wallet_transfer_cursors
         WHERE chain = $1 AND projection_version = $2 AND stream = $3`,
        [CHAIN, input.projectionVersion, STREAM]
    );
    const positionCursor = await client.query(
        `SELECT next_block::text, lifecycle_state
         FROM robinhood_wallet_position_cursors
         WHERE chain = $1 AND projection_version = $2 AND stream = $3`,
        [CHAIN, input.positionProjectionVersion, STREAM]
    );
    await client.query('COMMIT');
    return {
      partitionPresent: Boolean(partition.rows[0]?.present),
      ...rowSnapshot(raw.rows[0], summary.rows[0], transferCursor.rows[0], positionCursor.rows[0]),
      dayEnd: to,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
function positionAfterRaw(cursor, rawLastBlock) {
  return Boolean(cursor && ['running', 'complete'].includes(cursor.lifecycle_state)
    && (rawLastBlock === null || BigInt(cursor.next_block) > BigInt(rawLastBlock)));
}
function transferAfterDay(cursor, dayEnd) {
  return Boolean(cursor && ['running', 'complete'].includes(cursor.lifecycle_state)
    && new Date(cursor.next_block_time).toISOString() >= dayEnd);
}
async function evaluateSnapshot(snapshot, input, loadCanonicalBlockHash) {
  const summaryReconciled = snapshot.summaryMismatchCount === 0
    && snapshot.summaryTransferCount === snapshot.eligibleTransferCount
    && snapshot.summaryAmountRaw === snapshot.eligibleAmountRaw;
  const classificationComplete = snapshot.targetClassifiedEventCount === snapshot.rawEventCount;
  const cursorComplete = transferAfterDay(snapshot.transferCursor, snapshot.dayEnd);
  const positionComplete = positionAfterRaw(snapshot.positionCursor, snapshot.rawLastBlock);
  const storedHash = hash(snapshot.transferCursor?.checkpoint_hash);
  const canonicalHash = storedHash && snapshot.transferCursor?.checkpoint_block != null
    ? hash(await loadCanonicalBlockHash(String(snapshot.transferCursor.checkpoint_block))) : null;
  const checkpointCanonical = storedHash !== null && canonicalHash === storedHash;
  const gates = {
    summaryReconciled, positionComplete, evidenceComplete: summaryReconciled,
    cursorComplete, checkpointCanonical,
  };
  const reasons = [
    !snapshot.partitionPresent && 'partition_missing',
    !classificationComplete && 'classification_incomplete',
    !summaryReconciled && 'summary_mismatch',
    !positionComplete && 'position_incomplete',
    !cursorComplete && 'cursor_incomplete',
    !checkpointCanonical && 'checkpoint_noncanonical',
  ].filter(Boolean);
  return { ...snapshot, ...gates, classificationComplete, lifecycleState: reasons.length ? 'blocked' : 'verified',
    stateReason: reasons.join(',') || null, ...input };
}
function persistenceRow(audit) {
  const cursor = audit.transferCursor || {};
  return {
    projection_version: audit.projectionVersion, partition_day: audit.partitionDay,
    lifecycle_state: audit.lifecycleState, state_reason: audit.stateReason,
    raw_event_count: audit.rawEventCount,
    target_classified_event_count: audit.targetClassifiedEventCount,
    eligible_transfer_count: audit.eligibleTransferCount, eligible_amount_raw: audit.eligibleAmountRaw,
    summary_transfer_count: audit.summaryTransferCount, summary_amount_raw: audit.summaryAmountRaw,
    raw_last_block: audit.rawLastBlock, raw_last_transaction_index: audit.rawLastTransactionIndex,
    raw_last_log_index: audit.rawLastLogIndex, cursor_next_block: cursor.next_block || null,
    cursor_next_transaction_index: cursor.next_transaction_index ?? null,
    cursor_next_log_index: cursor.next_log_index ?? null, cursor_next_block_time: cursor.next_block_time || null,
    checkpoint_block: cursor.checkpoint_block || null, checkpoint_hash: cursor.checkpoint_hash || null,
    position_projection_version: audit.positionCursor ? audit.positionProjectionVersion : null,
    position_next_block: audit.positionCursor?.next_block || null,
    summary_reconciled: audit.summaryReconciled, position_complete: audit.positionComplete,
    evidence_complete: audit.evidenceComplete, cursor_complete: audit.cursorComplete,
    checkpoint_canonical: audit.checkpointCanonical,
  };
}
async function persistAudit(database, audit) {
  const row = persistenceRow(audit);
  const result = await database.query(
    `INSERT INTO robinhood_wallet_transfer_compaction_watermarks (
       chain, projection_version, partition_day, lifecycle_state, state_reason,
       raw_event_count, target_classified_event_count, eligible_transfer_count,
       eligible_amount_raw, summary_transfer_count, summary_amount_raw,
       raw_last_block, raw_last_transaction_index, raw_last_log_index,
       cursor_next_block, cursor_next_transaction_index, cursor_next_log_index,
       cursor_next_block_time, checkpoint_block, checkpoint_hash,
       position_projection_version, position_next_block, summary_reconciled,
       position_complete, evidence_complete, cursor_complete, checkpoint_canonical,
       audited_at, verified_at
     ) SELECT $1, item.*, NOW(), CASE WHEN item.lifecycle_state = 'verified' THEN NOW() END
       FROM jsonb_to_record($2::jsonb) AS item(
         projection_version text, partition_day date, lifecycle_state text, state_reason text,
         raw_event_count bigint, target_classified_event_count bigint, eligible_transfer_count bigint,
         eligible_amount_raw numeric, summary_transfer_count bigint, summary_amount_raw numeric,
         raw_last_block bigint, raw_last_transaction_index int, raw_last_log_index int,
         cursor_next_block bigint, cursor_next_transaction_index int, cursor_next_log_index int,
         cursor_next_block_time timestamptz, checkpoint_block bigint, checkpoint_hash text,
         position_projection_version text, position_next_block bigint, summary_reconciled boolean,
         position_complete boolean, evidence_complete boolean, cursor_complete boolean,
         checkpoint_canonical boolean
       ) ON CONFLICT (chain, projection_version, partition_day) DO UPDATE SET
         lifecycle_state = EXCLUDED.lifecycle_state, state_reason = EXCLUDED.state_reason,
         raw_event_count = EXCLUDED.raw_event_count,
         target_classified_event_count = EXCLUDED.target_classified_event_count,
         eligible_transfer_count = EXCLUDED.eligible_transfer_count,
         eligible_amount_raw = EXCLUDED.eligible_amount_raw,
         summary_transfer_count = EXCLUDED.summary_transfer_count,
         summary_amount_raw = EXCLUDED.summary_amount_raw,
         raw_last_block = EXCLUDED.raw_last_block,
         raw_last_transaction_index = EXCLUDED.raw_last_transaction_index,
         raw_last_log_index = EXCLUDED.raw_last_log_index,
         cursor_next_block = EXCLUDED.cursor_next_block,
         cursor_next_transaction_index = EXCLUDED.cursor_next_transaction_index,
         cursor_next_log_index = EXCLUDED.cursor_next_log_index,
         cursor_next_block_time = EXCLUDED.cursor_next_block_time,
         checkpoint_block = EXCLUDED.checkpoint_block, checkpoint_hash = EXCLUDED.checkpoint_hash,
         position_projection_version = EXCLUDED.position_projection_version,
         position_next_block = EXCLUDED.position_next_block,
         summary_reconciled = EXCLUDED.summary_reconciled,
         position_complete = EXCLUDED.position_complete,
         evidence_complete = EXCLUDED.evidence_complete, cursor_complete = EXCLUDED.cursor_complete,
         checkpoint_canonical = EXCLUDED.checkpoint_canonical, audited_at = NOW(),
         verified_at = EXCLUDED.verified_at, version =
           robinhood_wallet_transfer_compaction_watermarks.version + 1, updated_at = NOW()
       WHERE robinhood_wallet_transfer_compaction_watermarks.lifecycle_state <> 'dropped'
       RETURNING lifecycle_state, state_reason, version::text`,
    [CHAIN, JSON.stringify(row)]
  );
  return result.rows[0] || { lifecycle_state: 'dropped', state_reason: null, version: null };
}
function createRobinhoodWalletTransferCompactionAuditor(options = {}) {
  const database = options.database || db;
  const loadCanonicalBlockHash = options.loadCanonicalBlockHash;
  if (typeof loadCanonicalBlockHash !== 'function') throw new Error('loadCanonicalBlockHash is required');
  async function auditDay(input = {}) {
    const normalized = {
      projectionVersion: identifier(input.projectionVersion, 'projectionVersion'),
      positionProjectionVersion: identifier(input.positionProjectionVersion, 'positionProjectionVersion'),
      partitionDay: dayBounds(input.partitionDay).from.slice(0, 10),
    };
    if (normalized.positionProjectionVersion === 'swap_only_v1') {
      throw new Error('swap_only_v1 cannot prove transfer-adjusted positions');
    }
    const snapshot = await readAuditSnapshot(database, normalized);
    const audit = await evaluateSnapshot(snapshot, normalized, loadCanonicalBlockHash);
    return { audit, watermark: await persistAudit(database, audit) };
  }
  return { auditDay };
}

module.exports = { createRobinhoodWalletTransferCompactionAuditor };

'use strict';

const db = require('./db');

const CHAIN = 'robinhood';

function positiveInt(value, label, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function cursor(value) {
  if (value == null) return { transactionHash: null, logIndex: null };
  const transactionHash = String(value.transactionHash || '').toLowerCase();
  const logIndex = String(value.logIndex ?? '');
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash) || !/^\d+$/.test(logIndex)) {
    throw new Error('capture state cursor is invalid');
  }
  return { transactionHash, logIndex };
}

function maintenanceLag(row, maxLagBlocks) {
  if (row?.capture_next_block == null) throw new Error('canonical cursor is unavailable');
  const next = BigInt(row.capture_next_block);
  const capturedThrough = next > 0n ? next - 1n : 0n;
  const first = row.first_unsettled_block == null ? null : BigInt(row.first_unsettled_block);
  if (first != null && (first < 0n || first > next)) throw new Error('canonical frontier is invalid');
  const canonicalThrough = first == null ? capturedThrough : (first > 0n ? first - 1n : 0n);
  const lag = capturedThrough > canonicalThrough ? capturedThrough - canonicalThrough : 0n;
  if (lag > BigInt(maxLagBlocks)) {
    throw new Error(`canonical lag ${lag} exceeds backfill limit ${maxLagBlocks}`);
  }
  return lag.toString();
}

function createRobinhoodHeadCaptureStateRepository(options = {}) {
  const database = options.database || db;

  async function assertMirrorReady() {
    const result = await database.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_trigger trigger
         JOIN pg_proc function ON function.oid=trigger.tgfoid
        WHERE trigger.tgrelid='robinhood_head_captures'::regclass
          AND trigger.tgname='rh_head_capture_state_sync'
          AND function.proname='sync_robinhood_head_capture_state'
          AND trigger.tgenabled<>'D' AND NOT trigger.tgisinternal
       ) AS ready`
    );
    if (result.rows[0]?.ready !== true) {
      throw new Error('Stage 224 head capture state mirror is unavailable');
    }
  }

  async function assertMaintenanceAllowed(maxLagBlocks = 128) {
    const result = await database.query(
      `SELECT capture.next_block AS capture_next_block,
              (SELECT block_number FROM robinhood_chain_domain_outbox
                WHERE chain=$1 AND status<>'complete'
                ORDER BY block_number LIMIT 1) AS first_unsettled_block
         FROM robinhood_chain_capture_cursor capture WHERE capture.chain=$1`, [CHAIN]
    );
    return maintenanceLag(result.rows[0], maxLagBlocks);
  }

  async function processBatch(input = {}) {
    const limit = positiveInt(input.limit, 'limit', 5_000);
    const statementTimeoutMs = positiveInt(
      input.statementTimeoutMs || 30_000, 'statementTimeoutMs', 300_000
    );
    const after = cursor(input.after);
    const write = input.write === true;
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${statementTimeoutMs}ms`,
      ]);
      const copied = await client.query(
        `WITH batch AS MATERIALIZED (
           SELECT capture.chain, capture.transaction_hash, capture.log_index,
                  capture.processing_status, capture.lease_owner, capture.lease_until,
                  capture.attempt_count, capture.next_attempt_at, capture.last_error,
                  capture.terminal_at, capture.retention_eligible_at,
                  capture.created_at, capture.updated_at
             FROM robinhood_head_captures capture
            WHERE capture.chain=$1
              AND ($2::text IS NULL OR (capture.transaction_hash, capture.log_index)
                    > ($2::text, $3::bigint))
            ORDER BY capture.transaction_hash, capture.log_index
            LIMIT $4
         ), inserted AS (
           INSERT INTO robinhood_head_capture_states(
             chain, transaction_hash, log_index, processing_status,
             lease_owner, lease_until, attempt_count, next_attempt_at,
             last_error, terminal_at, retention_eligible_at, created_at, updated_at
           )
           SELECT chain, transaction_hash, log_index, processing_status,
                  lease_owner, lease_until, attempt_count, next_attempt_at,
                  last_error, terminal_at, retention_eligible_at, created_at, updated_at
             FROM batch WHERE $5::boolean
           ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING
           RETURNING 1
         )
         SELECT COUNT(*)::int AS scanned,
                (SELECT COUNT(*)::int FROM inserted) AS inserted,
                (SELECT transaction_hash FROM batch
                  ORDER BY transaction_hash DESC, log_index DESC LIMIT 1) AS last_hash,
                (SELECT log_index::text FROM batch
                  ORDER BY transaction_hash DESC, log_index DESC LIMIT 1) AS last_log_index
           FROM batch`,
        [CHAIN, after.transactionHash, after.logIndex, limit, write]
      );
      const progress = copied.rows[0];
      const next = progress.last_hash == null ? after : {
        transactionHash: progress.last_hash,
        logIndex: progress.last_log_index,
      };
      let parity = { checked: 0, missing: 0, divergent: 0 };
      if (Number(progress.scanned) > 0) {
        const compared = await client.query(
          `SELECT COUNT(*)::int AS checked,
                  COUNT(*) FILTER (WHERE state.transaction_hash IS NULL)::int AS missing,
                  COUNT(*) FILTER (WHERE state.transaction_hash IS NOT NULL AND (
                    state.processing_status IS DISTINCT FROM capture.processing_status
                    OR state.lease_owner IS DISTINCT FROM capture.lease_owner
                    OR state.lease_until IS DISTINCT FROM capture.lease_until
                    OR state.attempt_count IS DISTINCT FROM capture.attempt_count
                    OR state.next_attempt_at IS DISTINCT FROM capture.next_attempt_at
                    OR state.last_error IS DISTINCT FROM capture.last_error
                    OR state.terminal_at IS DISTINCT FROM capture.terminal_at
                    OR state.retention_eligible_at IS DISTINCT FROM capture.retention_eligible_at
                    OR state.created_at IS DISTINCT FROM capture.created_at
                    OR state.updated_at IS DISTINCT FROM capture.updated_at
                  ))::int AS divergent
             FROM robinhood_head_captures capture
             LEFT JOIN robinhood_head_capture_states state
               USING (chain, transaction_hash, log_index)
            WHERE capture.chain=$1
              AND ($2::text IS NULL OR (capture.transaction_hash, capture.log_index)
                    > ($2::text, $3::bigint))
              AND (capture.transaction_hash, capture.log_index)
                    <= ($4::text, $5::bigint)`,
          [CHAIN, after.transactionHash, after.logIndex,
            next.transactionHash, next.logIndex]
        );
        parity = compared.rows[0];
      }
      if (Number(parity.missing) > 0 || Number(parity.divergent) > 0) {
        await client.query('ROLLBACK');
        return {
          scanned: Number(progress.scanned), inserted: 0,
          checked: Number(parity.checked), missing: Number(parity.missing),
          divergent: Number(parity.divergent), next: after, complete: false,
        };
      }
      await client.query('COMMIT');
      return {
        scanned: Number(progress.scanned), inserted: Number(progress.inserted),
        checked: Number(parity.checked), missing: 0, divergent: 0, next,
        complete: Number(progress.scanned) < limit,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ assertMaintenanceAllowed, assertMirrorReady, processBatch });
}

module.exports = {
  createRobinhoodHeadCaptureStateRepository,
  __private: { maintenanceLag },
};

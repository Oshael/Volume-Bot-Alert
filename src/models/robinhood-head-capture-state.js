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

function heapBlock(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return parsed;
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

  async function describePhysicalSource() {
    const result = await database.query(
      `SELECT pg_relation_filenode('robinhood_head_captures'::regclass)::text
                AS relation_file_node,
              CEIL(pg_relation_size('robinhood_head_captures'::regclass)::numeric
                / current_setting('block_size')::numeric)::bigint::text AS heap_blocks`
    );
    return {
      relationFileNode: result.rows[0].relation_file_node,
      heapBlocks: Number(result.rows[0].heap_blocks),
    };
  }

  async function assertRoutingMirrorReady() {
    const result = await database.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_trigger trigger
         JOIN pg_proc function ON function.oid=trigger.tgfoid
        WHERE trigger.tgrelid='robinhood_head_captures'::regclass
          AND trigger.tgname='rh_head_capture_state_sync'
          AND trigger.tgenabled<>'D' AND NOT trigger.tgisinternal
          AND pg_get_functiondef(function.oid) LIKE '%NEW.market_key%'
       ) AS ready`
    );
    if (result.rows[0]?.ready !== true) {
      throw new Error('Stage 224 routing mirror is unavailable');
    }
  }

  async function describeRoutingPhysicalSource() {
    const result = await database.query(
      `SELECT pg_relation_filenode('robinhood_head_capture_states'::regclass)::text
                AS relation_file_node,
              CEIL(pg_relation_size('robinhood_head_capture_states'::regclass)::numeric
                / current_setting('block_size')::numeric)::bigint::text AS heap_blocks`
    );
    return {
      relationFileNode: result.rows[0].relation_file_node,
      heapBlocks: Number(result.rows[0].heap_blocks),
    };
  }

  async function processRoutingPhysicalBatch(input = {}) {
    const startBlock = heapBlock(input.startBlock ?? 0, 'startBlock');
    const endBlock = heapBlock(input.endBlock, 'endBlock');
    if (endBlock <= startBlock) throw new Error('endBlock must be greater than startBlock');
    const statementTimeoutMs = positiveInt(
      input.statementTimeoutMs || 30_000, 'statementTimeoutMs', 300_000
    );
    const write = input.write === true;
    const lock = write ? 'FOR UPDATE OF state' : '';
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${statementTimeoutMs}ms`,
      ]);
      const result = await client.query(
        `WITH candidates AS MATERIALIZED (
           SELECT state.ctid AS state_tid, state.chain, state.transaction_hash,
                  state.log_index, capture.stream, capture.protocol,
                  capture.market_key, capture.block_number, capture.transaction_index
             FROM robinhood_head_capture_states state
             JOIN robinhood_head_captures capture
               USING (chain, transaction_hash, log_index)
            WHERE state.ctid >= $1::tid AND state.ctid < $2::tid
              AND state.processing_status IN ('pending', 'leased', 'blocked')
              AND (state.stream IS DISTINCT FROM capture.stream
                OR state.protocol IS DISTINCT FROM capture.protocol
                OR state.market_key IS DISTINCT FROM capture.market_key
                OR state.block_number IS DISTINCT FROM capture.block_number
                OR state.transaction_index IS DISTINCT FROM capture.transaction_index)
            ${lock}
         ), updated AS (
           UPDATE robinhood_head_capture_states state
              SET stream = candidate.stream, protocol = candidate.protocol,
                  market_key = candidate.market_key,
                  block_number = candidate.block_number,
                  transaction_index = candidate.transaction_index
             FROM candidates candidate
            WHERE $3::boolean AND state.ctid = candidate.state_tid
              AND state.chain = candidate.chain
              AND state.transaction_hash = candidate.transaction_hash
              AND state.log_index = candidate.log_index
           RETURNING state.stream IS NOT DISTINCT FROM candidate.stream
             AND state.protocol IS NOT DISTINCT FROM candidate.protocol
             AND state.market_key IS NOT DISTINCT FROM candidate.market_key
             AND state.block_number IS NOT DISTINCT FROM candidate.block_number
             AND state.transaction_index IS NOT DISTINCT FROM candidate.transaction_index
               AS matches
         )
         SELECT (SELECT COUNT(*)::int FROM candidates) AS candidates,
                (SELECT COUNT(*)::int FROM updated) AS updated,
                (SELECT COUNT(*)::int FROM updated WHERE NOT matches) AS divergent`,
        [`(${startBlock},0)`, `(${endBlock},0)`, write]
      );
      const progress = result.rows[0];
      if (write && (Number(progress.updated) !== Number(progress.candidates)
          || Number(progress.divergent) > 0)) {
        throw new Error('head routing backfill parity failed');
      }
      await client.query('COMMIT');
      return {
        startBlock, endBlock, candidates: Number(progress.candidates),
        updated: Number(progress.updated), divergent: Number(progress.divergent),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function auditRoutingPhysicalBatch(input = {}) {
    const startBlock = heapBlock(input.startBlock ?? 0, 'startBlock');
    const endBlock = heapBlock(input.endBlock, 'endBlock');
    if (endBlock <= startBlock) throw new Error('endBlock must be greater than startBlock');
    const statementTimeoutMs = positiveInt(
      input.statementTimeoutMs || 30_000, 'statementTimeoutMs', 300_000
    );
    const client = await database.getClient();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${statementTimeoutMs}ms`,
      ]);
      const result = await client.query(
        `WITH active AS MATERIALIZED (
           SELECT chain, transaction_hash, log_index, stream, protocol,
                  market_key, block_number, transaction_index
             FROM robinhood_head_capture_states
            WHERE ctid >= $1::tid AND ctid < $2::tid
              AND processing_status IN ('pending', 'leased', 'blocked')
         )
         SELECT COUNT(*)::int AS active,
                COUNT(*) FILTER (WHERE capture.transaction_hash IS NULL)::int
                  AS missing_payload,
                COUNT(*) FILTER (WHERE capture.transaction_hash IS NOT NULL AND (
                  active.stream IS DISTINCT FROM capture.stream
                  OR active.protocol IS DISTINCT FROM capture.protocol
                  OR active.market_key IS DISTINCT FROM capture.market_key
                  OR active.block_number IS DISTINCT FROM capture.block_number
                  OR active.transaction_index IS DISTINCT FROM capture.transaction_index
                ))::int AS divergent,
                COUNT(*) FILTER (WHERE active.stream IS NULL
                  OR active.block_number IS NULL OR active.transaction_index IS NULL
                  OR (active.protocol = 'uniswap-v4' AND active.market_key IS NULL))::int
                  AS incomplete
           FROM active LEFT JOIN robinhood_head_captures capture
             USING (chain, transaction_hash, log_index)`,
        [`(${startBlock},0)`, `(${endBlock},0)`]
      );
      await client.query('COMMIT');
      return {
        startBlock, endBlock,
        active: Number(result.rows[0].active),
        missingPayload: Number(result.rows[0].missing_payload),
        divergent: Number(result.rows[0].divergent),
        incomplete: Number(result.rows[0].incomplete),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function processPhysicalBatch(input = {}) {
    const startBlock = heapBlock(input.startBlock ?? 0, 'startBlock');
    const endBlock = heapBlock(input.endBlock, 'endBlock');
    if (endBlock <= startBlock) throw new Error('endBlock must be greater than startBlock');
    const statementTimeoutMs = positiveInt(
      input.statementTimeoutMs || 30_000, 'statementTimeoutMs', 300_000
    );
    const write = input.write === true;
    const parentLock = write ? 'FOR KEY SHARE OF capture' : '';
    const tids = [`(${startBlock},0)`, `(${endBlock},0)`];
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
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
            WHERE capture.ctid >= $1::tid AND capture.ctid < $2::tid
            ${parentLock}
         ), inserted AS (
           INSERT INTO robinhood_head_capture_states(
             chain, transaction_hash, log_index, processing_status,
             lease_owner, lease_until, attempt_count, next_attempt_at,
             last_error, terminal_at, retention_eligible_at, created_at, updated_at
           )
           SELECT chain, transaction_hash, log_index, processing_status,
                  lease_owner, lease_until, attempt_count, next_attempt_at,
                  last_error, terminal_at, retention_eligible_at, created_at, updated_at
             FROM batch WHERE $3::boolean
           ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING
           RETURNING 1
         )
         SELECT COUNT(*)::int AS scanned,
                (SELECT COUNT(*)::int FROM inserted) AS inserted
           FROM batch`,
        [...tids, write]
      );
      let parity = { checked: 0, missing: 0, divergent: 0 };
      if (Number(copied.rows[0].scanned) > 0) {
        parity = (await client.query(
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
            WHERE capture.ctid >= $1::tid AND capture.ctid < $2::tid`, tids
        )).rows[0];
      }
      if (Number(parity.missing) > 0 || Number(parity.divergent) > 0) {
        await client.query('ROLLBACK');
        return {
          startBlock, endBlock, scanned: Number(copied.rows[0].scanned), inserted: 0,
          checked: Number(parity.checked), missing: Number(parity.missing),
          divergent: Number(parity.divergent),
        };
      }
      await client.query('COMMIT');
      return {
        startBlock, endBlock, scanned: Number(copied.rows[0].scanned),
        inserted: Number(copied.rows[0].inserted), checked: Number(parity.checked),
        missing: 0, divergent: 0,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function processBatch(input = {}) {
    const limit = positiveInt(input.limit, 'limit', 5_000);
    const statementTimeoutMs = positiveInt(
      input.statementTimeoutMs || 30_000, 'statementTimeoutMs', 300_000
    );
    const after = cursor(input.after);
    const write = input.write === true;
    const parentLock = write ? 'FOR KEY SHARE OF capture' : '';
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
            ${parentLock}
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

  return Object.freeze({
    assertMaintenanceAllowed, assertMirrorReady, assertRoutingMirrorReady,
    auditRoutingPhysicalBatch, describePhysicalSource, describeRoutingPhysicalSource,
    processBatch, processPhysicalBatch, processRoutingPhysicalBatch,
  });
}

module.exports = {
  createRobinhoodHeadCaptureStateRepository,
  __private: { maintenanceLag },
};

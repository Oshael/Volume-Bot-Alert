const db = require('./db');
const CHAIN = 'robinhood';
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}
function owner(value) {
  const parsed = String(value ?? '').trim();
  if (!parsed || parsed.length > 128) throw new Error('owner is invalid');
  return parsed;
}
function errorDetails(error) {
  const code = String(error?.code || 'range_failed').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(code)) throw new Error('error.code is invalid');
  return { code, message: String(error?.message || code).trim().slice(0, 500) };
}
function dayBounds(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('blockTime is invalid');
  const day = date.toISOString().slice(0, 10);
  const from = new Date(`${day}T00:00:00.000Z`);
  return Object.freeze({ name: `robinhood_native_funding_events_${day.replace(/-/g, '_')}`,
    from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() });
}
function runRow(row) {
  return row && Object.freeze({
    id: String(row.id), status: row.status, ruleVersion: row.rule_version,
    evidenceVersion: row.evidence_version, sourceFromBlock: String(row.source_from_block),
    sourceThroughBlock: String(row.source_through_block), sourceThroughHash: row.source_through_hash,
    lookbackBlocks: String(row.lookback_blocks), batchBlocks: Number(row.batch_blocks),
    concurrency: Number(row.concurrency), candidateCount: Number(row.candidate_count),
    rangeCount: Number(row.range_count), blocksTotal: String(row.blocks_total),
  });
}
function rangeRow(row, candidates = []) {
  return row && Object.freeze({
    runId: String(row.run_id), rangeIndex: Number(row.range_index), status: row.status,
    fromBlock: String(row.from_block), throughBlock: String(row.through_block),
    attemptCount: Number(row.attempt_count), leaseOwner: row.lease_owner,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({
      tokenAddress: candidate.token_address, walletAddress: candidate.wallet_address,
      launchBlock: String(candidate.launch_block), firstBuyBlock: String(candidate.first_buy_block),
      firstBuyTransactionIndex: String(candidate.first_buy_transaction_index),
    }))),
  });
}
function createRobinhoodBundleFundingBackfillRepository(options = {}) {
  const database = options.database || db;
  async function createRun(input = {}) {
    const { plan, preflight } = input;
    if (!preflight?.approved || preflight.checkpointCanonical !== true) {
      throw new Error('bundle funding preflight is not approved');
    }
    if (!plan?.candidates?.length || !plan?.ranges?.length) {
      throw new Error('bundle funding plan is empty');
    }
    if (String(plan.sourceThroughBlock) !== String(preflight.sourceThroughBlock)) {
      throw new Error('bundle funding plan does not match preflight frontier');
    }
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE robinhood_bundle_funding_backfill_runs IN SHARE ROW EXCLUSIVE MODE');
      const inserted = await client.query(
        `INSERT INTO robinhood_bundle_funding_backfill_runs (
           chain, rule_version, source_from_block, source_through_block,
           source_through_hash, lookback_blocks, batch_blocks, concurrency,
           candidate_count, range_count, blocks_total, status, started_at
         ) VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6::bigint, $7, $8,
                   $9, $10, $11::bigint, 'running', NOW()) RETURNING *`,
        [CHAIN, plan.ruleVersion, plan.sourceFromBlock, plan.sourceThroughBlock,
          preflight.sourceThroughHash, plan.lookbackBlocks, preflight.batchBlocks,
          preflight.concurrency, plan.candidates.length, plan.ranges.length,
          plan.blocksToScan]
      );
      const run = inserted.rows[0];
      const candidates = plan.candidates;
      const frozenCandidates = await client.query(
        `INSERT INTO robinhood_bundle_funding_backfill_candidates (
           run_id, token_address, wallet_address, launch_block,
           first_buy_block, first_buy_transaction_index
         ) SELECT $1, item.* FROM UNNEST(
           $2::varchar[], $3::varchar[], $4::bigint[], $5::bigint[], $6::integer[]
         ) AS item(token_address, wallet_address, launch_block,
                   first_buy_block, first_buy_transaction_index) RETURNING 1`,
        [run.id, candidates.map((item) => item.tokenAddress),
          candidates.map((item) => item.walletAddress),
          candidates.map((item) => item.launchBlock),
          candidates.map((item) => item.firstBuyBlock),
          candidates.map((item) => item.firstBuyTransactionIndex)]
      );
      const frozenRanges = await client.query(
        `INSERT INTO robinhood_bundle_funding_backfill_ranges (
           run_id, range_index, from_block, through_block
         ) SELECT $1, index - 1, item.from_block, item.through_block
             FROM UNNEST($2::bigint[], $3::bigint[]) WITH ORDINALITY
               AS item(from_block, through_block, index) RETURNING 1`,
        [run.id, plan.ranges.map((item) => item.fromBlock),
          plan.ranges.map((item) => item.toBlock)]
      );
      if (frozenCandidates.rowCount !== plan.candidates.length
          || frozenRanges.rowCount !== plan.ranges.length) {
        throw new Error('bundle funding frozen scope changed during creation');
      }
      await client.query('COMMIT');
      return runRow(run);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async function getRun(runIdValue) {
    const runId = integer(runIdValue, 'runId', 1);
    const result = await database.query(
      `SELECT * FROM robinhood_bundle_funding_backfill_runs
        WHERE id = $1 AND chain = $2`, [runId, CHAIN]
    );
    return runRow(result.rows[0]);
  }
  async function claimRange(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    const leaseOwner = owner(input.owner);
    const leaseMs = integer(input.leaseMs ?? 300_000, 'leaseMs', 1_000, 1_200_000);
    const claimed = await database.query(
      `WITH claimable AS (
         SELECT range_index FROM robinhood_bundle_funding_backfill_ranges
          WHERE run_id = $1 AND status = 'pending' AND next_attempt_at <= NOW()
          ORDER BY range_index LIMIT 1 FOR UPDATE SKIP LOCKED
       ) UPDATE robinhood_bundle_funding_backfill_ranges target SET
           status = 'leased', lease_owner = $2,
           lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
           attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, NOW()), updated_at = NOW()
          FROM claimable WHERE target.run_id = $1
            AND target.range_index = claimable.range_index
            AND EXISTS (SELECT 1 FROM robinhood_bundle_funding_backfill_runs run
                         WHERE run.id = $1 AND run.status = 'running')
       RETURNING target.*`, [runId, leaseOwner, leaseMs]
    );
    if (!claimed.rows[0]) return null;
    const row = claimed.rows[0];
    const candidates = await database.query(
      `SELECT * FROM robinhood_bundle_funding_backfill_candidates
        WHERE run_id = $1 AND first_buy_block BETWEEN $2 AND $3
        ORDER BY first_buy_block, first_buy_transaction_index, token_address, wallet_address`,
      [runId, row.from_block, row.through_block]
    );
    return rangeRow(row, candidates.rows);
  }
  async function renewRangeLease(input = {}) {
    const result = await database.query(
      `UPDATE robinhood_bundle_funding_backfill_ranges SET
         lease_until = NOW() + ($4::bigint * INTERVAL '1 millisecond'), updated_at = NOW()
        WHERE run_id = $1 AND range_index = $2 AND status = 'leased'
          AND lease_owner = $3 RETURNING range_index`,
      [integer(input.runId, 'runId', 1), integer(input.rangeIndex, 'rangeIndex'),
        owner(input.owner), integer(input.leaseMs ?? 300_000, 'leaseMs', 1_000, 1_200_000)]
    );
    if (!result.rowCount) throw new Error('bundle funding range lease was lost');
  }
  async function ensurePartitions(client, events) {
    const bounds = [...new Map(events.map((event) => {
      const value = dayBounds(event.blockTime);
      return [value.name, value];
    })).values()];
    if (!bounds.length) return;
    await client.query('BEGIN');
    try {
      for (const bound of bounds) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [bound.name]);
        await client.query(`CREATE TABLE IF NOT EXISTS ${bound.name}
          PARTITION OF robinhood_native_funding_events
          FOR VALUES FROM ('${bound.from}') TO ('${bound.to}')`);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  }
  async function persistEvents(client, events, evidenceVersion) {
    if (!events.length) return 0;
    const payload = events.map((event) => ({
      block_number: event.blockNumber, block_hash: event.blockHash, block_time: event.blockTime,
      transaction_hash: event.transactionHash,
      transaction_index: event.transactionIndex, from_address: event.fromAddress,
      to_address: event.toAddress, value_wei: event.valueWei,
    }));
    const result = await client.query(
      `INSERT INTO robinhood_native_funding_events (
         chain, block_number, block_hash, block_time, transaction_hash,
         transaction_index, from_wallet, to_wallet, value_wei, evidence_version
       ) SELECT $2, item.block_number::bigint, item.block_hash,
                item.block_time::timestamptz, item.transaction_hash,
                item.transaction_index::integer, item.from_address,
                item.to_address, item.value_wei::numeric, $3
           FROM jsonb_to_recordset($1::jsonb) AS item(
             block_number text, block_hash text, block_time text,
             transaction_hash text, transaction_index text,
             from_address text, to_address text, value_wei text)
       ON CONFLICT (chain, transaction_hash, transaction_index, block_time) DO NOTHING`,
      [JSON.stringify(payload), CHAIN, evidenceVersion]
    );
    return result.rowCount;
  }
  async function persistEdges(client, edges, evidenceVersion) {
    if (!edges.length) return 0;
    const payload = edges.map((edge) => ({
      from_address: edge.fromAddress, to_address: edge.toAddress,
      first_block_number: edge.firstBlockNumber, first_block_hash: edge.firstBlockHash,
      first_block_time: edge.firstBlockTime,
      first_transaction_hash: edge.firstTransactionHash,
      first_transaction_index: edge.firstTransactionIndex,
      last_block_number: edge.lastBlockNumber, last_block_hash: edge.lastBlockHash,
      last_block_time: edge.lastBlockTime, last_transaction_hash: edge.lastTransactionHash,
      last_transaction_index: edge.lastTransactionIndex,
      transfer_count: edge.transferCount, total_value_wei: edge.totalValueWei,
    }));
    const result = await client.query(
      `INSERT INTO robinhood_native_funding_edges (
         chain, from_wallet, to_wallet, evidence_version,
         first_block_number, first_block_hash, first_block_time,
         first_transaction_hash, first_transaction_index,
         last_block_number, last_block_hash, last_block_time,
         last_transaction_hash, last_transaction_index, transfer_count, total_value_wei
       ) SELECT $2, item.from_address, item.to_address, $3,
                item.first_block_number::bigint, item.first_block_hash,
                item.first_block_time::timestamptz, item.first_transaction_hash,
                item.first_transaction_index::integer, item.last_block_number::bigint,
                item.last_block_hash, item.last_block_time::timestamptz,
                item.last_transaction_hash, item.last_transaction_index::integer,
                item.transfer_count::bigint, item.total_value_wei::numeric
           FROM jsonb_to_recordset($1::jsonb) AS item(
             from_address text, to_address text, first_block_number text,
             first_block_hash text, first_block_time text, first_transaction_hash text,
             first_transaction_index text, last_block_number text, last_block_hash text,
             last_block_time text, last_transaction_hash text, last_transaction_index text,
             transfer_count text, total_value_wei text)
       ON CONFLICT (chain, from_wallet, to_wallet, evidence_version) DO UPDATE SET
         transfer_count = robinhood_native_funding_edges.transfer_count + EXCLUDED.transfer_count,
         total_value_wei = robinhood_native_funding_edges.total_value_wei + EXCLUDED.total_value_wei,
         first_block_number = CASE WHEN EXCLUDED.first_block_number <
           robinhood_native_funding_edges.first_block_number THEN EXCLUDED.first_block_number
           ELSE robinhood_native_funding_edges.first_block_number END,
         first_block_hash = CASE WHEN EXCLUDED.first_block_number <
           robinhood_native_funding_edges.first_block_number THEN EXCLUDED.first_block_hash
           ELSE robinhood_native_funding_edges.first_block_hash END,
         first_block_time = LEAST(robinhood_native_funding_edges.first_block_time,
                                  EXCLUDED.first_block_time),
         first_transaction_hash = CASE WHEN
           (EXCLUDED.first_block_number, EXCLUDED.first_transaction_index) <
           (robinhood_native_funding_edges.first_block_number,
            robinhood_native_funding_edges.first_transaction_index)
           THEN EXCLUDED.first_transaction_hash
           ELSE robinhood_native_funding_edges.first_transaction_hash END,
         first_transaction_index = CASE WHEN EXCLUDED.first_block_number <
           robinhood_native_funding_edges.first_block_number THEN EXCLUDED.first_transaction_index
           WHEN EXCLUDED.first_block_number > robinhood_native_funding_edges.first_block_number
             THEN robinhood_native_funding_edges.first_transaction_index
           ELSE LEAST(robinhood_native_funding_edges.first_transaction_index,
                      EXCLUDED.first_transaction_index) END,
         last_block_number = GREATEST(robinhood_native_funding_edges.last_block_number,
                                      EXCLUDED.last_block_number),
         last_block_hash = CASE WHEN EXCLUDED.last_block_number >
           robinhood_native_funding_edges.last_block_number THEN EXCLUDED.last_block_hash
           ELSE robinhood_native_funding_edges.last_block_hash END,
         last_block_time = GREATEST(robinhood_native_funding_edges.last_block_time,
                                    EXCLUDED.last_block_time),
         last_transaction_hash = CASE WHEN
           (EXCLUDED.last_block_number, EXCLUDED.last_transaction_index) >
           (robinhood_native_funding_edges.last_block_number,
            robinhood_native_funding_edges.last_transaction_index)
           THEN EXCLUDED.last_transaction_hash
           ELSE robinhood_native_funding_edges.last_transaction_hash END,
         last_transaction_index = CASE WHEN EXCLUDED.last_block_number >
           robinhood_native_funding_edges.last_block_number THEN EXCLUDED.last_transaction_index
           WHEN EXCLUDED.last_block_number < robinhood_native_funding_edges.last_block_number
             THEN robinhood_native_funding_edges.last_transaction_index
           ELSE GREATEST(robinhood_native_funding_edges.last_transaction_index,
                         EXCLUDED.last_transaction_index) END,
         updated_at = NOW()`,
      [JSON.stringify(payload), CHAIN, evidenceVersion]
    );
    return result.rowCount;
  }
  async function completeRange(input = {}) {
    const runId = integer(input.runId, 'runId', 1);
    const rangeIndex = integer(input.rangeIndex, 'rangeIndex');
    const leaseOwner = owner(input.owner);
    const events = Array.isArray(input.rawEvents) ? input.rawEvents : [];
    const edges = Array.isArray(input.edges) ? input.edges : [];
    const client = await database.getClient();
    try {
      await ensurePartitions(client, events);
      await client.query('BEGIN');
      const context = await client.query(
        `SELECT run.evidence_version, range.from_block, range.through_block
           FROM robinhood_bundle_funding_backfill_ranges range
           JOIN robinhood_bundle_funding_backfill_runs run ON run.id = range.run_id
          WHERE range.run_id = $1 AND range.range_index = $2
            AND range.status = 'leased' AND range.lease_owner = $3 FOR UPDATE OF range`,
        [runId, rangeIndex, leaseOwner]
      );
      if (!context.rows[0]) throw new Error('bundle funding range lease was lost');
      const rawWritten = await persistEvents(client, events, context.rows[0].evidence_version);
      const edgesWritten = await persistEdges(client, edges, context.rows[0].evidence_version);
      const completed = await client.query(
        `UPDATE robinhood_bundle_funding_backfill_ranges SET
           status = 'completed', lease_owner = NULL, lease_until = NULL,
           completed_through_hash = $4, blocks_scanned = through_block - from_block + 1,
           native_transfers_scanned = $5, raw_events_written = $6,
           edges_written = $7, last_error_code = NULL, last_error_message = NULL,
           completed_at = NOW(), updated_at = NOW()
          WHERE run_id = $1 AND range_index = $2 AND lease_owner = $3 RETURNING *`,
        [runId, rangeIndex, leaseOwner, input.completedThroughHash,
          integer(input.nativeTransfersScanned ?? 0, 'nativeTransfersScanned'),
          rawWritten, edgesWritten]
      );
      await client.query(
        `UPDATE robinhood_bundle_funding_backfill_runs run SET
           status = CASE WHEN EXISTS (
             SELECT 1 FROM robinhood_bundle_funding_backfill_ranges range
              WHERE range.run_id = run.id AND range.status = 'failed'
           ) THEN 'failed' ELSE 'completed' END,
           finished_at = NOW(), updated_at = NOW()
          WHERE run.id = $1 AND NOT EXISTS (
            SELECT 1 FROM robinhood_bundle_funding_backfill_ranges range
             WHERE range.run_id = run.id AND range.status IN ('pending', 'leased'))`, [runId]
      );
      await client.query('COMMIT');
      return rangeRow(completed.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async function retryRange(input = {}) {
    const details = errorDetails(input.error);
    const result = await database.query(
      `WITH retried AS (UPDATE robinhood_bundle_funding_backfill_ranges SET
         status = CASE WHEN attempt_count >= $4 THEN 'failed' ELSE 'pending' END,
         lease_owner = NULL, lease_until = NULL,
         next_attempt_at = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
         last_error_code = $6, last_error_message = $7,
         completed_at = CASE WHEN attempt_count >= $4 THEN NOW() ELSE NULL END,
         updated_at = NOW()
        WHERE run_id = $1 AND range_index = $2 AND status = 'leased'
          AND lease_owner = $3 RETURNING status), settled AS (
         UPDATE robinhood_bundle_funding_backfill_runs run SET
           status = 'failed', finished_at = NOW(), updated_at = NOW()
          WHERE run.id = $1 AND (SELECT status FROM retried) = 'failed'
            AND NOT EXISTS (SELECT 1 FROM robinhood_bundle_funding_backfill_ranges range
              WHERE range.run_id = run.id AND range.status IN ('pending', 'leased')
                AND range.range_index <> $2)
          RETURNING id) SELECT status FROM retried`,
      [integer(input.runId, 'runId', 1), integer(input.rangeIndex, 'rangeIndex'),
        owner(input.owner), integer(input.maxAttempts ?? 3, 'maxAttempts', 1, 10),
        integer(input.backoffMs ?? 1_000, 'backoffMs', 0, 300_000),
        details.code, details.message]
    );
    if (!result.rowCount) throw new Error('bundle funding range lease was lost');
    return result.rows[0].status;
  }
  async function reclaimExpired(runIdValue) {
    const result = await database.query(
      `UPDATE robinhood_bundle_funding_backfill_ranges SET status = 'pending',
         lease_owner = NULL, lease_until = NULL, next_attempt_at = NOW(), updated_at = NOW()
        WHERE run_id = $1 AND status = 'leased' AND lease_until < NOW()`,
      [integer(runIdValue, 'runId', 1)]
    );
    return result.rowCount;
  }
  async function getProgress(runIdValue) {
    const result = await database.query(
      `SELECT run.status, run.range_count AS total,
              COUNT(*) FILTER (WHERE range.status = 'pending')::integer AS pending,
              COUNT(*) FILTER (WHERE range.status = 'leased')::integer AS leased,
              COUNT(*) FILTER (WHERE range.status = 'completed')::integer AS completed,
              COUNT(*) FILTER (WHERE range.status = 'failed')::integer AS failed
         FROM robinhood_bundle_funding_backfill_runs run
         LEFT JOIN robinhood_bundle_funding_backfill_ranges range ON range.run_id = run.id
        WHERE run.id = $1 GROUP BY run.id`, [integer(runIdValue, 'runId', 1)]
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return Object.freeze({ status: row.status, total: Number(row.total),
      pending: row.pending, leased: row.leased, completed: row.completed, failed: row.failed });
  }
  return Object.freeze({ claimRange, completeRange, createRun, getProgress, getRun,
    reclaimExpired, renewRangeLease, retryRange });
}

module.exports = { createRobinhoodBundleFundingBackfillRepository, __private: { dayBounds } };

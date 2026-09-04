'use strict';

const TABLE = 'robinhood_holder_transfer_journal';
const LIMITS = { fromPage: [0, 4294959102], pages: [1, 8192], timeoutMs: [100, 10000] };

function normalizeOptions(input = {}) {
  const values = { fromPage: 0, pages: 128, timeoutMs: 3000, ...input };
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (!Number.isSafeInteger(values[key]) || values[key] < min || values[key] > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
  }
  if (!values.database || typeof values.database !== 'string') throw new Error('database is required');
  return { ...values, measure: values.measure === true };
}

function pilotSql(schema = 'public') {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('invalid schema');
  return `WITH bounded AS MATERIALIZED (
    SELECT j.* FROM ${schema}.${TABLE} j
    WHERE j.ctid >= $1::tid AND j.ctid < $2::tid
  ), protected AS MATERIALIZED (
    SELECT token_address FROM ${schema}.robinhood_holder_token_states
    WHERE chain = 'robinhood' AND ledger_status <> 'drifted'
    UNION
    SELECT t.token_address FROM ${schema}.robinhood_holder_global_backfill_tokens t
    JOIN ${schema}.robinhood_holder_global_backfill_runs r
      ON r.id = t.run_id AND r.chain = t.chain
    WHERE t.chain = 'robinhood' AND t.status = 'active'
      AND r.barrier_block IS NOT NULL AND r.status <> 'completed'
  ) SELECT b.* FROM bounded b LEFT JOIN protected p ON p.token_address = b.token_address
    WHERE b.chain = 'robinhood' AND
      (b.block_number >= $3::bigint OR (b.applied = false AND p.token_address IS NOT NULL))`;
}

function planNodes(node) {
  return [node, ...(node.Plans || []).flatMap(planNodes)];
}

function validatePlan(document) {
  if (!document?.Plan) throw new Error('missing EXPLAIN plan');
  const nodes = planNodes(document.Plan);
  const scans = nodes.filter((node) => node['Relation Name'] === TABLE);
  if (scans.length !== 1 || scans[0]['Node Type'] !== 'Tid Range Scan'
      || !scans[0]['TID Cond']?.includes('>=') || !scans[0]['TID Cond']?.includes('<')
      || nodes.some((node) => node['Parallel Aware'] || /Gather/.test(node['Node Type']))) {
    throw new Error('unsafe plan: requires one nonparallel bounded Tid Range Scan');
  }
  return scans[0];
}

function measurement(document, elapsedMs, blockSize) {
  const scan = validatePlan(document);
  const root = document.Plan;
  return {
    elapsedMs, executionMs: document['Execution Time'],
    scannedRows: scan['Actual Rows'], selectedRows: root['Actual Rows'],
    selectedRowsPerSecond: Math.round(root['Actual Rows'] * 1000 / Math.max(elapsedMs, 1)),
    journalSharedReadBlocks: scan['Shared Read Blocks'] || 0,
    journalSharedHitBlocks: scan['Shared Hit Blocks'] || 0,
    totalSharedReadBlocks: root['Shared Read Blocks'] || 0,
    totalSharedHitBlocks: root['Shared Hit Blocks'] || 0,
    sharedReadBytes: (root['Shared Read Blocks'] || 0) * blockSize,
    tempWrittenBlocks: root['Temp Written Blocks'] || 0,
  };
}

async function runPilot(pool, input, { signal, progress = () => {}, schema = 'public' } = {}) {
  const options = normalizeOptions(input);
  const sql = pilotSql(schema);
  const client = await pool.connect();
  let cancellation; let backend; let releaseError; let failure; let report;
  const check = () => { if (signal?.aborted) throw new Error('pilot interrupted'); };
  async function ask(text, params) {
    check(); const result = await client.query(text, params); check(); return result;
  }
  function cancel() {
    if (!backend || cancellation) return;
    cancellation = pool.query({
      text: `SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity
        WHERE pid = $1 AND backend_start = $2::timestamptz AND application_name = $3`,
      values: [backend.pid, backend.backend_start, backend.application_name],
      query_timeout: 5000,
    }).then((result) => progress({ phase: 'cancel', cancelled: result.rows[0]?.cancelled === true }))
      .catch(() => progress({ phase: 'cancel', cancelled: false, timeoutFallback: true }));
  }
  try {
    await ask('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const setting of [
      `statement_timeout = '${options.timeoutMs}ms'`, "lock_timeout = '500ms'",
      "idle_in_transaction_session_timeout = '15s'", "work_mem = '16MB'",
      "temp_file_limit = '0'", 'max_parallel_workers_per_gather = 0', 'jit = off',
      'enable_seqscan = off',
    ]) await ask(`SET LOCAL ${setting}`);
    const lock = await ask(`SELECT pg_try_advisory_xact_lock(
      hashtextextended('robinhood-holder-journal-pilot', 0)) AS acquired`);
    if (!lock.rows[0].acquired) throw new Error('another pilot is active in this database');
    backend = (await ask(`SELECT pid, backend_start::text, application_name
      FROM pg_stat_activity WHERE pid = pg_backend_pid()`)).rows[0];
    signal?.addEventListener('abort', cancel, { once: true });
    check();
    const identity = (await ask(`SELECT current_database() AS database,
      current_setting('server_version_num')::int AS version,
      current_setting('block_size')::int AS block_size,
      c.oid, c.relkind, pg_relation_filenode(c.oid) AS filenode,
      pg_relation_size(c.oid) AS heap_bytes
      FROM pg_class c WHERE c.oid = $1::regclass`, [`${schema}.${TABLE}`])).rows[0];
    if (identity.database !== options.database || identity.version < 140000 || identity.relkind !== 'r') {
      throw new Error('unexpected database, table kind or PostgreSQL version (14+ required)');
    }
    const cursor = (await ask(`SELECT next_block, journal_floor_block, updated_at,
      GREATEST(next_block - 20000, 0)::text AS cutoff
      FROM ${schema}.robinhood_holder_cursors WHERE chain = 'robinhood' AND stream = 'live'`)).rows;
    if (cursor.length !== 1) throw new Error('holder live cursor missing or ambiguous');
    const params = [`(${options.fromPage},0)`, `(${options.fromPage + options.pages},0)`, cursor[0].cutoff];
    const plan = (await ask(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
    const scan = validatePlan(plan);
    report = { mode: options.measure ? 'measure' : 'plan', backendPid: backend.pid,
      identity, cursor: cursor[0], fromPage: options.fromPage, pages: options.pages,
      heapRangeBytes: options.pages * identity.block_size, scan: scan['Node Type'],
      estimatedSelectedRows: plan.Plan['Plan Rows'], resumable: false };
    progress({ phase: 'plan', ...report });
    if (options.measure) {
      const started = Date.now();
      const measured = (await ask(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${sql}`, params))
        .rows[0]['QUERY PLAN'][0];
      report.measurement = measurement(measured, Date.now() - started, identity.block_size);
    }
  } catch (error) {
    failure = error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await cancellation;
    try { await client.query('ROLLBACK'); } catch (error) { releaseError = error; }
    client.release(releaseError);
  }
  if (failure) throw failure;
  if (releaseError) throw releaseError;
  return report;
}

module.exports = { normalizeOptions, pilotSql, validatePlan, measurement, runPilot };

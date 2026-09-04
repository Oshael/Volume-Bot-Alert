'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { digest, describeJournal } = require('./robinhood-holder-journal-receiver');
const { readHealth, checkHealth } = require('./robinhood-holder-journal-round');
const { validatePlan } = require('./robinhood-holder-journal-pilot');
const TABLE = 'robinhood_holder_transfer_journal';
const PAGES = 512; const MAX_RANGE_PAGES = 32768; const REORG_FENCE = '8241992116082026';

function sourceSql(schema, columns) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('invalid source schema');
  const projection = columns.map(c => `b."${c.name}"::text AS "${c.name}"`).join(',');
  return `WITH bounded AS MATERIALIZED (SELECT j.* FROM ${schema}.${TABLE} j
    WHERE j.ctid >= $1::tid AND j.ctid < $2::tid), protected AS MATERIALIZED (
    SELECT token_address FROM ${schema}.robinhood_holder_token_states
      WHERE chain='robinhood' AND ledger_status <> 'drifted'
    UNION SELECT t.token_address FROM ${schema}.robinhood_holder_global_backfill_tokens t
      JOIN ${schema}.robinhood_holder_global_backfill_runs r ON r.id=t.run_id AND r.chain=t.chain
      WHERE t.chain='robinhood' AND t.status='active' AND r.barrier_block IS NOT NULL AND r.status <> 'completed')
    SELECT ${projection} FROM bounded b LEFT JOIN protected p ON p.token_address=b.token_address
      WHERE b.chain='robinhood' AND (b.block_number >= $3::bigint OR (b.applied=false AND p.token_address IS NOT NULL))`;
}

async function assertHolderStopped(query, schema) {
  const { rows } = await query(`SELECT lease_key FROM ${schema}.worker_leases
    WHERE lease_key LIKE 'robinhood-holder-%' AND lease_key <> 'robinhood-holder-summary-worker'
      AND lease_until > NOW() LIMIT 1`);
  if (rows.length) throw new Error(`holder worker active: ${rows[0].lease_key}`);
}

async function lockSource(query, schema) {
  await assertHolderStopped(query, schema);
  const lock = await query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [REORG_FENCE]);
  if (!lock.rows[0].acquired) throw new Error('holder reorg fence is busy');
  await query(`LOCK TABLE ${schema}.${TABLE}, ${schema}.robinhood_holder_token_states,
    ${schema}.robinhood_holder_global_backfill_tokens, ${schema}.robinhood_holder_global_backfill_runs,
    ${schema}.robinhood_holder_cursors IN SHARE MODE NOWAIT`);
  await assertHolderStopped(query, schema);
}

async function sourceManifest(query, options) {
  const relation = `${options.schema}.${TABLE}`;
  const description = await describeJournal(query, relation);
  const { rows: [identity] } = await query(`SELECT current_database() AS database,
    current_setting('server_version_num')::int AS version, current_setting('block_size')::int AS block_size,
    c.oid::text, c.relkind, pg_relation_filenode(c.oid)::text AS filenode,
    pg_relation_size(c.oid)::bigint::text AS heap_bytes
    FROM pg_class c WHERE c.oid=$1::regclass`, [relation]);
  const { rows: [cursor] } = await query(`SELECT next_block::text, journal_floor_block::text, updated_at::text,
    GREATEST(next_block-20000,0)::text AS cutoff FROM ${options.schema}.robinhood_holder_cursors
    WHERE chain='robinhood' AND stream='live'`, []);
  if (identity.database !== options.database || identity.version < 140000
      || identity.relkind !== 'r' || !cursor) throw new Error('unexpected source database or table');
  const heapPages = Math.ceil(Number(identity.heap_bytes) / identity.block_size);
  const endPage = options.endPage ?? heapPages;
  const invalidRange = !Number.isSafeInteger(options.fromPage) || !Number.isSafeInteger(endPage)
    || options.fromPage < 0 || endPage <= options.fromPage || endPage > heapPages;
  const invalidModeRange = options.full
    ? options.fromPage !== 0 || endPage !== heapPages
    : endPage - options.fromPage > MAX_RANGE_PAGES;
  if (invalidRange || invalidModeRange) throw new Error(options.full
    ? 'full transfer must cover page zero through the exact heap end'
    : 'pilot transfer range must be 1..32768 pages within heap');
  const sourceIdentity = digest({ identity, cursor, schemaHash: description.hash });
  return { description, cursor, sourceIdentity, manifest: { version: 1, sourceIdentity,
    schemaHash: description.hash, fromPage: options.fromPage, endPage, pages: PAGES } };
}

async function healthWindow(monitor, database, schema, progress, signal, stage, previous) {
  for (let i = 0; i < 7; i += 1) {
    signal?.throwIfAborted();
    const snapshot = await readHealth(monitor, database, schema);
    previous = checkHealth(snapshot, previous); progress({ phase: 'health', stage, snapshot, health: previous });
    if (i < 6) await delay(5000, undefined, { signal });
  }
  return previous;
}

function assertTransferOptions(options, transport) {
  if (!transport?.send || !transport?.close || !options?.write || !options?.allowHolderLock) {
    throw new Error('transport, write and holder-lock acknowledgements are required');
  }
  if (options.full && (!options.pilotValidated || !options.allowUnattended || options.pauseMs !== 50)) {
    throw new Error('full transfer requires validated pilot, unattended acknowledgement and pause 50');
  }
}

async function copyBatches(query, monitor, source, sql, options, deps) {
  const { transport, signal, progress, observeBaseline, sleep, clock } = deps;
  const params = p => [`(${p},0)`, `(${Math.min(p + PAGES, source.manifest.endPage)},0)`, source.cursor.cutoff];
  const initialized = await transport.send({ op: 'init', runId: options.runId, manifest: source.manifest });
  if (initialized.manifest.sourceIdentity !== source.sourceIdentity) throw new Error('receiver manifest mismatch');
  let page = initialized.nextPage;
  if (page !== source.manifest.fromPage) throw new Error('cross-process CTID resume is refused; create a new run');
  let previous = await observeBaseline(monitor, options.database, options.schema, progress, signal, 'baseline');
  let lastHealth = clock(); let rows = 0; let batches = 0; const started = clock();
  while (page < source.manifest.endPage) {
    if (clock() - lastHealth >= 5000) {
      const snapshot = await readHealth(monitor, options.database, options.schema);
      previous = checkHealth(snapshot, previous); progress({ phase: 'health', stage: 'load', snapshot, health: previous });
      lastHealth = clock();
    }
    const toPage = Math.min(page + PAGES, source.manifest.endPage);
    const selected = await query(sql, params(page));
    const frame = { op: 'batch', runId: options.runId, sourceIdentity: source.sourceIdentity,
      fromPage: page, toPage, rows: selected.rows, checksum: digest(selected.rows) };
    const receipt = await transport.send(frame);
    if (!['committed', 'already_committed'].includes(receipt.outcome) || receipt.nextPage !== toPage) throw new Error('invalid receiver receipt');
    rows += selected.rowCount; batches += 1; page = toPage;
    progress({ phase: 'batch', batches, page, rows: selected.rowCount, receivedRows: receipt.receivedRows });
    await sleep(options.pauseMs ?? 100, undefined, { signal });
  }
  return { batches, rows, page, previous, elapsedMs: clock() - started };
}

async function cleanup(client, monitor, transport, transaction, failure) {
  let result = failure;
  if (transaction && client) { try { await client.query('ROLLBACK'); } catch (error) { result ||= error; } }
  try { await transport.close(); } catch (error) { result ||= error; }
  client?.release(Boolean(result)); monitor?.release(Boolean(result));
  return result;
}

async function runTransfer(pool, options, { transport, signal, progress = () => {},
  observeBaseline = healthWindow, observeRecovery = healthWindow, sleep = delay, clock = Date.now } = {}) {
  assertTransferOptions(options, transport);
  let client; let monitor;
  let transaction = false; let failure; let result;
  async function query(sql, values) { signal?.throwIfAborted(); const r = await client.query(sql, values); signal?.throwIfAborted(); return r; }
  try {
    client = await pool.connect(); monitor = await pool.connect();
    await query('BEGIN READ ONLY'); transaction = true;
    await query("SET LOCAL statement_timeout='3000ms'; SET LOCAL lock_timeout='500ms'; SET LOCAL idle_in_transaction_session_timeout='0'; SET LOCAL work_mem='16MB'; SET LOCAL temp_file_limit='0'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL jit=off; SET LOCAL enable_seqscan=off");
    await lockSource(query, options.schema);
    const source = await sourceManifest(query, options); const sql = sourceSql(options.schema, source.description.columns);
    const params = p => [`(${p},0)`, `(${Math.min(p + PAGES, source.manifest.endPage)},0)`, source.cursor.cutoff];
    const plan = (await query(`EXPLAIN (FORMAT JSON) ${sql}`, params(source.manifest.fromPage))).rows[0]['QUERY PLAN'][0];
    validatePlan(plan); progress({ phase: 'plan', manifest: source.manifest, scan: 'Tid Range Scan' });
    const copied = await copyBatches(query, monitor, source, sql, options,
      { transport, signal, progress, observeBaseline, sleep, clock });
    result = { status: 'transferred_unverified', mode: options.full ? 'full' : 'pilot', runId: options.runId,
      batches: copied.batches, rows: copied.rows, fromPage: source.manifest.fromPage,
      endPage: copied.page, elapsedMs: copied.elapsedMs,
      sourceConsistencyVerified: true, readyForSwap: false };
    await query('COMMIT'); transaction = false;
    await observeRecovery(monitor, options.database, options.schema, progress, signal, 'recovery', copied.previous);
  } catch (error) { failure = error; }
  finally { failure = await cleanup(client, monitor, transport, transaction, failure); }
  if (failure) throw failure;
  return result;
}

module.exports = { PAGES, MAX_RANGE_PAGES, sourceSql, sourceManifest, runTransfer };

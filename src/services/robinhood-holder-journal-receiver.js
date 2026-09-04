'use strict';

const { createHash } = require('node:crypto');
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 20000;
const hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

function namespace(runId) {
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) {
    throw new Error('runId must be a lowercase UUID');
  }
  return `holder_rx_${runId.replaceAll('-', '')}`;
}

function validateManifest(m) {
  if (m?.version !== 1 || !hex(m.sourceIdentity) || !hex(m.schemaHash) || m.pages !== 512
      || !integer(m.fromPage) || !integer(m.endPage) || m.endPage <= m.fromPage || m.endPage > 4294967295) {
    throw new Error('invalid immutable run manifest');
  }
}

function validateBatch(frame) {
  if (!hex(frame.sourceIdentity) || !integer(frame.fromPage) || !integer(frame.toPage)
      || frame.toPage <= frame.fromPage || frame.toPage - frame.fromPage > 512
      || !Array.isArray(frame.rows) || frame.rows.length > MAX_ROWS || !hex(frame.checksum)) {
    throw new Error('invalid bounded batch');
  }
  if (digest(frame.rows) !== frame.checksum) throw new Error('batch checksum mismatch');
}

function validateFrame(frame) {
  namespace(frame?.runId);
  if (!['init', 'batch', 'status'].includes(frame.op)) throw new Error('unknown receiver operation');
  if (Buffer.byteLength(JSON.stringify(frame)) > MAX_BYTES) throw new Error('receiver frame exceeds 16 MiB');
  if (frame.op === 'init') validateManifest(frame.manifest);
  if (frame.op === 'batch') validateBatch(frame);
  return frame;
}

async function describeJournal(query, relation) {
  const { rows: columns } = await query(`SELECT attname AS name, format_type(atttypid,atttypmod) AS type,
    attnotnull AS required, attgenerated AS generated, attidentity AS identity
    FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [relation]);
  if (!columns.length || columns.some(c => !/^[a-z_][a-z0-9_]*$/.test(c.name) || c.generated || c.identity)) {
    throw new Error('unsupported journal structure');
  }
  const { rows: checks } = await query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY pg_get_constraintdef(oid)`, [relation]);
  return { columns, hash: digest({ columns, checks: checks.map(c => c.definition).sort() }) };
}

function status(runId, row) {
  return { runId, nextPage: Number(row.next_page), receivedRows: String(row.received_rows),
    manifest: row.manifest, sourceConsistencyVerified: false, readyForSwap: false };
}

async function initialize(query, frame, schema, template) {
  const existing = (await query('SELECT to_regnamespace($1) AS oid', [schema])).rows[0].oid;
  if (existing) {
    const { rows: [row] } = await query(`SELECT * FROM ${schema}.run WHERE singleton`);
    if (row?.manifest_hash !== digest(frame.manifest)) throw new Error('run already exists with a different manifest');
    return { ...status(frame.runId, row), outcome: 'already_initialized' };
  }
  // Template names come only from the trusted caller, never the incoming frame.
  if (!/^(public|pg_temp)\.robinhood_holder_transfer_journal$/.test(template)) throw new Error('invalid template');
  const description = await describeJournal(query, template);
  if (description.hash !== frame.manifest.schemaHash) throw new Error('destination template schema mismatch');
  await query(`CREATE SCHEMA ${schema}`);
  await query(`CREATE TABLE ${schema}.journal (LIKE ${template} INCLUDING CONSTRAINTS INCLUDING STORAGE);
    CREATE TABLE ${schema}.run (singleton boolean PRIMARY KEY CHECK (singleton), manifest jsonb NOT NULL,
      manifest_hash text NOT NULL, next_page bigint NOT NULL, received_rows bigint NOT NULL DEFAULT 0);
    CREATE TABLE ${schema}.batches (from_page bigint PRIMARY KEY, to_page bigint NOT NULL,
      row_count integer NOT NULL, checksum text NOT NULL)`);
  const { rows: [row] } = await query(`INSERT INTO ${schema}.run(singleton,manifest,manifest_hash,next_page)
    VALUES(true,$1::jsonb,$2,$3) RETURNING *`, [JSON.stringify(frame.manifest), digest(frame.manifest), frame.manifest.fromPage]);
  return { ...status(frame.runId, row), outcome: 'initialized' };
}

function validateRows(rows, columns) {
  const names = columns.map(c => c.name);
  for (const row of rows) {
    if (!row || Array.isArray(row) || Object.keys(row).length !== names.length
        || names.some(name => !Object.hasOwn(row, name))) throw new Error('batch row columns mismatch');
    for (const value of Object.values(row)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'boolean') {
        throw new Error('row values must be strings, booleans or null; preserve numeric/timestamp precision');
      }
    }
  }
}

async function receiveBatch(query, frame, schema) {
  const { rows: [row] } = await query(`SELECT * FROM ${schema}.run WHERE singleton FOR UPDATE`);
  if (!row || row.manifest.sourceIdentity !== frame.sourceIdentity) throw new Error('source identity mismatch');
  const recorded = (await query(`SELECT * FROM ${schema}.batches WHERE from_page = $1`, [frame.fromPage])).rows[0];
  if (recorded) {
    if (Number(recorded.to_page) !== frame.toPage || recorded.checksum !== frame.checksum
        || recorded.row_count !== frame.rows.length) throw new Error('conflicting replay of committed batch');
    return { ...status(frame.runId, row), outcome: 'already_committed', fromPage: frame.fromPage, toPage: frame.toPage };
  }
  const expectedEnd = Math.min(frame.fromPage + row.manifest.pages, row.manifest.endPage);
  if (Number(row.next_page) !== frame.fromPage || frame.toPage !== expectedEnd) throw new Error('batch gap, overlap or boundary mismatch');
  await query(`LOCK TABLE ${schema}.journal IN ROW EXCLUSIVE MODE`);
  const description = await describeJournal(query, `${schema}.journal`);
  if (description.hash !== row.manifest.schemaHash) throw new Error('destination journal schema changed');
  validateRows(frame.rows, description.columns);
  const names = description.columns.map(c => `"${c.name}"`).join(',');
  const inserted = await query(`INSERT INTO ${schema}.journal (${names})
    SELECT ${names} FROM jsonb_populate_recordset(NULL::${schema}.journal,$1::jsonb)`, [JSON.stringify(frame.rows)]);
  if (inserted.rowCount !== frame.rows.length) throw new Error('inserted row count mismatch');
  await query(`INSERT INTO ${schema}.batches VALUES($1,$2,$3,$4)`,
    [frame.fromPage, frame.toPage, frame.rows.length, frame.checksum]);
  const updated = await query(`UPDATE ${schema}.run SET next_page=$1, received_rows=received_rows+$2
    WHERE singleton RETURNING *`, [frame.toPage, frame.rows.length]);
  return { ...status(frame.runId, updated.rows[0]), outcome: 'committed', fromPage: frame.fromPage, toPage: frame.toPage };
}

async function dispatch(query, frame, schema, template) {
  if (frame.op === 'init') {
    const lock = await query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [schema]);
    if (!lock.rows[0].acquired) throw new Error('receiver initialization already active');
    return initialize(query, frame, schema, template);
  }
  if (frame.op === 'batch') return receiveBatch(query, frame, schema);
  const { rows: [row] } = await query(`SELECT * FROM ${schema}.run WHERE singleton`);
  if (!row) throw new Error('run not initialized');
  return { ...status(frame.runId, row), outcome: 'status' };
}

async function receive(pool, input, { database, write = false, signal,
  template = 'public.robinhood_holder_transfer_journal' } = {}) {
  const frame = validateFrame(input); const schema = namespace(frame.runId);
  if (!database || (frame.op !== 'status' && !write)) throw new Error('explicit database and write acknowledgement required');
  const client = await pool.connect();
  let transaction = false; let failure; let result;
  async function query(sql, values) {
    signal?.throwIfAborted(); const response = await client.query(sql, values); signal?.throwIfAborted(); return response;
  }
  try {
    const identity = (await query('SELECT current_database() AS database, pg_is_in_recovery() AS recovery')).rows[0];
    if (identity.database !== database || identity.recovery || database === 'volume_alert') throw new Error('wrong destination database');
    await query(frame.op === 'status' ? 'BEGIN READ ONLY' : 'BEGIN'); transaction = true;
    await query("SET LOCAL statement_timeout = '5000ms'; SET LOCAL lock_timeout = '500ms'; SET LOCAL synchronous_commit = on; SET LOCAL idle_in_transaction_session_timeout = '5s'; SET LOCAL search_path = pg_catalog");
    result = await dispatch(query, frame, schema, template);
    await query('COMMIT'); transaction = false;
  } catch (error) { failure = error; }
  finally {
    if (transaction) { try { await client.query('ROLLBACK'); } catch (error) { failure ||= error; } }
    client.release(Boolean(failure));
  }
  if (failure) throw failure;
  return result;
}

module.exports = { MAX_BYTES, MAX_ROWS, digest, namespace, validateFrame, describeJournal, receive };

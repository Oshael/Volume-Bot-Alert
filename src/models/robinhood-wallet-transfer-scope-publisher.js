'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { decodeScopeBitmap } = require('./robinhood-wallet-transfer-scope-bitmap');
const digest = value => createHash('sha256').update(value).digest('hex');
const metadataHash = value => digest(JSON.stringify(value));
const HASH = /^[0-9a-f]{64}$/;
function validateAuditedEntry(map, hashes) {
  if (!HASH.test(map.hash) || map.source !== map.hash || !HASH.test(map.bitmap)
    || !['staging', 'legacy'].includes(map.storage) || !Number.isInteger(map.count)
    || map.count < 1 || map.count > 500000 || hashes.has(map.hash)) throw new Error('invalid audited map');
  hashes.add(map.hash);
}
function auditMaps(receipt) {
  if (!receipt || typeof receipt !== 'object') throw new Error('audit checkpoint required');
  const { checksum, ...state } = receipt;
  if (checksum !== metadataHash(state) || state.version !== 1 || !state.finalPassedAt
    || !Number.isFinite(Date.parse(state.finalPassedAt)) || state.context?.validator !== 'stage263-membership-v1'
    || !Array.isArray(state.completed) || !state.completed.length || state.completed.length > 5000) {
    throw new Error('audit checkpoint is incomplete or invalid');
  }
  const hashes = new Set();
  for (const map of state.completed) validateAuditedEntry(map, hashes);
  if (state.context.codec !== digest(fs.readFileSync(require.resolve('./robinhood-wallet-transfer-scope-bitmap')))) {
    throw new Error('audited bitmap codec changed');
  }
  return [...state.completed].sort((a, b) => a.hash.localeCompare(b.hash));
}
function optionsFor(input, maps) {
  const maxMaps = Number(input.maxMaps ?? 1), budgetMs = Number(input.budgetMs ?? 10000);
  if (!Number.isInteger(maxMaps) || maxMaps < 1 || maxMaps > 50
    || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 30000
    || (input.commit != null && typeof input.commit !== 'boolean')) throw new Error('invalid publication limits');
  const afterHash = input.afterHash ?? null;
  if (afterHash !== null && (!HASH.test(afterHash) || !maps.some(m => m.hash === afterHash))) {
    throw new Error('resume hash is outside audited cohort');
  }
  return { maxMaps, budgetMs, afterHash, commit: input.commit === true };
}
function validateMap(row, saved, dictionary) {
  if (!row) throw new Error('audited map missing');
  const proof = metadataHash({ hash: row.scope_hash, size: row.dictionary_size,
    count: row.bitmap_token_count, bytes: digest(row.scope_bitmap) });
  if (proof !== saved.bitmap || row.bitmap_token_count !== saved.count) throw new Error('audited bitmap changed');
  decodeScopeBitmap({ bitmap: row.scope_bitmap, dictionarySize: row.dictionary_size,
    tokenCount: row.bitmap_token_count, scopeHash: row.scope_hash }, dictionary);
}
async function publishOne(query, saved, dictionary, commit) {
  const legacy = (await query(`SELECT scope_hash,scope_bitmap,dictionary_size,bitmap_token_count
    FROM robinhood_wallet_transfer_token_scopes
    WHERE chain='robinhood' AND scope_hash=$1`, [saved.hash])).rows[0];
  const staged = (await query(`SELECT scope_hash,scope_bitmap,dictionary_size,bitmap_token_count
    FROM robinhood_wallet_transfer_scope_bitmap_staging WHERE chain='robinhood' AND scope_hash=$1`, [saved.hash])).rows[0];
  const payload = saved.storage === 'legacy' ? legacy : staged;
  validateMap(payload, saved, dictionary);
  if (legacy?.scope_bitmap) {
    validateMap(legacy, saved, dictionary);
    return 'verified-existing';
  }
  // Updating bitmap columns can force GIN reinsertion of a huge unchanged array.
  // Publishing and removing that array must instead be a separately authorized atomic cutover.
  if (legacy) return 'deferred-array-cutover';
  if (!commit) return 'would-publish';
  await query(`INSERT INTO robinhood_wallet_transfer_token_scopes
    (chain,scope_hash,token_addresses,scope_bitmap,dictionary_size,bitmap_token_count)
    VALUES ('robinhood',$1,NULL,$2,$3,$4) ON CONFLICT DO NOTHING`,
  [saved.hash, payload.scope_bitmap, payload.dictionary_size, payload.bitmap_token_count]);
  const stored = (await query(`SELECT scope_hash,scope_bitmap,dictionary_size,bitmap_token_count
    FROM robinhood_wallet_transfer_token_scopes WHERE chain='robinhood' AND scope_hash=$1`, [saved.hash])).rows[0];
  validateMap(stored, saved, dictionary);
  // The caller commits this map before recording a resumable cursor.
  return 'published';
}
async function publishScopeMaps(database, input, onProgress = () => {}) {
  const maps = auditMaps(input.audit), options = optionsFor(input, maps);
  const report = { mode: options.commit ? 'publish-maps-only' : 'dry-run', auditChecksum: input.audit.checksum,
    measured: [], resume: { afterHash: options.afterHash }, stopReason: 'map-limit' };
  const deadline = Date.now() + options.budgetMs, client = await database.getClient();
  async function query(sql, params) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('publication time budget exhausted');
    await client.query(`SET LOCAL statement_timeout='${Math.min(3000, remaining)}ms'`);
    return client.query(sql, params);
  }
  async function begin() {
    await client.query(options.commit ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='3s'");
    await client.query("SET LOCAL lock_timeout='250ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
    if (options.commit && !(await query('SELECT pg_try_advisory_xact_lock(262,1) AS locked')).rows[0].locked) {
      throw new Error('another scope converter or publisher is active');
    }
  }
  try {
    await begin();
    const dictionary = (await query(`SELECT token_address,ordinal
      FROM robinhood_wallet_transfer_scope_dictionary ORDER BY ordinal LIMIT 1000001`)).rows;
    if (metadataHash(dictionary) !== input.audit.context.dictionary) throw new Error('audited dictionary changed');
    await client.query('COMMIT');
    const remaining = maps.filter(m => options.afterHash === null || m.hash > options.afterHash);
    for (const saved of remaining.slice(0, options.maxMaps)) {
      if (Date.now() >= deadline) { report.stopReason = 'time-budget'; break; }
      await begin();
      const status = await publishOne(query, saved, dictionary, options.commit);
      if (Date.now() >= deadline) throw new Error('publication time budget exhausted');
      await client.query('COMMIT');
      report.measured.push({ hash: saved.hash, tokens: saved.count, status });
      report.resume.afterHash = saved.hash;
      await onProgress({ ...report, measured: [...report.measured], resume: { ...report.resume } });
    }
    if (report.measured.length === remaining.length) report.stopReason = 'cohort-end';
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    error.publicationReport = { ...report, stopReason: 'error' }; throw error;
  } finally { client.release(); }
}
module.exports = { auditMaps, publishScopeMaps };

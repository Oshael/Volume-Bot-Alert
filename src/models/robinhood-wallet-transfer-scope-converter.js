'use strict';
const { encodeScopeBitmap, decodeScopeBitmap, SCOPE_TOKENS_SQL } = require('./robinhood-wallet-transfer-scope-bitmap');
const { fingerprint } = require('./robinhood-wallet-transfer-scope-history-audit');
const MAX_ID = 9223372036854775807n;
function id(value, name) {
  const text = String(value);
  if (!/^\d+$/.test(text) || BigInt(text) > MAX_ID) throw new Error(`invalid ${name}`);
  return BigInt(text).toString();
}
function bounded(value, fallback, maximum, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`invalid ${name}`);
  return number;
}
function optionsFor(input) {
  if (!/^[\w.-]{1,64}$/.test(input.projectionVersion || '') || !['live', 'seed'].includes(input.stream)) {
    throw new Error('invalid conversion identity');
  }
  if (input.commit != null && typeof input.commit !== 'boolean') throw new Error('invalid commit mode');
  const afterId = id(input.afterId ?? 0, 'afterId');
  const highWaterId = input.highWaterId == null ? null : id(input.highWaterId, 'highWaterId');
  if (afterId !== '0' && highWaterId == null) throw new Error('resume requires highWaterId');
  if (highWaterId != null && BigInt(afterId) > BigInt(highWaterId)) throw new Error('invalid resume bounds');
  return { projectionVersion: input.projectionVersion, stream: input.stream, commit: input.commit === true,
    afterId, highWaterId, maxRanges: bounded(input.maxRanges, 1, 10, 'maxRanges'),
    maxTokens: bounded(input.maxTokens, 450000, 500000, 'maxTokens'),
    budgetMs: bounded(input.budgetMs, 10000, 30000, 'budgetMs') };
}
function mapPayload(row) {
  return { bitmap: row.scope_bitmap, dictionarySize: row.dictionary_size,
    tokenCount: row.bitmap_token_count, scopeHash: row.scope_hash };
}
async function readDictionary(query) {
  return (await query(`SELECT token_address,ordinal FROM robinhood_wallet_transfer_scope_dictionary
    WHERE chain='robinhood' ORDER BY ordinal LIMIT 1000001`)).rows;
}
async function completeDictionary(query, tokens, dictionary, commit) {
  const known = new Set(dictionary.map((entry) => entry.token_address));
  const missing = tokens.filter((token) => !known.has(token));
  let size = dictionary.reduce((maximum, entry) => Math.max(maximum, entry.ordinal + 1), 0);
  const sequenceSql = (await query(`SELECT format('SELECT last_value,is_called FROM %s',
    pg_get_serial_sequence('robinhood_wallet_transfer_scope_dictionary','ordinal')::regclass) AS sql`)).rows[0].sql;
  const sequence = (await query(sequenceSql)).rows[0];
  size = Math.max(size, Number(sequence.last_value) + (sequence.is_called ? 1 : 0));
  if (dictionary.length > 1000000 || size + missing.length > 1000000) throw new Error('scope dictionary limit reached');
  for (let offset = 0; offset < missing.length; offset += 5000) {
    const chunk = missing.slice(offset, offset + 5000);
    if (commit) {
      const result = await query(`INSERT INTO robinhood_wallet_transfer_scope_dictionary(chain,token_address)
        SELECT 'robinhood',token FROM unnest($1::text[]) token
        WHERE NOT EXISTS (SELECT 1 FROM robinhood_wallet_transfer_scope_dictionary d
          WHERE d.chain='robinhood' AND d.token_address=token)
        ORDER BY token RETURNING token_address,ordinal`, [chunk]);
      if (result.rowCount !== chunk.length) throw new Error('dictionary changed outside converter lock');
      dictionary.push(...result.rows);
    } else for (const token_address of chunk) dictionary.push({ token_address, ordinal: size++ });
  }
  return missing.length;
}
async function stageMap(query, hash, tokens, dictionary, existing, commit) {
  if (existing?.array_present && !existing.token_addresses) throw new Error('oversized existing token scope');
  if (existing?.token_addresses) fingerprint(existing.token_addresses, hash);
  if (existing?.scope_bitmap) {
    decodeScopeBitmap(mapPayload(existing), dictionary);
    return { payload: mapPayload(existing), status: 'verified-existing' };
  }
  if (existing && !existing.token_addresses) throw new Error('missing or oversized existing token scope');
  const payload = encodeScopeBitmap(tokens, dictionary);
  decodeScopeBitmap(payload, dictionary);
  if (!commit) return { payload, status: 'would-stage' };
  if (existing) await query(`UPDATE robinhood_wallet_transfer_token_scopes
    SET scope_bitmap=$2,dictionary_size=$3,bitmap_token_count=$4 WHERE chain='robinhood' AND scope_hash=$1`,
  [hash, payload.bitmap, payload.dictionarySize, payload.tokenCount]);
  else await query(`INSERT INTO robinhood_wallet_transfer_token_scopes
    (chain,scope_hash,token_addresses,scope_bitmap,dictionary_size,bitmap_token_count)
    VALUES ('robinhood',$1,NULL,$2,$3,$4)`, [hash, payload.bitmap, payload.dictionarySize, payload.tokenCount]);
  const saved = (await query(`SELECT scope_hash,scope_bitmap,dictionary_size,bitmap_token_count
    FROM robinhood_wallet_transfer_token_scopes WHERE chain='robinhood' AND scope_hash=$1`, [hash])).rows[0];
  decodeScopeBitmap(mapPayload(saved), dictionary);
  return { payload, status: 'staged' };
}
async function stageSource(query, row, options) {
  if (!['topics-only', 'address-filtered'].includes(row.filter_mode)) throw new Error('unsupported historical scope');
  const canonical = await query(`SELECT block_number FROM robinhood_chain_blocks WHERE chain='robinhood'
    AND block_number=$1 AND block_hash=$2 AND canonical IS TRUE ${options.commit ? 'FOR SHARE' : ''}`,
  [row.through_block, row.checkpoint_hash]);
  if (canonical.rowCount !== 1) throw new Error('source checkpoint is not canonical');
  const tokens = (await query(`SELECT CASE WHEN cardinality(tokens)<=$2 THEN tokens ELSE NULL END AS tokens
    FROM (SELECT ${SCOPE_TOKENS_SQL} AS tokens FROM robinhood_wallet_transfer_scan_scopes s
      LEFT JOIN robinhood_wallet_transfer_token_scopes t ON t.chain=s.chain AND t.scope_hash=s.token_scope_hash
      WHERE s.scan_scope_id=$1) source`, [row.id, options.maxTokens])).rows[0]?.tokens;
  const hash = fingerprint(tokens, row.token_scope_hash);
  const existing = (await query(`SELECT scope_hash,token_addresses IS NOT NULL AS array_present,
    CASE WHEN cardinality(token_addresses)<=$2 THEN token_addresses ELSE NULL END AS token_addresses,
    scope_bitmap,dictionary_size,bitmap_token_count
    FROM robinhood_wallet_transfer_token_scopes WHERE chain='robinhood' AND scope_hash=$1
    ${options.commit ? 'FOR UPDATE' : ''}`, [hash, options.maxTokens])).rows[0];
  const dictionary = await readDictionary(query);
  const added = existing?.scope_bitmap ? 0 : await completeDictionary(query, tokens, dictionary, options.commit);
  const { payload, status } = await stageMap(query, hash, tokens, dictionary, existing, options.commit);
  return { scanScopeId: row.id, hash, fromBlock: row.from_block, throughBlock: row.through_block,
    checkpointHash: row.checkpoint_hash, source: row.token_scope_hash ? 'hashed' : 'inline',
    tokens: tokens.length, dictionaryAdded: added, dictionarySize: payload.dictionarySize,
    bitmapBytes: payload.bitmap.length, status };
}
async function convertOne(database, options, cursor, deadline) {
  const client = await database.getClient();
  async function query(sql, params) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('conversion time budget exhausted');
    await client.query(`SET LOCAL statement_timeout='${Math.min(3000, remaining)}ms'`);
    return client.query(sql, params);
  }
  try {
    await client.query(options.commit ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
    if (options.commit && !(await query("SELECT pg_try_advisory_xact_lock(262,1) AS locked")).rows[0].locked) {
      throw new Error('another scope converter is active');
    }
    const identity = [options.projectionVersion, options.stream];
    if (cursor.highWaterId == null) cursor.highWaterId = (await query(`SELECT COALESCE(MAX(scan_scope_id),0)::text AS id
      FROM robinhood_wallet_transfer_scan_scopes WHERE chain='robinhood' AND projection_version=$1 AND stream=$2`, identity)).rows[0].id;
    const row = (await query(`SELECT scan_scope_id::text AS id,from_block::text,through_block::text,
      checkpoint_hash,token_scope_hash,scope_id::text,filter_mode FROM robinhood_wallet_transfer_scan_scopes
      WHERE chain='robinhood' AND projection_version=$1 AND stream=$2 AND scan_scope_id>$3 AND scan_scope_id<=$4
      ORDER BY scan_scope_id LIMIT 1 ${options.commit ? 'FOR UPDATE' : ''}`,
    [...identity, cursor.afterId, cursor.highWaterId])).rows[0];
    if (!row || row.scope_id) {
      await client.query('COMMIT');
      return { stopReason: row ? 'versioned-boundary' : 'cohort-end' };
    }
    const result = await stageSource(query, row, options);
    if (Date.now() >= deadline) throw new Error('conversion time budget exhausted');
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally { client.release(); }
}
async function convertScopeHistory(database, input, onProgress = () => {}) {
  const options = optionsFor(input); const started = Date.now();
  const cursor = { afterId: options.afterId, highWaterId: options.highWaterId };
  const report = { mode: options.commit ? 'stage-only' : 'dry-run', projectionVersion: options.projectionVersion,
    stream: options.stream, stopReason: 'range-limit', measured: [], resume: cursor };
  try {
    while (report.measured.length < options.maxRanges) {
      if (Date.now() - started >= options.budgetMs) { report.stopReason = 'time-budget'; break; }
      const result = await convertOne(database, options, cursor, started + options.budgetMs);
      if (result.stopReason) { report.stopReason = result.stopReason; break; }
      report.measured.push(result); cursor.afterId = result.scanScopeId;
      await onProgress({ ...report, measured: [...report.measured], resume: { ...cursor } });
    }
    report.elapsedMs = Date.now() - started;
    return report;
  } catch (error) {
    report.stopReason = 'error'; report.elapsedMs = Date.now() - started;
    error.conversionReport = report; throw error;
  }
}
module.exports = { convertScopeHistory, optionsFor };

'use strict';

const { createHash } = require('node:crypto');
const { SCOPE_TOKENS_SQL } = require('./robinhood-wallet-transfer-scope-bitmap');
const TOTAL_KEYS = ['ranges', 'bases', 'versions', 'unchangedRanges', 'gaps',
  'tokenOccurrences', 'membershipRows', 'added', 'removed'];

function bounded(value, fallback, maximum, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`invalid ${name}`);
  return number;
}
function optionsFor(input) {
  if (!/^[\w.-]{1,64}$/.test(input.projectionVersion || '')) throw new Error('invalid projectionVersion');
  if (!['live', 'seed'].includes(input.stream)) throw new Error('invalid stream');
  return { projectionVersion: input.projectionVersion, stream: input.stream,
    maxRanges: bounded(input.maxRanges, 5, 100, 'maxRanges'),
    maxTokens: bounded(input.maxTokens, 450000, 500000, 'maxTokens'),
    budgetMs: bounded(input.budgetMs, 10000, 30000, 'budgetMs') };
}
function fingerprint(tokens, expectedHash) {
  if (!Array.isArray(tokens) || !tokens.length) throw new Error('missing or oversized token scope');
  tokens.sort();
  const digest = createHash('sha256');
  for (let index = 0; index < tokens.length; index++) {
    if (!/^0x[0-9a-f]{40}$/.test(tokens[index]) || tokens[index] === tokens[index - 1]) {
      throw new Error('invalid or duplicate scope token');
    }
    digest.update(`${index ? '\n' : ''}${tokens[index]}`);
  }
  const hash = digest.digest('hex');
  if (expectedHash && hash !== expectedHash) throw new Error('token scope hash mismatch');
  return hash;
}
function difference(before, after) {
  let left = 0; let right = 0; let added = 0; let removed = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) { left++; right++; }
    else if (before[left] < after[right]) { removed++; left++; }
    else { added++; right++; }
  }
  return { added: added + after.length - right, removed: removed + before.length - left };
}
function checkResume(resume, options) {
  if (!resume) return;
  if (resume.format !== 1 || resume.projectionVersion !== options.projectionVersion || resume.stream !== options.stream
    || !/^\d+$/.test(resume.highWaterId) || !resume.last?.row || !resume.totals
    || !/^[0-9a-f]{64}$/.test(resume.last.hash)) {
    throw new Error('invalid resume identity');
  }
  for (const key of ['scan_scope_id', 'from_block', 'through_block']) {
    if (!/^\d+$/.test(resume.last.row[key])) throw new Error('invalid resume range');
  }
  if (BigInt(resume.last.row.scan_scope_id) > BigInt(resume.highWaterId)) throw new Error('invalid resume watermark');
  for (const key of TOTAL_KEYS) {
    if (!Number.isSafeInteger(resume.totals[key]) || resume.totals[key] < 0) throw new Error('invalid resume totals');
  }
}
const COLUMNS = 'scan_scope_id::text,from_block::text,through_block::text,checkpoint_hash,token_scope_hash,scope_id::text,filter_mode';

function recordRange(totals, last, row, previousTokens, tokens, hash) {
  if (!/^0x[0-9a-f]{64}$/.test(row.checkpoint_hash)) throw new Error('invalid checkpoint hash');
  if (last && BigInt(row.from_block) <= BigInt(last.row.through_block)) throw new Error('overlapping history ranges');
  const gap = Boolean(last && BigInt(row.from_block) !== BigInt(last.row.through_block) + 1n);
  const base = !last || gap;
  const delta = base ? { added: tokens.length, removed: 0 } : difference(previousTokens, tokens);
  totals.ranges++;
  totals.tokenOccurrences += tokens.length;
  totals.membershipRows += delta.added;
  totals.added += base ? 0 : delta.added;
  totals.removed += delta.removed;
  if (base) totals.bases++;
  if (gap) totals.gaps++;
  if (base || delta.added || delta.removed) totals.versions++;
  else totals.unchangedRanges++;
  for (const key of TOTAL_KEYS) if (!Number.isSafeInteger(totals[key])) throw new Error('audit total overflow');
  return { scanScopeId: row.scan_scope_id, fromBlock: row.from_block, throughBlock: row.through_block,
    hash, tokens: tokens.length, base, gap, ...delta };
}

async function auditScopeHistory(database, input) {
  const options = optionsFor(input);
  checkResume(input.resume, options);
  const started = Date.now();
  const deadline = started + options.budgetMs;
  const client = await database.getClient();
  async function query(sql, params) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('audit time budget exhausted; retain the previous report');
    await client.query(`SET LOCAL statement_timeout = '${Math.min(3000, remaining)}ms'`);
    return client.query(sql, params);
  }
  async function loadTokens(row) {
    const { rows } = await query(`SELECT CASE WHEN cardinality(tokens) <= $2 THEN tokens ELSE NULL END AS tokens
      FROM (SELECT ${SCOPE_TOKENS_SQL} AS tokens
        FROM robinhood_wallet_transfer_scan_scopes s
        LEFT JOIN robinhood_wallet_transfer_token_scopes t ON t.chain=s.chain AND t.scope_hash=s.token_scope_hash
        WHERE s.scan_scope_id=$1) source`, [row.scan_scope_id, options.maxTokens]);
    const tokens = rows[0]?.tokens;
    const hash = fingerprint(tokens, row.token_scope_hash);
    return { tokens, hash };
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
    const identity = [options.projectionVersion, options.stream];
    const highWaterId = input.resume?.highWaterId || (await query(`SELECT COALESCE(MAX(scan_scope_id),0)::text AS id
      FROM robinhood_wallet_transfer_scan_scopes WHERE chain='robinhood' AND projection_version=$1 AND stream=$2`, identity)).rows[0].id;
    const totals = { ...Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0])), ...input.resume?.totals };
    let last = input.resume?.last || null;
    let previousTokens = null;
    if (last) {
      const current = (await query(`SELECT ${COLUMNS} FROM robinhood_wallet_transfer_scan_scopes
        WHERE scan_scope_id=$3 AND chain='robinhood' AND projection_version=$1 AND stream=$2`,
      [...identity, last.row.scan_scope_id])).rows[0];
      if (JSON.stringify(current) !== JSON.stringify(last.row)) throw new Error('resume anchor changed');
      const loaded = await loadTokens(current);
      if (loaded.hash !== last.hash) throw new Error('resume anchor changed');
      previousTokens = loaded.tokens;
    }
    const measured = [];
    let stopReason = 'range-limit';
    while (measured.length < options.maxRanges) {
      if (Date.now() >= deadline) { stopReason = 'time-budget'; break; }
      const after = last ? [last.row.through_block, last.row.from_block, last.row.scan_scope_id] : ['-1', '-1', '0'];
      const row = (await query(`SELECT ${COLUMNS} FROM robinhood_wallet_transfer_scan_scopes
        WHERE chain='robinhood' AND projection_version=$1 AND stream=$2 AND scan_scope_id <= $3
          AND (through_block,from_block,scan_scope_id) > ($4::bigint,$5::bigint,$6::bigint)
        ORDER BY through_block,from_block,scan_scope_id LIMIT 1`,
      [...identity, highWaterId, ...after])).rows[0];
      if (!row) { stopReason = 'cohort-end'; break; }
      if (row.scope_id) { stopReason = 'versioned-boundary'; break; }
      const { tokens, hash } = await loadTokens(row);
      measured.push(recordRange(totals, last, row, previousTokens, tokens, hash));
      previousTokens = tokens;
      last = { row, hash };
    }
    await client.query('COMMIT');
    return { mode: 'read-only', stopReason, measured, totals, elapsedMs: Date.now() - started,
      resume: last ? { format: 1, projectionVersion: options.projectionVersion, stream: options.stream,
        highWaterId, totals, last } : null,
      qualification: 'Logical counts only; no canonical-hash verification, physical-byte estimate or conversion authorization.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { auditScopeHistory, difference, fingerprint };

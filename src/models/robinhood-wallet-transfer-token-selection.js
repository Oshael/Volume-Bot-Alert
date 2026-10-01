'use strict';

const MAX_CANDIDATES = 10000;
function normalizeCandidates(values) {
  if (!Array.isArray(values) || values.length > MAX_CANDIDATES) throw new Error('invalid candidate count');
  const tokens = values.map((value) => String(value).trim().toLowerCase());
  if (tokens.some((token) => !/^0x[0-9a-f]{40}$/.test(token))) throw new Error('invalid candidate address');
  return [...new Set(tokens)].sort();
}
function trackedTokenSql(filtered, maximum) {
  if (maximum != null && (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 500000)) {
    throw new Error('invalid tracked token limit');
  }
  return `SELECT token_address FROM robinhood_holder_token_states
    WHERE chain=$1 AND ledger_status IN ('backfilling','shadow','live')
      ${filtered ? 'AND token_address=ANY($2::varchar[])' : ''}
    UNION
    SELECT token.token_address FROM robinhood_holder_global_backfill_tokens token
    INNER JOIN robinhood_holder_global_backfill_runs run ON run.id=token.run_id AND run.chain=token.chain
    WHERE token.chain=$1 AND token.status='active'
      AND run.barrier_block IS NOT NULL AND run.status <> 'completed'
      ${filtered ? 'AND token.token_address=ANY($2::varchar[])' : ''}
    ORDER BY token_address ${maximum == null ? '' : `LIMIT ${maximum + 1}`}`;
}
async function listTrackedTokens(database, candidates = null, maximum = null) {
  const sql = trackedTokenSql(candidates !== null, maximum);
  const tokens = candidates === null ? null : normalizeCandidates(candidates);
  if (tokens?.length === 0) return Object.freeze([]);
  const { rows } = await database.query(sql, tokens === null ? ['robinhood'] : ['robinhood', tokens]);
  if (maximum != null && rows.length > maximum) throw new Error('tracked token limit exceeded');
  return Object.freeze(rows.map((row) => row.token_address));
}
async function listTrackedCandidates(database, candidates) {
  return listTrackedTokens(database, normalizeCandidates(candidates));
}
module.exports = { listTrackedCandidates, listTrackedTokens, normalizeCandidates, trackedTokenSql };

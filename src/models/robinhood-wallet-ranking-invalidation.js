'use strict';

const CHANNEL = 'robinhood_wallet_ranking_invalidated';
const SOURCES = new Set(['positions', 'transfers', 'swaps', 'prices', 'reorg']);

function withRankingInvalidation(updateSql, source, extraSelect = '') {
  if (!SOURCES.has(source)) throw new Error('ranking invalidation source is invalid');
  return `WITH changed AS (${updateSql}), revised AS (
    INSERT INTO robinhood_wallet_ranking_revisions (source, version)
    SELECT '${source}', 1 FROM changed
    ON CONFLICT (source) DO UPDATE SET
      version = robinhood_wallet_ranking_revisions.version + 1,
      updated_at = NOW()
    RETURNING source, version
  ) SELECT changed.*,
    pg_notify('${CHANNEL}', json_build_object(
      'chain', 'robinhood', 'source', revised.source,
      'version', revised.version::text
    )::text) AS ranking_notified${extraSelect ? `, ${extraSelect}` : ''}
  FROM changed CROSS JOIN revised`;
}

async function publishRankingInvalidation(client, source) {
  if (typeof client?.query !== 'function') throw new TypeError('transaction client is required');
  if (!SOURCES.has(source)) throw new Error('ranking invalidation source is invalid');
  const result = await client.query(
    `WITH revised AS (
       INSERT INTO robinhood_wallet_ranking_revisions (source, version)
       VALUES ($1, 1)
       ON CONFLICT (source) DO UPDATE SET
         version = robinhood_wallet_ranking_revisions.version + 1,
         updated_at = NOW()
       RETURNING source, version
     )
     SELECT source, version::text,
       pg_notify($2, json_build_object(
         'chain', 'robinhood', 'source', source, 'version', version::text
       )::text) AS notified
     FROM revised`,
    [source, CHANNEL]
  );
  return result.rows[0].version;
}

module.exports = { CHANNEL, publishRankingInvalidation, withRankingInvalidation };

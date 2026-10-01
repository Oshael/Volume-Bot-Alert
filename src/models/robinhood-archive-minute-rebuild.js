const { __private: persistence } = require('./robinhood-persistence');
const { STOCKS } = require('../services/robinhood-archive-replay-scope');
const { publishRankingInvalidation } = require('./robinhood-wallet-ranking-invalidation');

async function rebuildArchiveMinute(database, rows, minute) {
  if (!rows.length) return { minutes: 0, hours: 0 };
  if (rows.length > 100_000 || !Number.isFinite(Date.parse(minute)) || Date.parse(minute) % 60_000) {
    throw new Error('Archive rebuild requires a bounded, complete minute');
  }
  const identities = rows.map((row) => ({
    transactionHash: row.transaction_hash, logIndex: row.log_index,
    blockNumber: row.block_number, protocol: row.protocol, marketKey: row.market_key,
    tokenAddress: row.token_address, quoteAddress: row.quote_address,
  }));
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const result = await client.query(`
      SELECT observation.status, observation.protocol,
        observation.market_key AS "marketKey", observation.observed_at AS "observedAt"
      FROM jsonb_to_recordset($1::jsonb) AS target(
        "transactionHash" text, "logIndex" bigint, "blockNumber" bigint,
        protocol text, "marketKey" text, "tokenAddress" text, "quoteAddress" text
      )
      JOIN robinhood_market_observations observation
        ON observation.chain = 'robinhood'
       AND observation.transaction_hash = target."transactionHash"
       AND observation.log_index = target."logIndex"
       AND observation.block_number = target."blockNumber"
       AND observation.protocol = target.protocol
       AND observation.market_key = target."marketKey"
       AND observation.token_address = target."tokenAddress"
       AND observation.quote_address = target."quoteAddress"
      WHERE observation.observed_at >= $2::timestamptz
        AND observation.observed_at < $2::timestamptz + INTERVAL '1 minute'
        AND observation.quote_address = ANY($3::text[])
        AND observation.status IN ('accepted', 'rejected')
      FOR SHARE OF observation`, [JSON.stringify(identities), minute, STOCKS]);
    if (result.rows.length !== identities.length) {
      throw new Error('Stock minute has missing, pending or conflicting observations');
    }
    const extra = await client.query(`
      WITH input AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
          "transactionHash" text, "logIndex" bigint, protocol text, "marketKey" text)
      ), targets AS (SELECT DISTINCT protocol, "marketKey" AS market_key FROM input)
      SELECT 1 FROM targets JOIN robinhood_market_observations observation USING (protocol, market_key)
      WHERE observation.chain = 'robinhood' AND observation.status = 'accepted'
        AND observation.observed_at >= $2::timestamptz
        AND observation.observed_at < $2::timestamptz + INTERVAL '1 minute'
        AND NOT EXISTS (SELECT 1 FROM input
          WHERE input."transactionHash" = observation.transaction_hash
            AND input."logIndex" = observation.log_index)
      LIMIT 1`, [JSON.stringify(identities), minute]);
    if (extra.rowCount) throw new Error('Stock minute contains accepted observations absent from archive');
    const stale = await client.query(`
      WITH targets AS (
        SELECT DISTINCT protocol, "marketKey" AS market_key
        FROM jsonb_to_recordset($1::jsonb) AS row(protocol text, "marketKey" text)
      )
      SELECT 1 FROM targets
      JOIN robinhood_market_buckets_1m bucket USING (protocol, market_key)
      WHERE bucket.chain = 'robinhood' AND bucket.bucket_ts = $2::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM robinhood_market_observations observation
          WHERE observation.chain = bucket.chain AND observation.protocol = bucket.protocol
            AND observation.market_key = bucket.market_key AND observation.status = 'accepted'
            AND observation.observed_at >= bucket.bucket_ts
            AND observation.observed_at < bucket.bucket_ts + INTERVAL '1 minute'
        ) LIMIT 1`, [JSON.stringify(result.rows), minute]);
    if (stale.rowCount) throw new Error('Stored Stock minute has no accepted archive observations; review required');
    const minutes = await persistence.rebuildReplayMinuteBuckets(client, result.rows);
    const hours = await persistence.refreshHourlyBuckets(client, result.rows);
    if (minutes) await publishRankingInvalidation(client, 'prices');
    await client.query('COMMIT');
    return { minutes, hours };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { rebuildArchiveMinute };

const db = require('./db');

const CHAIN = 'robinhood';

function normalize(value) {
  const row = {
    wallet_address: String(value.walletAddress).toLowerCase(),
    first_block_number: String(value.blockNumber),
    first_block_hash: String(value.blockHash).toLowerCase(),
    first_block_time: new Date(value.blockTime).toISOString(),
    first_transaction_hash: String(value.transactionHash).toLowerCase(),
    first_transaction_index: String(value.transactionIndex),
    first_nonce: String(value.nonce),
    coverage_origin_block: String(value.coverageOriginBlock),
    source_stream: String(value.sourceStream),
    observed_at: new Date(value.observedAt).toISOString(),
  };
  if (!/^0x[0-9a-f]{40}$/.test(row.wallet_address)
      || !/^0x[0-9a-f]{64}$/.test(row.first_block_hash)
      || !/^0x[0-9a-f]{64}$/.test(row.first_transaction_hash)
      || !['seed', 'live'].includes(row.source_stream)
      || ![row.first_block_number, row.first_transaction_index, row.first_nonce,
        row.coverage_origin_block].every((item) => /^\d+$/.test(item))) {
    throw new Error('signed origin is invalid');
  }
  return row;
}

function compare(left, right) {
  const block = BigInt(left.first_block_number) - BigInt(right.first_block_number);
  if (block) return block < 0n ? -1 : 1;
  const index = BigInt(left.first_transaction_index) - BigInt(right.first_transaction_index);
  return index === 0n ? 0 : index < 0n ? -1 : 1;
}

function sameIdentity(left, right) {
  return compare(left, right) === 0
    && left.first_block_hash === right.first_block_hash
    && left.first_transaction_hash === right.first_transaction_hash
    && left.first_nonce === right.first_nonce;
}

function dedupe(values) {
  const rows = new Map();
  for (const value of values.map(normalize)) {
    const current = rows.get(value.wallet_address);
    if (!current) { rows.set(value.wallet_address, value); continue; }
    if (current.first_transaction_hash === value.first_transaction_hash
        && !sameIdentity(value, current)) {
      throw Object.assign(new Error('signed origin batch has a canonical conflict'), {
        code: 'signed_origin_reorg_conflict',
      });
    }
    const order = compare(value, current);
    if (order < 0 || (order === 0 && sameIdentity(value, current)
        && BigInt(value.coverage_origin_block) < BigInt(current.coverage_origin_block))) {
      rows.set(value.wallet_address, value);
    } else if (order === 0 && !sameIdentity(value, current)) {
      throw Object.assign(new Error('signed origin batch has a canonical conflict'), {
        code: 'signed_origin_reorg_conflict',
      });
    }
  }
  return [...rows.values()];
}

function createRobinhoodWalletSignedOriginRepository(options = {}) {
  const database = options.database || db;

  async function persistOrigins(values = []) {
    if (!Array.isArray(values)) throw new TypeError('origins must be a list');
    const rows = dedupe(values);
    if (!rows.length) return Object.freeze({ originsConsidered: 0, originsWritten: 0 });
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const written = await client.query(`INSERT INTO robinhood_wallet_signed_origins (
        chain, wallet_address, first_block_number, first_block_hash, first_block_time,
        first_transaction_hash, first_transaction_index, first_nonce,
        coverage_origin_block, source_stream, observed_at
      ) SELECT $1, item.* FROM jsonb_to_recordset($2::jsonb) AS item(
        wallet_address text, first_block_number bigint, first_block_hash text,
        first_block_time timestamptz, first_transaction_hash text,
        first_transaction_index integer, first_nonce numeric,
        coverage_origin_block bigint, source_stream text, observed_at timestamptz
      ) ON CONFLICT (chain, wallet_address) DO UPDATE SET
        first_block_number = EXCLUDED.first_block_number,
        first_block_hash = EXCLUDED.first_block_hash,
        first_block_time = EXCLUDED.first_block_time,
        first_transaction_hash = EXCLUDED.first_transaction_hash,
        first_transaction_index = EXCLUDED.first_transaction_index,
        first_nonce = EXCLUDED.first_nonce,
        coverage_origin_block = LEAST(
          robinhood_wallet_signed_origins.coverage_origin_block,
          EXCLUDED.coverage_origin_block
        ),
        source_stream = EXCLUDED.source_stream,
        observed_at = EXCLUDED.observed_at,
        updated_at = NOW()
      WHERE (EXCLUDED.first_transaction_hash <>
               robinhood_wallet_signed_origins.first_transaction_hash
             AND (EXCLUDED.first_block_number, EXCLUDED.first_transaction_index) <
               (robinhood_wallet_signed_origins.first_block_number,
                robinhood_wallet_signed_origins.first_transaction_index))
         OR (EXCLUDED.first_block_number = robinhood_wallet_signed_origins.first_block_number
             AND EXCLUDED.first_transaction_index =
               robinhood_wallet_signed_origins.first_transaction_index
             AND EXCLUDED.first_block_hash = robinhood_wallet_signed_origins.first_block_hash
             AND EXCLUDED.first_transaction_hash =
               robinhood_wallet_signed_origins.first_transaction_hash
             AND EXCLUDED.first_nonce = robinhood_wallet_signed_origins.first_nonce
             AND EXCLUDED.coverage_origin_block <
               robinhood_wallet_signed_origins.coverage_origin_block)
      RETURNING wallet_address`, [CHAIN, JSON.stringify(rows)]);
      const current = (await client.query(`SELECT wallet_address,
        first_block_number::text, first_block_hash, first_transaction_hash,
        first_transaction_index::text, first_nonce::text
        FROM robinhood_wallet_signed_origins
        WHERE chain = $1 AND wallet_address = ANY($2::varchar[])`,
      [CHAIN, rows.map((row) => row.wallet_address)])).rows;
      const stored = new Map(current.map((row) => [row.wallet_address, row]));
      for (const row of rows) {
        const actual = stored.get(row.wallet_address);
        if (!actual || compare(actual, row) > 0
            || (compare(actual, row) === 0 && !sameIdentity(actual, row))
            || (actual.first_transaction_hash === row.first_transaction_hash
              && !sameIdentity(actual, row))) {
          throw Object.assign(new Error('signed origin conflicts with canonical storage'), {
            code: 'signed_origin_reorg_conflict',
          });
        }
      }
      await client.query('COMMIT');
      return Object.freeze({ originsConsidered: rows.length, originsWritten: written.rowCount });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ persistOrigins });
}

module.exports = { createRobinhoodWalletSignedOriginRepository };

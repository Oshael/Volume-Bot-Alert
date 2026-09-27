'use strict';

const CHAIN = 'robinhood';

function mirrorError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}

async function mirrorCapturedTransactions(client, blocks, options = {}) {
  if (options.enabled === false) return { inserted: 0 };
  const hashes = blocks.map(({ block_hash: hash }) => hash);
  if (!hashes.length) return { inserted: 0 };
  let copied;
  try {
    copied = await client.query(`WITH source AS MATERIALIZED (
        SELECT tx.chain, block.block_number, tx.block_hash, tx.transaction_hash,
               tx.transaction_index, tx.from_address, tx.to_address,
               tx.receipt_succeeded, tx.contract_address, tx.nonce, tx.value_wei
          FROM public.robinhood_chain_transactions tx
          JOIN public.robinhood_chain_blocks block
            ON block.chain=tx.chain AND block.block_hash=tx.block_hash
         WHERE tx.chain=$1 AND tx.block_hash=ANY($2::varchar[])
      ), inserted AS (
        INSERT INTO public.robinhood_chain_transactions_shadow (
          chain, block_number, block_hash, transaction_hash, transaction_index,
          from_address, to_address, receipt_succeeded, contract_address, nonce, value_wei
        ) SELECT chain, block_number, block_hash, transaction_hash, transaction_index,
                 from_address, to_address, receipt_succeeded, contract_address, nonce, value_wei
            FROM source WHERE TRUE
        ON CONFLICT (chain, block_number, block_hash, transaction_hash) DO NOTHING
        RETURNING 1
      ) SELECT (SELECT count(*) FROM source) AS source_count,
               (SELECT count(*) FROM inserted) AS inserted_count`, [CHAIN, hashes]);
  } catch (error) {
    if (error.code === '23514' || error.code === '42P01') {
      throw mirrorError('capture_transaction_shadow_unavailable',
        'chain transaction shadow is missing a partition or its schema', error);
    }
    throw error;
  }
  const { source_count: sourceCount, inserted_count: insertedCount } = copied.rows[0];
  if (sourceCount !== insertedCount) {
    const mismatch = await client.query(`SELECT tx.block_hash, tx.transaction_hash
        FROM public.robinhood_chain_transactions tx
        JOIN public.robinhood_chain_blocks block
          ON block.chain=tx.chain AND block.block_hash=tx.block_hash
        LEFT JOIN public.robinhood_chain_transactions_shadow shadow
          ON shadow.chain=tx.chain AND shadow.block_number=block.block_number
         AND shadow.block_hash=tx.block_hash
         AND shadow.transaction_hash=tx.transaction_hash
       WHERE tx.chain=$1 AND tx.block_hash=ANY($2::varchar[])
         AND to_jsonb(tx) IS DISTINCT FROM to_jsonb(shadow)-'block_number'
       LIMIT 1`, [CHAIN, hashes]);
    if (mismatch.rowCount) {
      throw mirrorError('capture_transaction_shadow_mismatch',
        `chain transaction shadow differs at ${mismatch.rows[0].block_hash}:${mismatch.rows[0].transaction_hash}`);
    }
  }
  return { inserted: Number(insertedCount) };
}

module.exports = { mirrorCapturedTransactions };

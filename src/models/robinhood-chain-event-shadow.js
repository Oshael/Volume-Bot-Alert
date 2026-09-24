'use strict';

const CHAIN = 'robinhood';

function shadowError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}

async function mirrorCapturedEvents(client, blocks) {
  const hashes = blocks.map(({ block_hash: hash }) => hash);
  if (!hashes.length) return { inserted: 0 };
  let inserted;
  try {
    inserted = await client.query(`INSERT INTO public.robinhood_chain_events_shadow (
        chain, block_hash, block_number, transaction_hash, transaction_index,
        log_index, address, topic0, topics, data, captured_at
      ) SELECT event.chain, event.block_hash, event.block_number,
          event.transaction_hash, event.transaction_index, event.log_index,
          event.address, event.topic0, event.topics, event.data, event.captured_at
        FROM public.robinhood_chain_events event
       WHERE event.chain=$1 AND event.block_hash=ANY($2::varchar[])
      ON CONFLICT (chain, block_number, block_hash, log_index) DO NOTHING`,
    [CHAIN, hashes]);
  } catch (error) {
    if (error.code === '23514' || error.code === '42P01') {
      throw shadowError('capture_shadow_unavailable',
        'chain event shadow is missing a partition or its schema', error);
    }
    throw error;
  }
  const mismatch = await client.query(`SELECT event.block_hash, event.log_index
      FROM public.robinhood_chain_events event
      LEFT JOIN public.robinhood_chain_events_shadow shadow
        ON shadow.chain=event.chain AND shadow.block_number=event.block_number
       AND shadow.block_hash=event.block_hash AND shadow.log_index=event.log_index
     WHERE event.chain=$1 AND event.block_hash=ANY($2::varchar[])
       AND to_jsonb(event) IS DISTINCT FROM to_jsonb(shadow)
     LIMIT 1`, [CHAIN, hashes]);
  if (mismatch.rowCount) {
    throw shadowError('capture_shadow_mismatch',
      `chain event shadow differs at ${mismatch.rows[0].block_hash}:${mismatch.rows[0].log_index}`);
  }
  const extra = await client.query(`SELECT shadow.block_hash, shadow.log_index
      FROM public.robinhood_chain_events_shadow shadow
      LEFT JOIN public.robinhood_chain_events event
        ON event.chain=shadow.chain AND event.block_hash=shadow.block_hash
       AND event.log_index=shadow.log_index
     WHERE shadow.chain=$1 AND shadow.block_hash=ANY($2::varchar[])
       AND event.block_hash IS NULL
     LIMIT 1`, [CHAIN, hashes]);
  if (extra.rowCount) {
    throw shadowError('capture_shadow_mismatch',
      `chain event shadow has an extra row at ${extra.rows[0].block_hash}:${extra.rows[0].log_index}`);
  }
  return { inserted: inserted.rowCount };
}

module.exports = { mirrorCapturedEvents };

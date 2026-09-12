'use strict';

async function insertEvidence(client, rows, resolveCurve) {
  if (!rows.length) return 0;
  const result = await client.query(
    `WITH items AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
         block_hash text, block_number bigint, transaction_hash text, log_index integer,
         event_address text, token_address text, curve_address text, event_kind text,
         quote_delta_raw numeric, graduation_threshold_raw numeric
       )
     )
     INSERT INTO token_launchpad_lifecycle_events(
       chain, block_hash, block_number, transaction_hash, log_index, event_address,
       token_address, curve_address, launchpad_id, event_kind, quote_delta_raw,
       graduation_threshold_raw, evidence_source
     )
     SELECT 'robinhood', item.block_hash, item.block_number, item.transaction_hash,
            item.log_index, item.event_address, COALESCE(item.token_address, launch.token_address),
            item.curve_address, 'pons-v2', item.event_kind, item.quote_delta_raw,
            item.graduation_threshold_raw, 'canonical_event'
       FROM items item
       LEFT JOIN LATERAL (
         SELECT evidence.token_address
           FROM token_launchpad_lifecycle_events evidence
           JOIN robinhood_chain_blocks block
             ON block.chain=evidence.chain AND block.block_hash=evidence.block_hash
          WHERE $2::boolean AND evidence.chain='robinhood'
            AND evidence.event_kind='launched' AND evidence.curve_address=item.curve_address
            AND block.canonical=TRUE
          ORDER BY evidence.block_number DESC, evidence.log_index DESC LIMIT 1
       ) launch ON TRUE
      WHERE item.token_address IS NOT NULL OR launch.token_address IS NOT NULL
     ON CONFLICT (chain, block_hash, log_index) DO NOTHING`,
    [JSON.stringify(rows), resolveCurve]
  );
  return result.rowCount;
}

async function appendRobinhoodTokenLifecycleEvidence(client, evidence = []) {
  const direct = evidence.filter((item) => item.token_address);
  const curves = evidence.filter((item) => !item.token_address);
  return (await insertEvidence(client, direct, false))
    + (await insertEvidence(client, curves, true));
}

module.exports = { appendRobinhoodTokenLifecycleEvidence };

// Static SQL fragments only: callers provide internal column/parameter names.
// A creator hint or pool discovery timestamp cannot establish contract birth.
function canonicalTokenCreationSql(addressSql, cutoffSql, partitioned = false) {
  return `SELECT (EXTRACT(EPOCH FROM block.block_timestamp)*1000)::bigint AS created_at_ms
    FROM robinhood_token_attributions attribution
    JOIN robinhood_chain_blocks block ON block.chain=attribution.chain
      AND block.block_number=attribution.attribution_block AND block.canonical
    JOIN robinhood_chain_transactions transaction ON transaction.chain=block.chain
      ${partitioned ? 'AND transaction.block_number=block.block_number' : ''}
      AND transaction.block_hash=block.block_hash
      AND transaction.transaction_hash=attribution.attribution_tx_hash
    WHERE attribution.chain='robinhood' AND attribution.token_address=${addressSql}
      AND attribution.source IN ('rpc_direct','rpc_trace','blockscout_internal','launchpad_event')
      AND attribution.creator_address IS NOT NULL AND transaction.receipt_succeeded
      AND block.block_timestamp <= ${cutoffSql}::timestamptz
      AND (attribution.source<>'rpc_direct'
        OR (transaction.to_address IS NULL AND transaction.contract_address=attribution.token_address))`;
}

const layouts = new WeakMap();
function transactionPartitioned(database) {
  if (!layouts.has(database)) {
    const sql = `SELECT relation.relkind='p' AS partitioned FROM pg_class relation
      WHERE relation.oid=to_regclass('robinhood_chain_transactions')`;
    const load = typeof database.queryWithStatementTimeout === 'function'
      ? () => database.queryWithStatementTimeout(sql, [], 5000)
      : () => database.query(sql);
    layouts.set(database, Promise.resolve().then(load).then(({ rows }) => {
      if (typeof rows[0]?.partitioned !== 'boolean') throw new Error('canonical transaction layout is unavailable');
      return rows[0].partitioned;
    }).catch((error) => { layouts.delete(database); throw error; }));
  }
  return layouts.get(database);
}

module.exports = { canonicalTokenCreationSql, transactionPartitioned };

'use strict';

/** Insert one capture batch into the currently active transaction layout. */
const CHAIN = 'robinhood';
const ACTIVE = 'public.robinhood_chain_transactions';

function insertSql(partitioned, relation) {
  const numberColumn = partitioned ? 'block_number, ' : '';
  const numberValue = partitioned ? 'item.block_number, ' : '';
  const numberType = partitioned ? 'block_number BIGINT, ' : '';
  return `INSERT INTO ${relation}(
      chain, ${numberColumn}block_hash, transaction_hash, transaction_index, from_address,
      to_address, receipt_succeeded, contract_address, nonce, value_wei
    ) SELECT $1, ${numberValue}item.block_hash, item.transaction_hash,
        item.transaction_index, item.from_address, item.to_address,
        item.receipt_succeeded, item.contract_address, item.nonce, item.value_wei
      FROM jsonb_to_recordset($2::jsonb) AS item(
        ${numberType}block_hash TEXT, transaction_hash TEXT, transaction_index INTEGER,
        from_address TEXT, to_address TEXT, receipt_succeeded BOOLEAN,
        contract_address TEXT, nonce NUMERIC, value_wei NUMERIC
      )`;
}

async function insertCapturedTransactions(client, transactions, options = {}) {
  const relation = options.relation || ACTIVE;
  if (!/^public\.[a-z_][a-z0-9_]*$/.test(relation)) {
    throw new Error('invalid transaction relation');
  }
  await client.query(insertSql(options.partitioned === true, relation),
    [CHAIN, JSON.stringify(transactions)]);
}

module.exports = { insertCapturedTransactions };

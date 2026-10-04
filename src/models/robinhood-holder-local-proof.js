'use strict';
const { captureDigest } = require('./robinhood-chain-capture-digest');
const { lockRobinhoodCanonicalProjection } = require('./robinhood-canonical-projection-fence');

function gap(reason) {
  return Object.assign(new Error(`local holder evidence unavailable: ${reason}`), {
    code: 'canonical_holder_source_gap', reason,
  });
}

function assertLocalFrontier(row) {
  if (row.recovery_state !== 'running' || row.generation == null
      || row.checkpoint_hash !== row.canonical_hash
      || row.canonical_hash == null || BigInt(row.next_block) !== BigInt(row.checkpoint_block) + 1n) {
    throw gap('frontier-unproven');
  }
}

// Reuse the capture digest, including empty blocks and every captured event.
// A Transfer-only count cannot detect pruning or a missing mint.
async function readLocalEvidence(client, fromBlock, toBlock) {
  const params = ['robinhood', String(fromBlock), String(toBlock)];
  const blocks = (await client.query(`SELECT block_number, block_hash, parent_hash,
    block_timestamp, capture_version, capture_digest FROM robinhood_chain_blocks
    WHERE chain=$1 AND canonical AND block_number BETWEEN $2::bigint AND $3::bigint
    ORDER BY block_number`, params)).rows;
  if (BigInt(blocks.length) !== toBlock - fromBlock + 1n) throw gap('block-gap');
  const parts = [];
  for (const [table, columns] of [
    ['robinhood_chain_transactions', `transaction_hash, transaction_index, from_address,
      to_address, receipt_succeeded, contract_address, nonce::text, value_wei::text`],
    ['robinhood_chain_events', `transaction_hash, transaction_index, log_index,
      address, topic0, topics, data`],
    ['robinhood_chain_v3_balance_snapshots', `log_index, pool_address, token_address,
      quote_address, balance_status, token_balance_raw::text, quote_balance_raw::text`],
  ]) {
    const result = await client.query(`SELECT evidence.block_hash, ${columns}
      FROM ${table} evidence JOIN robinhood_chain_blocks block
        ON block.chain=evidence.chain AND block.block_hash=evidence.block_hash
      WHERE block.chain=$1 AND block.canonical
        AND block.block_number BETWEEN $2::bigint AND $3::bigint`, params);
    const grouped = new Map();
    for (const { block_hash: hash, ...row } of result.rows) {
      if (!grouped.has(hash)) grouped.set(hash, []);
      grouped.get(hash).push(row);
    }
    parts.push(grouped);
  }
  const events = [];
  for (const [index, row] of blocks.entries()) {
    if (BigInt(row.block_number) !== fromBlock + BigInt(index)
        || (index > 0 && row.parent_hash !== blocks[index - 1].block_hash)) throw gap('block-gap');
    if (row.capture_version !== 4) throw gap('capture-version-unproven');
    const captured = parts.map((part) => part.get(row.block_hash) || []);
    captured[2] = captured[2].map(({ balance_status, token_balance_raw, quote_balance_raw, ...snapshot }) => ({
      ...snapshot, ...(balance_status === 'observed' ? {} : { balance_status }),
      token_balance_raw, quote_balance_raw,
    }));
    const digest = captureDigest({ number: BigInt(row.block_number), hash: row.block_hash,
      parentHash: row.parent_hash, timestamp: new Date(row.block_timestamp).toISOString(),
      captureVersion: row.capture_version }, ...captured);
    if (digest !== row.capture_digest) throw gap('capture-digest-mismatch');
    events.push(...captured[1].map((event) => ({ ...event,
      block_hash: row.block_hash, block_number: row.block_number })));
  }
  return events.sort((a, b) => Number(BigInt(a.block_number) - BigInt(b.block_number))
    || a.transaction_index - b.transaction_index || a.log_index - b.log_index);
}

async function fenceLocalReplay(client, input) {
  if (!input.localProof) return;
  try {
    await lockRobinhoodCanonicalProjection(client, {
      blockNumber: input.checkpoint.number, blockHash: input.checkpoint.hash,
    }, 'local holder replay');
  } catch (error) {
    if (error.code === 'canonical_projection_fence_conflict') throw gap('checkpoint-unproven');
    throw error;
  }
  const cursor = await client.query(`SELECT generation FROM robinhood_chain_capture_cursor
    WHERE chain='robinhood'`);
  if (String(cursor.rows[0]?.generation) !== input.localProof.generation) throw gap('generation-changed');
}

module.exports = { assertLocalFrontier, fenceLocalReplay, gap, readLocalEvidence };

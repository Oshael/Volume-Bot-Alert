'use strict';

const { createHash } = require('node:crypto');
const CHUNK_SIZE = 5000;

async function applyDelta(client, head, tokens, scopeHash) {
  const { rows } = await client.query(`SELECT token_address FROM robinhood_wallet_transfer_scope_members
    WHERE scope_id=$1 AND valid_to_version IS NULL`, [head.scope_id]);
  const previous = rows.map((row) => row.token_address).sort();
  if (previous.length !== head.token_count
    || createHash('sha256').update(previous.join('\n')).digest('hex') !== head.scope_hash) {
    throw new Error('active transfer scope membership does not match its head');
  }
  const before = new Set(previous);
  const after = new Set(tokens);
  const added = tokens.filter((token) => !before.has(token));
  const removed = previous.filter((token) => !after.has(token));
  const version = (BigInt(head.current_version) + 1n).toString();
  await client.query(`INSERT INTO robinhood_wallet_transfer_scope_versions
    (scope_id,scope_version,scope_hash) VALUES ($1,$2,$3)`, [head.scope_id, version, scopeHash]);
  for (let offset = 0; offset < removed.length; offset += CHUNK_SIZE) {
    const chunk = removed.slice(offset, offset + CHUNK_SIZE);
    const result = await client.query(`UPDATE robinhood_wallet_transfer_scope_members SET valid_to_version=$2
      WHERE scope_id=$1 AND token_address=ANY($3::text[]) AND valid_to_version IS NULL`,
    [head.scope_id, version, chunk]);
    if (result.rowCount !== chunk.length) throw new Error('transfer scope removal conflict');
  }
  for (let offset = 0; offset < added.length; offset += CHUNK_SIZE) {
    await client.query(`INSERT INTO robinhood_wallet_transfer_scope_members
      (scope_id,token_address,valid_from_version) SELECT $1,token,$2 FROM unnest($3::text[]) AS item(token)`,
    [head.scope_id, version, added.slice(offset, offset + CHUNK_SIZE)]);
  }
  await client.query(`UPDATE robinhood_wallet_transfer_scope_heads SET current_version=$2,
    scope_hash=$3,token_count=$4,loaded_tokens=$4 WHERE scope_id=$1`,
  [head.scope_id, version, scopeHash, tokens.length]);
  return { version, added: added.length, removed: removed.length };
}

// The projection caller already holds the cursor lock and owns this transaction.
async function persistVersionedScope(client, batch, scopeHash) {
  const { rows } = await client.query(`SELECT * FROM robinhood_wallet_transfer_scope_heads
    WHERE chain='robinhood' AND projection_version=$1 AND stream=$2 FOR UPDATE`,
  [batch.projectionVersion, batch.stream]);
  const head = rows[0];
  if (!head) return { format: 'legacy', reason: 'baseline-missing' };
  if (head.state !== 'ready') throw new Error('transfer scope baseline is not ready; complete the offline bootstrap');
  // A recovery crossing the baseline needs historical array proof until it catches up.
  if (BigInt(batch.captureScope.fromBlock) < BigInt(head.baseline_next_block)) {
    return { format: 'legacy', reason: 'before-baseline' };
  }
  const delta = head.scope_hash === scopeHash
    ? { version: head.current_version, added: 0, removed: 0 }
    : await applyDelta(client, head, batch.captureScope.tokenAddresses, scopeHash);
  await client.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes (
      chain,projection_version,stream,from_block,through_block,checkpoint_hash,scope_id,scope_version,filter_mode
    ) VALUES ('robinhood',$1,$2,$3,$4,$5,$6,$7,$8)`,
  [batch.projectionVersion, batch.stream, batch.captureScope.fromBlock, batch.checkpointBlock,
    batch.checkpointHash, head.scope_id, delta.version, batch.captureScope.filterMode]);
  return { format: 'versioned', scopeId: head.scope_id, ...delta };
}

module.exports = { persistVersionedScope };

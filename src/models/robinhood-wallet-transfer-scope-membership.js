'use strict';

const { createHash } = require('node:crypto');
const { SCOPE_TOKENS_SQL } = require('./robinhood-wallet-transfer-scope-bitmap');
const LEASES = ['robinhood-wallet-transfer-live-worker', 'robinhood-wallet-transfer-backfill-worker'];

function normalize(input = {}) {
  const stream = input.stream || 'live';
  const projectionVersion = input.projectionVersion || 'rh_transfer_v1';
  const batchSize = Number(input.batchSize ?? 5000);
  if (!['seed', 'live'].includes(stream) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(projectionVersion)) {
    throw new Error('invalid scope identity');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error('batchSize must be between 1 and 5000');
  }
  return { stream, projectionVersion, batchSize };
}

async function inspectScopeBaseline(database, input = {}) {
  const { stream, projectionVersion } = normalize(input);
  const result = await database.query(`SELECT c.version AS cursor_version, c.next_block,
      c.checkpoint_block, c.checkpoint_hash, s.scan_scope_id, s.token_scope_hash,
      cardinality(${SCOPE_TOKENS_SQL}) AS token_count,
      h.scope_id, h.state, h.loaded_tokens,
      EXISTS (SELECT 1 FROM worker_leases WHERE lease_key=ANY($3::text[])
        AND lease_until>clock_timestamp()) AS worker_active
    FROM robinhood_wallet_transfer_cursors c
    LEFT JOIN LATERAL (SELECT * FROM robinhood_wallet_transfer_scan_scopes s
      WHERE s.chain=c.chain AND s.projection_version=c.projection_version AND s.stream=c.stream
        AND s.through_block=c.checkpoint_block AND s.checkpoint_hash=c.checkpoint_hash
      ORDER BY s.scan_scope_id DESC LIMIT 1) s ON TRUE
    LEFT JOIN robinhood_wallet_transfer_token_scopes t
      ON t.chain=s.chain AND t.scope_hash=s.token_scope_hash
    LEFT JOIN robinhood_wallet_transfer_scope_heads h
      ON h.chain=c.chain AND h.projection_version=c.projection_version AND h.stream=c.stream
    WHERE c.chain='robinhood' AND c.projection_version=$1 AND c.stream=$2`,
  [projectionVersion, stream, LEASES]);
  if (!result.rows[0]) throw new Error('transfer cursor is missing');
  return result.rows[0];
}

async function createBaseline(client, identity, point) {
  if (!point.scan_scope_id || !point.token_count || BigInt(point.next_block) !== BigInt(point.checkpoint_block) + 1n) {
    throw new Error('committed scope at checkpoint is missing');
  }
  const { rows } = await client.query(`SELECT ${SCOPE_TOKENS_SQL} AS tokens
    FROM robinhood_wallet_transfer_scan_scopes s LEFT JOIN robinhood_wallet_transfer_token_scopes t
      ON t.chain=s.chain AND t.scope_hash=s.token_scope_hash WHERE s.scan_scope_id=$1`, [point.scan_scope_id]);
  const tokens = rows[0].tokens;
  if (tokens.some((token, index) => !/^0x[0-9a-f]{40}$/.test(token)
    || (index > 0 && tokens[index - 1] >= token))) throw new Error('baseline tokens must be normalized, sorted and unique');
  const hash = createHash('sha256').update(tokens.join('\n')).digest('hex');
  if (point.token_scope_hash && point.token_scope_hash !== hash) throw new Error('baseline scope hash mismatch');
  const inserted = await client.query(`INSERT INTO robinhood_wallet_transfer_scope_heads (
      chain,projection_version,stream,baseline_scan_scope_id,baseline_cursor_version,
      baseline_next_block,baseline_checkpoint_hash,scope_hash,token_count
    ) VALUES ('robinhood',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [identity.projectionVersion, identity.stream, point.scan_scope_id, point.cursor_version,
    point.next_block, point.checkpoint_hash, hash, tokens.length]);
  const head = inserted.rows[0];
  await client.query(`INSERT INTO robinhood_wallet_transfer_scope_versions
    (scope_id,scope_version,scope_hash) VALUES ($1,0,$2)`, [head.scope_id, hash]);
  return head;
}

function assertFence(head, point) {
  if (head.baseline_cursor_version !== point.cursor_version || head.baseline_next_block !== point.next_block
    || head.baseline_checkpoint_hash !== point.checkpoint_hash
    || head.baseline_scan_scope_id !== point.scan_scope_id) throw new Error('baseline cursor fence changed');
}

async function verifyBaseline(client, head) {
  const { rows } = await client.query(`SELECT array_agg(token_address ORDER BY token_address) AS tokens
    FROM robinhood_wallet_transfer_scope_members WHERE scope_id=$1 AND valid_from_version=0
      AND valid_to_version IS NULL`, [head.scope_id]);
  const tokens = rows[0].tokens || [];
  if (tokens.length !== head.token_count
    || createHash('sha256').update(tokens.join('\n')).digest('hex') !== head.scope_hash) {
    throw new Error('copied baseline scope hash mismatch');
  }
}

async function copyBatch(client, head, batchSize) {
  const inserted = await client.query(`INSERT INTO robinhood_wallet_transfer_scope_members
      (scope_id,token_address,valid_from_version)
    SELECT $1,token,0 FROM robinhood_wallet_transfer_scan_scopes s
    LEFT JOIN robinhood_wallet_transfer_token_scopes t ON t.chain=s.chain AND t.scope_hash=s.token_scope_hash
    CROSS JOIN LATERAL unnest((${SCOPE_TOKENS_SQL})[$3:$4]) AS item(token)
    WHERE s.scan_scope_id=$2`,
  [head.scope_id, head.baseline_scan_scope_id, head.loaded_tokens + 1, head.loaded_tokens + batchSize]);
  if (inserted.rowCount !== Math.min(batchSize, head.token_count - head.loaded_tokens)) {
    throw new Error('baseline token count changed');
  }
  const loaded = head.loaded_tokens + inserted.rowCount;
  if (loaded === head.token_count) await verifyBaseline(client, head);
  const result = await client.query(`UPDATE robinhood_wallet_transfer_scope_heads SET loaded_tokens=$2,
    state=CASE WHEN $2=token_count THEN 'ready' ELSE 'preparing' END WHERE scope_id=$1
    RETURNING scope_id,state,loaded_tokens,token_count`, [head.scope_id, loaded]);
  return { ...result.rows[0], inserted: inserted.rowCount };
}

async function prepareScopeBaseline(database, input = {}) {
  const identity = normalize(input);
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query('SELECT lease_key FROM worker_leases WHERE lease_key=ANY($1::text[]) FOR UPDATE', [LEASES]);
    await client.query(`SELECT version FROM robinhood_wallet_transfer_cursors WHERE chain='robinhood'
      AND projection_version=$1 AND stream=$2 FOR UPDATE`, [identity.projectionVersion, identity.stream]);
    const point = await inspectScopeBaseline(client, identity);
    if (point.worker_active) throw new Error('wallet-transfer worker lease is active');
    const existing = await client.query(`SELECT * FROM robinhood_wallet_transfer_scope_heads
      WHERE chain='robinhood' AND projection_version=$1 AND stream=$2 FOR UPDATE`,
    [identity.projectionVersion, identity.stream]);
    const head = existing.rows[0] || await createBaseline(client, identity, point);
    assertFence(head, point);
    const result = head.state === 'ready'
      ? { scope_id: head.scope_id, state: head.state, loaded_tokens: head.loaded_tokens,
        token_count: head.token_count, inserted: 0 }
      : await copyBatch(client, head, identity.batchSize);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { inspectScopeBaseline, prepareScopeBaseline };

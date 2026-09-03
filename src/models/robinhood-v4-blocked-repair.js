const v4 = require('../services/uniswap-v4-decoder');
const { matchesLedger } = require('../utils/preview-robinhood-v4-blocked');
const { createV4BlockedPreviewRepository } = require('./robinhood-v4-blocked-preview');
const { BLOCKED_RECOVERY_ERROR } = require('./robinhood-head-processing');

const key = (e) => `${e.transactionHash}:${e.logIndex}`;
const rangeKey = (e) => `${e.tickLower}:${e.tickUpper}`;
const order = (a, b) => BigInt(a.blockNumber) - BigInt(b.blockNumber) || BigInt(a.logIndex) - BigInt(b.logIndex);
function requireTrue(ok, message) { if (!ok) throw new Error(message); }
function validateShape(e) {
  for (const [fields, pattern] of [
    [['transactionHash', 'blockHash', 'salt'], /^0x[0-9a-f]{64}$/],
    [['sender'], /^0x[0-9a-f]{40}$/], [['blockNumber', 'logIndex', 'timestampMs'], /^\d+$/],
    [['liquidityDelta'], /^-?\d+$/],
  ]) requireTrue(fields.every((field) => pattern.test(e[field])), 'Invalid archive event shape');
  requireTrue(e.kind === 'modify-liquidity' && e.protocol === 'uniswap-v4'
    && Number.isSafeInteger(Number(e.timestampMs)) && Number.isSafeInteger(e.tickLower)
    && Number.isSafeInteger(e.tickUpper) && e.tickLower >= -887272 && e.tickUpper <= 887272
    && e.tickLower < e.tickUpper && BigInt(e.liquidityDelta) >= -(1n << 127n)
    && BigInt(e.liquidityDelta) < (1n << 127n), 'Invalid archive event values');
}
function validateEvents({ target: t, events, nextBlock }) {
  requireTrue(events.length > 0 && events.length <= 100000
    && BigInt(nextBlock) === BigInt(t.blocked_block) + 1n, 'Incomplete pool checkpoint');
  const balances = new Map(); const seen = new Set();
  for (const [i, e] of events.entries()) {
    validateShape(e);
    requireTrue(e.poolId === t.pool_id && e.marketKey === t.market_key
      && e.tickLower % Number(t.tick_spacing) === 0 && e.tickUpper % Number(t.tick_spacing) === 0
      && BigInt(e.blockNumber) >= BigInt(t.discovery_block) && BigInt(e.blockNumber) <= BigInt(t.blocked_block)
      && !seen.has(key(e)) && (!i || order(events[i - 1], e) < 0n), 'Invalid archive event/order');
    seen.add(key(e));
    balances.set(rangeKey(e), (balances.get(rangeKey(e)) || 0n) + BigInt(e.liquidityDelta));
    requireTrue(balances.get(rangeKey(e)) >= 0n, 'Negative archive prefix');
  }
  const last = events.at(-1);
  requireTrue(key(last) === `${t.transaction_hash}:${t.log_index}`
    && last.blockNumber === t.blocked_block && last.blockHash === t.block_hash, 'Blocker mismatch');
}
function sameCapture(e, row, tickSpacing) {
  const decoded = v4.decodeModifyLiquidity({ address: row.address, topics: row.topics, data: row.data,
    blockNumber: row.block_number, blockHash: row.block_hash, transactionHash: row.transaction_hash,
    logIndex: row.log_index, blockTimestamp: String(BigInt(e.timestampMs) / 1000n) },
  { tracked: true, poolId: e.poolId, marketKey: e.marketKey, tickSpacing,
    poolManagerAddress: v4.ROBINHOOD_V4_POOL_MANAGER });
  return row.stream === 'market' && row.protocol === e.protocol && row.market_key === e.marketKey
    && ['transactionHash', 'logIndex', 'blockNumber', 'blockHash', 'poolId', 'sender', 'tickLower',
      'tickUpper', 'liquidityDelta', 'salt', 'kind', 'chain', 'protocol', 'timestampMs'].every((field) =>
      String(decoded[field]) === String(e[field]) && String(row.evidence?.event?.[field]) === String(e[field]));
}
async function inspect(client, item) {
  const repository = createV4BlockedPreviewRepository(client);
  const found = new Map(); const captures = new Map();
  for (let i = 0; i < item.events.length; i += 500) {
    const batch = item.events.slice(i, i + 500);
    for (const [id, row] of await repository.identities(batch)) found.set(id, row);
    const result = await client.query(`SELECT c.* FROM robinhood_head_captures c
      JOIN jsonb_to_recordset($1::jsonb) AS i("transactionHash" text, "logIndex" text)
      ON c.transaction_hash = i."transactionHash" AND c.log_index = i."logIndex"::bigint
      WHERE c.chain = 'robinhood' FOR UPDATE OF c`, [JSON.stringify(batch)]);
    for (const row of result.rows) captures.set(`${row.transaction_hash}:${row.log_index}`, row);
    const markers = await client.query(`SELECT p.* FROM robinhood_processed_logs p
      JOIN jsonb_to_recordset($1::jsonb) AS i("transactionHash" text, "logIndex" text)
      ON p.transaction_hash = i."transactionHash" AND p.log_index = i."logIndex"::bigint
      WHERE p.chain = 'robinhood'`, [JSON.stringify(batch)]);
    const expected = new Map(batch.map((e) => [key(e), e]));
    for (const row of markers.rows) {
      const e = expected.get(`${row.transaction_hash}:${row.log_index}`);
      requireTrue(row.stream === 'market' && row.protocol === 'uniswap-v4'
        && row.topic0 === v4.TOPICS.modifyLiquidity && row.event_kind === 'modify-liquidity'
        && row.market_key === e.marketKey && row.block_hash === e.blockHash
        && String(row.block_number) === e.blockNumber, 'Processed marker conflict');
    }
  }
  for (const e of item.events) {
    const row = found.get(key(e)); const capture = captures.get(key(e));
    const allowed = key(e) === key(item.events.at(-1)) ? ['blocked', 'pending', 'processed'] : ['pending', 'processed'];
    requireTrue(row && (!row.ledger || matchesLedger(e, row.ledger)), 'Ledger conflict');
    requireTrue(!row.processed || row.ledger, 'Processed identity without delta');
    requireTrue(!capture || (sameCapture(e, capture, Number(item.target.tick_spacing))
      && allowed.includes(capture.processing_status)), 'Capture conflict/leased');
  }
  return { found, captures };
}
async function checkMaterialization(client, item, found, allowLater = false) {
  const rows = (await client.query(`SELECT transaction_hash, block_number::text, log_index::text, tick_lower, tick_upper,
    liquidity_delta::text FROM robinhood_v4_liquidity_deltas
    WHERE chain = 'robinhood' AND pool_id = $1 LIMIT 100001`, [item.target.pool_id])).rows;
  requireTrue(rows.length <= 100000, 'Ledger exceeds bounded repair');
  const totals = new Map();
  for (const row of rows) {
    requireTrue(found.has(`${row.transaction_hash}:${row.log_index}`) || (allowLater
      && order({ blockNumber: row.block_number, logIndex: row.log_index }, item.events.at(-1)) > 0n),
    'Ledger extends outside archive checkpoint');
    const id = `${row.tick_lower}:${row.tick_upper}`;
    totals.set(id, (totals.get(id) || 0n) + BigInt(row.liquidity_delta));
  }
  const ranges = (await client.query(`SELECT market_key, tick_lower, tick_upper, liquidity_gross::text
    FROM robinhood_v4_liquidity_ranges WHERE chain = 'robinhood' AND pool_id = $1 FOR UPDATE`,
  [item.target.pool_id])).rows;
  for (const row of ranges) {
    const id = `${row.tick_lower}:${row.tick_upper}`;
    requireTrue(row.market_key === item.target.market_key
      && BigInt(row.liquidity_gross) === (totals.get(id) || 0n), 'Materialized balance differs from ledger');
    totals.delete(id);
  }
  requireTrue([...totals.values()].every((n) => n === 0n), 'Materialized range missing');
}
async function insertPredecessors(client, missing, predecessors) {
  for (let i = 0; i < missing.length; i += 500) {
    const json = JSON.stringify(missing.slice(i, i + 500));
    await client.query(`INSERT INTO robinhood_v4_liquidity_deltas
      (chain, transaction_hash, log_index, block_number, block_hash, pool_id, market_key, sender,
       tick_lower, tick_upper, liquidity_delta, salt, observed_at)
      SELECT 'robinhood', "transactionHash", "logIndex"::bigint, "blockNumber"::bigint, "blockHash",
        "poolId", "marketKey", sender, "tickLower", "tickUpper", "liquidityDelta"::numeric, salt,
        to_timestamp("timestampMs"::numeric / 1000)
      FROM jsonb_to_recordset($1::jsonb) AS e("transactionHash" text, "logIndex" text,
        "blockNumber" text, "blockHash" text, "poolId" text, "marketKey" text, sender text,
        "tickLower" int, "tickUpper" int, "liquidityDelta" text, salt text, "timestampMs" text)`, [json]);
  }
  for (let i = 0; i < predecessors.length; i += 500) {
    await client.query(`INSERT INTO robinhood_processed_logs
      (chain, transaction_hash, log_index, stream, block_number, block_hash, topic0, event_kind, protocol, market_key)
      SELECT 'robinhood', "transactionHash", "logIndex"::bigint, 'market', "blockNumber"::bigint,
        "blockHash", $2, 'modify-liquidity', 'uniswap-v4', "marketKey"
      FROM jsonb_to_recordset($1::jsonb) AS e("transactionHash" text, "logIndex" text,
        "blockNumber" text, "blockHash" text, "marketKey" text)
      ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING`,
    [JSON.stringify(predecessors.slice(i, i + 500)), v4.TOPICS.modifyLiquidity]);
  }
}
async function repairPool(client, item, { write = false, verifyCanonical = async () => {} } = {}) {
  validateEvents(item);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['robinhood-processing-blocked-recovery']);
    const lease = (await client.query(`SELECT lease_until > clock_timestamp() AS active
      FROM worker_leases WHERE lease_key = 'robinhood-processing-worker' FOR UPDATE`)).rows[0];
    requireTrue(lease && !lease.active, 'Processing must be stopped with an expired/released lease');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['robinhood-v4-liquidity-materialization']);
    requireTrue((await client.query(`SELECT 1 FROM robinhood_v4_liquidity_materialization_state
      WHERE chain = 'robinhood'`)).rowCount === 1, 'Materialization is unavailable');
    const registry = (await client.query(`SELECT pool_id, discovery_block::text, tick_spacing, origin_address
      FROM robinhood_pool_registry WHERE chain = 'robinhood' AND protocol = 'uniswap-v4'
      AND market_key = $1 FOR SHARE`, [item.target.market_key])).rows[0];
    requireTrue(registry && Object.entries(registry).every(([field, value]) =>
      String(value) === String(item.target[field])), 'Pool registry changed');
    requireTrue(!(await client.query(`SELECT 1 FROM robinhood_head_captures WHERE chain = 'robinhood'
      AND market_key = $1 AND processing_status = 'leased' LIMIT 1`, [item.target.market_key])).rowCount,
    'Pool still has leased captures');
    const { found, captures } = await inspect(client, item);
    const blocker = item.events.at(-1); const capture = captures.get(key(blocker));
    const missing = item.events.slice(0, -1).filter((e) => !found.get(key(e)).ledger);
    if (capture && ['pending', 'processed'].includes(capture.processing_status) && !missing.length) {
      await checkMaterialization(client, item, found, true);
      await client.query('ROLLBACK');
      return { marketKey: item.target.market_key, status: 'already-repaired', inserted: 0 };
    }
    requireTrue(capture?.processing_status === 'blocked' && capture.last_error === BLOCKED_RECOVERY_ERROR
      && !found.get(key(blocker)).ledger, 'Target is no longer the expected blocked event');
    requireTrue(missing.length > 0, 'No missing predecessors; requires another diagnosis');
    await checkMaterialization(client, item, found);
    if (write) {
      await insertPredecessors(client, missing, item.events.slice(0, -1));
      // Recompute only this pool after verifying its old projection, never reset global ranges.
      await client.query(`INSERT INTO robinhood_v4_liquidity_ranges
        (chain, pool_id, market_key, tick_lower, tick_upper, liquidity_gross)
        SELECT chain, pool_id, market_key, tick_lower, tick_upper, SUM(liquidity_delta)
        FROM robinhood_v4_liquidity_deltas WHERE chain = 'robinhood' AND pool_id = $1
        GROUP BY chain, pool_id, market_key, tick_lower, tick_upper
        ON CONFLICT (chain, pool_id, tick_lower, tick_upper) DO UPDATE
        SET liquidity_gross = EXCLUDED.liquidity_gross, updated_at = NOW()`, [item.target.pool_id]);
      await client.query(`UPDATE robinhood_head_captures SET processing_status = 'pending',
        attempt_count = 0, next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE chain = 'robinhood' AND transaction_hash = $1 AND log_index = $2`,
      [blocker.transactionHash, blocker.logIndex]);
    }
    await verifyCanonical();
    await client.query(write ? 'COMMIT' : 'ROLLBACK');
    return { marketKey: item.target.market_key, status: write ? 'requeued' : 'validated',
      missingPredecessors: missing.length, inserted: write ? missing.length : 0 };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
module.exports = { repairPool, validateEvents };

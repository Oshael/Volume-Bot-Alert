'use strict';

const { createHash } = require('node:crypto');
const { TRANSFER_TOPIC } = require('../services/evm-erc20-supply-delta');
const { __private: { coverageFrom, coverageGap, decodeRows } } = require('./robinhood-canonical-holder-source');
const { listTrackedTokens, normalizeCandidates, trackedTokenSql } = require('./robinhood-wallet-transfer-token-selection');

function bounds(input) {
  if (!/^\d+$/.test(String(input.fromBlock)) || !/^\d+$/.test(String(input.toBlock))) throw new Error('invalid block bounds');
  const from = BigInt(input.fromBlock); const to = BigInt(input.toBlock);
  if (to < from || to - from + 1n > 1000n) throw new Error('invalid range width');
  const maximumRows = Number(input.maximumRows ?? 5000);
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 10000) throw new Error('invalid row limit');
  return { fromBlock: from.toString(), toBlock: to.toString(), maximumRows };
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function transferOutcome(rows, context, tokens) {
  try {
    const decoded = decodeRows(rows, context, new Set(tokens), false);
    return { status: 'decoded', count: decoded.transfers.length, hash: digest(decoded.transfers),
      ignoredMalformedLogs: decoded.ignoredMalformedLogs };
  } catch (error) {
    if (error.code !== 'holder_transfer_invalid_log') throw error;
    return { status: 'rejected', code: error.code, tokenAddress: error.tokenAddress, message: error.message };
  }
}
function planSummary(node) {
  return [{ type: node['Node Type'], index: node['Index Name'] || null,
    rows: node['Plan Rows'], cost: node['Total Cost'] }, ...(node.Plans || []).flatMap(planSummary)];
}
function rangeTimes(first, last) {
  const from = new Date(first.block_timestamp); const to = new Date(last.block_timestamp);
  if (!first.block_timestamp || !last.block_timestamp || !Number.isFinite(from.getTime())
    || !Number.isFinite(to.getTime()) || from > to) throw new Error('invalid canonical range timestamps');
  return [from.toISOString(), to.toISOString()];
}

async function auditBatchSelection(database, input) {
  const range = bounds(input);
  const started = Date.now(); const timings = {};
  const client = await database.getClient();
  async function query(sql, params) {
    const remaining = 15000 - (Date.now() - started);
    if (remaining <= 0) throw new Error('selection audit time budget exhausted');
    await client.query(`SET LOCAL statement_timeout='${Math.min(3000, remaining)}ms'`);
    return client.query(sql, params);
  }
  async function timed(name, operation) {
    const begin = Date.now(); const result = await operation();
    timings[name] = Date.now() - begin;
    return result;
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
    const frontier = (await query(`SELECT cursor.checkpoint_block,cursor.node_head,
      (SELECT block_number FROM robinhood_chain_blocks WHERE chain='robinhood' AND canonical ORDER BY block_number LIMIT 1) AS journal_start_block
      FROM robinhood_chain_capture_cursor cursor WHERE cursor.chain='robinhood'`)).rows[0];
    const coverage = coverageFrom(frontier);
    const gap = coverageGap(BigInt(range.fromBlock), BigInt(range.toBlock), coverage);
    if (gap) throw new Error(`journal coverage unavailable: ${gap}`);
    const headers = (await query(`SELECT block_number::text,block_hash,block_timestamp FROM robinhood_chain_blocks
      WHERE chain='robinhood' AND canonical AND block_number BETWEEN $1 AND $2 ORDER BY block_number`,
    [range.fromBlock, range.toBlock])).rows;
    if (headers.length !== Number(BigInt(range.toBlock) - BigInt(range.fromBlock) + 1n)) throw new Error('canonical header gap');
    const first = headers[0]; const last = headers.at(-1);
    const [fromTime, toTime] = rangeTimes(first, last);
    const rows = await timed('discoveryMs', async () => {
      const events = (await query(`SELECT event.block_number,event.block_hash,event.transaction_hash,event.transaction_index,
        event.log_index,event.address,event.topics,event.data FROM robinhood_chain_events event
        JOIN robinhood_chain_blocks block ON block.chain=event.chain AND block.block_hash=event.block_hash AND block.canonical
        WHERE event.chain='robinhood' AND event.block_number BETWEEN $1 AND $2 AND event.topic0=$3
        ORDER BY event.block_number,event.transaction_index,event.log_index LIMIT $4`,
      [range.fromBlock, range.toBlock, TRANSFER_TOPIC, range.maximumRows + 1])).rows;
      const swaps = (await query(`SELECT token_address,transaction_hash,action_index,wallet_address,block_number
        FROM robinhood_wallet_swaps WHERE chain='robinhood' AND block_number BETWEEN $1 AND $2
          AND block_time BETWEEN $3::timestamptz AND $4::timestamptz
        ORDER BY block_number,action_index,transaction_hash,wallet_address LIMIT $5`,
      [range.fromBlock, range.toBlock, fromTime, toTime, range.maximumRows + 1])).rows;
      if (events.length > range.maximumRows || swaps.length > range.maximumRows) throw new Error('batch row limit exceeded');
      return { events, swaps };
    });
    const candidates = normalizeCandidates([...new Set([...rows.events.map((row) => row.address),
      ...rows.swaps.map((row) => row.token_address)])]);
    const plan = candidates.length ? (await query(`EXPLAIN (FORMAT JSON) ${trackedTokenSql(true, null)}`,
      ['robinhood', candidates])).rows[0]['QUERY PLAN'][0].Plan : null;
    const reader = { query };
    const full = await timed('fullSelectionMs', () => listTrackedTokens(reader, null, 500000));
    const selected = await timed('candidateSelectionMs', () => listTrackedTokens(reader, candidates));
    const fullSet = new Set(full); const selectedSet = new Set(selected);
    const expected = candidates.filter((token) => fullSet.has(token));
    const context = { tokenAddress: null, fromBlock: BigInt(range.fromBlock), toBlock: BigInt(range.toBlock), checkpointHash: last.block_hash };
    const transfers = await timed('decodeComparisonMs', () => ({ full: transferOutcome(rows.events, context, full),
      candidates: transferOutcome(rows.events, context, selected) }));
    const swapFull = rows.swaps.filter((row) => fullSet.has(row.token_address));
    const swapSelected = rows.swaps.filter((row) => selectedSet.has(row.token_address));
    const parity = digest(expected) === digest(selected) && digest(transfers.full) === digest(transfers.candidates)
      && digest(swapFull) === digest(swapSelected);
    await client.query('ROLLBACK');
    return { mode: 'read-only', measuredAt: new Date().toISOString(), ...range, checkpointHash: last.block_hash,
      coverage, parity, fullTokens: full.length, candidateTokens: candidates.length, selectedTokens: selected.length,
      transferLogs: rows.events.length, selectedSwaps: swapSelected.length, transfers,
      selectionPlan: plan ? planSummary(plan) : [], timings, elapsedMs: Date.now() - started,
      qualification: 'Selection parity in one snapshot; no persisted coverage proof or incident causality. Timings are sequential, not a controlled benchmark.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
module.exports = { auditBatchSelection };

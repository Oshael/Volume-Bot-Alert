'use strict';
const { TRANSFER_TOPIC } = require('../services/evm-erc20-supply-delta');
const { __private: { coverageFrom, coverageGap, decodeRows } } = require('./robinhood-canonical-holder-source');
const { listTrackedCandidates, normalizeCandidates } = require('./robinhood-wallet-transfer-token-selection');
const { buildGlobalScanProof } = require('./robinhood-wallet-transfer-global-scan-proof');

function limitError() {
  return Object.assign(new Error('global Transfer batch exceeds row or contract limit'), { code: 'wallet_transfer_global_limit' });
}
function rangeBounds(input) {
  if (!/^\d+$/.test(String(input.fromBlock)) || !/^\d+$/.test(String(input.toBlock))) throw new Error('invalid candidate range');
  const from = BigInt(input.fromBlock); const to = BigInt(input.toBlock);
  const maximumRows = Number(input.maximumRows ?? 100000);
  if (to < from || to - from >= 5000n || to >= 9223372036854775807n
    || !Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 100000) throw new Error('invalid candidate bounds');
  return { from, to, maximumRows };
}
function headersFor(rows, from, to) {
  if (rows.length !== Number(to - from + 1n)) throw new Error('canonical header gap');
  return new Map(rows.map((row, index) => {
    const time = row.block_timestamp == null ? NaN : new Date(row.block_timestamp).getTime();
    if (BigInt(row.block_number) !== from + BigInt(index) || !Number.isFinite(time)
      || !/^0x[0-9a-f]{64}$/.test(row.block_hash)) throw new Error('invalid canonical header');
    return [String(row.block_number), { hash: row.block_hash, blockTime: new Date(time).toISOString() }];
  }));
}
async function readBoundedRange(database, input, deadline) {
  const { from, to, maximumRows } = rangeBounds(input);
  const client = await database.getClient();
  async function query(sql, params) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('global Transfer capture time budget exhausted');
    await client.query("SELECT set_config('statement_timeout',$1,true)", [`${Math.min(5000, remaining)}ms`]);
    return client.query(sql, params);
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
    const frontier = (await query(`SELECT cursor.checkpoint_block,cursor.node_head,
      (SELECT block_number FROM robinhood_chain_blocks WHERE chain='robinhood' AND canonical ORDER BY block_number LIMIT 1) AS journal_start_block
      FROM robinhood_chain_capture_cursor cursor WHERE cursor.chain='robinhood'`)).rows[0];
    const gap = coverageGap(from, to, coverageFrom(frontier));
    if (gap) throw new Error(`canonical coverage unavailable: ${gap}`);
    const headers = headersFor((await query(`SELECT block_number,block_hash,block_timestamp
      FROM robinhood_chain_blocks WHERE chain='robinhood' AND canonical
      AND block_number BETWEEN $1 AND $2 ORDER BY block_number`, [from.toString(), to.toString()])).rows, from, to);
    const first = headers.get(from.toString()); const last = headers.get(to.toString());
    if (first.blockTime > last.blockTime) throw new Error('canonical timestamps are inverted');
    const fromTime = input.fromTime == null ? first.blockTime : new Date(input.fromTime).toISOString();
    if (fromTime > last.blockTime) throw new Error('candidate timestamps are inverted');
    const rows = (await query(`SELECT event.block_number,event.block_hash,event.transaction_hash,
      event.transaction_index,event.log_index,event.address,event.topics,event.data
      FROM robinhood_chain_events event JOIN robinhood_chain_blocks block
      ON block.chain=event.chain AND block.block_hash=event.block_hash AND block.block_number=event.block_number AND block.canonical
      WHERE event.chain='robinhood' AND event.block_number BETWEEN $1 AND $2 AND event.topic0=$3
      ORDER BY event.block_number,event.transaction_index,event.log_index LIMIT $4`,
    [from.toString(), to.toString(), TRANSFER_TOPIC, maximumRows + 1])).rows;
    const swaps = (await query(`SELECT token_address FROM robinhood_wallet_swaps
      WHERE chain='robinhood' AND block_number BETWEEN $1 AND $2
      AND block_time BETWEEN $3::timestamptz AND $4::timestamptz LIMIT $5`,
    [from.toString(), to.toString(), fromTime, last.blockTime, maximumRows + 1])).rows;
    if (rows.length > maximumRows || swaps.length > maximumRows) throw limitError();
    const observed = [...new Set(rows.map((row) => String(row.address).toLowerCase()))];
    const candidates = [...new Set([...observed, ...swaps.map((row) => row.token_address)])];
    if (candidates.length > 10000) throw limitError();
    const selectedTokenAddresses = await listTrackedCandidates({ query }, normalizeCandidates(candidates));
    const allowed = new Set(selectedTokenAddresses);
    const decoded = decodeRows(rows.filter((row) => allowed.has(String(row.address).toLowerCase())), {
      tokenAddress: null, fromBlock: from, toBlock: to, checkpointHash: last.hash,
    }, allowed, false);
    const transfers = decoded.transfers.map((transfer) => {
      const header = headers.get(String(transfer.blockNumber));
      if (!header || header.hash !== transfer.blockHash) throw new Error('canonical Transfer header mismatch');
      return Object.freeze({ ...transfer, blockTime: header.blockTime });
    });
    const globalScan = { source: 'canonical-journal', complete: true, selectedLogsValidated: true,
      fromBlock: from.toString(), throughBlock: to.toString(), checkpointHash: last.hash,
      observedLogs: rows.length, observedTokenAddresses: observed, selectedTokenAddresses };
    buildGlobalScanProof(globalScan);
    await client.query('ROLLBACK');
    return Object.freeze({ fromBlock: from.toString(), toBlock: to.toString(), nextBlock: (to + 1n).toString(),
      fromBlockTime: first.blockTime, checkpoint: Object.freeze({ number: to.toString(), hash: last.hash, blockTime: last.blockTime }),
      scopeTokens: selectedTokenAddresses.length, selectedTokenAddresses, globalScan, transfers: Object.freeze(transfers),
      telemetry: Object.freeze({ source: 'canonical-journal', filterMode: 'canonical-global-v1', requests: 0,
        observedLogs: rows.length, ignoredLogs: rows.length - transfers.length, candidateTokens: candidates.length,
        excludedContracts: observed.length - observed.filter((token) => allowed.has(token)).length, scopeTokens: selectedTokenAddresses.length }) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
async function readCandidateRange(database, input) {
  const { from, to } = rangeBounds(input);
  const deadline = Date.now() + 15000;
  let through = to; let splits = 0;
  for (;;) {
    try {
      const captured = await readBoundedRange(database, { ...input, toBlock: through.toString() }, deadline);
      return Object.freeze({ ...captured, telemetry: Object.freeze({ ...captured.telemetry, splits }) });
    } catch (error) {
      if (error.code !== 'wallet_transfer_global_limit' || through === from) throw error;
      through = from + (through - from) / 2n; splits += 1;
    }
  }
}
module.exports = { readCandidateRange };

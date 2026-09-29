const db = require('./db');

const CHAIN = 'robinhood';
const TIMEOUT_MS = 5000;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BLOCK = 9223372036854775807n;
const BLOCK_SQL = `SELECT block_number::text, block_timestamp
  FROM robinhood_chain_blocks
  WHERE chain='${CHAIN}' AND canonical AND block_number=$1::bigint`;

function block(value, label) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a block number`);
  const number = BigInt(text);
  if (number > MAX_BLOCK) throw new Error(`${label} exceeds PostgreSQL bigint`);
  return number;
}

function normalizeInput(input) {
  const windowStart = new Date(input.windowStart);
  const asOf = new Date(input.asOf);
  if (!Number.isFinite(windowStart.getTime()) || !Number.isFinite(asOf.getTime())
      || asOf <= windowStart || asOf - windowStart > MAX_WINDOW_MS) {
    throw new Error('windowStart/asOf must define a window of at most 30 days');
  }
  const originBlock = block(input.originBlock, 'originBlock');
  const throughBlock = block(input.throughBlock, 'throughBlock');
  if (originBlock >= throughBlock) throw new Error('block bounds are inverted');
  return { windowStart, asOf, originBlock, throughBlock };
}

function unavailable(reason) {
  return { verified: false, fromBlock: null, throughBlock: null, reasons: [reason] };
}

function createRobinhoodWalletRankingWindowBlockBoundsRepository(options = {}) {
  const database = options.database || db;
  async function load(number) {
    const result = await database.queryWithStatementTimeout(
      BLOCK_SQL, [number.toString()], TIMEOUT_MS
    );
    const row = result.rows[0];
    if (!row) return null;
    const time = new Date(row.block_timestamp);
    return Number.isFinite(time.getTime()) ? { number, time } : null;
  }

  async function firstMatching(originBlock, throughBlock, boundary, inclusive) {
    let low = originBlock;
    let high = throughBlock;
    while (low < high) {
      const midpoint = low + (high - low) / 2n;
      const row = await load(midpoint);
      if (!row) return null;
      const matches = inclusive ? row.time >= boundary : row.time > boundary;
      if (matches) high = midpoint;
      else low = midpoint + 1n;
    }
    return low;
  }

  return {
    async resolveWindow(input = {}) {
      const { windowStart, asOf, originBlock, throughBlock } = normalizeInput(input);
      const origin = await load(originBlock);
      const tip = await load(throughBlock);
      if (!origin || !tip) return unavailable('transfer_window_anchor_missing');
      if (origin.time >= windowStart || tip.time <= asOf) {
        return unavailable('transfer_window_outside_frontier');
      }
      const firstNumber = await firstMatching(originBlock, throughBlock, windowStart, true);
      const afterNumber = await firstMatching(originBlock, throughBlock, asOf, false);
      if (firstNumber === null || afterNumber === null) {
        return unavailable('transfer_window_block_gap');
      }
      if (firstNumber >= afterNumber) return unavailable('transfer_window_no_blocks');
      const first = await load(firstNumber);
      const before = await load(firstNumber - 1n);
      const last = await load(afterNumber - 1n);
      const after = await load(afterNumber);
      if (!first || !before || !last || !after
          || before.time >= windowStart || first.time < windowStart
          || last.time > asOf || after.time <= asOf) {
        return unavailable('transfer_window_boundary_unproven');
      }
      return { verified: true, fromBlock: firstNumber.toString(),
        throughBlock: (afterNumber - 1n).toString(), reasons: [] };
    },
  };
}

module.exports = { createRobinhoodWalletRankingWindowBlockBoundsRepository };

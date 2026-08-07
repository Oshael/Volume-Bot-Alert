/**
 * Robinhood wallet-attributed swap persistence.
 *
 * Write side of the durable `robinhood_wallet_swaps` partitioned table
 * (stage 90). Responsibilities:
 *  - create daily RANGE partitions on demand (idempotent);
 *  - bulk upsert attributed swap rows, deduped by the natural swap identity.
 *
 * The table is partitioned by day on `block_time` and has no default partition,
 * so a row can only land after its day's partition exists. `insertWalletSwaps`
 * therefore ensures the partitions for the batch's days before writing.
 *
 * RPC and orchestration live in the worker; this module performs only
 * validation and SQL.
 */
const db = require('./db');

const CHAIN = 'robinhood';
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const SIDES = new Set(['buy', 'sell']);

function fixedHex(value, label, bytes) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function optionalFixedHex(value, label, bytes) {
  if (value === null || value === undefined || value === '') return null;
  return fixedHex(value, label, bytes);
}

function boundedText(value, label, maxLength) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must contain between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function nonNegativeInteger(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(raw).toString();
}

function positiveInteger(value, label) {
  const normalized = nonNegativeInteger(value, label);
  if (BigInt(normalized) <= 0n) throw new Error(`${label} must be greater than zero`);
  return normalized;
}

function optionalSmallint(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be an integer between 0 and 255`);
  const parsed = Number(raw);
  if (parsed < 0 || parsed > 255) throw new Error(`${label} must be an integer between 0 and 255`);
  return String(parsed);
}

function optionalNumeric(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`${label} must be a decimal number`);
  return raw;
}

function optionalNonNegativeInteger(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return nonNegativeInteger(value, label);
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date;
}

function partitionDayKey(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

function partitionName(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new Error('dayKey must be YYYY-MM-DD');
  return `robinhood_wallet_swaps_${dayKey.replace(/-/g, '_')}`;
}

function dayBounds(dayKey) {
  const from = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) throw new Error('dayKey must be a valid UTC day');
  const to = new Date(from.getTime() + 86400000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function enumValue(value, label, allowed) {
  const normalized = String(value ?? '').trim();
  if (!allowed.has(normalized)) {
    throw new Error(`${label} must be one of ${[...allowed].join(', ')}`);
  }
  return normalized;
}

function normalizeSwapRow(input = {}) {
  const blockTime = isoTimestamp(input.blockTime, 'blockTime');
  return {
    wallet_address: fixedHex(input.walletAddress, 'walletAddress', 20),
    transaction_hash: fixedHex(input.transactionHash, 'transactionHash', 32),
    action_index: nonNegativeInteger(input.actionIndex, 'actionIndex'),
    block_number: nonNegativeInteger(input.blockNumber, 'blockNumber'),
    block_time: blockTime.toISOString(),
    protocol: enumValue(input.protocol, 'protocol', PROTOCOLS),
    market_key: boundedText(input.marketKey, 'marketKey', 160),
    token_address: fixedHex(input.tokenAddress, 'tokenAddress', 20),
    quote_address: fixedHex(input.quoteAddress, 'quoteAddress', 20),
    side: enumValue(input.side, 'side', SIDES),
    token_amount_raw: positiveInteger(input.tokenAmountRaw, 'tokenAmountRaw'),
    quote_amount_raw: positiveInteger(input.quoteAmountRaw, 'quoteAmountRaw'),
    token_decimals: optionalSmallint(input.tokenDecimals, 'tokenDecimals'),
    quote_decimals: optionalSmallint(input.quoteDecimals, 'quoteDecimals'),
    token_amount: optionalNumeric(input.tokenAmount, 'tokenAmount'),
    quote_amount: optionalNumeric(input.quoteAmount, 'quoteAmount'),
    price_usd: optionalNumeric(input.priceUsd, 'priceUsd'),
    volume_usd: optionalNumeric(input.volumeUsd, 'volumeUsd'),
    router_address: optionalFixedHex(input.routerAddress, 'routerAddress', 20),
    recipient_address: optionalFixedHex(input.recipientAddress, 'recipientAddress', 20),
    parser_version: boundedText(input.parserVersion, 'parserVersion', 64),
    __dayKey: partitionDayKey(blockTime),
  };
}

// Narrow sidecar row (robinhood_swap_mc): the per-swap MC + at-block supply that
// must outlive the pruned observation. Keyed by log_index (= the swap action_index).
// Returns null when the swap carries no MC (nothing worth persisting).
function normalizeMcRow(input = {}) {
  const fdvUsd = optionalNumeric(input.fdvUsd, 'fdvUsd');
  const tokenTotalSupplyRaw = optionalNonNegativeInteger(
    input.tokenTotalSupplyRaw, 'tokenTotalSupplyRaw',
  );
  if (fdvUsd === null && tokenTotalSupplyRaw === null) return null;
  return {
    chain: CHAIN,
    transaction_hash: fixedHex(input.transactionHash, 'transactionHash', 32),
    log_index: nonNegativeInteger(input.actionIndex, 'actionIndex'),
    fdv_usd: fdvUsd,
    token_total_supply_raw: tokenTotalSupplyRaw,
  };
}

function createRobinhoodWalletSwapRepository(options = {}) {
  const database = options.database || db;

  async function insertSwapMc(rows = []) {
    const payload = (Array.isArray(rows) ? rows : []).map(normalizeMcRow).filter(Boolean);
    if (payload.length === 0) return { inserted: 0 };
    const result = await database.query(
      `INSERT INTO robinhood_swap_mc (
         chain, transaction_hash, log_index, fdv_usd, token_total_supply_raw
       )
       SELECT item.chain, item.transaction_hash, item.log_index::bigint,
              item.fdv_usd::numeric, item.token_total_supply_raw::numeric
       FROM jsonb_to_recordset($1::jsonb) AS item(
         chain text, transaction_hash text, log_index text,
         fdv_usd text, token_total_supply_raw text
       )
       ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING`,
      [JSON.stringify(payload)]
    );
    return { inserted: result.rowCount || 0 };
  }

  async function ensurePartitionForDay(dayKey) {
    const name = partitionName(dayKey);
    const { from, to } = dayBounds(dayKey);
    await database.query(
      `CREATE TABLE IF NOT EXISTS ${name}
         PARTITION OF robinhood_wallet_swaps
         FOR VALUES FROM ('${from}') TO ('${to}')`
    );
    return name;
  }

  async function ensurePartitionsForDays(dayKeys) {
    const unique = [...new Set(dayKeys)].sort();
    for (const dayKey of unique) await ensurePartitionForDay(dayKey);
    return unique;
  }

  async function insertWalletSwaps(rows = []) {
    const normalized = (Array.isArray(rows) ? rows : []).map(normalizeSwapRow);
    if (normalized.length === 0) return { inserted: 0, ensuredDays: [] };

    const ensuredDays = await ensurePartitionsForDays(normalized.map((row) => row.__dayKey));
    const payload = normalized.map(({ __dayKey, ...row }) => ({ ...row, chain: CHAIN }));

    const result = await database.query(
      `INSERT INTO robinhood_wallet_swaps (
         chain, wallet_address, transaction_hash, action_index, block_number, block_time,
         protocol, market_key, token_address, quote_address, side,
         token_amount_raw, quote_amount_raw, token_decimals, quote_decimals,
         token_amount, quote_amount, price_usd, volume_usd,
         router_address, recipient_address, parser_version
       )
       SELECT item.chain, item.wallet_address, item.transaction_hash,
              item.action_index::bigint, item.block_number::bigint,
              item.block_time::timestamptz, item.protocol, item.market_key,
              item.token_address, item.quote_address, item.side,
              item.token_amount_raw::numeric, item.quote_amount_raw::numeric,
              item.token_decimals::smallint, item.quote_decimals::smallint,
              item.token_amount::numeric, item.quote_amount::numeric,
              item.price_usd::numeric, item.volume_usd::numeric,
              item.router_address, item.recipient_address, item.parser_version
       FROM jsonb_to_recordset($1::jsonb) AS item(
         chain text, wallet_address text, transaction_hash text, action_index text,
         block_number text, block_time text, protocol text, market_key text,
         token_address text, quote_address text, side text, token_amount_raw text,
         quote_amount_raw text, token_decimals text, quote_decimals text,
         token_amount text, quote_amount text, price_usd text, volume_usd text,
         router_address text, recipient_address text, parser_version text
       )
       ON CONFLICT (chain, transaction_hash, action_index, block_time) DO NOTHING`,
      [JSON.stringify(payload)]
    );
    // Crystallize the per-swap MC into the durable sidecar so it survives the
    // observation prune. Idempotent; safe to retry with the wallet-swap insert.
    const mc = await insertSwapMc(rows);
    return { inserted: result.rowCount || 0, ensuredDays, mcInserted: mc.inserted };
  }

  return {
    ensurePartitionForDay, ensurePartitionsForDays, insertWalletSwaps, insertSwapMc,
  };
}

module.exports = {
  createRobinhoodWalletSwapRepository,
  PROTOCOLS,
  SIDES,
  __private: { normalizeSwapRow, normalizeMcRow, partitionName, dayBounds, partitionDayKey },
};

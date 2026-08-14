const db = require('./db');

const CHAIN = 'robinhood';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const RAW_RETENTION_DAYS = 30;
const TRANSFER_KINDS = new Set([
  'unclassified', 'mint', 'burn', 'dex_flow', 'liquidity_flow',
  'router_flow', 'wallet_transfer', 'contract_flow', 'unknown',
]);

function fixedHex(value, label, bytes) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function uint(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function index(value, label) {
  const normalized = uint(value, label);
  if (BigInt(normalized) > 2_147_483_647n) throw new Error(`${label} exceeds PostgreSQL integer`);
  return normalized;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) throw new Error('blockTime must be a valid timestamp');
  return date;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function partitionName(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');
  return `robinhood_token_transfer_events_${day.replace(/-/g, '_')}`;
}

function dayBounds(day) {
  const from = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== day) {
    throw new Error('day must be a valid UTC day');
  }
  return {
    from: from.toISOString(),
    to: new Date(from.getTime() + 86_400_000).toISOString(),
  };
}

function classification(input) {
  const kind = String(input.transferKind ?? 'unclassified').trim();
  if (!TRANSFER_KINDS.has(kind)) throw new Error('transferKind is invalid');
  const version = input.classificationVersion == null
    ? null : String(input.classificationVersion).trim().toLowerCase();
  if (kind === 'unclassified' && version !== null) {
    throw new Error('unclassified transfers cannot have a classificationVersion');
  }
  if (kind !== 'unclassified' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(version || '')) {
    throw new Error('classified transfers require a valid classificationVersion');
  }
  return { kind, version };
}

function normalizeTransferEvent(input = {}) {
  const blockTime = timestamp(input.blockTime);
  const tokenAddress = fixedHex(input.tokenAddress, 'tokenAddress', 20);
  if (tokenAddress === ZERO_ADDRESS) throw new Error('tokenAddress cannot be zero');
  const classified = classification(input);
  return {
    block_number: uint(input.blockNumber, 'blockNumber'),
    block_hash: fixedHex(input.blockHash, 'blockHash', 32),
    block_time: blockTime.toISOString(),
    transaction_hash: fixedHex(input.transactionHash, 'transactionHash', 32),
    transaction_index: index(input.transactionIndex, 'transactionIndex'),
    log_index: index(input.logIndex, 'logIndex'),
    token_address: tokenAddress,
    from_wallet: fixedHex(input.fromWallet, 'fromWallet', 20),
    to_wallet: fixedHex(input.toWallet, 'toWallet', 20),
    amount_raw: uint(input.amountRaw, 'amountRaw'),
    transfer_kind: classified.kind,
    classification_version: classified.version,
    __dayKey: dayKey(blockTime),
  };
}

function createRobinhoodTokenTransferRepository(options = {}) {
  const database = options.database || db;

  async function ensurePartitionForDay(day) {
    const name = partitionName(day);
    const { from, to } = dayBounds(day);
    await database.query(
      `CREATE TABLE IF NOT EXISTS ${name}
         PARTITION OF robinhood_token_transfer_events
         FOR VALUES FROM ('${from}') TO ('${to}')`
    );
    return name;
  }

  async function insertTransferEvents(rows = []) {
    const normalized = (Array.isArray(rows) ? rows : []).map(normalizeTransferEvent);
    if (normalized.length === 0) return { inserted: 0, ensuredDays: [] };
    const ensuredDays = [...new Set(normalized.map((row) => row.__dayKey))].sort();
    for (const day of ensuredDays) await ensurePartitionForDay(day);
    const payload = normalized.map(({ __dayKey, ...row }) => ({ chain: CHAIN, ...row }));
    const result = await database.query(
      `INSERT INTO robinhood_token_transfer_events (
         chain, block_number, block_hash, block_time, transaction_hash,
         transaction_index, log_index, token_address, from_wallet, to_wallet,
         amount_raw, transfer_kind, classification_version
       ) SELECT item.chain, item.block_number::bigint, item.block_hash,
         item.block_time::timestamptz, item.transaction_hash,
         item.transaction_index::integer, item.log_index::integer,
         item.token_address, item.from_wallet, item.to_wallet,
         item.amount_raw::numeric, item.transfer_kind, item.classification_version
       FROM jsonb_to_recordset($1::jsonb) AS item(
         chain text, block_number text, block_hash text, block_time text,
         transaction_hash text, transaction_index text, log_index text,
         token_address text, from_wallet text, to_wallet text, amount_raw text,
         transfer_kind text, classification_version text
       ) ON CONFLICT (chain, transaction_hash, log_index, block_time) DO NOTHING`,
      [JSON.stringify(payload)]
    );
    return { inserted: result.rowCount || 0, ensuredDays };
  }

  return { ensurePartitionForDay, insertTransferEvents };
}

module.exports = {
  RAW_RETENTION_DAYS,
  TRANSFER_KINDS,
  createRobinhoodTokenTransferRepository,
  __private: { dayBounds, dayKey, normalizeTransferEvent, partitionName },
};

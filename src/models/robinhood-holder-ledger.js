const db = require('./db');

const CHAIN = 'robinhood';
const STREAM = 'live';

function decimalQuantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw).toString();
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function hex(value, bytes, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function normalizeTransfer(value = {}) {
  return Object.freeze({
    blockNumber: decimalQuantity(value.blockNumber, 'transfer.blockNumber'),
    blockHash: hex(value.blockHash, 32, 'transfer.blockHash'),
    transactionHash: hex(value.transactionHash, 32, 'transfer.transactionHash'),
    transactionIndex: nonNegativeInteger(value.transactionIndex, 'transfer.transactionIndex'),
    logIndex: nonNegativeInteger(value.logIndex, 'transfer.logIndex'),
    tokenAddress: hex(value.tokenAddress, 20, 'transfer.tokenAddress'),
    fromWallet: hex(value.fromWallet, 20, 'transfer.fromWallet'),
    toWallet: hex(value.toWallet, 20, 'transfer.toWallet'),
    amountRaw: decimalQuantity(value.amountRaw, 'transfer.amountRaw'),
  });
}

function normalizeCursor(value = {}) {
  const checkpoint = value.checkpoint || {};
  const expectedVersion = value.expectedVersion == null
    ? null : nonNegativeInteger(value.expectedVersion, 'cursor.expectedVersion');
  return Object.freeze({
    rangeStart: decimalQuantity(value.rangeStart, 'cursor.rangeStart'),
    nextBlock: decimalQuantity(value.nextBlock, 'cursor.nextBlock'),
    safeHead: value.safeHead == null ? null : decimalQuantity(value.safeHead, 'cursor.safeHead'),
    checkpointBlock: decimalQuantity(checkpoint.number, 'cursor.checkpoint.number'),
    checkpointHash: hex(checkpoint.hash, 32, 'cursor.checkpoint.hash'),
    expectedVersion,
  });
}

function validateRange(transfers, cursor) {
  const rangeStart = BigInt(cursor.rangeStart);
  const nextBlock = BigInt(cursor.nextBlock);
  const checkpointBlock = BigInt(cursor.checkpointBlock);
  if (nextBlock !== checkpointBlock + 1n) {
    throw new Error('cursor.nextBlock must immediately follow its checkpoint');
  }
  if (rangeStart > nextBlock || (cursor.safeHead != null && checkpointBlock > BigInt(cursor.safeHead))) {
    throw new Error('capture range bounds are invalid');
  }
  if (transfers.some(({ blockNumber }) => (
    BigInt(blockNumber) < rangeStart || BigInt(blockNumber) > checkpointBlock
  ))) {
    throw new Error('transfer must be inside the captured range');
  }
}

async function insertTransfer(client, transfer) {
  const result = await client.query(
    `INSERT INTO robinhood_holder_transfer_journal (
       chain, block_number, block_hash, transaction_hash, transaction_index,
       log_index, token_address, from_wallet, to_wallet, amount_raw
     ) VALUES ('robinhood', $1, $2, $3, $4, $5, $6, $7, $8, $9::numeric)
     ON CONFLICT (chain, transaction_hash, log_index) DO UPDATE SET
       captured_at = robinhood_holder_transfer_journal.captured_at
     WHERE robinhood_holder_transfer_journal.block_number = EXCLUDED.block_number
       AND robinhood_holder_transfer_journal.block_hash = EXCLUDED.block_hash
       AND robinhood_holder_transfer_journal.transaction_index = EXCLUDED.transaction_index
       AND robinhood_holder_transfer_journal.token_address = EXCLUDED.token_address
       AND robinhood_holder_transfer_journal.from_wallet = EXCLUDED.from_wallet
       AND robinhood_holder_transfer_journal.to_wallet = EXCLUDED.to_wallet
       AND robinhood_holder_transfer_journal.amount_raw = EXCLUDED.amount_raw
     RETURNING (xmax = 0) AS inserted`,
    [
      transfer.blockNumber, transfer.blockHash, transfer.transactionHash,
      transfer.transactionIndex, transfer.logIndex, transfer.tokenAddress,
      transfer.fromWallet, transfer.toWallet, transfer.amountRaw,
    ]
  );
  if (!result.rowCount) {
    const error = new Error('captured transfer conflicts with existing journal evidence');
    error.code = 'holder_capture_conflict';
    throw error;
  }
  return result.rows[0]?.inserted === true;
}

async function advanceCursor(client, cursor) {
  const result = await client.query(
    `INSERT INTO robinhood_holder_cursors (
       chain, stream, next_block, safe_head, checkpoint_block, checkpoint_hash
     ) VALUES ('robinhood', 'live', $1, $2, $3, $4)
     ON CONFLICT (chain, stream) DO UPDATE SET
       next_block = EXCLUDED.next_block,
       safe_head = EXCLUDED.safe_head,
       checkpoint_block = EXCLUDED.checkpoint_block,
       checkpoint_hash = EXCLUDED.checkpoint_hash,
       version = robinhood_holder_cursors.version + 1,
       updated_at = NOW()
     WHERE $5::bigint IS NOT NULL
       AND robinhood_holder_cursors.version = $5::bigint
       AND robinhood_holder_cursors.next_block = $6::bigint
     RETURNING version`,
    [
      cursor.nextBlock, cursor.safeHead, cursor.checkpointBlock,
      cursor.checkpointHash, cursor.expectedVersion, cursor.rangeStart,
    ]
  );
  if (!result.rowCount) {
    const error = new Error('holder capture cursor is stale');
    error.code = 'holder_cursor_stale';
    throw error;
  }
  return Number(result.rows[0].version);
}

function normalizeCursorRow(row) {
  if (!row) return null;
  return Object.freeze({
    stream: row.stream,
    nextBlock: String(row.next_block),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash,
    version: Number(row.version),
  });
}

function createRobinhoodHolderLedgerRepository(options = {}) {
  const database = options.database || db;

  async function appendCapturedRange(input = {}) {
    const transfers = (Array.isArray(input.transfers) ? input.transfers : [])
      .map(normalizeTransfer);
    const cursor = normalizeCursor(input.cursor);
    validateRange(transfers, cursor);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      let insertedTransfers = 0;
      for (const transfer of transfers) {
        if (await insertTransfer(client, transfer)) insertedTransfers += 1;
      }
      const version = await advanceCursor(client, cursor);
      await client.query('COMMIT');
      return Object.freeze({
        insertedTransfers,
        duplicateTransfers: transfers.length - insertedTransfers,
        cursorVersion: version,
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function getCursor() {
    const result = await database.query(
      `SELECT stream, next_block, safe_head, checkpoint_block, checkpoint_hash, version
         FROM robinhood_holder_cursors
        WHERE chain = $1 AND stream = $2`,
      [CHAIN, STREAM]
    );
    return normalizeCursorRow(result.rows[0]);
  }

  return Object.freeze({ appendCapturedRange, getCursor });
}

module.exports = {
  createRobinhoodHolderLedgerRepository,
  __private: { normalizeCursor, normalizeTransfer, validateRange },
};

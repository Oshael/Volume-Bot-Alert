const db = require('./db');
const {
  deriveHolderBalanceChanges,
  normalizeHolderTransfer,
} = require('./robinhood-holder-ledger');

const CHAIN = 'robinhood';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const MAX_RANGE_BLOCKS = 5000n;

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function integer(value, label, minimum = 1) {
  const parsed = Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label} is invalid`);
  return parsed;
}

function fixedHex(value, bytes, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function compareTransfers(left, right) {
  const leftBlock = BigInt(left.blockNumber);
  const rightBlock = BigInt(right.blockNumber);
  if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
  return left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex;
}

function normalizeRange(input = {}) {
  const runId = integer(input.runId, 'runId');
  const fromBlock = quantity(input.fromBlock, 'fromBlock');
  const toBlock = quantity(input.toBlock, 'toBlock');
  if (fromBlock > toBlock) throw new Error('global holder range is inverted');
  if (toBlock - fromBlock + 1n > MAX_RANGE_BLOCKS) {
    throw new Error(`global holder range exceeds ${MAX_RANGE_BLOCKS} blocks`);
  }
  const checkpointBlock = quantity(input.checkpoint?.number, 'checkpoint.number');
  if (checkpointBlock !== toBlock) throw new Error('checkpoint must match global range end');
  const checkpointHash = fixedHex(input.checkpoint?.hash, 32, 'checkpoint.hash');
  const transfers = (Array.isArray(input.transfers) ? input.transfers : [])
    .map(normalizeHolderTransfer).sort(compareTransfers);
  const identities = new Set();
  const blockHashes = new Map();
  for (const transfer of transfers) {
    const block = BigInt(transfer.blockNumber);
    if (block < fromBlock || block > toBlock) {
      throw new Error('global holder transfer is outside its range');
    }
    const identity = `${transfer.transactionHash}:${transfer.logIndex}`;
    if (identities.has(identity)) throw new Error('global holder range has duplicate transfers');
    identities.add(identity);
    const knownHash = blockHashes.get(transfer.blockNumber);
    if (knownHash && knownHash !== transfer.blockHash) {
      throw new Error('global holder range has conflicting block hashes');
    }
    blockHashes.set(transfer.blockNumber, transfer.blockHash);
    if (block === toBlock && transfer.blockHash !== checkpointHash) {
      throw new Error('global holder transfer conflicts with checkpoint');
    }
  }
  return Object.freeze({
    runId, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
    nextBlock: (toBlock + 1n).toString(), checkpointHash,
    transfers: Object.freeze(transfers),
  });
}

async function lockRun(client, range) {
  const result = await client.query(
    `SELECT id FROM robinhood_holder_global_backfill_runs
      WHERE id = $1 AND chain = $2 AND status IN ('scanning', 'attached')
        AND next_block = $3 FOR UPDATE`,
    [range.runId, CHAIN, range.fromBlock]
  );
  if (!result.rowCount) {
    const error = new Error('global holder backfill cursor is stale or unavailable');
    error.code = 'holder_global_backfill_cursor_stale';
    throw error;
  }
}

function touchedTokenAddresses(transfers) {
  return [...new Set(transfers.map(({ tokenAddress }) => tokenAddress))].sort();
}

async function lockCohortTokens(client, range, tokens) {
  if (!tokens.length) return;
  const result = await client.query(
    `SELECT token_address FROM robinhood_holder_global_backfill_tokens
      WHERE run_id = $1 AND chain = $2 AND status = 'active'
        AND token_address = ANY($3::varchar[])
      ORDER BY token_address FOR UPDATE`,
    [range.runId, CHAIN, tokens]
  );
  if (result.rowCount !== tokens.length) {
    const error = new Error('global holder transfer token is outside the active cohort');
    error.code = 'holder_global_backfill_token_unavailable';
    throw error;
  }
}

async function loadBalances(client, transfers) {
  const keys = [...new Map(transfers.flatMap(({ tokenAddress, fromWallet, toWallet }) => (
    [fromWallet, toWallet].filter((wallet) => wallet !== ZERO_ADDRESS).map((wallet) => [
      `${tokenAddress}:${wallet}`, { token_address: tokenAddress, wallet_address: wallet },
    ])
  ))).values()].sort((left, right) => (
    left.token_address.localeCompare(right.token_address)
      || left.wallet_address.localeCompare(right.wallet_address)
  ));
  const books = new Map();
  if (!keys.length) return books;
  const result = await client.query(
    `SELECT balance.token_address, balance.wallet_address, balance.balance_raw
       FROM robinhood_holder_balances balance
       INNER JOIN jsonb_to_recordset($1::jsonb)
         AS item(token_address text, wallet_address text)
         ON item.token_address = balance.token_address
        AND item.wallet_address = balance.wallet_address
      WHERE balance.chain = $2
      ORDER BY balance.token_address, balance.wallet_address FOR UPDATE OF balance`,
    [JSON.stringify(keys), CHAIN]
  );
  for (const row of result.rows) {
    if (!books.has(row.token_address)) books.set(row.token_address, {});
    books.get(row.token_address)[row.wallet_address] = String(row.balance_raw);
  }
  return books;
}

function computeRange(range, books) {
  const finalRows = new Map();
  const holderDeltas = new Map();
  for (const transfer of range.transfers) {
    if (!books.has(transfer.tokenAddress)) books.set(transfer.tokenAddress, {});
    const balances = books.get(transfer.tokenAddress);
    let changes;
    try {
      changes = deriveHolderBalanceChanges(transfer, balances);
    } catch (error) {
      if (error.code !== 'holder_negative_balance') throw error;
      error.tokenAddress = transfer.tokenAddress;
      error.failedBlock = transfer.blockNumber;
      error.fingerprint = [
        transfer.blockHash, transfer.transactionHash, transfer.logIndex,
        transfer.fromWallet, transfer.amountRaw, balances[transfer.fromWallet] ?? '0',
      ].join(':');
      throw error;
    }
    holderDeltas.set(
      transfer.tokenAddress,
      (holderDeltas.get(transfer.tokenAddress) || 0) + changes.holderDelta
    );
    for (const transition of changes.transitions) {
      balances[transition.walletAddress] = transition.after;
      finalRows.set(`${transfer.tokenAddress}:${transition.walletAddress}`, {
        token_address: transfer.tokenAddress, wallet_address: transition.walletAddress,
        balance_raw: transition.after, block_number: transfer.blockNumber,
        transaction_hash: transfer.transactionHash, log_index: transfer.logIndex,
      });
    }
  }
  return { finalRows, holderDeltas };
}

async function persistBalances(client, finalRows) {
  const rows = [...finalRows.values()];
  const zeroRows = rows.filter(({ balance_raw: balance }) => BigInt(balance) === 0n);
  const positiveRows = rows.filter(({ balance_raw: balance }) => BigInt(balance) > 0n);
  if (zeroRows.length) {
    await client.query(
      `DELETE FROM robinhood_holder_balances balance
        USING jsonb_to_recordset($1::jsonb)
          AS item(token_address text, wallet_address text)
        WHERE balance.chain = $2 AND balance.token_address = item.token_address
          AND balance.wallet_address = item.wallet_address`,
      [JSON.stringify(zeroRows), CHAIN]
    );
  }
  if (!positiveRows.length) return;
  await client.query(
    `INSERT INTO robinhood_holder_balances (
       chain, token_address, wallet_address, balance_raw, last_block_number,
       last_transaction_hash, last_log_index
     ) SELECT $1, item.token_address, item.wallet_address, item.balance_raw::numeric,
              item.block_number::bigint, item.transaction_hash, item.log_index
         FROM jsonb_to_recordset($2::jsonb) AS item(
           token_address text, wallet_address text, balance_raw text,
           block_number text, transaction_hash text, log_index int
         )
     ON CONFLICT (chain, token_address, wallet_address) DO UPDATE SET
       balance_raw = EXCLUDED.balance_raw,
       last_block_number = EXCLUDED.last_block_number,
       last_transaction_hash = EXCLUDED.last_transaction_hash,
       last_log_index = EXCLUDED.last_log_index,
       updated_at = NOW()`,
    [CHAIN, JSON.stringify(positiveRows)]
  );
}

async function persistCounts(client, range, holderDeltas) {
  const rows = [...holderDeltas].map(([tokenAddress, holderDelta]) => ({
    token_address: tokenAddress, holder_delta: String(holderDelta),
  }));
  if (!rows.length) return;
  const result = await client.query(
    `UPDATE robinhood_holder_global_backfill_tokens token
        SET holder_count = token.holder_count + item.holder_delta::bigint,
            updated_at = NOW()
       FROM jsonb_to_recordset($2::jsonb)
         AS item(token_address text, holder_delta text)
      WHERE token.run_id = $1 AND token.chain = $3 AND token.status = 'active'
        AND token.token_address = item.token_address
        AND token.holder_count + item.holder_delta::bigint >= 0
      RETURNING token.token_address`,
    [range.runId, JSON.stringify(rows), CHAIN]
  );
  if (result.rowCount !== rows.length) throw new Error('global holder count update was rejected');
}

async function advanceRun(client, range) {
  const result = await client.query(
    `UPDATE robinhood_holder_global_backfill_runs
        SET next_block = $3, checkpoint_block = $4, checkpoint_hash = $5,
            version = version + 1, updated_at = NOW()
      WHERE id = $1 AND chain = $2 AND status IN ('scanning', 'attached')
        AND next_block = $6
      RETURNING version`,
    [range.runId, CHAIN, range.nextBlock, range.toBlock, range.checkpointHash, range.fromBlock]
  );
  if (!result.rowCount) throw new Error('global holder cursor rejected an ordered range');
  return String(result.rows[0].version);
}

async function withTransaction(database, callback) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createRobinhoodHolderGlobalBackfillCommitRepository(options = {}) {
  const database = options.database || db;

  async function commitRange(input = {}) {
    const range = normalizeRange(input);
    return withTransaction(database, async (client) => {
      await lockRun(client, range);
      const tokens = touchedTokenAddresses(range.transfers);
      await lockCohortTokens(client, range, tokens);
      const computed = computeRange(range, await loadBalances(client, range.transfers));
      await persistBalances(client, computed.finalRows);
      await persistCounts(client, range, computed.holderDeltas);
      const version = await advanceRun(client, range);
      return Object.freeze({
        status: 'committed', runId: String(range.runId), fromBlock: range.fromBlock,
        toBlock: range.toBlock, nextBlock: range.nextBlock,
        checkpointHash: range.checkpointHash, transfers: range.transfers.length,
        touchedTokens: tokens.length, touchedWallets: computed.finalRows.size, version,
      });
    });
  }

  async function excludeToken(input = {}) {
    const runId = integer(input.runId, 'runId');
    const tokenAddress = fixedHex(input.tokenAddress, 20, 'tokenAddress');
    const reason = String(input.reason || '').trim();
    if (!reason || reason.length > 256) throw new Error('reason is invalid');
    return withTransaction(database, async (client) => {
      const run = await client.query(
        `SELECT id FROM robinhood_holder_global_backfill_runs
          WHERE id = $1 AND chain = $2 AND status IN ('scanning', 'attached') FOR UPDATE`,
        [runId, CHAIN]
      );
      if (!run.rowCount) throw new Error('global holder backfill run is unavailable');
      const token = await client.query(
        `SELECT status, exclusion_reason FROM robinhood_holder_global_backfill_tokens
          WHERE run_id = $1 AND chain = $2 AND token_address = $3 FOR UPDATE`,
        [runId, CHAIN, tokenAddress]
      );
      if (!token.rowCount || !['active', 'excluded'].includes(token.rows[0].status)) {
        throw new Error('global holder backfill token cannot be excluded');
      }
      if (token.rows[0].status === 'excluded') {
        return Object.freeze({ status: 'excluded', tokenAddress, deletedBalances: 0 });
      }
      const deleted = await client.query(
        `DELETE FROM robinhood_holder_balances WHERE chain = $1 AND token_address = $2`,
        [CHAIN, tokenAddress]
      );
      await client.query(
        `UPDATE robinhood_holder_global_backfill_tokens
            SET holder_count = 0, status = 'excluded', exclusion_reason = $4, updated_at = NOW()
          WHERE run_id = $1 AND chain = $2 AND token_address = $3`,
        [runId, CHAIN, tokenAddress, reason]
      );
      return Object.freeze({
        status: 'excluded', tokenAddress, deletedBalances: deleted.rowCount,
      });
    });
  }

  return Object.freeze({ commitRange, excludeToken });
}

module.exports = {
  createRobinhoodHolderGlobalBackfillCommitRepository,
  __private: { compareTransfers, computeRange, normalizeRange },
};

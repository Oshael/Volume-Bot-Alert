const db = require('./db');
const {
  deriveHolderBalanceChanges,
  normalizeHolderTransfer,
} = require('./robinhood-holder-ledger');

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const MAX_RANGE_BLOCKS = 5000n;

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function tokenAddress(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error('tokenAddress is invalid');
  return normalized;
}

function blockHash(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('checkpoint.hash is invalid');
  return normalized;
}

function stateRow(row) {
  if (!row) return null;
  const state = {
    tokenAddress: tokenAddress(row.token_address),
    deploymentBlock: quantity(row.deployment_block, 'deploymentBlock').toString(),
    backfillNextBlock: quantity(row.backfill_next_block, 'backfillNextBlock').toString(),
    liveThroughBlock: row.live_through_block == null ? null : String(row.live_through_block),
    liveThroughHash: row.live_through_hash,
    version: Number(row.version),
  };
  if ((state.liveThroughBlock === null) !== (state.liveThroughHash === null)) {
    throw new Error('holder backfill checkpoint pair is inconsistent');
  }
  if (state.liveThroughBlock !== null
      && BigInt(state.liveThroughBlock) + 1n !== BigInt(state.backfillNextBlock)) {
    throw new Error('holder backfill checkpoint does not precede its cursor');
  }
  return Object.freeze(state);
}

function normalizeRange(input = {}) {
  const token = tokenAddress(input.tokenAddress);
  const fromBlock = quantity(input.fromBlock, 'fromBlock');
  const toBlock = quantity(input.toBlock, 'toBlock');
  if (fromBlock > toBlock) throw new Error('holder backfill range is inverted');
  if (toBlock - fromBlock + 1n > MAX_RANGE_BLOCKS) {
    throw new Error(`holder backfill range exceeds ${MAX_RANGE_BLOCKS} blocks`);
  }
  const checkpointNumber = quantity(input.checkpoint?.number, 'checkpoint.number');
  if (checkpointNumber !== toBlock) throw new Error('checkpoint must match range end');
  const checkpoint = Object.freeze({ number: toBlock.toString(), hash: blockHash(input.checkpoint.hash) });
  const transfers = (Array.isArray(input.transfers) ? input.transfers : [])
    .map(normalizeHolderTransfer)
    .sort((left, right) => (
      BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1
        : BigInt(left.blockNumber) > BigInt(right.blockNumber) ? 1
          : left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex
    ));
  for (const transfer of transfers) {
    const block = BigInt(transfer.blockNumber);
    if (transfer.tokenAddress !== token || block < fromBlock || block > toBlock) {
      throw new Error('holder backfill transfer does not belong to range');
    }
    if (block === toBlock && transfer.blockHash !== checkpoint.hash) {
      throw new Error('holder backfill transfer conflicts with checkpoint');
    }
  }
  const identities = new Set(transfers.map(({ transactionHash, logIndex }) => (
    `${transactionHash}:${logIndex}`
  )));
  if (identities.size !== transfers.length) throw new Error('holder backfill has duplicate transfers');
  return Object.freeze({
    tokenAddress: token, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
    nextBlock: (toBlock + 1n).toString(), checkpoint, transfers: Object.freeze(transfers),
  });
}

async function lockState(client, range) {
  const result = await client.query(
    `SELECT holder_count, backfill_next_block, version
       FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status = 'backfilling' AND backfill_next_block = $2
        AND deployment_block <= $2
      FOR UPDATE`,
    [range.tokenAddress, range.fromBlock]
  );
  if (!result.rowCount) {
    const error = new Error('holder backfill token cursor is stale or unavailable');
    error.code = 'holder_backfill_cursor_stale';
    throw error;
  }
  return result.rows[0];
}

async function loadBalances(client, range) {
  const wallets = [...new Set(range.transfers.flatMap(({ fromWallet, toWallet }) => (
    [fromWallet, toWallet]
  )).filter((wallet) => wallet !== ZERO_ADDRESS))].sort();
  if (!wallets.length) return {};
  const result = await client.query(
    `SELECT wallet_address, balance_raw
       FROM robinhood_holder_balances
      WHERE chain = 'robinhood' AND token_address = $1
        AND wallet_address = ANY($2::varchar[])
      ORDER BY wallet_address FOR UPDATE`,
    [range.tokenAddress, wallets]
  );
  return Object.fromEntries(result.rows.map((row) => (
    [row.wallet_address, String(row.balance_raw)]
  )));
}

function computeRange(range, balances) {
  const finalRows = new Map();
  let holderDelta = 0;
  for (const transfer of range.transfers) {
    const changes = deriveHolderBalanceChanges(transfer, balances);
    holderDelta += changes.holderDelta;
    for (const transition of changes.transitions) {
      balances[transition.walletAddress] = transition.after;
      finalRows.set(transition.walletAddress, {
        walletAddress: transition.walletAddress,
        balanceRaw: transition.after,
        blockNumber: transfer.blockNumber,
        transactionHash: transfer.transactionHash,
        logIndex: transfer.logIndex,
      });
    }
  }
  return { finalRows, holderDelta };
}

async function persistBalances(client, token, finalRows) {
  const rows = [...finalRows.values()];
  const zeroWallets = rows.filter(({ balanceRaw }) => BigInt(balanceRaw) === 0n)
    .map(({ walletAddress }) => walletAddress);
  const positiveRows = rows.filter(({ balanceRaw }) => BigInt(balanceRaw) > 0n);
  if (zeroWallets.length) {
    await client.query(
      `DELETE FROM robinhood_holder_balances
        WHERE chain = 'robinhood' AND token_address = $1
          AND wallet_address = ANY($2::varchar[])`,
      [token, zeroWallets]
    );
  }
  if (!positiveRows.length) return;
  await client.query(
    `INSERT INTO robinhood_holder_balances (
       chain, token_address, wallet_address, balance_raw, last_block_number,
       last_transaction_hash, last_log_index
     ) SELECT 'robinhood', $1, item.wallet_address, item.balance_raw::numeric,
              item.block_number::bigint, item.transaction_hash, item.log_index
         FROM jsonb_to_recordset($2::jsonb) AS item(
           wallet_address text, balance_raw text, block_number text,
           transaction_hash text, log_index int
         )
     ON CONFLICT (chain, token_address, wallet_address) DO UPDATE SET
       balance_raw = EXCLUDED.balance_raw,
       last_block_number = EXCLUDED.last_block_number,
       last_transaction_hash = EXCLUDED.last_transaction_hash,
       last_log_index = EXCLUDED.last_log_index,
       updated_at = NOW()`,
    [token, JSON.stringify(positiveRows.map((row) => ({
      wallet_address: row.walletAddress, balance_raw: row.balanceRaw,
      block_number: row.blockNumber, transaction_hash: row.transactionHash,
      log_index: row.logIndex,
    })))]
  );
}

async function advanceState(client, range, holderDelta) {
  const result = await client.query(
    `UPDATE robinhood_holder_token_states
        SET holder_count = holder_count + $3::bigint,
            backfill_next_block = $4, live_through_block = $5,
            live_through_hash = $6, version = version + 1, updated_at = NOW()
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status = 'backfilling' AND backfill_next_block = $2
        AND holder_count + $3::bigint >= 0
      RETURNING holder_count, backfill_next_block, live_through_block,
                live_through_hash, version`,
    [
      range.tokenAddress, range.fromBlock, String(holderDelta), range.nextBlock,
      range.checkpoint.number, range.checkpoint.hash,
    ]
  );
  if (!result.rowCount) throw new Error('holder backfill state rejected committed range');
  return result.rows[0];
}

async function markDrifted(client, range, reason) {
  await client.query(
    `UPDATE robinhood_holder_token_states
        SET ledger_status = 'drifted', version = version + 1, updated_at = NOW()
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status = 'backfilling' AND backfill_next_block = $2`,
    [range.tokenAddress, range.fromBlock]
  );
  return Object.freeze({ status: 'drifted', tokenAddress: range.tokenAddress, reason });
}

function createRobinhoodHolderBackfillRepository(options = {}) {
  const database = options.database || db;

  async function getNextToken(input = {}) {
    const throughBlock = quantity(input.throughBlock, 'throughBlock').toString();
    const result = await database.query(
      `SELECT token_address, deployment_block, backfill_next_block,
              live_through_block, live_through_hash, version
         FROM robinhood_holder_token_states
        WHERE chain = 'robinhood' AND ledger_status = 'backfilling'
          AND backfill_next_block <= $1
        ORDER BY backfill_next_block DESC, token_address
        LIMIT 1`,
      [throughBlock]
    );
    return stateRow(result.rows[0]);
  }

  async function markResyncing(input = {}) {
    const token = tokenAddress(input.tokenAddress);
    const nextBlock = quantity(input.backfillNextBlock, 'backfillNextBlock').toString();
    const result = await database.query(
      `UPDATE robinhood_holder_token_states
          SET ledger_status = 'resyncing', version = version + 1, updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = $1
          AND ledger_status = 'backfilling' AND backfill_next_block = $2
        RETURNING token_address`,
      [token, nextBlock]
    );
    if (!result.rowCount) {
      const error = new Error('holder backfill cursor changed before resync isolation');
      error.code = 'holder_backfill_cursor_stale';
      throw error;
    }
    return Object.freeze({ status: 'resyncing', tokenAddress: token });
  }

  async function commitRange(input = {}) {
    const range = normalizeRange(input);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await lockState(client, range);
      const balances = await loadBalances(client, range);
      let computed;
      try {
        computed = computeRange(range, balances);
      } catch (error) {
        if (error.code !== 'holder_negative_balance') throw error;
        const drifted = await markDrifted(client, range, error.code);
        await client.query('COMMIT');
        return drifted;
      }
      await persistBalances(client, range.tokenAddress, computed.finalRows);
      const state = await advanceState(client, range, computed.holderDelta);
      await client.query('COMMIT');
      return Object.freeze({
        status: 'committed', tokenAddress: range.tokenAddress,
        transfers: range.transfers.length, touchedWallets: computed.finalRows.size,
        holderDelta: computed.holderDelta, holderCount: String(state.holder_count),
        backfillNextBlock: String(state.backfill_next_block),
        liveThroughBlock: String(state.live_through_block),
        liveThroughHash: state.live_through_hash, version: Number(state.version),
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ commitRange, getNextToken, markResyncing });
}

module.exports = {
  createRobinhoodHolderBackfillRepository,
  __private: { computeRange, normalizeRange, stateRow },
};

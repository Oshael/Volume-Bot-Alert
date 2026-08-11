require('dotenv').config();

const db = require('../models/db');
const {
  deriveHolderBalanceChanges,
} = require('../models/robinhood-holder-ledger');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  createRobinhoodHolderTransferReader,
} = require('../services/robinhood-holder-transfer-reader');
const { resolveRobinhoodHolderRpcProvider } = require('../services/robinhood-holder-rpc');

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function optionalAddress(value) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(normalized)) throw new Error('drift probe token is invalid');
  return normalized;
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    tokenAddress: optionalAddress(input.tokenAddress),
    limit: boundedInteger(input.limit, 5, 1, 100, 'drift probe limit'),
    rangeSize: boundedInteger(input.rangeSize, 5000, 1, 5000, 'drift probe rangeSize'),
    confirmations: boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations'),
    timeoutMs: boundedInteger(input.timeoutMs, 15_000, 1000, 60_000, 'RPC timeout'),
  });
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function balanceOfData(walletAddress) {
  const wallet = optionalAddress(walletAddress);
  if (!wallet) throw new Error('balanceOf wallet is required');
  return `0x70a08231${'0'.repeat(24)}${wallet.slice(2)}`;
}

function decimalResult(value) {
  const normalized = String(value || '').trim();
  if (!/^0x[0-9a-f]+$/i.test(normalized)) throw new Error('balanceOf result is invalid');
  return BigInt(normalized).toString();
}

function touchedWallets(transfers) {
  return [...new Set(transfers.flatMap(({ fromWallet, toWallet }) => (
    [fromWallet, toWallet]
  )).filter((wallet) => wallet !== ZERO_ADDRESS))].sort();
}

function findFirstDeficit(transfers, initialBalances = {}) {
  const balances = { ...initialBalances };
  const blockStarts = new Map();
  for (const transfer of transfers) {
    for (const wallet of [transfer.fromWallet, transfer.toWallet]) {
      if (wallet === ZERO_ADDRESS) continue;
      const key = `${transfer.blockNumber}:${wallet}`;
      if (!blockStarts.has(key)) blockStarts.set(key, String(balances[wallet] ?? 0));
    }
    let changes;
    try {
      changes = deriveHolderBalanceChanges(transfer, balances);
    } catch (error) {
      if (error.code !== 'holder_negative_balance') throw error;
      return Object.freeze({
        transfer,
        localBalanceBefore: String(balances[transfer.fromWallet] ?? 0),
        localBalanceAtBlockStart: blockStarts.get(
          `${transfer.blockNumber}:${transfer.fromWallet}`
        ) || '0',
      });
    }
    for (const transition of changes.transitions) {
      balances[transition.walletAddress] = transition.after;
    }
  }
  return null;
}

function classifyDivergence(localBalanceAtBlockStart, historicalBalance) {
  if (historicalBalance == null) return 'archive-state-unavailable';
  if (BigInt(historicalBalance) === BigInt(localBalanceAtBlockStart)) {
    return 'same-block-or-nonstandard-transfer-semantics';
  }
  return BigInt(historicalBalance) > BigInt(localBalanceAtBlockStart)
    ? 'missing-or-implicit-credit-before-block'
    : 'historical-state-diverged-below-ledger';
}

async function loadDriftedStates(database, options) {
  const { rows } = await database.query(
    `SELECT token_address, deployment_block, backfill_next_block, holder_count
       FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND ledger_status = 'drifted'
        AND ($1::varchar IS NULL OR token_address = $1)
      ORDER BY updated_at ASC, token_address ASC
      LIMIT $2::int`,
    [options.tokenAddress, options.limit]
  );
  return rows.map((row) => Object.freeze({
    tokenAddress: row.token_address,
    deploymentBlock: String(row.deployment_block),
    backfillNextBlock: String(row.backfill_next_block),
    holderCount: String(row.holder_count),
  }));
}

async function loadBalances(database, tokenAddress, wallets) {
  if (!wallets.length) return {};
  const { rows } = await database.query(
    `SELECT wallet_address, balance_raw
       FROM robinhood_holder_balances
      WHERE chain = 'robinhood' AND token_address = $1
        AND wallet_address = ANY($2::varchar[])`,
    [tokenAddress, wallets]
  );
  return Object.fromEntries(rows.map((row) => (
    [row.wallet_address, String(row.balance_raw)]
  )));
}

async function historicalBalanceOf(rpcClient, tokenAddress, walletAddress, blockNumber) {
  const value = await rpcClient.request('eth_call', [{
    to: tokenAddress, data: balanceOfData(walletAddress),
  }, blockTag(blockNumber)]);
  return decimalResult(value);
}

async function inspectState(state, context) {
  const fromBlock = BigInt(state.backfillNextBlock);
  const safeHead = BigInt(context.safeHead);
  if (fromBlock > safeHead) return Object.freeze({ ...state, status: 'awaiting-safe-head' });
  const candidateEnd = fromBlock + BigInt(context.rangeSize - 1);
  const toBlock = candidateEnd < safeHead ? candidateEnd : safeHead;
  const range = await context.reader.readRange({
    tokenAddress: state.tokenAddress,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
  });
  const balances = await loadBalances(
    context.database, state.tokenAddress, touchedWallets(range.transfers)
  );
  const deficit = findFirstDeficit(range.transfers, balances);
  if (!deficit) return Object.freeze({
    ...state, status: 'not-reproduced', inspectedThroughBlock: toBlock.toString(),
    transfers: range.transfers.length,
  });

  const precedingBlock = BigInt(deficit.transfer.blockNumber) - 1n;
  let historicalBalance = null;
  let archiveError = null;
  try {
    historicalBalance = await historicalBalanceOf(
      context.rpcClient, state.tokenAddress, deficit.transfer.fromWallet, precedingBlock
    );
  } catch (error) {
    archiveError = String(error?.code || error?.message || error).slice(0, 160);
  }
  return Object.freeze({
    ...state,
    status: 'deficit-found',
    classification: classifyDivergence(deficit.localBalanceAtBlockStart, historicalBalance),
    failedBlock: deficit.transfer.blockNumber,
    precedingBlock: precedingBlock.toString(),
    transactionHash: deficit.transfer.transactionHash,
    logIndex: deficit.transfer.logIndex,
    sender: deficit.transfer.fromWallet,
    recipient: deficit.transfer.toWallet,
    amountRaw: deficit.transfer.amountRaw,
    localBalanceBefore: deficit.localBalanceBefore,
    localBalanceAtBlockStart: deficit.localBalanceAtBlockStart,
    historicalBalanceAtPrecedingBlock: historicalBalance,
    archiveError,
  });
}

async function runDriftProbe(input = {}) {
  const options = normalizeOptions(input);
  const database = input.database || db;
  const provider = input.provider || resolveRobinhoodHolderRpcProvider(
    input.env || process.env, 'robinhood-holder-drift-probe'
  );
  const rpcClient = input.rpcClient || createEvmJsonRpcClient({
    providers: [provider], timeoutMs: options.timeoutMs, maxRetries: 1,
  });
  const reader = input.reader || createRobinhoodHolderTransferReader({ rpcClient });
  const head = await reader.getSafeHead(options.confirmations);
  const states = await loadDriftedStates(database, options);
  const results = [];
  for (const state of states) {
    try {
      results.push(await inspectState(state, {
        database, rpcClient, reader, safeHead: head.safeHead, rangeSize: options.rangeSize,
      }));
    } catch (error) {
      results.push(Object.freeze({
        ...state, status: 'probe-error',
        error: String(error?.code || error?.message || error).slice(0, 160),
      }));
    }
  }
  return Object.freeze({
    provider: provider.name, safeHead: head.safeHead, selectedTokens: states.length,
    results: Object.freeze(results),
  });
}

async function main() {
  try {
    const result = await runDriftProbe({
      tokenAddress: process.env.ROBINHOOD_HOLDER_DRIFT_PROBE_TOKEN,
      limit: process.env.ROBINHOOD_HOLDER_DRIFT_PROBE_LIMIT,
      rangeSize: process.env.ROBINHOOD_HOLDER_DRIFT_PROBE_RANGE_SIZE,
      confirmations: process.env.ROBINHOOD_HOLDER_BACKFILL_CONFIRMATIONS,
      timeoutMs: process.env.ROBINHOOD_RPC_TIMEOUT_MS,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodHolderDriftProbe] Failed:', error.message);
  process.exitCode = 1;
});

module.exports = {
  runDriftProbe,
  __private: {
    balanceOfData, classifyDivergence, findFirstDeficit, normalizeOptions,
  },
};

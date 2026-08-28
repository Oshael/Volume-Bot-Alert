require('dotenv').config();

const db = require('../models/db');
const {
  deriveHolderBalanceChanges,
} = require('../models/robinhood-holder-ledger');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { TRANSFER_TOPIC } = require('../services/evm-erc20-supply-delta');
const {
  createRobinhoodHolderTransferReader,
} = require('../services/robinhood-holder-transfer-reader');
const { resolveRobinhoodHolderRpcProvider } = require('../services/robinhood-holder-rpc');

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const MAX_UINT256 = (1n << 256n) - 1n;
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
    afterTokenAddress: optionalAddress(input.afterTokenAddress),
    limit: boundedInteger(input.limit, 5, 1, 100, 'drift probe limit'),
    rangeSize: boundedInteger(input.rangeSize, 5000, 1, 5000, 'drift probe rangeSize'),
    confirmations: boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations'),
    timeoutMs: boundedInteger(input.timeoutMs, 15_000, 1000, 60_000, 'RPC timeout'),
    receiptBlockLimit: boundedInteger(
      input.receiptBlockLimit, 250, 1, 1000, 'receipt block limit'
    ),
    receiptBatchSize: boundedInteger(
      input.receiptBatchSize, 25, 1, 100, 'receipt batch size'
    ),
  });
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized);
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

function receiptTransferIdentity(log, tokenAddress, fromBlock, toBlock) {
  const topics = Array.isArray(log?.topics) ? log.topics : [];
  if (String(log?.address || '').toLowerCase() !== tokenAddress
      || String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) return null;
  const blockNumber = quantity(log.blockNumber, 'receipt log blockNumber');
  if (blockNumber < fromBlock || blockNumber > toBlock || log.removed === true) {
    throw new Error('receipt Transfer log is outside the canonical probe range');
  }
  const transactionHash = String(log.transactionHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new Error('receipt Transfer transactionHash is invalid');
  }
  return `${transactionHash}:${quantity(log.logIndex, 'receipt logIndex').toString()}`;
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value));
}

async function readReceiptEvidence(range, deficit, context) {
  const fromBlock = BigInt(range.fromBlock);
  const toBlock = BigInt(deficit.transfer.blockNumber);
  const blockCount = Number(toBlock - fromBlock + 1n);
  if (blockCount > context.receiptBlockLimit) return Object.freeze({
    status: 'range-too-wide', fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
    blockCount, blockLimit: context.receiptBlockLimit,
  });
  const requests = Array.from({ length: blockCount }, (_, offset) => ({
    method: 'eth_getBlockReceipts', params: [blockTag(fromBlock + BigInt(offset))],
  }));
  const receiptResults = [];
  const startedAt = context.now();
  try {
    for (let offset = 0; offset < requests.length; offset += context.receiptBatchSize) {
      receiptResults.push(...await context.rpcClient.requestBatch(
        requests.slice(offset, offset + context.receiptBatchSize)
      ));
    }
  } catch (error) {
    return Object.freeze({
      status: 'unavailable', fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
      blockCount, error: String(error?.code || error?.message || error).slice(0, 160),
    });
  }
  const identities = [];
  let receiptCount = 0;
  for (const blockReceipts of receiptResults) {
    if (!Array.isArray(blockReceipts)) throw new Error('eth_getBlockReceipts result is invalid');
    receiptCount += blockReceipts.length;
    for (const receipt of blockReceipts) {
      if (!Array.isArray(receipt?.logs)) throw new Error('receipt logs are invalid');
      for (const log of receipt.logs) {
        const identity = receiptTransferIdentity(
          log, range.tokenAddress, fromBlock, toBlock
        );
        if (identity) identities.push(identity);
      }
    }
  }
  const receiptSet = new Set(identities);
  if (receiptSet.size !== identities.length) throw new Error('receipt probe returned duplicate logs');
  const getLogsSet = new Set(range.transfers
    .filter(({ blockNumber }) => BigInt(blockNumber) <= toBlock)
    .map(({ transactionHash, logIndex }) => `${transactionHash}:${logIndex}`));
  const missingFromGetLogs = difference(receiptSet, getLogsSet);
  const missingFromReceipts = difference(getLogsSet, receiptSet);
  return Object.freeze({
    status: missingFromGetLogs.length || missingFromReceipts.length ? 'mismatch' : 'match',
    fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), blockCount,
    rpcBatches: Math.ceil(blockCount / context.receiptBatchSize), receiptCount,
    getLogsTransfers: getLogsSet.size, receiptTransfers: receiptSet.size,
    missingFromGetLogsCount: missingFromGetLogs.length,
    missingFromReceiptsCount: missingFromReceipts.length,
    missingFromGetLogs: Object.freeze(missingFromGetLogs.slice(0, 20)),
    missingFromReceipts: Object.freeze(missingFromReceipts.slice(0, 20)),
    elapsedMs: Math.max(0, context.now() - startedAt),
  });
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
      if (!['holder_negative_balance', 'holder_balance_overflow'].includes(error.code)) {
        throw error;
      }
      const walletAddress = error.code === 'holder_balance_overflow'
        ? error.walletAddress : transfer.fromWallet;
      return Object.freeze({
        transfer, reason: error.code, walletAddress,
        projectedBalanceRaw: error.balanceRaw || null,
        localBalanceBefore: String(balances[walletAddress] ?? 0),
        localBalanceAtBlockStart: blockStarts.get(
          `${transfer.blockNumber}:${walletAddress}`
        ) || '0',
      });
    }
    for (const transition of changes.transitions) {
      balances[transition.walletAddress] = transition.after;
    }
  }
  return null;
}

function classifyOverflow(overflow, historicalBalance) {
  if (BigInt(overflow.localBalanceBefore) > MAX_UINT256) return Object.freeze({
    classification: 'invalid-persisted-balance',
    recommendedAction: 'full-replay-candidate',
  });
  if (historicalBalance == null) return Object.freeze({
    classification: 'archive-state-unavailable',
    recommendedAction: 'fallback-required',
  });
  if (BigInt(historicalBalance) !== BigInt(overflow.localBalanceAtBlockStart)) {
    return Object.freeze({
      classification: 'historical-state-diverged-from-ledger',
      recommendedAction: 'fallback-required',
    });
  }
  return Object.freeze({
    classification: 'same-block-or-nonstandard-transfer-semantics',
    recommendedAction: 'fallback-required',
  });
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
    `SELECT token_address, deployment_block, backfill_next_block, holder_count,
            live_through_block, live_through_hash, version
       FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND ledger_status = 'drifted'
        AND ($1::varchar IS NULL OR token_address = $1)
        AND ($2::varchar IS NULL OR token_address > $2)
      ORDER BY token_address ASC
      LIMIT $3::int`,
    [options.tokenAddress, options.afterTokenAddress, options.limit]
  );
  return rows.map((row) => Object.freeze({
    tokenAddress: row.token_address,
    deploymentBlock: String(row.deployment_block),
    backfillNextBlock: String(row.backfill_next_block),
    liveThroughBlock: row.live_through_block == null ? null : String(row.live_through_block),
    liveThroughHash: row.live_through_hash,
    holderCount: String(row.holder_count),
    version: String(row.version),
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

async function optionalHistoricalBalance(rpcClient, tokenAddress, walletAddress, blockNumber) {
  try {
    return Object.freeze({
      balance: await historicalBalanceOf(rpcClient, tokenAddress, walletAddress, blockNumber),
      error: null,
    });
  } catch (error) {
    return Object.freeze({
      balance: null,
      error: String(error?.code || error?.message || error).slice(0, 160),
    });
  }
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
  const divergence = findFirstDeficit(range.transfers, balances);
  if (!divergence) return Object.freeze({
    ...state, status: 'not-reproduced', inspectedThroughBlock: toBlock.toString(),
    transfers: range.transfers.length,
  });

  const failedBlock = BigInt(divergence.transfer.blockNumber);
  const precedingBlock = failedBlock - 1n;
  const preceding = await optionalHistoricalBalance(
    context.rpcClient, state.tokenAddress, divergence.walletAddress, precedingBlock
  );
  const receiptEvidence = await readReceiptEvidence(range, divergence, context);
  if (divergence.reason === 'holder_balance_overflow') {
    const failed = await optionalHistoricalBalance(
      context.rpcClient, state.tokenAddress, divergence.walletAddress, failedBlock
    );
    return Object.freeze({
      ...state, status: 'overflow-found',
      ...classifyOverflow(divergence, preceding.balance),
      failedBlock: divergence.transfer.blockNumber,
      precedingBlock: precedingBlock.toString(),
      transactionHash: divergence.transfer.transactionHash,
      logIndex: divergence.transfer.logIndex,
      walletAddress: divergence.walletAddress,
      sender: divergence.transfer.fromWallet,
      recipient: divergence.transfer.toWallet,
      amountRaw: divergence.transfer.amountRaw,
      localBalanceBefore: divergence.localBalanceBefore,
      localBalanceAtBlockStart: divergence.localBalanceAtBlockStart,
      projectedBalanceRaw: divergence.projectedBalanceRaw,
      historicalBalanceAtPrecedingBlock: preceding.balance,
      historicalBalanceAtFailedBlock: failed.balance,
      archiveErrors: Object.freeze({
        precedingBlock: preceding.error, failedBlock: failed.error,
      }),
      receiptEvidence,
    });
  }
  return Object.freeze({
    ...state,
    status: 'deficit-found',
    classification: classifyDivergence(divergence.localBalanceAtBlockStart, preceding.balance),
    failedBlock: divergence.transfer.blockNumber,
    precedingBlock: precedingBlock.toString(),
    transactionHash: divergence.transfer.transactionHash,
    logIndex: divergence.transfer.logIndex,
    sender: divergence.transfer.fromWallet,
    recipient: divergence.transfer.toWallet,
    amountRaw: divergence.transfer.amountRaw,
    localBalanceBefore: divergence.localBalanceBefore,
    localBalanceAtBlockStart: divergence.localBalanceAtBlockStart,
    historicalBalanceAtPrecedingBlock: preceding.balance,
    archiveError: preceding.error, receiptEvidence,
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
        receiptBlockLimit: options.receiptBlockLimit,
        receiptBatchSize: options.receiptBatchSize,
        now: input.now || Date.now,
      }));
    } catch (error) {
      results.push(Object.freeze({
        ...state, status: 'probe-error',
        error: String(error?.code || error?.message || error).slice(0, 160),
      }));
    }
  }
  const rpcMetrics = typeof rpcClient.getMetrics === 'function'
    ? rpcClient.getMetrics()?.[provider.name]?.['eth_getBlockReceipts:batch'] || null
    : null;
  return Object.freeze({
    provider: provider.name, safeHead: head.safeHead, selectedTokens: states.length,
    receiptRpcMetrics: rpcMetrics, results: Object.freeze(results),
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
      receiptBlockLimit: process.env.ROBINHOOD_HOLDER_DRIFT_PROBE_RECEIPT_BLOCK_LIMIT,
      receiptBatchSize: process.env.ROBINHOOD_HOLDER_DRIFT_PROBE_RECEIPT_BATCH_SIZE,
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
    balanceOfData, classifyDivergence, classifyOverflow, findFirstDeficit, normalizeOptions,
    readReceiptEvidence, receiptTransferIdentity,
  },
};

const { createHash } = require('node:crypto');

const RULE_VERSION = 'rh_possible_bundle_redistribution_v1';
const EVIDENCE_VERSION = 'rh_token_redistribution_v1';
const MAX_SELL_DELAY_MS = 5 * 60 * 1000;
const MIN_FAST_SELLERS = 2;
const MAX_RECIPIENTS = 10_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
const POLICY = Object.freeze({
  minimumDistinctRecipients: MIN_FAST_SELLERS,
  minimumRapidSellingRecipients: MIN_FAST_SELLERS,
  maximumRecipientSellDelayMs: MAX_SELL_DELAY_MS,
  fdvIsClassificationGate: false,
});

function address(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ADDRESS.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function unsigned(value, label) {
  const normalized = String(value ?? '');
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized);
}

function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return Object.freeze({ iso: parsed.toISOString(), milliseconds: parsed.getTime() });
}

function fdv(value, label) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function position(item, label, indexName) {
  const blockNumber = unsigned(item?.blockNumber, `${label} blockNumber`);
  const transactionIndex = unsigned(item?.transactionIndex, `${label} transactionIndex`);
  const index = unsigned(item?.[indexName], `${label} ${indexName}`);
  const transactionHash = String(item?.transactionHash || '').trim().toLowerCase();
  if (!HASH.test(transactionHash)) throw new Error(`${label} transactionHash is invalid`);
  const time = instant(item?.blockTime, `${label} blockTime`);
  return Object.freeze({
    blockNumber, transactionIndex, index, transactionHash,
    blockTime: time.iso, milliseconds: time.milliseconds,
  });
}

function sourceBuy(item) {
  const normalized = position(item, 'sourceBuy', 'actionIndex');
  return Object.freeze({
    blockNumber: normalized.blockNumber.toString(),
    transactionIndex: normalized.transactionIndex.toString(),
    actionIndex: normalized.index.toString(), transactionHash: normalized.transactionHash,
    blockTime: normalized.blockTime, milliseconds: normalized.milliseconds,
    fdvUsd: fdv(item.fdvUsd, 'sourceBuy fdvUsd'),
  });
}

function transfer(item, buy) {
  const normalized = position(item, 'transfer', 'logIndex');
  const amountRaw = unsigned(item?.amountRaw, 'transfer amountRaw');
  if (amountRaw === 0n || normalized.blockNumber <= BigInt(buy.blockNumber)
      || normalized.milliseconds < buy.milliseconds) {
    throw new Error('transfer must be positive and strictly after source buy block');
  }
  return Object.freeze({
    blockNumber: normalized.blockNumber.toString(), logIndex: normalized.index.toString(),
    transactionIndex: normalized.transactionIndex.toString(),
    transactionHash: normalized.transactionHash, blockTime: normalized.blockTime,
    milliseconds: normalized.milliseconds, amountRaw: amountRaw.toString(),
  });
}

function firstSell(item, received) {
  if (item == null) return null;
  const normalized = position(item, 'firstSell', 'actionIndex');
  if (normalized.blockNumber <= BigInt(received.blockNumber)
      || normalized.milliseconds < received.milliseconds) {
    throw new Error('first sell must be strictly after transfer block');
  }
  return Object.freeze({
    blockNumber: normalized.blockNumber.toString(), actionIndex: normalized.index.toString(),
    transactionIndex: normalized.transactionIndex.toString(),
    transactionHash: normalized.transactionHash, blockTime: normalized.blockTime,
    milliseconds: normalized.milliseconds,
    delayMs: normalized.milliseconds - received.milliseconds,
    fdvUsd: fdv(item.fdvUsd, 'firstSell fdvUsd'),
  });
}

function compareSell(left, right) {
  const block = BigInt(left.sell.blockNumber) - BigInt(right.sell.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  const transaction = BigInt(left.sell.transactionIndex) - BigInt(right.sell.transactionIndex);
  if (transaction !== 0n) return transaction < 0n ? -1 : 1;
  const index = BigInt(left.sell.actionIndex) - BigInt(right.sell.actionIndex);
  if (index !== 0n) return index < 0n ? -1 : 1;
  return left.walletAddress.localeCompare(right.walletAddress);
}

function bundleId(tokenAddress, members) {
  return `0x${createHash('sha256').update(
    `${tokenAddress}:${RULE_VERSION}:${members.join(',')}`
  ).digest('hex')}`;
}

function publicPosition(item, indexName) {
  return Object.freeze({
    blockNumber: item.blockNumber, transactionIndex: item.transactionIndex,
    [indexName]: item[indexName],
    transactionHash: item.transactionHash, blockTime: item.blockTime,
  });
}

function evaluateBundleRedistribution(input = {}) {
  const tokenAddress = address(input.tokenAddress, 'tokenAddress');
  const sourceWallet = address(input.sourceWallet, 'sourceWallet');
  const creatorAddress = address(input.creatorAddress, 'creatorAddress');
  if (!Array.isArray(input.recipients) || input.recipients.length > MAX_RECIPIENTS) {
    throw new Error('recipients are invalid or exceed policy limit');
  }
  const barriers = new Set([ZERO_ADDRESS, DEAD_ADDRESS, creatorAddress,
    ...(input.barrierAddresses || []).map((item) => address(item, 'barrierAddress'))].filter(Boolean));
  const buy = sourceBuy(input.sourceBuy || {});
  const seenRecipients = new Set();
  const eligible = [];
  for (const item of input.recipients) {
    const walletAddress = address(item.walletAddress, 'recipient walletAddress');
    if (seenRecipients.has(walletAddress)) throw new Error('recipient wallet is duplicated');
    seenRecipients.add(walletAddress);
    const received = transfer(item.transfer || {}, buy);
    const sell = firstSell(item.firstSell, received);
    if (walletAddress === sourceWallet || barriers.has(walletAddress)) continue;
    eligible.push(Object.freeze({ walletAddress, transfer: received, sell }));
  }
  const rapid = eligible.filter(({ sell }) => sell && sell.delayMs <= MAX_SELL_DELAY_MS)
    .sort(compareSell);
  const policy = POLICY;
  if (barriers.has(sourceWallet)) return Object.freeze({
    tokenAddress, sourceWallet, ruleVersion: RULE_VERSION, evidenceVersion: EVIDENCE_VERSION,
    statusReason: 'source_excluded', eligibleRecipientCount: eligible.length,
    rapidSellingRecipientCount: rapid.length, policy, group: null,
  });
  if (rapid.length < MIN_FAST_SELLERS) return Object.freeze({
    tokenAddress, sourceWallet, ruleVersion: RULE_VERSION, evidenceVersion: EVIDENCE_VERSION,
    statusReason: 'no_group', eligibleRecipientCount: eligible.length,
    rapidSellingRecipientCount: rapid.length, policy, group: null,
  });
  const memberWallets = [sourceWallet, ...rapid.map(({ walletAddress }) => walletAddress)].sort();
  const confirmation = rapid[MIN_FAST_SELLERS - 1].sell;
  const id = bundleId(tokenAddress, memberWallets);
  const group = Object.freeze({
    tokenAddress, ruleVersion: RULE_VERSION, bundleId: id,
    signal: 'coordinated_token_redistribution', sourceWallet,
    memberCount: memberWallets.length, connectionCount: rapid.length,
    confirmationFdvUsd: confirmation.fdvUsd,
    evidenceJson: Object.freeze({
      evidenceVersion: EVIDENCE_VERSION, maximumRecipientSellDelayMs: MAX_SELL_DELAY_MS,
      sourceBuy: Object.freeze({ ...publicPosition(buy, 'actionIndex'), fdvUsd: buy.fdvUsd }),
      recipients: Object.freeze(rapid.map(({ walletAddress, transfer: received, sell }) => (
        Object.freeze({ walletAddress,
          transfer: Object.freeze({ ...publicPosition(received, 'logIndex'),
            amountRaw: received.amountRaw }),
          firstSell: Object.freeze({ ...publicPosition(sell, 'actionIndex'),
            delayMs: sell.delayMs, fdvUsd: sell.fdvUsd }),
        })
      ))),
    }),
    members: Object.freeze(memberWallets.map((walletAddress) => Object.freeze({
      tokenAddress, bundleId: id, walletAddress,
      connectionKind: walletAddress === sourceWallet
        ? 'redistribution_source' : 'rapid_sell_recipient',
    }))),
  });
  return Object.freeze({
    tokenAddress, sourceWallet, ruleVersion: RULE_VERSION, evidenceVersion: EVIDENCE_VERSION,
    statusReason: 'group_found', eligibleRecipientCount: eligible.length,
    rapidSellingRecipientCount: rapid.length, policy, group,
  });
}

module.exports = {
  EVIDENCE_VERSION, MAX_SELL_DELAY_MS, MIN_FAST_SELLERS, POLICY, RULE_VERSION,
  evaluateBundleRedistribution,
};

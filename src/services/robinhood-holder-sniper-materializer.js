const {
  createRobinhoodHolderClassificationRepository,
} = require('../models/robinhood-holder-classification');
const {
  createRobinhoodHolderLaunchSource,
} = require('../models/robinhood-holder-launch-source');
const { parseDecimal } = require('./evm-market-metrics');

function normalizeMinimumNotionalUsd(value) {
  if (value == null || String(value).trim() === '') {
    throw new Error('minimumNotionalUsd is required');
  }
  const raw = String(value).trim();
  const match = raw.match(/^\+?(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('minimumNotionalUsd must be a base-10 decimal');
  const integer = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] || '').replace(/0+$/, '');
  const normalized = `${integer}${fraction ? `.${fraction}` : ''}`;
  const parsed = parseDecimal(normalized, 'minimumNotionalUsd');
  if (parsed.numerator <= 0n) throw new Error('minimumNotionalUsd must be positive');
  return Object.freeze({ normalized, parsed });
}

function atLeast(value, minimum) {
  if (value == null) return false;
  const actual = parseDecimal(value, 'first buy volumeUsd');
  return actual.numerator * minimum.denominator
    >= minimum.numerator * actual.denominator;
}

function buildSniperSnapshot(input, observedAt, minimumInput) {
  if (!input?.ready || !input.frontier || !input.anchor || !input.window) {
    throw new Error('SNIPER snapshot requires ready launch evidence');
  }
  const minimum = normalizeMinimumNotionalUsd(minimumInput);
  const excluded = new Set((input.exclusions || []).map(({ walletAddress }) => walletAddress));
  const records = (input.firstBuys || []).filter((buy) => (
    buy.withinLaunchWindow === true
      && !excluded.has(buy.walletAddress)
      && atLeast(buy.volumeUsd, minimum.parsed)
  )).map((buy) => ({
    walletAddress: buy.walletAddress,
    confidence: 'high',
    reasonCode: 'early_launch_buy',
    evidence: {
      source: 'robinhood_wallet_swaps',
      evidenceVersion: buy.evidenceVersion,
      launchAnchor: {
        transactionHash: input.anchor.transactionHash,
        actionIndex: input.anchor.actionIndex,
        transactionIndex: input.anchor.transactionIndex,
        blockNumber: input.anchor.blockNumber,
        blockHash: input.anchor.blockHash,
        blockTime: input.anchor.blockTime,
      },
      firstBuy: {
        transactionHash: buy.transactionHash,
        actionIndex: buy.actionIndex,
        transactionIndex: buy.transactionIndex,
        blockNumber: buy.blockNumber,
        blockHash: buy.blockHash,
        blockTime: buy.blockTime,
        volumeUsd: buy.volumeUsd,
        deltaBlocks: buy.deltaBlocks,
        deltaSeconds: buy.deltaSeconds,
      },
      rule: {
        maxBlocks: input.window.maxBlocks,
        maxSeconds: input.window.maxSeconds,
        minimumNotionalUsd: minimum.normalized,
      },
    },
  }));
  return Object.freeze({
    tokenAddress: input.tokenAddress,
    classifier: 'sniper',
    status: 'ready',
    statusReason: 'materialized',
    throughBlockNumber: input.frontier.blockNumber,
    throughBlockHash: input.frontier.blockHash,
    observedAt,
    records: Object.freeze(records),
  });
}

function createRobinhoodHolderSniperMaterializer(options = {}) {
  const minimum = normalizeMinimumNotionalUsd(options.minimumNotionalUsd).normalized;
  const source = options.source || createRobinhoodHolderLaunchSource(options);
  const classifications = options.classifications
    || createRobinhoodHolderClassificationRepository(options);
  const now = options.now || (() => new Date().toISOString());

  async function materializeToken(tokenAddress) {
    const evidence = await source.loadLaunchEvidence(tokenAddress);
    if (!evidence.ready) {
      return Object.freeze({ status: 'deferred', reason: evidence.reason, records: 0 });
    }
    return classifications.replaceClassifierSnapshot(
      buildSniperSnapshot(evidence, now(), minimum)
    );
  }

  return Object.freeze({ materializeToken });
}

module.exports = {
  buildSniperSnapshot,
  createRobinhoodHolderSniperMaterializer,
  normalizeMinimumNotionalUsd,
};

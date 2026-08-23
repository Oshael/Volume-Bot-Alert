const {
  createRobinhoodHolderClassificationRepository,
} = require('../models/robinhood-holder-classification');
const {
  createRobinhoodHolderLaunchSource,
} = require('../models/robinhood-holder-launch-source');
const {
  createRobinhoodHolderSniperCalibrationSource,
} = require('../models/robinhood-holder-sniper-calibration-source');
const {
  SNIPER_HIGH_CONFIDENCE_RULE,
} = require('./robinhood-holder-sniper-policy');
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

function normalizeRule(input = SNIPER_HIGH_CONFIDENCE_RULE) {
  const minimum = normalizeMinimumNotionalUsd(input.minimumNotionalUsd);
  const integer = (value, label, minimum = 1) => {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${label} must be at least ${minimum}`);
    }
    return value;
  };
  const evidenceVersion = String(input.evidenceVersion || '').trim();
  if (!/^rh_sniper_high_v[1-9]\d*$/.test(evidenceVersion)) {
    throw new Error('SNIPER evidenceVersion must match rh_sniper_high_vN');
  }
  return Object.freeze({
    evidenceVersion,
    maxBlocks: integer(input.maxBlocks, 'SNIPER maxBlocks', 0),
    maxBuyerRank: integer(input.maxBuyerRank, 'SNIPER maxBuyerRank'),
    minimumNotionalUsd: minimum.normalized,
    minimumNotional: minimum.parsed,
    minimumRecurringLaunches: integer(
      input.minimumRecurringLaunches, 'SNIPER minimumRecurringLaunches'
    ),
  });
}

function highConfidenceCandidates(input, rule) {
  const excluded = new Set((input.exclusions || []).map(({ walletAddress }) => walletAddress));
  return (input.firstBuys || []).filter((buy) => (
    !excluded.has(buy.walletAddress)
      && /^\d+$/.test(String(buy.deltaBlocks ?? ''))
      && BigInt(buy.deltaBlocks) >= 0n
      && BigInt(buy.deltaBlocks) <= BigInt(rule.maxBlocks)
      && Number.isSafeInteger(buy.buyerRank)
      && buy.buyerRank >= 1
      && buy.buyerRank <= rule.maxBuyerRank
      && atLeast(buy.volumeUsd, rule.minimumNotional)
  ));
}

function qualifyingLaunchCounts(rows, rule) {
  const tokensByWallet = new Map();
  for (const row of rows || []) {
    if (!row.anchorReady || !row.withinOneBlock || !row.positionReady
        || !Number.isSafeInteger(row.buyerRank) || row.buyerRank < 1
        || row.buyerRank > rule.maxBuyerRank
        || !atLeast(row.volumeUsd, rule.minimumNotional)) continue;
    const tokens = tokensByWallet.get(row.walletAddress) || new Set();
    tokens.add(row.tokenAddress);
    tokensByWallet.set(row.walletAddress, tokens);
  }
  return new Map([...tokensByWallet].map(([wallet, tokens]) => [wallet, tokens.size]));
}

function buildSniperSnapshot(input, recurrenceRows, observedAt, ruleInput) {
  if (!input?.ready || !input.frontier || !input.anchor || !input.window
      || !input.coverage?.completeThroughBlock) {
    throw new Error('SNIPER snapshot requires ready launch evidence');
  }
  const rule = normalizeRule(ruleInput);
  const recurrence = qualifyingLaunchCounts(recurrenceRows, rule);
  const records = highConfidenceCandidates(input, rule).filter((buy) => (
    (recurrence.get(buy.walletAddress) || 0) >= rule.minimumRecurringLaunches
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
        evidenceVersion: rule.evidenceVersion,
        maxBlocks: rule.maxBlocks,
        maxBuyerRank: rule.maxBuyerRank,
        minimumNotionalUsd: rule.minimumNotionalUsd,
        minimumRecurringLaunches: rule.minimumRecurringLaunches,
      },
      recurrence: {
        source: 'robinhood_wallet_token_first_buys',
        qualifyingLaunches: recurrence.get(buy.walletAddress),
        completeThroughBlock: input.coverage.completeThroughBlock,
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
  const rule = normalizeRule(options.rule);
  const sourceFactory = options.sourceFactory || createRobinhoodHolderLaunchSource;
  const source = options.source || sourceFactory({
    ...options, firstBuyLimit: rule.maxBuyerRank,
  });
  const recurrenceSource = options.recurrenceSource
    || createRobinhoodHolderSniperCalibrationSource(options);
  const classifications = options.classifications
    || createRobinhoodHolderClassificationRepository(options);
  const now = options.now || (() => new Date().toISOString());

  async function materializeToken(tokenAddress) {
    const evidence = await source.loadLaunchEvidence(tokenAddress);
    if (!evidence.ready) {
      return Object.freeze({ status: 'deferred', reason: evidence.reason, records: 0 });
    }
    const candidates = highConfidenceCandidates(evidence, rule);
    const recurrence = await recurrenceSource.loadHighConfidenceRecurrence(
      candidates.map(({ walletAddress }) => walletAddress), evidence.coverage
    );
    if (!recurrence.ready) {
      return Object.freeze({ status: 'deferred', reason: recurrence.reason, records: 0 });
    }
    return classifications.replaceClassifierSnapshot(
      buildSniperSnapshot(evidence, recurrence.rows, now(), rule),
      { allowSameFrontierReplacement: true }
    );
  }

  return Object.freeze({ materializeToken });
}

module.exports = {
  buildSniperSnapshot,
  createRobinhoodHolderSniperMaterializer,
  highConfidenceCandidates,
  normalizeMinimumNotionalUsd,
  normalizeRule,
  qualifyingLaunchCounts,
  SNIPER_HIGH_CONFIDENCE_RULE,
};

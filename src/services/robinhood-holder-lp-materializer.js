const {
  createRobinhoodHolderClassificationRepository,
} = require('../models/robinhood-holder-classification');
const {
  createRobinhoodHolderLpSource,
} = require('../models/robinhood-holder-lp-source');

function buildLpSnapshot(input, observedAt) {
  if (!input?.ready || !input.frontier) {
    throw new Error('LP snapshot requires a ready holder frontier');
  }
  const byAddress = new Map();
  for (const pool of input.pools || []) {
    const registrations = byAddress.get(pool.poolAddress) || [];
    registrations.push(Object.freeze({
      protocol: pool.protocol,
      marketKey: pool.marketKey,
      discoveryBlock: pool.discoveryBlock,
      discoveryBlockHash: pool.discoveryBlockHash,
      discoveryTransactionHash: pool.discoveryTransactionHash,
      discoveryLogIndex: pool.discoveryLogIndex,
    }));
    byAddress.set(pool.poolAddress, registrations);
  }
  const records = [...byAddress.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  )).map(([walletAddress, registrations]) => ({
    walletAddress,
    confidence: 'deterministic',
    reasonCode: 'registered_token_pool',
    evidence: {
      source: 'robinhood_pool_registry',
      registrations: registrations.sort((left, right) => (
        left.protocol.localeCompare(right.protocol)
          || left.marketKey.localeCompare(right.marketKey)
      )),
    },
  }));
  return Object.freeze({
    tokenAddress: input.tokenAddress,
    classifier: 'lp',
    status: 'ready',
    statusReason: 'materialized',
    throughBlockNumber: input.frontier.blockNumber,
    throughBlockHash: input.frontier.blockHash,
    observedAt,
    records: Object.freeze(records),
  });
}

function createRobinhoodHolderLpMaterializer(options = {}) {
  const source = options.source || createRobinhoodHolderLpSource(options);
  const classifications = options.classifications
    || createRobinhoodHolderClassificationRepository(options);
  const now = options.now || (() => new Date().toISOString());

  async function materializeToken(inputTokenAddress) {
    const candidate = await source.loadTokenPoolEvidence(inputTokenAddress);
    if (!candidate.ready) {
      return Object.freeze({ status: 'deferred', reason: candidate.reason, records: 0 });
    }
    const snapshot = buildLpSnapshot(candidate, now());
    return classifications.replaceClassifierSnapshot(snapshot);
  }

  return Object.freeze({ materializeToken });
}

module.exports = {
  buildLpSnapshot,
  createRobinhoodHolderLpMaterializer,
};

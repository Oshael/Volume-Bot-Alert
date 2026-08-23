const {
  createRobinhoodHolderClassificationRepository,
} = require('../models/robinhood-holder-classification');
const {
  createRobinhoodHolderInsiderSource,
} = require('../models/robinhood-holder-insider-source');

const INSIDER_DIRECT_RULE = Object.freeze({
  evidenceVersion: 'rh_insider_direct_v1',
  maxHops: 1,
  requirePositiveAmount: true,
  nativeFundingIncluded: false,
});

function buildInsiderSnapshot(input, observedAt) {
  if (!input?.ready || !input.frontier || !input.creator || !input.coverage) {
    throw new Error('INSIDER snapshot requires ready directional evidence');
  }
  const records = (input.distributions || []).map((distribution) => {
    const amountRaw = String(distribution.amountRaw ?? '');
    if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n
        || distribution.walletAddress === input.creator.address) {
      throw new Error('INSIDER direct distribution evidence is invalid');
    }
    return {
      walletAddress: distribution.walletAddress,
      confidence: 'high',
      reasonCode: 'creator_token_distribution',
      evidence: {
        source: 'robinhood_wallet_transfer_edges',
        creator: input.creator,
        transfer: {
          transactionHash: distribution.transactionHash,
          blockNumber: distribution.blockNumber,
          logIndex: distribution.logIndex,
          blockTime: distribution.blockTime,
          amountRaw,
        },
        rule: INSIDER_DIRECT_RULE,
        coverage: input.coverage,
      },
    };
  });
  return Object.freeze({
    tokenAddress: input.tokenAddress,
    classifier: 'insider',
    status: 'ready',
    statusReason: 'materialized',
    throughBlockNumber: input.frontier.blockNumber,
    throughBlockHash: input.frontier.blockHash,
    observedAt,
    records: Object.freeze(records),
  });
}

function createRobinhoodHolderInsiderMaterializer(options = {}) {
  const source = options.source || createRobinhoodHolderInsiderSource(options);
  const classifications = options.classifications
    || createRobinhoodHolderClassificationRepository(options);
  const now = options.now || (() => new Date().toISOString());

  async function materializeToken(tokenAddress) {
    const evidence = await source.loadDirectDistributionEvidence(tokenAddress);
    if (!evidence.ready) {
      return Object.freeze({ status: 'deferred', reason: evidence.reason, records: 0 });
    }
    return classifications.replaceClassifierSnapshot(buildInsiderSnapshot(evidence, now()));
  }

  return Object.freeze({ materializeToken });
}

module.exports = {
  buildInsiderSnapshot,
  createRobinhoodHolderInsiderMaterializer,
  INSIDER_DIRECT_RULE,
};

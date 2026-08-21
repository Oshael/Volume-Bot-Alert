const {
  createRobinhoodHolderClassificationRepository,
} = require('../models/robinhood-holder-classification');
const {
  createRobinhoodHolderCexSource,
} = require('../models/robinhood-holder-cex-source');

function buildCexSnapshot(input, observedAt) {
  if (!input?.ready || !input.frontier) {
    throw new Error('CEX snapshot requires a ready holder frontier');
  }
  const records = (input.entries || []).map((entry) => ({
    walletAddress: entry.address,
    confidence: 'deterministic',
    reasonCode: 'known_cex_address',
    evidence: {
      source: 'robinhood_infrastructure_registry',
      registry: {
        label: entry.label,
        source: entry.source,
        evidence: entry.evidence,
        validFromBlock: entry.validFromBlock,
        validThroughBlock: entry.validThroughBlock,
        verifiedAt: entry.verifiedAt,
      },
    },
  }));
  return Object.freeze({
    tokenAddress: input.tokenAddress,
    classifier: 'cex',
    status: 'ready',
    statusReason: 'materialized',
    throughBlockNumber: input.frontier.blockNumber,
    throughBlockHash: input.frontier.blockHash,
    observedAt,
    records: Object.freeze(records),
  });
}

function createRobinhoodHolderCexMaterializer(options = {}) {
  const source = options.source || createRobinhoodHolderCexSource(options);
  const classifications = options.classifications
    || createRobinhoodHolderClassificationRepository(options);
  const now = options.now || (() => new Date().toISOString());

  async function materializeToken(tokenAddress) {
    const candidate = await source.loadCexEvidence(tokenAddress);
    if (!candidate.ready) {
      return Object.freeze({ status: 'deferred', reason: candidate.reason, records: 0 });
    }
    return classifications.replaceClassifierSnapshot(buildCexSnapshot(candidate, now()));
  }

  return Object.freeze({ materializeToken });
}

module.exports = { buildCexSnapshot, createRobinhoodHolderCexMaterializer };

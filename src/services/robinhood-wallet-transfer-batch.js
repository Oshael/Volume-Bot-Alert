const {
  CLASSIFICATION_VERSION,
  createRobinhoodTransferClassifier,
} = require('./robinhood-transfer-classifier');

const EDGE_KINDS = new Set(['wallet_transfer', 'dex_flow']);

function classificationInput(captured, fromTime) {
  const transactionHashes = new Set();
  const endpointAddresses = new Set();
  for (const transfer of captured.transfers) {
    transactionHashes.add(transfer.transactionHash);
    endpointAddresses.add(transfer.fromWallet);
    endpointAddresses.add(transfer.toWallet);
  }
  return {
    fromBlock: captured.fromBlock, toBlock: captured.toBlock,
    fromTime, toTime: captured.checkpoint.blockTime,
    transactionHashes: [...transactionHashes], endpointAddresses: [...endpointAddresses],
  };
}

function classifyTransfers(transfers, context, classifierFactory = createRobinhoodTransferClassifier) {
  const classifier = classifierFactory({
    poolAddresses: context.poolAddresses,
    routerAddresses: context.routerAddresses,
    contractAddresses: context.contractAddresses,
    walletAddresses: context.walletAddresses,
  });
  const counts = {};
  const events = transfers.map((transfer) => {
    const decision = classifier.classify(transfer, context);
    counts[decision.kind] = (counts[decision.kind] || 0) + 1;
    return {
      ...transfer, transferKind: decision.kind,
      classificationVersion: decision.classificationVersion,
    };
  });
  return Object.freeze({ counts: Object.freeze(counts), events: Object.freeze(events) });
}

module.exports = {
  CLASSIFICATION_VERSION, EDGE_KINDS, classificationInput, classifyTransfers,
};

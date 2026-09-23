const {
  CLASSIFICATION_VERSION,
  createRobinhoodTransferClassifier,
} = require('./robinhood-transfer-classifier');

const EDGE_KINDS = new Set(['wallet_transfer', 'dex_flow']);
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function isEdgeEligibleTransfer(event = {}) {
  if (!EDGE_KINDS.has(event.transferKind)) return false;
  if (event.transferKind === 'wallet_transfer' && event.connectionEligible === false) return false;
  const fromWallet = String(event.fromWallet ?? '').toLowerCase();
  const toWallet = String(event.toWallet ?? '').toLowerCase();
  return fromWallet !== ZERO_ADDRESS && toWallet !== ZERO_ADDRESS && fromWallet !== toWallet;
}

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

function contractProofs(context) {
  return new Map((context.contractRoleEvidence || []).map((item) => [
    item.endpointAddress, item,
  ]));
}

function hasContractRoleCoverage(transfer, proofs) {
  const blockValue = String(transfer.blockNumber ?? '');
  if (!/^\d+$/.test(blockValue)) return false;
  const block = BigInt(blockValue);
  return [transfer.fromWallet, transfer.toWallet].some((address) => {
    const proof = proofs.get(address);
    if (!proof || !/^\d+$/.test(String(proof.observedFromBlock ?? ''))
        || !/^\d+$/.test(String(proof.observedThroughBlock ?? ''))) return false;
    return block >= BigInt(proof.observedFromBlock)
      && block <= BigInt(proof.observedThroughBlock);
  });
}

function classifyTransfers(transfers, context, classifierFactory = createRobinhoodTransferClassifier) {
  const classifier = classifierFactory({
    poolAddresses: context.poolAddresses,
    routerAddresses: context.routerAddresses,
    contractAddresses: context.contractAddresses,
    walletAddresses: context.walletAddresses,
  });
  const counts = {};
  const unknownReasons = {};
  const proofs = contractProofs(context);
  let unknownWithContractRoleCoverage = 0;
  const events = transfers.map((transfer) => {
    const decision = classifier.classify(transfer, context);
    counts[decision.kind] = (counts[decision.kind] || 0) + 1;
    if (decision.kind === 'unknown') {
      unknownReasons[decision.reasonCode] = (unknownReasons[decision.reasonCode] || 0) + 1;
      if (hasContractRoleCoverage(transfer, proofs)) unknownWithContractRoleCoverage += 1;
    }
    return {
      ...transfer, transferKind: decision.kind,
      classificationVersion: decision.classificationVersion,
      reasonCode: decision.reasonCode,
      affectsPosition: decision.affectsPosition,
      connectionEligible: decision.connectionEligible,
      duplicateOfSwap: decision.duplicateOfSwap,
    };
  });
  return Object.freeze({
    counts: Object.freeze(counts), events: Object.freeze(events),
    unknownEvidence: Object.freeze({
      total: counts.unknown || 0,
      withContractRoleCoverage: unknownWithContractRoleCoverage,
      withoutContractRoleCoverage: (counts.unknown || 0) - unknownWithContractRoleCoverage,
      reasons: Object.freeze(unknownReasons),
    }),
  });
}

module.exports = {
  CLASSIFICATION_VERSION, EDGE_KINDS, classificationInput, classifyTransfers,
  isEdgeEligibleTransfer,
};

const RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function position(item) {
  return [BigInt(item.blockNumber), BigInt(item.transactionIndex)];
}

function comparePosition(left, right) {
  const [leftBlock, leftIndex] = position(left);
  const [rightBlock, rightIndex] = position(right);
  if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
  return leftIndex === rightIndex ? 0 : leftIndex < rightIndex ? -1 : 1;
}

function candidatePosition(candidate) {
  return {
    blockNumber: candidate.firstBuyBlock,
    transactionIndex: candidate.firstBuyTransactionIndex,
  };
}

function orderedTransfers(transfers) {
  return transfers.filter(({ fromAddress, toAddress }) => fromAddress !== toAddress)
    .sort(comparePosition);
}

function createRollingInboundIndex() {
  const ordered = [];
  const inbound = new Map();
  let head = 0;

  function add(event) {
    const stored = { ...event, active: true };
    ordered.push(stored);
    const bucket = inbound.get(stored.toAddress) || { events: [], head: 0 };
    bucket.events.push(stored);
    inbound.set(stored.toAddress, bucket);
  }

  function evict(beforeBlock) {
    while (head < ordered.length && BigInt(ordered[head].blockNumber) < beforeBlock) {
      const event = ordered[head];
      event.active = false;
      head += 1;
      const bucket = inbound.get(event.toAddress);
      while (bucket && bucket.head < bucket.events.length && !bucket.events[bucket.head].active) {
        bucket.head += 1;
      }
      if (bucket?.head === bucket.events.length) inbound.delete(event.toAddress);
      else if (bucket && bucket.head > 100 && bucket.head * 2 > bucket.events.length) {
        bucket.events.splice(0, bucket.head);
        bucket.head = 0;
      }
    }
    if (head > 10_000 && head * 2 > ordered.length) {
      ordered.splice(0, head);
      head = 0;
    }
  }

  function to(address) {
    const bucket = inbound.get(address);
    return bucket ? bucket.events.slice(bucket.head) : [];
  }
  return Object.freeze({ add, evict, to });
}

function scopedEvidence(candidate, event, hop) {
  return Object.freeze({
    tokenAddress: candidate.tokenAddress, candidateWallet: candidate.walletAddress, hop,
    blockNumber: event.blockNumber, blockHash: event.blockHash,
    blockTime: isoBlockTime(event), transactionHash: event.transactionHash,
    transactionIndex: event.transactionIndex, fromAddress: event.fromAddress,
    toAddress: event.toAddress, valueWei: event.valueWei,
  });
}

function selectCandidateEvidence(candidate, index, lookbackBlocks, selected, causalEvidence) {
  const buy = candidatePosition(candidate);
  const buyBlock = BigInt(candidate.firstBuyBlock);
  const fromBlock = buyBlock > BigInt(lookbackBlocks)
    ? buyBlock - BigInt(lookbackBlocks) : 0n;
  const direct = index.to(candidate.walletAddress).filter((event) => (
    BigInt(event.blockNumber) >= fromBlock && comparePosition(event, buy) < 0
  ));
  for (const event of direct) {
    selected.set(event.transactionHash, event);
    causalEvidence.set(
      `${candidate.tokenAddress}:${candidate.walletAddress}:${event.transactionHash}:1`,
      scopedEvidence(candidate, event, 1)
    );
    const ancestors = index.to(event.fromAddress).filter((ancestor) => (
      BigInt(ancestor.blockNumber) >= fromBlock && comparePosition(ancestor, event) < 0
      && ancestor.fromAddress !== candidate.walletAddress
    ));
    for (const ancestor of ancestors) {
      selected.set(ancestor.transactionHash, ancestor);
      causalEvidence.set(
        `${candidate.tokenAddress}:${candidate.walletAddress}:${ancestor.transactionHash}:2`,
        scopedEvidence(candidate, ancestor, 2)
      );
    }
  }
}

function processBlock(input) {
  const {
    blockNumber, candidates, transfers, index, lookbackBlocks, selected, causalEvidence,
  } = input;
  const fromBlock = BigInt(blockNumber) > BigInt(lookbackBlocks)
    ? BigInt(blockNumber) - BigInt(lookbackBlocks) : 0n;
  index.evict(fromBlock);
  const ordered = orderedTransfers(transfers);
  let transferIndex = 0;
  for (const candidate of candidates.sort((left, right) => (
    comparePosition(candidatePosition(left), candidatePosition(right))
  ))) {
    while (transferIndex < ordered.length
        && comparePosition(ordered[transferIndex], candidatePosition(candidate)) < 0) {
      index.add(ordered[transferIndex]);
      transferIndex += 1;
    }
    selectCandidateEvidence(candidate, index, lookbackBlocks, selected, causalEvidence);
  }
  while (transferIndex < ordered.length) {
    index.add(ordered[transferIndex]);
    transferIndex += 1;
  }
}

function isoBlockTime(event) {
  const milliseconds = Number(BigInt(event.blockTimestamp) * 1000n);
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new Error('block timestamp is invalid');
  return date.toISOString();
}

function rawEvent(event) {
  return Object.freeze({
    blockNumber: event.blockNumber, blockHash: event.blockHash,
    blockTime: isoBlockTime(event), transactionHash: event.transactionHash,
    transactionIndex: event.transactionIndex, fromAddress: event.fromAddress,
    toAddress: event.toAddress, valueWei: event.valueWei,
  });
}

function edgeEvent(event) {
  const blockTime = isoBlockTime(event);
  return {
    fromAddress: event.fromAddress, toAddress: event.toAddress,
    firstBlockNumber: event.blockNumber, firstBlockHash: event.blockHash,
    firstBlockTime: blockTime, firstTransactionHash: event.transactionHash,
    firstTransactionIndex: event.transactionIndex,
    lastBlockNumber: event.blockNumber, lastBlockHash: event.blockHash,
    lastBlockTime: blockTime, lastTransactionHash: event.transactionHash,
    lastTransactionIndex: event.transactionIndex, transferCount: '1',
    totalValueWei: event.valueWei,
  };
}

function aggregateEdges(events) {
  const edges = new Map();
  for (const event of events.sort(comparePosition)) {
    const key = `${event.fromAddress}:${event.toAddress}`;
    const current = edges.get(key);
    if (!current) edges.set(key, edgeEvent(event));
    else {
      current.lastBlockNumber = event.blockNumber;
      current.lastBlockHash = event.blockHash;
      current.lastBlockTime = isoBlockTime(event);
      current.lastTransactionHash = event.transactionHash;
      current.lastTransactionIndex = event.transactionIndex;
      current.transferCount = (BigInt(current.transferCount) + 1n).toString();
      current.totalValueWei = (BigInt(current.totalValueWei) + BigInt(event.valueWei)).toString();
    }
  }
  return Object.freeze([...edges.values()].map(Object.freeze));
}

function groupedByBlock(items, blockKey) {
  const grouped = new Map();
  for (const item of items) {
    const block = String(item[blockKey]);
    if (!grouped.has(block)) grouped.set(block, []);
    grouped.get(block).push(item);
  }
  return grouped;
}

function materializerOptions(input) {
  const fromBlock = BigInt(input.range?.fromBlock);
  const throughBlock = BigInt(input.range?.throughBlock);
  if (fromBlock > throughBlock) throw new Error('funding range is invalid');
  const lookbackBlocks = boundedInteger(
    input.lookbackBlocks, 'lookbackBlocks', 0, 50_000_000
  );
  const batchBlocks = boundedInteger(input.batchBlocks ?? 50, 'batchBlocks', 1, 100);
  const candidates = input.range.candidates || [];
  if (!candidates.length) throw new Error('funding range has no frozen candidates');
  return { fromBlock, throughBlock, lookbackBlocks, batchBlocks, candidates };
}

async function scanBlocks(options, reader) {
  const { fromBlock, throughBlock, lookbackBlocks, batchBlocks, candidates } = options;
  const candidatesByBlock = groupedByBlock(candidates, 'firstBuyBlock');
  const selected = new Map();
  const causalEvidence = new Map();
  const index = createRollingInboundIndex();
  let blocksScanned = 0;
  let nativeTransfersScanned = 0;
  for (let start = fromBlock; start <= throughBlock; start += BigInt(batchBlocks)) {
    const end = start + BigInt(batchBlocks - 1) < throughBlock
      ? start + BigInt(batchBlocks - 1) : throughBlock;
    const numbers = Array.from({ length: Number(end - start + 1n) }, (
      _, offset
    ) => (start + BigInt(offset)).toString());
    const result = await reader.readBlocks(numbers);
    blocksScanned += result.blocksScanned;
    nativeTransfersScanned += result.transfers.length;
    const transfersByBlock = groupedByBlock(result.transfers, 'blockNumber');
    for (const blockNumber of numbers) processBlock({
      blockNumber, candidates: candidatesByBlock.get(blockNumber) || [],
      transfers: transfersByBlock.get(blockNumber) || [], index, lookbackBlocks, selected,
      causalEvidence,
    });
  }
  return { blocksScanned, nativeTransfersScanned, selected, causalEvidence };
}

async function materializeBundleFundingRange(input = {}, deps = {}) {
  const reader = deps.reader;
  if (!reader?.readBlocks || !reader?.checkpoint) throw new Error('funding reader is required');
  const options = materializerOptions(input);
  const initialHash = await reader.checkpoint(options.throughBlock.toString());
  const scanned = await scanBlocks(options, reader);
  const { blocksScanned, nativeTransfersScanned, selected, causalEvidence } = scanned;
  const { fromBlock, throughBlock } = options;
  if (blocksScanned !== Number(throughBlock - fromBlock + 1n)) {
    throw new Error('funding reader returned incomplete block coverage');
  }
  const completedThroughHash = await reader.checkpoint(throughBlock.toString());
  if (initialHash !== completedThroughHash) {
    const error = new Error('bundle funding range checkpoint changed during scan');
    error.code = 'bundle_funding_checkpoint_changed';
    throw error;
  }
  const events = [...selected.values()];
  const now = deps.now ? deps.now() : Date.now();
  const rawCutoff = now - RAW_RETENTION_MS;
  return Object.freeze({
    completedThroughBlock: throughBlock.toString(), completedThroughHash,
    blocksScanned, nativeTransfersScanned, relevantTransfers: events.length,
    rawEvents: Object.freeze(events.filter((event) => (
      Number(BigInt(event.blockTimestamp) * 1000n) >= rawCutoff
    )).map(rawEvent)),
    edges: aggregateEdges(events),
    causalEvidence: Object.freeze([...causalEvidence.values()]),
  });
}

module.exports = {
  RAW_RETENTION_MS, materializeBundleFundingRange,
  __private: { aggregateEdges, comparePosition, createRollingInboundIndex, processBlock },
};

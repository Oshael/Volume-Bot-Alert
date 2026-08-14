function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizedJournalCheckpoints(values) {
  if (!Array.isArray(values)) throw new TypeError('holder journal checkpoints are required');
  let previous = -1n;
  return values.map((value) => {
    const number = BigInt(String(value?.number ?? ''));
    const hash = String(value?.hash || '').toLowerCase();
    if (number < 0n || number <= previous || !/^0x[0-9a-f]{64}$/.test(hash)) {
      throw new Error('holder journal checkpoints are invalid');
    }
    previous = number;
    return Object.freeze({ number: number.toString(), hash });
  });
}

async function findLastCanonicalCheckpoint(reader, values) {
  const checkpoints = normalizedJournalCheckpoints(values);
  let low = 0;
  let high = checkpoints.length - 1;
  let canonical = null;
  let checkedCheckpoints = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = checkpoints[middle];
    checkedCheckpoints += 1;
    if (await reader.matchesCheckpoint(candidate)) {
      canonical = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return Object.freeze({ canonical, checkedCheckpoints });
}

async function readOrQuarantine(input) {
  try {
    return await input.reader.readGlobalRange({
      tokenAddresses: input.tokenAddresses,
      fromBlock: input.fromBlock.toString(), toBlock: input.toBlock.toString(),
    });
  } catch (error) {
    if (error.code !== 'holder_transfer_invalid_log' || !error.tokenAddress) throw error;
    const quarantined = await input.ledger.quarantineMalformedToken({
      tokenAddress: error.tokenAddress,
    });
    return Object.freeze({
      ...quarantined, status: 'malformed-token-quarantined',
      nextBlock: input.fromBlock.toString(), safeHead: input.safeHead,
    });
  }
}

function hasMethods(value, names) {
  return names.every((name) => typeof value?.[name] === 'function');
}

function assertDependencies(ledger, reader) {
  if (!hasMethods(ledger, [
    'getCursor', 'listJournalBlockCheckpoints', 'listTrackedTokenAddresses',
    'quarantineMalformedToken', 'appendCapturedRange', 'rewindOrphanedRange',
  ])) {
    throw new TypeError('holder live ledger is required');
  }
  if (!hasMethods(reader, ['getSafeHead', 'matchesCheckpoint', 'readGlobalRange'])) {
    throw new TypeError('holder global Transfer reader is required');
  }
}

function createRobinhoodHolderLiveCapture(options = {}) {
  const ledger = options.ledger;
  const reader = options.reader;
  assertDependencies(ledger, reader);

  async function captureOnce(input = {}) {
    const rangeSize = boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize');
    const confirmations = boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations');
    const head = await reader.getSafeHead(confirmations);
    const cursor = await ledger.getCursor();
    if (cursor?.checkpointBlock != null) {
      const matches = await reader.matchesCheckpoint({
        number: cursor.checkpointBlock, hash: cursor.checkpointHash,
      });
      if (!matches) {
        if (cursor.journalFloorBlock == null
            || BigInt(cursor.checkpointBlock) <= BigInt(cursor.journalFloorBlock)) {
          return Object.freeze({
            status: 'reorg-unrecoverable', reason: 'canonical-evidence-unavailable',
            nextBlock: cursor.nextBlock, checkpointBlock: cursor.checkpointBlock,
            journalFloorBlock: cursor.journalFloorBlock, cursorVersion: cursor.version,
            checkedCheckpoints: 0,
          });
        }
        const candidates = await ledger.listJournalBlockCheckpoints({
          fromBlock: cursor.journalFloorBlock,
          toBlock: (BigInt(cursor.checkpointBlock) - 1n).toString(),
        });
        const located = await findLastCanonicalCheckpoint(reader, candidates);
        if (!located.canonical) {
          return Object.freeze({
            status: 'reorg-unrecoverable', reason: 'canonical-evidence-unavailable',
            nextBlock: cursor.nextBlock, checkpointBlock: cursor.checkpointBlock,
            journalFloorBlock: cursor.journalFloorBlock, cursorVersion: cursor.version,
            checkedCheckpoints: located.checkedCheckpoints,
          });
        }
        const rewind = await ledger.rewindOrphanedRange({
          nextBlock: (BigInt(located.canonical.number) + 1n).toString(),
          safeHead: head.safeHead, expectedVersion: cursor.version,
          checkpoint: located.canonical,
        });
        return Object.freeze({
          ...rewind, status: 'reorg-rewound',
          orphanedCheckpointBlock: cursor.checkpointBlock,
          canonicalCheckpointBlock: located.canonical.number,
          checkedCheckpoints: located.checkedCheckpoints,
        });
      }
    }
    const safeHead = BigInt(head.safeHead);
    const fromBlock = cursor ? BigInt(cursor.nextBlock) : safeHead;
    if (fromBlock > safeHead) {
      return Object.freeze({ status: 'idle', nextBlock: fromBlock.toString(), safeHead: head.safeHead });
    }
    const candidateEnd = fromBlock + BigInt(rangeSize - 1);
    const toBlock = cursor && candidateEnd < safeHead ? candidateEnd : safeHead;
    const tokenAddresses = await ledger.listTrackedTokenAddresses();
    const captured = await readOrQuarantine({
      ledger, reader, tokenAddresses, fromBlock, toBlock, safeHead: head.safeHead,
    });
    if (captured.status === 'malformed-token-quarantined') return captured;
    const committed = await ledger.appendCapturedRange({
      transfers: captured.transfers,
      cursor: {
        rangeStart: captured.fromBlock, nextBlock: captured.nextBlock,
        safeHead: head.safeHead, expectedVersion: cursor?.version ?? null,
        checkpoint: captured.checkpoint,
      },
    });
    return Object.freeze({
      status: 'captured', fromBlock: captured.fromBlock, toBlock: captured.toBlock,
      nextBlock: captured.nextBlock, safeHead: head.safeHead,
      scopeTokens: captured.scopeTokens, transfers: captured.transfers.length,
      telemetry: captured.telemetry, ...committed,
    });
  }

  return Object.freeze({ captureOnce });
}

module.exports = { createRobinhoodHolderLiveCapture };

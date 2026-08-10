function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function createRobinhoodHolderLiveCapture(options = {}) {
  const ledger = options.ledger;
  const reader = options.reader;
  if (typeof ledger?.getCursor !== 'function'
      || typeof ledger?.listTrackedTokenAddresses !== 'function'
      || typeof ledger?.appendCapturedRange !== 'function') {
    throw new TypeError('holder live ledger is required');
  }
  if (typeof reader?.getSafeHead !== 'function'
      || typeof reader?.matchesCheckpoint !== 'function'
      || typeof reader?.readGlobalRange !== 'function') {
    throw new TypeError('holder global Transfer reader is required');
  }

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
        return Object.freeze({
          status: 'reorg-detected', nextBlock: cursor.nextBlock,
          checkpointBlock: cursor.checkpointBlock, cursorVersion: cursor.version,
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
    const captured = await reader.readGlobalRange({
      tokenAddresses, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
    });
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

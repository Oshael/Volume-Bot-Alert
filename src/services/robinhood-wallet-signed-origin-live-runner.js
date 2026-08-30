const DEFAULT_MAX_BLOCKS = 100;

function quantity(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^\d+$/.test(normalized) && !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return BigInt(normalized);
}

function hash(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`maxBlocks must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function fatal(message) {
  return Object.assign(new Error(message), { code: 'persistent_reorg', fatal: true });
}

async function canonicalHeader(fetchBlockHeader, number, label) {
  const expected = BigInt(number);
  const block = await fetchBlockHeader(expected.toString());
  if (quantity(block?.number, `${label}.number`) !== expected) {
    throw Object.assign(new Error(`${label} returned the wrong block`), {
      code: 'source_contract_error', fatal: true,
    });
  }
  return Object.freeze({ number: expected.toString(), hash: hash(block.hash, `${label}.hash`) });
}

async function revalidateCheckpoint(cursor, fetchBlockHeader) {
  if (cursor.checkpointBlock == null) return;
  const checkpoint = await canonicalHeader(fetchBlockHeader, cursor.checkpointBlock, 'checkpoint');
  if (checkpoint.hash !== cursor.checkpointHash) throw fatal('signed-origin LIVE checkpoint diverged');
}

function result(status, cursor, safeHead, extras = {}) {
  const nextBlock = cursor?.nextBlock || null;
  const lag = cursor && safeHead != null && BigInt(nextBlock) <= safeHead
    ? safeHead - BigInt(nextBlock) + 1n : 0n;
  return Object.freeze({ status, sourceSafeHead: safeHead?.toString?.() || null, nextBlock,
    checkpointBlock: cursor?.checkpointBlock || null,
    lagBlocks: safeHead == null ? null : lag.toString(), ...extras });
}

async function runLiveTick(deps = {}) {
  if (!deps.repository?.initializeLiveFromSeed || !deps.repository?.commitLiveBatch
      || !deps.reader?.readBlocks || !deps.loadSourceFrontier || !deps.fetchBlockHeader) {
    throw new TypeError('signed-origin LIVE dependencies are incomplete');
  }
  const maxBlocks = bounded(deps.maxBlocks, DEFAULT_MAX_BLOCKS, 1, 200);
  let cursor = await deps.repository.initializeLiveFromSeed();
  const source = await deps.loadSourceFrontier();
  if (source?.safeHead == null) return result('waiting_source', cursor, null);
  const safeHead = quantity(source.safeHead, 'source.safeHead');
  await revalidateCheckpoint(cursor, deps.fetchBlockHeader);
  if (safeHead < BigInt(cursor.safeHead)) throw fatal('signed-origin LIVE safe frontier regressed');
  const safeHeader = await canonicalHeader(deps.fetchBlockHeader, safeHead, 'safeHead');
  if (safeHead === BigInt(cursor.safeHead) && safeHeader.hash !== cursor.safeHeadHash) {
    throw fatal('signed-origin LIVE safe frontier hash diverged');
  }
  if (BigInt(cursor.nextBlock) > safeHead) return result('caught_up', cursor, safeHead);
  const remaining = safeHead - BigInt(cursor.nextBlock) + 1n;
  const count = Number(remaining < BigInt(maxBlocks) ? remaining : BigInt(maxBlocks));
  const blockNumbers = Array.from({ length: count }, (_, index) => (
    BigInt(cursor.nextBlock) + BigInt(index)
  ).toString());
  const evidence = await deps.reader.readBlocks({ blockNumbers,
    coverageOriginBlock: cursor.originBlock, safeHead: safeHead.toString(), stream: 'live' });
  const committed = await deps.repository.commitLiveBatch({
    expectedVersion: cursor.version, expectedNextBlock: cursor.nextBlock,
    safeHead: safeHead.toString(), safeHeadHash: safeHeader.hash,
    blocks: evidence.blocks, origins: evidence.origins,
  });
  cursor = committed.cursor;
  return result(cursor.lifecycleState === 'caught_up' ? 'caught_up' : 'advanced',
    cursor, safeHead, { blocksCommitted: committed.blocksCommitted,
      originsWritten: committed.originsWritten, metrics: evidence.metrics });
}

module.exports = { DEFAULT_MAX_BLOCKS, runLiveTick,
  __private: { canonicalHeader, revalidateCheckpoint } };

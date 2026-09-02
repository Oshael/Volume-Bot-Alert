/**
 * Pure tick orchestration for LIVE Robinhood wallet-swap attribution.
 * All database and RPC I/O is injected so this module owns only frontier,
 * checkpoint and fail-closed progress rules.
 */

const DEFAULT_REORG_DEPTH = 12;
const DEFAULT_MAX_BLOCKS = 200;
const MAX_BLOCKS = 2000;

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) {
    throw new Error(`${label} must be a non-negative quantity`);
  }
  return BigInt(raw);
}

function hash(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 32-byte hex hash`);
  }
  return normalized;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function runnerError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.fatal = options.fatal === true;
  error.retryable = options.retryable === true;
  return error;
}

function cursorNextBlock(cursor, label) {
  const value = cursor?.nextBlock ?? cursor?.next_block;
  return value == null ? null : quantity(value, `${label}.nextBlock`);
}

function calculateFrontiers(nodeHead, marketCursor, reorgDepth) {
  const nodeSafeHead = nodeHead < BigInt(reorgDepth) ? null : nodeHead - BigInt(reorgDepth);
  const marketNextBlock = cursorNextBlock(marketCursor, 'marketCursor');
  const sourceSafeHead = marketNextBlock == null || marketNextBlock === 0n
    ? null
    : marketNextBlock - 1n;
  const processableThrough = nodeSafeHead == null || sourceSafeHead == null
    ? null
    : (nodeSafeHead < sourceSafeHead ? nodeSafeHead : sourceSafeHead);
  return { nodeHead, nodeSafeHead, sourceSafeHead, processableThrough };
}

function frontierOutput(frontiers) {
  return Object.fromEntries(Object.entries(frontiers).map(([key, value]) => (
    [key, value == null ? null : value.toString()]
  )));
}

function tickResult(status, frontiers, state, extra = {}) {
  return {
    status,
    ...frontierOutput(frontiers),
    nextBlock: state?.nextBlock ?? null,
    safeHead: state?.safeHead ?? null,
    checkpointBlock: state?.checkpointBlock ?? null,
    processedBlocks: 0,
    attributed: 0,
    inserted: 0,
    unresolved: 0,
    missing: 0,
    ...extra,
  };
}

function assertDependencies(deps) {
  if (typeof deps.readNodeHead !== 'function') throw new Error('readNodeHead is required');
  if (typeof deps.loadMarketCursor !== 'function') throw new Error('loadMarketCursor is required');
  if (typeof deps.fetchBlockHeader !== 'function') throw new Error('fetchBlockHeader is required');
  if (typeof deps.reader?.readAcceptedBlockGroups !== 'function') throw new Error('reader is required');
  if (typeof deps.attributor?.attributeGroups !== 'function') throw new Error('attributor is required');
  if (typeof deps.cursor?.loadCursor !== 'function'
    || typeof deps.cursor?.advanceLiveCursor !== 'function') {
    throw new Error('live cursor repository is required');
  }
}

async function revalidateCheckpoint(state, fetchBlockHeader) {
  if (state.checkpointBlock == null || state.checkpointHash == null) return;
  let header;
  try {
    header = await fetchBlockHeader(state.checkpointBlock);
  } catch (cause) {
    throw runnerError('checkpoint_unavailable', 'wallet LIVE checkpoint could not be fetched', {
      retryable: true, cause,
    });
  }
  const blockNumber = quantity(header?.number, 'checkpoint.number').toString();
  const blockHash = hash(header?.hash, 'checkpoint.hash');
  if (blockNumber !== String(state.checkpointBlock)
    || blockHash !== String(state.checkpointHash).toLowerCase()) {
    throw runnerError(
      'persistent_reorg',
      `wallet LIVE checkpoint diverged at block ${state.checkpointBlock}`,
      { fatal: true }
    );
  }
}

function assertNoFrontierRegression(state, frontiers) {
  if (state.safeHead == null || frontiers.processableThrough == null) return;
  if (quantity(state.safeHead, 'liveCursor.safeHead') > frontiers.processableThrough) {
    throw runnerError('persistent_reorg', 'wallet LIVE safe frontier regressed', { fatal: true });
  }
}

async function advance(cursor, state, input) {
  return cursor.advanceLiveCursor({ ...input, expectedVersion: state.version });
}

function validateGroup(group, previousBlock, through) {
  if (!Array.isArray(group) || group.length !== 2 || !Array.isArray(group[1])) {
    throw runnerError('source_contract_error', 'wallet LIVE source returned an invalid group');
  }
  const blockNumber = quantity(group[0], 'group.blockNumber');
  if (blockNumber <= previousBlock || blockNumber > through) {
    throw runnerError('source_contract_error', 'wallet LIVE source groups are out of range');
  }
  return { blockNumber, observations: group[1] };
}

function sourceGroups(source, maxBlocks) {
  if (!Array.isArray(source?.groups) || !Array.isArray(source?.blockNumbers)) {
    throw runnerError('source_contract_error', 'wallet LIVE source result is incomplete');
  }
  if (source.groups.length !== source.blockNumbers.length || source.groups.length > maxBlocks) {
    throw runnerError('source_contract_error', 'wallet LIVE source result has invalid bounds');
  }
  for (let index = 0; index < source.groups.length; index += 1) {
    if (String(source.groups[index]?.[0]) !== String(source.blockNumbers[index])) {
      throw runnerError('source_contract_error', 'wallet LIVE source block identities diverged');
    }
  }
  return source.groups;
}

function assertOrderedResults(results, groups) {
  for (let index = 0; index < results.length; index += 1) {
    if (quantity(results[index].blockNumber, 'attribution.blockNumber')
      !== quantity(groups[index][0], 'group.blockNumber')) {
      throw runnerError('source_contract_error', 'attributor returned blocks out of order');
    }
  }
}

function assertBatchFrontier(batch, groups, results, blocked) {
  if (!blocked && results.length !== groups.length) {
    throw runnerError('source_contract_error', 'attributor returned an incomplete batch');
  }
  if (!blocked) return;
  const failedBlock = results.length < groups.length ? groups[results.length][0] : null;
  if (failedBlock == null || String(batch?.failedBlock) !== String(failedBlock)) {
    throw runnerError('source_contract_error', 'attributor returned an invalid blocked frontier');
  }
}

function validateBatchResult(batch, groups) {
  const results = Array.isArray(batch?.results) ? batch.results : [];
  if (Number(batch?.blocks) !== results.length || results.length > groups.length) {
    throw runnerError('source_contract_error', 'attributor returned an invalid batch size');
  }
  assertOrderedResults(results, groups);
  const attributed = results.reduce((sum, result) => sum + Number(result.attributed || 0), 0);
  const blocked = Number(batch?.unresolved || 0) > 0 || Number(batch?.missing || 0) > 0;
  if (Number(batch?.attributed) !== attributed) {
    throw runnerError('source_contract_error', 'attributor returned invalid attribution totals');
  }
  assertBatchFrontier(batch, groups, results, blocked);
  return { results, blocked };
}

async function processGroups(deps, context, groups, maxBlocks) {
  let previousBlock = quantity(context.state.nextBlock, 'liveCursor.nextBlock') - 1n;
  const validatedGroups = groups.map((group) => {
    const validated = validateGroup(group, previousBlock, context.frontiers.processableThrough);
    previousBlock = validated.blockNumber;
    return [validated.blockNumber.toString(), validated.observations];
  });
  const batch = await deps.attributor.attributeGroups(validatedGroups);
  const { results, blocked } = validateBatchResult(batch, validatedGroups);
  const totals = {
    processedBlocks: results.length,
    attributed: Number(batch?.attributed || 0),
    inserted: Number(batch?.inserted || 0),
    unresolved: Number(batch?.unresolved || 0),
    missing: Number(batch?.missing || 0),
  };
  if (!results.length) {
    return tickResult('blocked-unresolved', context.frontiers, context.state, {
      ...totals, failedBlock: String(batch.failedBlock),
    });
  }

  const last = results.at(-1);
  const lastBlock = quantity(last.blockNumber, 'attribution.blockNumber');
  const nextBlock = blocked
    ? String(batch.failedBlock)
    : (groups.length < maxBlocks
      ? (context.frontiers.processableThrough + 1n).toString()
      : (lastBlock + 1n).toString());
  const advanced = await advance(deps.cursor, context.state, {
    nextBlock,
    safeHead: context.frontiers.processableThrough.toString(),
    checkpointBlock: lastBlock.toString(),
    checkpointHash: hash(last.blockHash, 'attribution.blockHash'),
    checkpointTimestamp: new Date(last.blockTime).toISOString(),
  });
  if (!advanced) return tickResult('conflict', context.frontiers, context.state, totals);
  return tickResult(blocked ? 'blocked-unresolved' : 'advanced', context.frontiers, advanced, {
    ...totals,
    ...(blocked ? { failedBlock: String(batch.failedBlock) } : {}),
  });
}

async function runLiveTick(deps = {}) {
  assertDependencies(deps);
  const reorgDepth = boundedInteger(
    deps.reorgDepth, DEFAULT_REORG_DEPTH, 1, 1000, 'reorgDepth'
  );
  const maxBlocks = boundedInteger(deps.maxBlocks, DEFAULT_MAX_BLOCKS, 1, MAX_BLOCKS, 'maxBlocks');
  const [rawHead, marketCursor, state] = await Promise.all([
    deps.readNodeHead(), deps.loadMarketCursor(), deps.cursor.loadCursor('live'),
  ]);
  const frontiers = calculateFrontiers(quantity(rawHead, 'nodeHead'), marketCursor, reorgDepth);
  if (!state) return tickResult('awaiting-bootstrap', frontiers, null);
  await revalidateCheckpoint(state, deps.fetchBlockHeader);
  assertNoFrontierRegression(state, frontiers);
  if (frontiers.nodeSafeHead == null) return tickResult('waiting-head', frontiers, state);
  if (frontiers.sourceSafeHead == null) return tickResult('waiting-source', frontiers, state);

  const nextBlock = quantity(state.nextBlock, 'liveCursor.nextBlock');
  if (nextBlock > frontiers.processableThrough) {
    if (state.safeHead == null || quantity(state.safeHead, 'liveCursor.safeHead') < frontiers.processableThrough) {
      const advanced = await advance(deps.cursor, state, {
        nextBlock: nextBlock.toString(), safeHead: frontiers.processableThrough.toString(),
      });
      if (!advanced) return tickResult('conflict', frontiers, state);
      return tickResult('caught-up', frontiers, advanced);
    }
    return tickResult('caught-up', frontiers, state);
  }

  const source = await deps.reader.readAcceptedBlockGroups({
    fromBlock: nextBlock.toString(),
    toBlock: frontiers.processableThrough.toString(),
    maxBlocks,
  });
  const groups = sourceGroups(source, maxBlocks);
  if (groups.length === 0) {
    const advanced = await advance(deps.cursor, state, {
      nextBlock: (frontiers.processableThrough + 1n).toString(),
      safeHead: frontiers.processableThrough.toString(),
    });
    return tickResult(advanced ? 'advanced-empty' : 'conflict', frontiers, advanced || state);
  }
  return processGroups(deps, { state, frontiers }, groups, maxBlocks);
}

module.exports = {
  DEFAULT_MAX_BLOCKS,
  DEFAULT_REORG_DEPTH,
  MAX_BLOCKS,
  runLiveTick,
  __private: { calculateFrontiers, revalidateCheckpoint, sourceGroups, validateGroup },
};

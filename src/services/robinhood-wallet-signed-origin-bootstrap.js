const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_HOURS = 5;
const MAX_HOURS = 24;
const MAX_SESSION_MINUTES = 1440;
const SAFETY_FACTOR = 1.25;

function failure(message, code = 'signed_origin_bootstrap_refused') {
  return Object.assign(new Error(message), { code });
}

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function quantity(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(normalized)) {
    throw failure(`${label} is not a canonical quantity`, 'signed_origin_rpc_invalid');
  }
  return BigInt(normalized);
}

function hash(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw failure(`${label} is invalid`, 'signed_origin_rpc_invalid');
  }
  return normalized;
}

function tag(value) { return `0x${BigInt(value).toString(16)}`; }

async function header(rpcClient, number) {
  const expected = BigInt(number);
  const block = await rpcClient.request('eth_getBlockByNumber', [tag(expected), false]);
  if (quantity(block?.number, 'block.number') !== expected) {
    throw failure(`RPC did not return block ${expected}`, 'signed_origin_rpc_invalid');
  }
  const timestamp = quantity(block.timestamp, 'block.timestamp');
  return Object.freeze({ number: expected.toString(), hash: hash(block.hash, 'block.hash'),
    blockTime: new Date(Number(timestamp * 1000n)).toISOString() });
}

async function resolveOrigin(rpcClient, targetAt, upperBlock) {
  const targetMs = Date.parse(targetAt);
  let low = 0n; let high = BigInt(upperBlock) - 1n; let found = null;
  while (low <= high) {
    const middle = (low + high) / 2n;
    const block = await header(rpcClient, middle);
    if (Date.parse(block.blockTime) < targetMs) {
      found = block; low = middle + 1n;
    } else high = middle - 1n;
  }
  if (!found) throw failure('activation cutoff predates the canonical chain');
  const next = await header(rpcClient, BigInt(found.number) + 1n);
  if (Date.parse(next.blockTime) < targetMs) {
    throw failure('activation cutoff resolution is incomplete');
  }
  return found;
}

async function loadActivation(database) {
  const row = (await database.query(`SELECT activation_at, activation_block::text,
    activation_block_hash FROM robinhood_fresh_wallet_activations
    WHERE chain = 'robinhood' AND rule_version = 'rh_fresh_signed_v1'
      AND status = 'active'`)).rows[0];
  if (!row) throw failure('active FRESH activation is unavailable');
  return Object.freeze({ activationAt: new Date(row.activation_at).toISOString(),
    activationBlock: String(row.activation_block),
    activationBlockHash: hash(row.activation_block_hash, 'activation_block_hash') });
}

function sampleStarts(nextBlock, safeHead, sampleCount, sampleBlocks) {
  const first = BigInt(nextBlock); const last = BigInt(safeHead);
  const remaining = last - first + 1n;
  if (remaining <= 0n) return [];
  const width = remaining < BigInt(sampleBlocks) ? remaining : BigInt(sampleBlocks);
  const available = remaining - width;
  const count = Math.min(sampleCount, Number(available + 1n));
  const starts = new Set();
  for (let index = 0; index < count; index += 1) {
    const offset = count === 1 ? 0n : (available * BigInt(index)) / BigInt(count - 1);
    starts.add((first + offset).toString());
  }
  return [...starts].map((start) => ({ start, width: Number(width) }));
}

async function revalidate(rpcClient, expected, label) {
  const actual = await header(rpcClient, expected.number);
  if (actual.hash !== expected.hash) {
    throw failure(`${label} hash diverged`, 'signed_origin_reorg_conflict');
  }
  return actual;
}

function preflightOptions(options) {
  const confirmations = bounded(options.confirmations, 12, 0, 1000, 'confirmations');
  const sampleCount = bounded(options.sampleCount, 3, 1, 16, 'sampleCount');
  const sampleBlocks = bounded(options.sampleBlocks, 10, 1, 200, 'sampleBlocks');
  const maxHours = Number(options.maxHours ?? DEFAULT_MAX_HOURS);
  if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > MAX_HOURS) {
    throw new TypeError(`maxHours must be greater than 0 and at most ${MAX_HOURS}`);
  }
  return { confirmations, sampleCount, sampleBlocks, maxHours };
}

async function resolvePlan(deps, activation, nodeHead, confirmations) {
  const { repository, rpcClient } = deps;
  const activationHeader = await revalidate(rpcClient, {
    number: activation.activationBlock, hash: activation.activationBlockHash,
  }, 'activation');
  const targetAt = new Date(Date.parse(activation.activationAt) - DAY_MS).toISOString();
  const resolvedOrigin = await resolveOrigin(rpcClient, targetAt, activation.activationBlock);
  const existing = await repository.loadCursor('seed');
  if (existing) {
    if (!['running', 'completed'].includes(existing.lifecycleState)) {
      throw failure(`seed cursor is ${existing.lifecycleState}`);
    }
    if (existing.originBlock !== resolvedOrigin.number
        || existing.originBlockHash !== resolvedOrigin.hash) {
      throw failure('frozen origin diverged', 'signed_origin_cursor_conflict');
    }
    if (nodeHead < BigInt(existing.safeHead)) throw failure('node is behind the frozen safe head');
    await revalidate(rpcClient, { number: existing.safeHead, hash: existing.safeHeadHash }, 'safe head');
    if (existing.checkpointBlock) await revalidate(rpcClient, {
      number: existing.checkpointBlock, hash: existing.checkpointHash,
    }, 'checkpoint');
    return { plan: existing, targetAt };
  }
  const safeHead = nodeHead - BigInt(confirmations);
  if (safeHead < BigInt(activationHeader.number)) {
    throw failure('safe head precedes FRESH activation');
  }
  const safe = await header(rpcClient, safeHead);
  return { targetAt, plan: { stream: 'seed', originBlock: resolvedOrigin.number,
    originBlockHash: resolvedOrigin.hash, nextBlock: resolvedOrigin.number,
    safeHead: safe.number, safeHeadHash: safe.hash, lifecycleState: 'planned', version: 0 } };
}

async function measureSamples(reader, plan, options) {
  let sampledBlocks = 0; let sampledTransactions = 0; let sampledBytes = 0; let elapsedMs = 0;
  for (const sample of sampleStarts(plan.nextBlock, plan.safeHead,
    options.sampleCount, options.sampleBlocks)) {
    const blockNumbers = Array.from({ length: sample.width }, (_, index) => (
      BigInt(sample.start) + BigInt(index)
    ).toString());
    const result = await reader.readBlocks({ blockNumbers,
      coverageOriginBlock: plan.originBlock, safeHead: plan.safeHead, stream: 'seed' });
    sampledBlocks += result.metrics.blocksScanned;
    sampledTransactions += result.metrics.transactionsScanned;
    sampledBytes += result.metrics.payloadBytes;
    elapsedMs += result.metrics.elapsedMs;
  }
  return { sampledBlocks, sampledTransactions, sampledBytes, elapsedMs };
}

async function runPreflight(deps = {}, options = {}) {
  const { database, repository, reader, rpcClient } = deps;
  if (!database?.query || !repository?.loadCursor || !reader?.readBlocks || !rpcClient?.request) {
    throw new TypeError('signed-origin bootstrap dependencies are incomplete');
  }
  const limits = preflightOptions(options);
  const activation = await loadActivation(database);
  await reader.assertChain();
  const [rawHead, syncing] = await Promise.all([
    rpcClient.request('eth_blockNumber'), rpcClient.request('eth_syncing'),
  ]);
  if (syncing !== false) throw failure('Robinhood node is still syncing');
  const nodeHead = quantity(rawHead, 'eth_blockNumber');
  if (nodeHead < BigInt(limits.confirmations)) throw failure('Robinhood safe head is unavailable');
  const { plan, targetAt } = await resolvePlan(deps, activation, nodeHead, limits.confirmations);
  const remainingBlocks = BigInt(plan.safeHead) >= BigInt(plan.nextBlock)
    ? BigInt(plan.safeHead) - BigInt(plan.nextBlock) + 1n : 0n;
  const metrics = await measureSamples(reader, plan, limits);
  const projectedMs = remainingBlocks === 0n ? 0 : Math.ceil(
    (Math.max(1, metrics.elapsedMs) / Math.max(1, metrics.sampledBlocks))
      * Number(remainingBlocks) * SAFETY_FACTOR
  );
  return Object.freeze({ ...plan, activationAt: activation.activationAt, targetAt,
    nodeHead: nodeHead.toString(), confirmations: limits.confirmations,
    remainingBlocks: remainingBlocks.toString(), ...metrics, safetyFactor: SAFETY_FACTOR,
    projectedMs, projectedHours: Number((projectedMs / 3_600_000).toFixed(2)),
    maxHours: limits.maxHours,
    durationAdvisoryExceeded: projectedMs > limits.maxHours * 3_600_000,
    approved: true });
}

async function executeBootstrap(deps = {}, options = {}) {
  const preflight = options.preflight;
  if (!preflight?.approved) throw failure('signed-origin bootstrap preflight was not approved');
  const batchSize = bounded(options.batchSize, 50, 1, 500, 'batchSize');
  const maxMinutes = bounded(options.maxMinutes, 1440, 1, MAX_SESSION_MINUTES, 'maxMinutes');
  let cursor = await deps.repository.createOrResume(preflight);
  const deadline = (deps.now || Date.now)() + maxMinutes * 60_000;
  let blocksCommitted = 0; let originsWritten = 0;
  while (cursor.lifecycleState !== 'completed' && (deps.now || Date.now)() < deadline) {
    const batchStartedAt = (deps.now || Date.now)();
    const remaining = BigInt(cursor.safeHead) - BigInt(cursor.nextBlock) + 1n;
    const count = Number(remaining < BigInt(batchSize) ? remaining : BigInt(batchSize));
    const blockNumbers = Array.from({ length: count }, (_, index) => (
      BigInt(cursor.nextBlock) + BigInt(index)
    ).toString());
    const evidence = await deps.reader.readBlocks({ blockNumbers,
      coverageOriginBlock: cursor.originBlock, safeHead: cursor.safeHead, stream: 'seed' });
    const readCompletedAt = (deps.now || Date.now)();
    const committed = await deps.repository.commitBatch({ stream: 'seed',
      expectedVersion: cursor.version, expectedNextBlock: cursor.nextBlock,
      blocks: evidence.blocks, origins: evidence.origins });
    cursor = committed.cursor; blocksCommitted += committed.blocksCommitted;
    originsWritten += committed.originsWritten;
    const completedAt = (deps.now || Date.now)();
    const totalElapsedMs = Math.max(1, completedAt - batchStartedAt);
    options.onProgress?.({ cursor, blocksCommitted, originsWritten,
      metrics: { ...evidence.metrics,
        persistenceElapsedMs: Math.max(0, completedAt - readCompletedAt), totalElapsedMs,
        endToEndBlocksPerSecond: Number(
          ((committed.blocksCommitted * 1000) / totalElapsedMs).toFixed(2)
        ),
      } });
  }
  return Object.freeze({ status: cursor.lifecycleState === 'completed' ? 'completed' : 'time_limit',
    cursor, blocksCommitted, originsWritten });
}

module.exports = { executeBootstrap, runPreflight, __private: { resolveOrigin, sampleStarts } };

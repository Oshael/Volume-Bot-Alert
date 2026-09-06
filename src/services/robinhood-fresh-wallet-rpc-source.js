const { RULE_VERSION } = require('./robinhood-fresh-wallet-rule');

const ROBINHOOD_CHAIN_ID = 4663n;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_BLOCKS = 65536;
const RPC_BATCH_SIZE = 100;
const RPC_SUB_BATCH_SIZE = 10;
const INITIAL_CUTOFF_STEP = 8192n;
const MAX_DATE_MS = 8_640_000_000_000_000n;

function invalid(message) {
  const error = new Error(message);
  error.code = 'fresh_evidence_invalid';
  return error;
}

function quantity(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(normalized)) throw invalid(`${label} is invalid`);
  return BigInt(normalized);
}

function fixedHex(value, bytes, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw invalid(`${label} is invalid`);
  }
  return normalized;
}

function address(value, label) {
  return fixedHex(value, 20, label);
}

function decimalQuantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw invalid(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function instant(value, label) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw invalid(`${label} is invalid`);
  return new Date(parsed).toISOString();
}

function parseBlock(block, expectedNumber) {
  const number = quantity(block?.number, 'block.number');
  if (number !== BigInt(expectedNumber)) throw invalid('RPC returned the wrong block');
  const timestampMs = quantity(block.timestamp, 'block.timestamp') * 1000n;
  if (timestampMs > MAX_DATE_MS) throw invalid('block.timestamp is unsafe');
  return Object.freeze({
    number: number.toString(),
    hash: fixedHex(block.hash, 32, 'block.hash'),
    blockTime: new Date(Number(timestampMs)).toISOString(),
  });
}

function normalizeFirstBuy(input = {}) {
  return Object.freeze({
    walletAddress: address(input.walletAddress, 'walletAddress'),
    transactionHash: fixedHex(input.transactionHash, 32, 'transactionHash'),
    blockNumber: decimalQuantity(input.blockNumber, 'blockNumber'),
    blockHash: fixedHex(input.blockHash, 32, 'blockHash'),
    blockTime: instant(input.blockTime, 'blockTime'),
  });
}

function canonicalEvidence(firstBuy, transaction, rawBlock, metadata) {
  if (!transaction) throw invalid('first-buy transaction is unavailable');
  const firstBuyBlock = rawBlock;
  const transactionHash = fixedHex(transaction.hash, 32, 'transaction.hash');
  const transactionFrom = address(transaction.from, 'transaction.from');
  const transactionBlock = quantity(transaction.blockNumber, 'transaction.blockNumber');
  const transactionBlockHash = fixedHex(transaction.blockHash, 32, 'transaction.blockHash');
  if (transactionHash !== firstBuy.transactionHash || transactionFrom !== firstBuy.walletAddress
      || transactionBlock.toString() !== firstBuy.blockNumber
      || transactionBlockHash !== firstBuy.blockHash
      || firstBuyBlock.hash !== firstBuy.blockHash
      || firstBuyBlock.blockTime !== firstBuy.blockTime) {
    throw invalid('first-buy evidence is not canonical');
  }
  const firstBuyNonce = quantity(transaction.nonce, 'transaction.nonce');
  return Object.freeze({
    ruleVersion: RULE_VERSION, ...metadata,
    firstBuy: Object.freeze({ ...firstBuy, nonce: firstBuyNonce.toString() }),
  });
}

async function requestBatches(requests, requestBatch, size = RPC_SUB_BATCH_SIZE) {
  const batches = [];
  for (let offset = 0; offset < requests.length; offset += size) {
    batches.push(requests.slice(offset, offset + size));
  }
  return (await Promise.all(batches.map(requestBatch))).flat();
}

function resolveRobinhoodFreshWalletRpcProvider(env = process.env, kind = 'archive') {
  const archive = kind === 'archive';
  if (!archive && kind !== 'live') throw new Error('FRESH RPC kind must be archive or live');
  const variable = archive ? 'RH_NODE_RPC_URL' : 'ROBINHOOD_RPC_URL';
  const url = String(env[variable] || '').trim();
  if (!url) throw Object.assign(new Error(`${variable} is required for FRESH`), {
    code: 'configuration_error', fatal: true,
  });
  return Object.freeze({ name: archive ? 'robinhood-pc-archive' : 'robinhood-live', url });
}

function createRobinhoodFreshWalletRpcSource(options = {}) {
  const rpcClient = options.rpcClient;
  if (typeof rpcClient?.request !== 'function') throw new TypeError('FRESH RPC client is required');
  const source = String(options.source || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) throw new TypeError('FRESH RPC source is invalid');
  const sourceKind = options.sourceKind;
  if (!['seed', 'live'].includes(sourceKind)) throw new TypeError('FRESH sourceKind is invalid');
  const now = options.now || (() => new Date());
  const maxCacheBlocks = Number(options.maxCacheBlocks ?? DEFAULT_CACHE_BLOCKS);
  const rpcSubBatchSize = Number(options.rpcSubBatchSize ?? RPC_SUB_BATCH_SIZE);
  if (!Number.isSafeInteger(maxCacheBlocks) || maxCacheBlocks < 16 || maxCacheBlocks > 65536) {
    throw new TypeError('maxCacheBlocks must be between 16 and 65536');
  }
  if (!Number.isSafeInteger(rpcSubBatchSize) || rpcSubBatchSize < 1 || rpcSubBatchSize > 100) {
    throw new TypeError('rpcSubBatchSize must be between 1 and 100');
  }
  const cache = new Map();
  let chainValidation = null;

  async function batchedRequests(requests) {
    if (!requests.length) return [];
    if (typeof rpcClient.requestBatch !== 'function') {
      return Promise.all(requests.map(({ method, params }) => rpcClient.request(method, params)));
    }
    return requestBatches(requests, (batch) => rpcClient.requestBatch(batch), rpcSubBatchSize);
  }

  async function validateChain() {
    chainValidation ||= Promise.resolve(rpcClient.request('eth_chainId')).then((value) => {
      if (quantity(value, 'eth_chainId') !== ROBINHOOD_CHAIN_ID) {
        throw Object.assign(new Error('FRESH RPC is not Robinhood Chain'), {
          code: 'configuration_error', fatal: true,
        });
      }
    }).catch((error) => { chainValidation = null; throw error; });
    return chainValidation;
  }

  async function cachedBlocks(numbers) {
    const keys = [...new Set(numbers.map((number) => BigInt(number).toString()))];
    const missing = keys.filter((key) => !cache.has(key));
    if (missing.length) {
      const values = await batchedRequests(missing.map((key) => ({
        method: 'eth_getBlockByNumber', params: [blockTag(key), false],
      })));
      missing.forEach((key, index) => cache.set(key, Promise.resolve(parseBlock(values[index], key))));
    }
    const blocks = await Promise.all(keys.map((key) => cache.get(key)));
    while (cache.size > maxCacheBlocks) cache.delete(cache.keys().next().value);
    return new Map(keys.map((key, index) => [key, blocks[index]]));
  }

  function interpolationProbe(state) {
    const lowNumber = BigInt(state.low.number);
    const highNumber = BigInt(state.high.number);
    const span = highNumber - lowNumber;
    const lowMs = BigInt(Date.parse(state.low.blockTime));
    const highMs = BigInt(Date.parse(state.high.blockTime));
    let probe = lowNumber + ((highNumber - lowNumber)
      * (BigInt(state.targetMs) - lowMs) / (highMs - lowMs));
    let edge = null;
    if (probe <= lowNumber) { probe = lowNumber + 1n; edge = 'low'; }
    if (probe >= highNumber) { probe = highNumber - 1n; edge = 'high'; }
    if (edge && state.previousEdge === edge) {
      probe = lowNumber + (span / 2n); edge = null;
    }
    state.previousEdge = edge;
    return probe;
  }

  async function resolveCutoffBounds(entries) {
    const states = entries.map(({ targetAt, upperBlock }) => {
      const targetMs = Date.parse(targetAt);
      if (Date.parse(upperBlock.blockTime) < targetMs || BigInt(upperBlock.number) < 1n) {
        throw invalid('cutoff upper bound is invalid');
      }
      return { targetAt, targetMs, anchor: BigInt(upperBlock.number), upper: upperBlock,
        step: INITIAL_CUTOFF_STEP, low: null, high: null, previousEdge: null };
    });
    while (states.some(({ low }) => !low)) {
      const active = states.filter(({ low }) => !low);
      active.forEach((state) => {
        state.probe = state.anchor > state.step ? state.anchor - state.step : 0n;
      });
      const blocks = await cachedBlocks(active.map(({ probe }) => probe));
      for (const state of active) {
        const block = blocks.get(state.probe.toString());
        if (Date.parse(block.blockTime) < state.targetMs) {
          state.low = block; state.high = state.upper;
        } else {
          if (state.probe === 0n) throw invalid('24-hour cutoff predates the canonical chain');
          state.upper = block; state.step *= 2n;
        }
      }
    }
    while (states.some(({ low, high }) => BigInt(high.number) - BigInt(low.number) > 1n)) {
      const active = states.filter(({ low, high }) => BigInt(high.number) - BigInt(low.number) > 1n);
      active.forEach((state) => { state.probe = interpolationProbe(state); });
      const blocks = await cachedBlocks(active.flatMap(({ probe, high }) => [
        probe, probe + 1n < BigInt(high.number) ? probe + 1n : BigInt(high.number),
      ]));
      for (const state of active) {
        const block = blocks.get(state.probe.toString());
        const nextBlock = blocks.get((state.probe + 1n).toString());
        if (Date.parse(block.blockTime) >= state.targetMs) state.high = block;
        else if (Date.parse(nextBlock.blockTime) < state.targetMs) state.low = nextBlock;
        else { state.low = block; state.high = nextBlock; }
      }
    }
    return states.map(({ targetAt, targetMs, low, high }) => {
      if (BigInt(high.number) !== BigInt(low.number) + 1n
          || Date.parse(low.blockTime) >= targetMs || Date.parse(high.blockTime) < targetMs) {
        throw invalid('cutoff resolution is incomplete');
      }
      return { targetAt, cutoff: low, nextBlock: high };
    });
  }

  async function resolveCutoff(targetAt, upperBlock) {
    const [resolved] = await resolveCutoffBounds([{ targetAt, upperBlock }]);
    return resolved;
  }

  async function readCanonicalEvidence(input = {}) {
    const firstBuy = normalizeFirstBuy(input);
    await validateChain();
    const [transaction, firstBuyBlock] = await Promise.all([
      rpcClient.request('eth_getTransactionByHash', [firstBuy.transactionHash]),
      rpcClient.request('eth_getBlockByNumber', [blockTag(firstBuy.blockNumber), false])
        .then((block) => parseBlock(block, firstBuy.blockNumber)),
    ]);
    const canonical = canonicalEvidence(firstBuy, transaction, firstBuyBlock, {
      source, sourceKind, observedAt: instant(now(), 'observedAt'),
    });
    const targetAt = new Date(Date.parse(firstBuy.blockTime) - DAY_MS).toISOString();
    const { cutoff, nextBlock } = await resolveCutoff(targetAt, firstBuyBlock);
    return Object.freeze({ ...canonical,
      cutoff: Object.freeze({ targetAt, ...cutoff }), nextBlock });
  }

  async function canonicalEvidenceBatch(inputs) {
    const firstBuys = inputs.map(normalizeFirstBuy);
    await validateChain();
    const transactionKeys = [...new Set(firstBuys.map(({ transactionHash }) => transactionHash))];
    const [transactions, blocks] = await Promise.all([
      batchedRequests(transactionKeys.map((transactionHash) => ({
        method: 'eth_getTransactionByHash', params: [transactionHash],
      }))),
      cachedBlocks(firstBuys.map(({ blockNumber }) => blockNumber)),
    ]);
    const transactionByHash = new Map(transactionKeys.map((key, index) => [key, transactions[index]]));
    const observedAt = instant(now(), 'observedAt');
    return firstBuys.map((firstBuy) => canonicalEvidence(
      firstBuy, transactionByHash.get(firstBuy.transactionHash), blocks.get(firstBuy.blockNumber),
      { source, sourceKind, observedAt }
    ));
  }

  async function resolveCutoffsBatch(canonicals) {
    const bounds = await resolveCutoffBounds(canonicals.map(({ firstBuy }) => ({
      targetAt: new Date(Date.parse(firstBuy.blockTime) - DAY_MS).toISOString(),
      upperBlock: { number: firstBuy.blockNumber, hash: firstBuy.blockHash,
        blockTime: firstBuy.blockTime },
    })));
    return bounds.map((bound, index) => ({ canonical: canonicals[index], ...bound }));
  }

  async function readCanonicalEvidenceBatch(inputs = []) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > RPC_BATCH_SIZE) {
      throw new TypeError(`FRESH evidence batch must contain between 1 and ${RPC_BATCH_SIZE} items`);
    }
    const cutoffs = await resolveCutoffsBatch(await canonicalEvidenceBatch(inputs));
    return cutoffs.map(({ canonical, targetAt, cutoff, nextBlock }) => Object.freeze({
      ...canonical, cutoff: Object.freeze({ targetAt, ...cutoff }), nextBlock,
    }));
  }

  async function readEvidenceBatch(inputs = []) {
    const canonicals = await readCanonicalEvidenceBatch(inputs);
    const nonceKeys = [...new Map(canonicals.map((canonical) => [
      `${canonical.firstBuy.walletAddress}:${canonical.cutoff.hash}`,
      { canonical, cutoff: canonical.cutoff },
    ])).entries()];
    const nonces = await batchedRequests(nonceKeys.map(([, { canonical, cutoff }]) => ({
      method: 'eth_getTransactionCount', params: [canonical.firstBuy.walletAddress,
        { blockHash: cutoff.hash, requireCanonical: true }],
    })));
    const nonceByKey = new Map(nonceKeys.map(([key], index) => [key, nonces[index]]));
    return canonicals.map((canonical) => {
      const { cutoff } = canonical;
      const cutoffNonce = quantity(nonceByKey.get(
        `${canonical.firstBuy.walletAddress}:${cutoff.hash}`
      ), 'cutoffNonce');
      if (cutoffNonce > BigInt(canonical.firstBuy.nonce)) {
        throw invalid('historical nonce exceeds first-buy nonce');
      }
      return Object.freeze({ ...canonical,
        cutoff: Object.freeze({ ...cutoff, nonce: cutoffNonce.toString() }) });
    });
  }

  async function readEvidence(input = {}) {
    const canonical = await readCanonicalEvidence(input);
    const cutoffNonce = quantity(await rpcClient.request('eth_getTransactionCount', [
      canonical.firstBuy.walletAddress,
      { blockHash: canonical.cutoff.hash, requireCanonical: true },
    ]), 'cutoffNonce');
    const firstBuyNonce = BigInt(canonical.firstBuy.nonce);
    if (cutoffNonce > firstBuyNonce) throw invalid('historical nonce exceeds first-buy nonce');
    return Object.freeze({ ...canonical,
      cutoff: Object.freeze({ ...canonical.cutoff, nonce: cutoffNonce.toString() }),
    });
  }

  return Object.freeze({ sourceKind, readCanonicalEvidence, readCanonicalEvidenceBatch,
    readEvidence, readEvidenceBatch });
}

module.exports = {
  createRobinhoodFreshWalletRpcSource,
  resolveRobinhoodFreshWalletRpcProvider,
  __private: { parseBlock, requestBatches },
};

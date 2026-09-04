const WebSocket = require('ws');
const { DISCOVERY_TOPICS, MARKET_TOPICS } = require('./robinhood-continuous-runner');
const { LIQUIDITY_EVENT_TOPICS } = require('./robinhood-pool-liquidity-events');
const { TRANSFER_TOPIC } = require('./evm-erc20-supply-delta');
const {
  LAUNCHHOOD_TOKEN_LAUNCHED_TOPIC, PONS_TOKEN_LAUNCHED_TOPIC,
} = require('./robinhood-launchpad-creator-adapter');

const CAPTURE_TOPICS = Object.freeze([...new Set([
  ...DISCOVERY_TOPICS, ...MARKET_TOPICS, ...LIQUIDITY_EVENT_TOPICS, TRANSFER_TOPIC,
  LAUNCHHOOD_TOKEN_LAUNCHED_TOPIC, PONS_TOKEN_LAUNCHED_TOPIC,
].map((value) => value.toLowerCase()))]);

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}
function hex(value, bytes, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}
function optionalAddress(value, label) {
  return value == null ? null : hex(value, 20, label);
}
function dataHex(value, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}
function blockTimestamp(value) {
  const milliseconds = Number(quantity(value, 'block.timestamp')) * 1000;
  if (!Number.isFinite(milliseconds)) throw new Error('block.timestamp is out of range');
  return new Date(milliseconds).toISOString();
}

function normalizeTransaction(tx, receipt, position, block) {
  const hashValue = hex(tx?.hash, 32, `transactions[${position}].hash`);
  if (hex(receipt?.transactionHash, 32, `receipts[${position}].transactionHash`) !== hashValue) {
    throw new Error(`receipt ${position} does not match its transaction`);
  }
  const index = quantity(tx.transactionIndex, `transactions[${position}].transactionIndex`);
  if (quantity(receipt.transactionIndex, `receipts[${position}].transactionIndex`) !== index
      || index !== BigInt(position)) throw new Error(`transaction ${position} index is invalid`);
  if (quantity(tx.blockNumber, `transactions[${position}].blockNumber`) !== block.number
      || hex(tx.blockHash, 32, `transactions[${position}].blockHash`) !== block.hash) {
    throw new Error(`transaction ${position} does not match its block`);
  }
  const status = quantity(receipt.status, `receipts[${position}].status`);
  if (status > 1n) throw new Error(`receipt ${position} status is invalid`);
  return {
    hash: hashValue, index: index.toString(),
    from: hex(tx.from, 20, `transactions[${position}].from`),
    to: optionalAddress(tx.to, `transactions[${position}].to`),
    succeeded: status === 1n,
    contractAddress: optionalAddress(receipt.contractAddress, `receipts[${position}].contractAddress`),
    nonce: quantity(tx.nonce, `transactions[${position}].nonce`).toString(),
    valueWei: quantity(tx.value, `transactions[${position}].value`).toString(),
  };
}

function normalizeEvents(receipts, block, topics) {
  const events = [];
  const indexes = new Set();
  for (const [receiptIndex, receipt] of receipts.entries()) {
    if (!Array.isArray(receipt.logs)) throw new Error(`receipt ${receiptIndex} logs are unavailable`);
    for (const [position, log] of receipt.logs.entries()) {
      const topic0 = String(log?.topics?.[0] || '').toLowerCase();
      if (!topics.has(topic0)) continue;
      if (log.removed === true) throw new Error('removed log is unsupported in canonical capture');
      const logIndex = quantity(log.logIndex, `receipts[${receiptIndex}].logs[${position}].logIndex`);
      if (indexes.has(logIndex.toString())) throw new Error(`duplicate log index ${logIndex}`);
      indexes.add(logIndex.toString());
      if (hex(log.transactionHash, 32, 'log.transactionHash') !== receipt.transactionHash.toLowerCase()
          || quantity(log.transactionIndex, 'log.transactionIndex')
            !== quantity(receipt.transactionIndex, 'receipt.transactionIndex')) {
        throw new Error(`log ${logIndex} does not match its receipt`);
      }
      if (quantity(log.blockNumber, 'log.blockNumber') !== block.number
          || hex(log.blockHash, 32, 'log.blockHash') !== block.hash) {
        throw new Error(`log ${logIndex} does not match its block`);
      }
      events.push({
        transactionHash: hex(log.transactionHash, 32, 'log.transactionHash'),
        transactionIndex: quantity(log.transactionIndex, 'log.transactionIndex').toString(),
        logIndex: logIndex.toString(), address: hex(log.address, 20, 'log.address'),
        topics: log.topics.map((topic, index) => hex(topic, 32, `log.topics[${index}]`)),
        data: dataHex(log.data, 'log.data'),
      });
    }
  }
  return events.sort((left, right) => Number(BigInt(left.logIndex) - BigInt(right.logIndex)));
}

async function readReceiptBlock(rpcClient, blockNumber, options = {}) {
  const tag = `0x${BigInt(blockNumber).toString(16)}`;
  const [rawBlock, receipts] = await Promise.all([
    rpcClient.request('eth_getBlockByNumber', [tag, true]),
    rpcClient.request('eth_getBlockReceipts', [tag]),
  ]);
  if (!rawBlock || !Array.isArray(rawBlock.transactions) || !Array.isArray(receipts)
      || receipts.length !== rawBlock.transactions.length) {
    const error = new Error(`receipts unavailable for block ${blockNumber}`);
    error.code = 'capture_receipts_unavailable';
    throw error;
  }
  const block = {
    number: quantity(rawBlock.number, 'block.number'), hash: hex(rawBlock.hash, 32, 'block.hash'),
    parentHash: hex(rawBlock.parentHash, 32, 'block.parentHash'),
    timestamp: blockTimestamp(rawBlock.timestamp),
  };
  if (block.number !== BigInt(blockNumber)) throw new Error(`received unexpected block ${block.number}`);
  for (const [index, receipt] of receipts.entries()) {
    if (quantity(receipt.blockNumber, `receipts[${index}].blockNumber`) !== block.number
        || hex(receipt.blockHash, 32, `receipts[${index}].blockHash`) !== block.hash) {
      throw new Error(`receipt ${index} does not match its block`);
    }
  }
  return {
    block,
    transactions: rawBlock.transactions.map((tx, index) => (
      normalizeTransaction(tx, receipts[index], index, block)
    )),
    events: normalizeEvents(receipts, block, options.topics || new Set(CAPTURE_TOPICS)),
  };
}

function createHeadSubscription(url, onHead, options = {}) {
  if (!url) return { start() {}, stop() {}, getStatus: () => ({ state: 'polling_fallback' }) };
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  let socket = null; let reconnectTimer = null; let stopped = true; let state = 'idle';
  function connect() {
    if (stopped) return;
    state = 'connecting'; socket = new WebSocketImpl(url);
    socket.on('open', () => {
      state = 'subscribing';
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
    });
    socket.on('message', (message) => {
      try {
        const payload = JSON.parse(String(message));
        if (payload.id === 1 && payload.result) state = 'subscribed';
        if (payload.method === 'eth_subscription' && payload.params?.result?.number) {
          onHead(quantity(payload.params.result.number, 'newHeads.number'));
        }
      } catch (_) { state = 'invalid_message'; }
    });
    socket.on('error', () => { state = 'error'; socket.terminate?.(); });
    socket.on('close', () => {
      socket = null;
      if (!stopped) reconnectTimer = schedule(connect, options.reconnectMs || 1000);
    });
  }
  return {
    start() { if (stopped) { stopped = false; connect(); } },
    stop() { stopped = true; if (reconnectTimer) cancel(reconnectTimer); if (socket) socket.close(); },
    getStatus: () => ({ state }),
  };
}

function createRobinhoodChainCaptureWorker(deps, options = {}) {
  if (typeof deps.v3Snapshotter?.captureBlock !== 'function') {
    throw new Error('v3Snapshotter.captureBlock is required');
  }
  const now = deps.now || (() => new Date());
  const schedule = deps.schedule || setTimeout; const cancel = deps.cancel || clearTimeout;
  const topics = new Set(options.topics || CAPTURE_TOPICS);
  const v3SnapshotWindowBlocks = BigInt(options.v3SnapshotWindowBlocks ?? 32);
  const status = { running: false, mode: 'shadow_receipts', lastResult: null, lastError: null,
    nodeHead: null, nextBlock: null, lagBlocks: null, lastHeadObservedAt: null,
    lastTiming: null, blocks: 0, transactions: 0, events: 0,
    v3Snapshots: 0, v3MissedPools: 0, v3SkippedPools: 0,
    v3SnapshotWindowBlocks: Number(v3SnapshotWindowBlocks) };
  let timer = null; let inFlight = null; let requested = false;
  const subscription = createHeadSubscription(options.wsUrl, () => {
    status.lastHeadObservedAt = now().toISOString(); void kick();
  }, {
    WebSocketImpl: deps.WebSocketImpl, schedule, cancel, reconnectMs: options.reconnectMs,
  });
  function recordFrontier(nodeHead, nextBlock) {
    status.nextBlock = nextBlock.toString();
    status.lagBlocks = Number(nodeHead >= nextBlock ? nodeHead - nextBlock + 1n : 0n);
  }
  async function captureOnce() {
    const nodeHead = quantity(await deps.rpcClient.request('eth_blockNumber'), 'eth_blockNumber');
    const cursor = await deps.journal.getCursor();
    let nextBlock = cursor ? quantity(cursor.next_block, 'cursor.next_block')
      : (options.startBlock == null ? nodeHead : BigInt(options.startBlock));
    if (cursor && nodeHead + 1n < nextBlock) {
      const error = new Error(`node head ${nodeHead} regressed behind capture cursor ${nextBlock}`);
      error.code = 'capture_node_head_regressed'; throw error;
    }
    const limit = BigInt(options.maxBlocksPerDrain || 100);
    const through = nodeHead < nextBlock + limit - 1n ? nodeHead : nextBlock + limit - 1n;
    status.nodeHead = nodeHead.toString(); recordFrontier(nodeHead, nextBlock);
    while (nextBlock <= through) {
      const startedAt = now();
      const observedAt = status.lastHeadObservedAt || startedAt.toISOString();
      const capture = await readReceiptBlock(deps.rpcClient, nextBlock, { topics });
      const receiptsAvailableAt = now();
      const v3State = await deps.v3Snapshotter.captureBlock(capture, {
        // Cover intervening live blocks too; old catch-up only updates pool tracking.
        readBalances: nodeHead - nextBlock < v3SnapshotWindowBlocks,
      });
      const snapshotsAvailableAt = now();
      const finalizedHead = nodeHead > BigInt(options.confirmations || 0)
        ? nodeHead - BigInt(options.confirmations || 0) : 0n;
      const result = await deps.journal.commitBlock({
        ...capture, v3Snapshots: v3State.snapshots, nodeHead: nodeHead.toString(),
        finalizedHead: finalizedHead.toString(), block: { ...capture.block,
          finality: nextBlock <= finalizedHead ? 'finalized' : 'observed', headObservedAt: observedAt,
          receiptsAvailableAt: receiptsAvailableAt.toISOString() },
      });
      const committedAt = now();
      status.blocks += 1; status.transactions += result.transactions; status.events += result.events;
      status.v3Snapshots += result.v3Snapshots || 0;
      status.v3MissedPools += v3State.missedPools;
      status.v3SkippedPools += v3State.skippedPools || 0;
      status.lastResult = { block: nextBlock.toString(), ...result }; nextBlock += 1n;
      recordFrontier(nodeHead, nextBlock);
      status.lastTiming = {
        fetchMs: receiptsAvailableAt - startedAt,
        snapshotMs: snapshotsAvailableAt - receiptsAvailableAt,
        commitMs: committedAt - snapshotsAvailableAt,
        headToCommitMs: Math.max(0, committedAt - new Date(observedAt)),
      };
    }
    if (nextBlock <= nodeHead) requested = true;
    return status.lastResult;
  }
  async function kick() {
    requested = true;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (status.running && requested) {
        requested = false;
        try { await captureOnce(); status.lastError = null; }
        catch (error) { status.lastError = { code: error.code || null, message: error.message }; }
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  function armFallback() {
    if (!status.running) return;
    timer = schedule(async () => { await kick(); armFallback(); }, options.fallbackPollMs || 250);
    timer?.unref?.();
  }
  return Object.freeze({
    start() { if (!status.running) { status.running = true; subscription.start(); void kick(); armFallback(); } },
    async stop() { status.running = false; requested = false; if (timer) cancel(timer); subscription.stop(); await inFlight; },
    captureOnce,
    getStatus: () => ({ ...status, transport: subscription.getStatus() }),
  });
}

module.exports = {
  CAPTURE_TOPICS, createRobinhoodChainCaptureWorker,
  __private: { createHeadSubscription, readReceiptBlock },
};

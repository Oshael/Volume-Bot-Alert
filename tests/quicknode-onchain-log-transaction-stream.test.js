const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');

const logStream = require('../src/services/quicknode-onchain-log-transaction-stream');
const { resolveProgram } = require('../src/utils/quicknode-transaction-probe');

const PROGRAMS = [
  'pumpswap',
  'meteora-dlmm',
  'raydium-cpmm',
  'raydium-clmm',
  'raydium-amm-v4',
].map(resolveProgram);

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  receive(payload) {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  close() {
    this.emit('close');
  }
}

function logsNotification(subscription, signature, logs) {
  return {
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: {
      subscription,
      result: { value: { signature, err: null, logs } },
    },
  };
}

function fetchedTransaction(programAddress) {
  return {
    slot: 430000000,
    blockTime: 1783137600,
    transaction: {
      message: { instructions: [{ programId: programAddress }] },
    },
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  };
}

function waitForBatch() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('quicknode onchain log transaction stream', () => {
  it('subscribes all DEX logs and fetches full data only for actual invokes', async () => {
    const socket = new FakeWebSocket();
    const summaries = [];
    const fetchBodies = [];
    const stream = logStream.createOnchainLogTransactionStream({
      wsUrl: 'wss://example.test/',
      rpcUrl: 'https://example.test/',
      programs: PROGRAMS,
      wsFactory: () => socket,
      fetchBatchWaitMs: 1,
      fetchAvailabilityDelayMs: 0,
      now: () => 1_783_137_600_123,
      fetchImpl: async (_url, request) => {
        const payload = JSON.parse(request.body);
        fetchBodies.push(payload);
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify(payload.map((item) => ({
              jsonrpc: '2.0',
              id: item.id,
              result: fetchedTransaction(PROGRAMS[0].address),
            })));
          },
        };
      },
      onSummary: (summary) => summaries.push(summary),
    });

    stream.start();
    socket.emit('open');
    assert.equal(socket.sent.length, 5);
    assert.ok(socket.sent.every((payload) => payload.method === 'logsSubscribe'));

    socket.receive({ jsonrpc: '2.0', id: 1, result: 501 });
    socket.receive(logsNotification(501, 'mention-only', ['Program log: address mentioned']));
    socket.receive(logsNotification(501, 'actual-invoke', [
      `Program ${PROGRAMS[0].address} invoke [1]`,
      `Program ${PROGRAMS[0].address} success`,
    ]));
    await waitForBatch();

    assert.equal(fetchBodies.length, 1);
    assert.equal(fetchBodies[0][0].method, 'getTransaction');
    assert.equal(fetchBodies[0][0].params[0], 'actual-invoke');
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].program, 'pumpswap');
    assert.equal(summaries[0].observedAtMs, 1_783_137_600_123);
    assert.equal(stream.stats()[0].skippedMentionOnly, 1);
    assert.equal(stream.httpStats().fetched, 1);
    stream.stop();
  });

  it('deduplicates signatures that arrive from multiple monitored subscriptions', async () => {
    const socket = new FakeWebSocket();
    let fetches = 0;
    const stream = logStream.createOnchainLogTransactionStream({
      wsUrl: 'wss://example.test/',
      rpcUrl: 'https://example.test/',
      programs: PROGRAMS,
      wsFactory: () => socket,
      fetchBatchWaitMs: 1,
      fetchAvailabilityDelayMs: 0,
      fetchImpl: async (_url, request) => {
        fetches += 1;
        const payload = JSON.parse(request.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload.map((item) => ({
            id: item.id,
            result: fetchedTransaction(PROGRAMS[0].address),
          }))),
        };
      },
    });

    stream.start();
    socket.emit('open');
    socket.receive({ jsonrpc: '2.0', id: 1, result: 501 });
    socket.receive({ jsonrpc: '2.0', id: 2, result: 502 });
    socket.receive(logsNotification(501, 'same-signature', [`Program ${PROGRAMS[0].address} invoke [1]`]));
    socket.receive(logsNotification(502, 'same-signature', [`Program ${PROGRAMS[1].address} invoke [2]`]));
    await waitForBatch();

    assert.equal(fetches, 1);
    stream.stop();
  });

  it('requires the exact runtime invoke prefix', () => {
    assert.equal(logStream.__private.hasProgramInvoke([
      `Program ${PROGRAMS[0].address} invoke [1]`,
    ], PROGRAMS[0].address), true);
    assert.equal(logStream.__private.hasProgramInvoke([
      `Program log: ${PROGRAMS[0].address}`,
    ], PROGRAMS[0].address), false);
  });

  it('honors configured fetch attempts before counting exhausted fetches', async () => {
    const socket = new FakeWebSocket();
    const stream = logStream.createOnchainLogTransactionStream({
      wsUrl: 'wss://example.test/',
      rpcUrl: 'https://example.test/',
      programs: PROGRAMS,
      wsFactory: () => socket,
      fetchBatchWaitMs: 1,
      fetchAvailabilityDelayMs: 0,
      fetchAttempts: 1,
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        text: async () => '',
      }),
    });

    stream.start();
    socket.emit('open');
    socket.receive({ jsonrpc: '2.0', id: 1, result: 501 });
    socket.receive(logsNotification(501, 'rate-limited', [`Program ${PROGRAMS[0].address} invoke [1]`]));
    await waitForBatch();

    assert.equal(stream.httpStats().rateLimitedBatches, 1);
    assert.equal(stream.httpStats().errors, 1);
    assert.equal(stream.httpStats().queued, 0);
    stream.stop();
  });

  it('drops the oldest queued fetch when the configured queue limit is reached', async () => {
    const socket = new FakeWebSocket();
    let fetches = 0;
    const stream = logStream.createOnchainLogTransactionStream({
      wsUrl: 'wss://example.test/',
      rpcUrl: 'https://example.test/',
      programs: PROGRAMS,
      wsFactory: () => socket,
      fetchAvailabilityDelayMs: 60_000,
      fetchMaxQueueSize: 1,
      fetchImpl: async () => {
        fetches += 1;
        return { ok: true, status: 200, text: async () => '[]' };
      },
    });

    stream.start();
    socket.emit('open');
    socket.receive({ jsonrpc: '2.0', id: 1, result: 501 });
    socket.receive(logsNotification(501, 'first-signature', [`Program ${PROGRAMS[0].address} invoke [1]`]));
    socket.receive(logsNotification(501, 'second-signature', [`Program ${PROGRAMS[0].address} invoke [1]`]));

    assert.equal(stream.httpStats().dropped, 1);
    assert.equal(stream.httpStats().queued, 1);
    assert.equal(fetches, 0);
    stream.stop();
  });
});

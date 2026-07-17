const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');

const { createOnchainTransactionStream } = require('../src/services/quicknode-onchain-transaction-stream');
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
    this.readyState = 0;
    this.sent = [];
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  receive(payload) {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function notification(subscription, programAddress, signature = 'stream-signature') {
  return {
    jsonrpc: '2.0',
    method: 'transactionNotification',
    params: {
      subscription,
      result: {
        value: {
          signature,
          slot: 430000000,
          transaction: {
            transaction: {
              message: {
                instructions: [{ programId: programAddress }],
              },
            },
            meta: {
              innerInstructions: [],
              preTokenBalances: [],
              postTokenBalances: [],
            },
          },
        },
      },
    },
  };
}

describe('quicknode onchain transaction stream', () => {
  it('subscribes all monitored DEX programs over one connection and routes matches', () => {
    const socket = new FakeWebSocket();
    const summaries = [];
    const statuses = [];
    const stream = createOnchainTransactionStream({
      wsUrl: 'wss://example.test/',
      programs: PROGRAMS,
      wsFactory: () => socket,
      now: () => 1_783_137_600_123,
      onSummary: (summary) => summaries.push(summary),
      onStatus: (status) => statuses.push(status),
    });

    stream.start();
    socket.open();

    assert.equal(socket.sent.length, 5);
    assert.deepEqual(
      socket.sent.map((payload) => payload.params[0].accounts.include[0]),
      PROGRAMS.map((program) => program.address),
    );

    socket.receive({ jsonrpc: '2.0', id: 1, result: 501 });
    socket.receive(notification(501, PROGRAMS[0].address));

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].program, 'pumpswap');
    assert.equal(summaries[0].observedAtMs, 1_783_137_600_123);
    assert.equal(stream.stats()[0].matches, 1);
    assert.ok(statuses.some((status) => status.status === 'subscribed'));
    stream.stop();
  });

  it('counts mention-only notifications without forwarding them', () => {
    const socket = new FakeWebSocket();
    const summaries = [];
    const stream = createOnchainTransactionStream({
      wsUrl: 'wss://example.test/',
      programs: PROGRAMS,
      wsFactory: () => socket,
      onSummary: (summary) => summaries.push(summary),
    });

    stream.start();
    socket.open();
    socket.receive({ jsonrpc: '2.0', id: 2, result: 502 });
    socket.receive(notification(502, 'Unrelated111111111111111111111111111111111'));

    assert.equal(summaries.length, 0);
    assert.equal(stream.stats()[1].seen, 1);
    assert.equal(stream.stats()[1].skippedMentionOnly, 1);
    stream.stop();
  });

  it('reconnects and restores every subscription after an unexpected close', () => {
    const sockets = [];
    const scheduled = [];
    const stream = createOnchainTransactionStream({
      wsUrl: 'wss://example.test/',
      programs: PROGRAMS,
      reconnectDelayMs: 10,
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return scheduled.length;
      },
      cancelSchedule: () => {},
    });

    stream.start();
    sockets[0].open();
    sockets[0].close();

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delayMs, 10);
    scheduled[0].callback();
    sockets[1].open();

    assert.equal(sockets.length, 2);
    assert.equal(sockets[1].sent.length, 5);
    stream.stop();
  });
});

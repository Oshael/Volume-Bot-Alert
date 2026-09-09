const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const esbuild = require('../frontend/node_modules/esbuild');

const SOLANA = 'So11111111111111111111111111111111111111112';
const ROBINHOOD = '0xabcdef0123456789abcdef0123456789abcdef01';
let client;
let socket;

function createSocketMock() {
  const handlers = new Map();
  return {
    connected: true,
    sent: [],
    connect() {
      this.connected = true;
      handlers.get('connect')?.();
    },
    disconnect() {
      this.connected = false;
      handlers.get('disconnect')?.('client disconnect');
    },
    emit(event, payload) {
      this.sent.push({ event, payload });
    },
    off(event) {
      handlers.delete(event);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    trigger(event, payload) {
      this.connected = event === 'connect' ? true : this.connected;
      handlers.get(event)?.(payload);
    },
  };
}

before(async () => {
  socket = createSocketMock();
  globalThis.__frontendSocketFactory = () => socket;
  const result = await esbuild.build({
    entryPoints: ['frontend/src/services/socket/client.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [{
      name: 'socket-client-test-boundaries',
      setup(build) {
        build.onResolve({ filter: /^socket\.io-client$/ }, () => ({
          path: 'socket.io-client', namespace: 'socket-io-test',
        }));
        build.onLoad({ filter: /.*/, namespace: 'socket-io-test' }, () => ({
          contents: 'export const io = (...args) => globalThis.__frontendSocketFactory(...args);',
          loader: 'js',
        }));
        build.onResolve({ filter: /api\/base$/ }, () => ({
          path: 'api-base', namespace: 'api-base-test',
        }));
        build.onLoad({ filter: /^api-base$/, namespace: 'api-base-test' }, () => ({
          contents: "export const resolveApiBase = () => 'http://test.invalid';",
          loader: 'js',
        }));
      },
    }],
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  client = await import(`data:text/javascript;base64,${source}`);
});

after(() => {
  delete globalThis.__frontendSocketFactory;
});

describe('frontend socket market subscriptions', () => {
  it('marks when a market bucket reaches the browser before dispatch', () => {
    const received = [];
    client.bindSocketLifecycle({ onRevoked() {}, onMarketBucket: (event) => received.push(event) });
    socket.trigger('market:bucket', {
      type: 'market:bucket', chain: 'robinhood', address: ROBINHOOD,
      bucketTs: '2026-09-09T12:00:00.000Z', sequence: 'robinhood:1',
      granularityMinutes: 1,
      latency: { publishedAt: '2026-09-09T12:00:00.100Z' },
      candle: { bucketTs: '2026-09-09T12:00:00.000Z', granularityMinutes: 1 },
    });

    assert.equal(received.length, 1);
    assert.ok(Number.isFinite(Date.parse(received[0].latency.clientReceivedAt)));
    assert.equal(received[0].latency.publishedAt, '2026-09-09T12:00:00.100Z');
  });

  it('marks trade and alert events when they reach the browser', () => {
    const trades = [];
    const alerts = [];
    client.bindSocketLifecycle({ onRevoked() {}, onAlertEvent: (event) => alerts.push(event) });
    const unsubscribe = client.subscribeRobinhoodTrades(ROBINHOOD, (event) => trades.push(event));
    socket.trigger('market:trade', {
      type: 'market:trade', chain: 'robinhood', address: ROBINHOOD,
      transactionHash: `0x${'1'.repeat(64)}`, actionIndex: 1, blockNumber: 100,
      blockTime: '2026-09-09T12:00:00.000Z', side: 'buy',
      walletAddress: `0x${'2'.repeat(40)}`, amountUsd: 1, priceUsd: 2, mcUsd: 3,
      latency: { publishedAt: '2026-09-09T12:00:00.100Z' },
    });
    socket.trigger('alert:event', {
      id: 9, chain: 'robinhood', address: ROBINHOOD,
      latency: { publishedAt: '2026-09-09T12:00:00.100Z' },
    });

    assert.ok(Number.isFinite(Date.parse(trades[0].latency.clientReceivedAt)));
    assert.ok(Number.isFinite(Date.parse(alerts[0].latency.clientReceivedAt)));
    unsubscribe();
  });

  it('restores canonical chart and workspace subscriptions after reconnect', () => {
    client.bindSocketLifecycle({ onRevoked() {} });
    client.subscribeMarketChart(SOLANA);
    client.replaceWorkspaceMarketSubscriptions([
      { chain: 'robinhood', address: ROBINHOOD.toUpperCase() },
    ]);
    socket.sent.length = 0;

    socket.trigger('disconnect', 'transport close');
    socket.trigger('connect');
    socket.trigger('connect');

    const syncs = socket.sent.filter(({ event }) => event === 'market:sync');
    assert.equal(syncs.length, 2);
    for (const sync of syncs) {
      assert.deepEqual(sync.payload, { subscriptions: [
        { chain: 'robinhood', address: ROBINHOOD },
        { chain: 'solana', address: SOLANA },
      ] });
    }
  });

  it('dispatches ordered holder events and requests REST recovery after reconnect', () => {
    const counts = [];
    const invalidations = [];
    let recoveries = 0;
    const unsubscribe = client.subscribeRobinhoodHolderUpdates(ROBINHOOD, {
      onCount: (event) => counts.push(event),
      onInvalidate: (event) => invalidations.push(event.reason),
      onRecover: () => { recoveries += 1; },
    });
    const holderEvent = (overrides = {}) => {
      const version = String(overrides.ledgerVersion || '7');
      return {
        type: 'holder:count', chain: 'robinhood', address: ROBINHOOD,
        holderCount: 4424, source: 'ledger_live', observedAt: '2026-08-10T12:00:00.000Z',
        ledgerVersion: version, liveThroughBlock: '32653260', liveThroughHash: `0x${'b'.repeat(64)}`,
        sequence: `robinhood-holder:${ROBINHOOD}:${version.padStart(24, '0')}`,
        ...overrides,
      };
    };

    socket.trigger('holder:count', holderEvent({
      latency: { publishedAt: '2026-08-10T12:00:00.100Z' },
    }));
    socket.trigger('holder:count', holderEvent({ holderCount: 9999 }));
    socket.trigger('holder:invalidate', holderEvent({
      type: 'holder:invalidate', holderCount: undefined, ledgerVersion: '8',
      sequence: `robinhood-holder:${ROBINHOOD}:000000000000000000000008`, reason: 'reorg_resync',
    }));
    socket.trigger('disconnect', 'transport close');
    socket.trigger('connect');

    assert.equal(counts.length, 1);
    assert.equal(counts[0].holderCount, 4424);
    assert.ok(Number.isFinite(Date.parse(counts[0].latency.clientReceivedAt)));
    assert.deepEqual(invalidations, ['reorg_resync']);
    assert.equal(recoveries, 1);
    unsubscribe();
  });
});

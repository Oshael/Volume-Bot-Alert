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
      onCount: (event) => counts.push(event.holderCount),
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

    socket.trigger('holder:count', holderEvent());
    socket.trigger('holder:count', holderEvent({ holderCount: 9999 }));
    socket.trigger('holder:invalidate', holderEvent({
      type: 'holder:invalidate', holderCount: undefined, ledgerVersion: '8',
      sequence: `robinhood-holder:${ROBINHOOD}:000000000000000000000008`, reason: 'reorg_resync',
    }));
    socket.trigger('disconnect', 'transport close');
    socket.trigger('connect');

    assert.deepEqual(counts, [4424]);
    assert.deepEqual(invalidations, ['reorg_resync']);
    assert.equal(recoveries, 1);
    unsubscribe();
  });
});

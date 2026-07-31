const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, '..', 'frontend/src/state/telegram-connection-controller.ts');
const source = fs.readFileSync(file, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const moduleRecord = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleRecord,
  exports: moduleRecord.exports,
  require: () => ({
    fetchTelegramStatus: async () => { throw new Error('Unexpected default API call'); },
    createTelegramLink: async () => { throw new Error('Unexpected default API call'); },
    disconnectTelegram: async () => { throw new Error('Unexpected default API call'); },
  }),
}, { filename: file });

const { createTelegramConnectionController } = moduleRecord.exports;

function createTelegramState(overrides = {}) {
  return {
    loaded: false,
    loading: false,
    mutating: false,
    available: false,
    status: 'disconnected',
    identity: null,
    botUrl: null,
    linkedAt: null,
    lastDeliveryAt: null,
    lastError: null,
    pendingDeepLink: null,
    pendingDeepLinkExpiresAt: null,
    error: null,
    ...overrides,
  };
}

function createHarness(apiOverrides = {}, stateOverrides = {}) {
  const state = createTelegramState(stateOverrides);
  const notifications = [];
  let authenticated = true;
  const api = {
    fetchStatus: async () => ({
      available: true,
      status: 'active',
      identity: { username: 'alice', firstName: 'Alice' },
      botUrl: 'https://t.me/trend_scope_bot',
      linkedAt: '2026-07-29T12:00:00.000Z',
      lastDeliveryAt: null,
      lastError: null,
    }),
    createLink: async () => ({
      deepLink: 'https://t.me/trend_scope_bot?start=opaque',
      expiresAt: '2026-07-29T12:10:00.000Z',
    }),
    disconnect: async () => ({
      available: true,
      status: 'disconnected',
      identity: null,
      botUrl: 'https://t.me/trend_scope_bot',
      linkedAt: null,
      lastDeliveryAt: null,
      lastError: null,
    }),
    ...apiOverrides,
  };
  const controller = createTelegramConnectionController({
    state,
    isAuthenticated: () => authenticated,
    notify: () => notifications.push({ loading: state.loading, mutating: state.mutating }),
    createInitialState: () => createTelegramState(),
    sessionToken: '__cookie_session__',
    api,
  });
  return {
    state,
    notifications,
    controller,
    setAuthenticated(value) {
      authenticated = value;
    },
  };
}

describe('Telegram connection controller', () => {
  it('loads status only for an authenticated session and deduplicates in-flight refreshes', async () => {
    let resolveStatus;
    let calls = 0;
    const statusPromise = new Promise((resolve) => {
      resolveStatus = resolve;
    });
    const harness = createHarness({
      fetchStatus: async (token) => {
        calls += 1;
        assert.equal(token, '__cookie_session__');
        return statusPromise;
      },
    });

    harness.setAuthenticated(false);
    await harness.controller.refresh();
    assert.equal(calls, 0);

    harness.setAuthenticated(true);
    const firstRefresh = harness.controller.refresh();
    const duplicateRefresh = harness.controller.refresh();
    assert.equal(harness.state.loading, true);
    assert.equal(calls, 1);

    resolveStatus({
      available: true,
      status: 'active',
      identity: null,
      botUrl: 'https://t.me/trend_scope_bot',
      linkedAt: null,
      lastDeliveryAt: null,
      lastError: null,
    });
    await Promise.all([firstRefresh, duplicateRefresh]);

    assert.equal(harness.state.loaded, true);
    assert.equal(harness.state.status, 'active');
    assert.equal(harness.state.loading, false);
    assert.deepEqual(harness.notifications, [
      { loading: true, mutating: false },
      { loading: false, mutating: false },
    ]);
  });

  it('owns link creation, disconnect, and reset transitions', async () => {
    const harness = createHarness();

    await harness.controller.createLink();
    assert.equal(harness.state.pendingDeepLink, 'https://t.me/trend_scope_bot?start=opaque');
    assert.equal(harness.state.mutating, false);

    await harness.controller.disconnect();
    assert.equal(harness.state.loaded, true);
    assert.equal(harness.state.status, 'disconnected');
    assert.equal(harness.state.pendingDeepLink, null);

    harness.controller.reset();
    assert.deepEqual(harness.state, createTelegramState());
  });

  it('exposes API failures in state and releases the mutation lock', async () => {
    const harness = createHarness({
      createLink: async () => {
        throw new TypeError('Telegram link unavailable');
      },
    });

    await harness.controller.createLink();

    assert.equal(harness.state.error, 'Unable to connect Telegram');
    assert.equal(harness.state.mutating, false);
    assert.deepEqual(harness.notifications, [
      { loading: false, mutating: true },
      { loading: false, mutating: false },
    ]);
  });
});

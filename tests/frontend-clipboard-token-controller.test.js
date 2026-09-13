const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, '..', 'frontend/src/state/clipboard-token-controller.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const moduleRecord = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleRecord, exports: moduleRecord.exports, AbortController,
  require: (id) => id.endsWith('app-state')
    ? { createClipboardTokenState: () => ({ status: 'idle', hit: null, error: null }) }
    : { fetchExactToken: async () => { throw new Error('Unexpected API call'); } },
}, { filename: file });
const { classifyClipboardTokenAddress, createClipboardTokenController } = moduleRecord.exports;
const createState = () => ({ status: 'idle', hit: null, error: null });
const ADDRESS = `0x${'a'.repeat(40)}`;
const SECOND_ADDRESS = `0x${'b'.repeat(40)}`;
const SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112';

function exactPayload(address) {
  return {
    status: 'ready',
    hits: [{
      kind: 'token', chain: 'robinhood', address, symbol: 'HOOD', name: 'Robin Hood', imageUrl: null,
      destination: { type: 'expanded-chart', chain: 'robinhood', address }, match: 'exact_address',
    }],
  };
}

describe('frontend clipboard token shortcut', () => {
  it('locally rejects unrelated or oversized text and normalizes supported address families', async () => {
    assert.equal(classifyClipboardTokenAddress('not a contract'), null);
    assert.equal(classifyClipboardTokenAddress('x'.repeat(121)), null);
    assert.equal(classifyClipboardTokenAddress(ADDRESS.toUpperCase()), ADDRESS);
    assert.equal(classifyClipboardTokenAddress(SOLANA_ADDRESS), SOLANA_ADDRESS);

    let requests = 0;
    const state = createState();
    const controller = createClipboardTokenController({
      state, isAuthenticated: () => true, notify() {},
      readPermission: async () => 'granted', readClipboard: async () => 'private unrelated note',
      request: async () => { requests += 1; return exactPayload(ADDRESS); },
    });
    await controller.activate();
    assert.equal(requests, 0);
    assert.deepEqual(state, createState());
  });

  it('treats denied and unavailable clipboard access as closed non-requesting states', async () => {
    let reads = 0;
    let requests = 0;
    const denied = createState();
    const deniedController = createClipboardTokenController({
      state: denied, isAuthenticated: () => true, notify() {},
      readPermission: async () => 'denied',
      readClipboard: async () => { reads += 1; return ADDRESS; },
      request: async () => { requests += 1; return exactPayload(ADDRESS); },
    });
    await deniedController.activate();
    await deniedController.activate();
    assert.equal(denied.status, 'denied');
    assert.equal(reads, 0);
    assert.equal(requests, 0);

    const unavailable = createState();
    const unavailableError = { name: 'NotSupportedError' };
    const unavailableController = createClipboardTokenController({
      state: unavailable, isAuthenticated: () => true, notify() {},
      readPermission: async () => null,
      readClipboard: async () => { throw unavailableError; },
    });
    await unavailableController.activate();
    assert.equal(unavailable.status, 'unavailable');
  });

  it('aborts stale exact resolutions and publishes only the latest clipboard identity', async () => {
    const state = createState();
    const addresses = [ADDRESS, SECOND_ADDRESS];
    const requests = [];
    const controller = createClipboardTokenController({
      state, isAuthenticated: () => true, notify() {}, readPermission: async () => 'granted',
      readClipboard: async () => addresses.shift(),
      request(address, token, signal) {
        return new Promise((resolve) => requests.push({ address, token, signal, resolve }));
      },
    });

    const first = controller.activate();
    await new Promise(setImmediate);
    const second = controller.activate();
    await new Promise(setImmediate);
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve(exactPayload(ADDRESS));
    requests[1].resolve(exactPayload(SECOND_ADDRESS));
    await Promise.all([first, second]);
    assert.equal(state.status, 'ready');
    assert.equal(state.hit.address, SECOND_ADDRESS);

    controller.reset();
    assert.deepEqual(state, createState());
  });
});

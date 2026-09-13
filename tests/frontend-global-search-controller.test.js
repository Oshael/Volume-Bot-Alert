const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, '..', 'frontend/src/state/global-search-controller.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const moduleRecord = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleRecord, exports: moduleRecord.exports, AbortController,
  require: (id) => id.endsWith('app-state')
    ? { createGlobalSearchState: () => ({ query: '', status: 'idle', hits: [], error: null }) }
    : { fetchGlobalSearch: async () => { throw new Error('Unexpected API call'); } },
}, { filename: file });
const { createGlobalSearchController } = moduleRecord.exports;
const createGlobalSearchState = () => ({ query: '', status: 'idle', hits: [], error: null });
const ADDRESS = `0x${'a'.repeat(40)}`;

describe('frontend global search request lifecycle', () => {
  it('debounces text, aborts stale ownership and applies only the latest response', async () => {
    const state = createGlobalSearchState();
    const timers = new Map();
    const requests = [];
    let timerId = 0;
    const controller = createGlobalSearchController({
      state, isAuthenticated: () => true, notify() {}, debounceMs: 250,
      schedule(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
      cancel(id) { timers.delete(id); },
      request(query, token, signal) {
        return new Promise((resolve) => requests.push({ query, token, signal, resolve }));
      },
    });

    controller.setQuery('h');
    assert.equal(state.status, 'idle');
    controller.setQuery('hood');
    assert.equal(state.status, 'debouncing');
    assert.equal([...timers.values()][0].delay, 250);
    const firstTimer = [...timers.entries()][0];
    timers.delete(firstTimer[0]);
    firstTimer[1].callback();
    await Promise.resolve();
    assert.equal(state.status, 'loading');

    controller.setQuery('hoodie');
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ status: 'ready', hits: [{ address: 'stale' }] });
    const secondTimer = [...timers.entries()][0];
    timers.delete(secondTimer[0]);
    secondTimer[1].callback();
    await Promise.resolve();
    requests[1].resolve({ status: 'ready', hits: [{ address: ADDRESS }] });
    await new Promise(setImmediate);
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.hits.map(({ address }) => address), [ADDRESS]);

    controller.reset();
    assert.equal(state.status, 'idle');
    assert.equal(state.query, '');
  });
});

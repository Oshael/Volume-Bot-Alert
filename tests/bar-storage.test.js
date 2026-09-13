const { afterEach, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

let loadCompactSparklineCache;
let saveCompactSparklineCache;

before(async () => {
  ({
    loadCompactSparklineCache,
    saveCompactSparklineCache,
  } = await import('../frontend/src/utils/bar-storage.ts'));
});

afterEach(() => {
  delete global.window;
});

function createLocalStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    values,
  };
}

describe('compact sparkline storage', () => {
  const scope = 'user:7';
  const address = '11111111111111111111111111111111';
  const identityKey = `solana:${address}`;
  const storageKey = `frontend_vite:${scope}:compact_sparklines`;

  it('loads and normalizes only the canonical identity cache', () => {
    const localStorage = createLocalStorage({
      [storageKey]: JSON.stringify({
        [identityKey]: { address, series: [1, 2, 3] },
        [address]: { address, series: [4, 5] },
      }),
    });
    global.window = { localStorage };

    const cache = loadCompactSparklineCache(scope);

    assert.deepEqual(cache[identityKey].series, [1, 2, 3]);
    assert.deepEqual(
      JSON.parse(localStorage.values.get(storageKey)),
      JSON.parse(JSON.stringify(cache)),
    );
  });

  it('persists only normalized canonical identity entries', () => {
    const localStorage = createLocalStorage();
    global.window = { localStorage };

    saveCompactSparklineCache(scope, {
      [identityKey]: { chain: 'solana', address, series: [4, 5] },
      [address]: { chain: 'solana', address, series: [6, 7] },
    });

    const stored = JSON.parse(localStorage.values.get(storageKey));
    assert.deepEqual(Object.keys(stored), [identityKey]);
    assert.deepEqual(stored[identityKey].series, [4, 5]);
  });
});

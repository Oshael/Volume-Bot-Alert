const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const tokenMeteoraState = require('../src/models/token-meteora-state');
const uiMeteoraSummaryCache = require('../src/services/ui-meteora-summary-cache');

describe('ui meteora summary cache', () => {
  const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
  const originalNow = Date.now;

  beforeEach(() => {
    uiMeteoraSummaryCache.clearUiMeteoraSummaryCache();
  });

  afterEach(() => {
    tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    Date.now = originalNow;
    uiMeteoraSummaryCache.clearUiMeteoraSummaryCache();
  });

  it('reuses cached rows for the same address set within the ttl', async () => {
    let currentNow = 1_000;
    let callCount = 0;
    Date.now = () => currentNow;
    tokenMeteoraState.listSummaryByAddresses = async (addresses) => {
      callCount += 1;
      return addresses.map((address) => ({ tokenAddress: address, currentTvl: 42 }));
    };

    const first = await uiMeteoraSummaryCache.listUiSummaryByAddresses([
      'So11111111111111111111111111111111111111112',
      '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
    ]);
    currentNow += 5_000;
    const second = await uiMeteoraSummaryCache.listUiSummaryByAddresses([
      '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
      'So11111111111111111111111111111111111111112',
    ]);

    assert.equal(callCount, 1);
    assert.equal(first, second);
  });

  it('coalesces concurrent requests for the same address set', async () => {
    let resolveRequest;
    let callCount = 0;
    tokenMeteoraState.listSummaryByAddresses = async (addresses) => {
      callCount += 1;
      await new Promise((resolve) => {
        resolveRequest = resolve;
      });
      return addresses.map((address) => ({ tokenAddress: address, currentTvl: 7 }));
    };

    const firstPromise = uiMeteoraSummaryCache.listUiSummaryByAddresses([
      'So11111111111111111111111111111111111111112',
    ]);
    const secondPromise = uiMeteoraSummaryCache.listUiSummaryByAddresses([
      'So11111111111111111111111111111111111111112',
    ]);
    resolveRequest();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(callCount, 1);
    assert.equal(first, second);
  });

  it('refreshes after the ttl expires', async () => {
    let currentNow = 2_000;
    let callCount = 0;
    Date.now = () => currentNow;
    tokenMeteoraState.listSummaryByAddresses = async (addresses) => {
      callCount += 1;
      return addresses.map((address) => ({ tokenAddress: address, currentTvl: callCount }));
    };

    const first = await uiMeteoraSummaryCache.listUiSummaryByAddresses([
      'So11111111111111111111111111111111111111112',
    ]);
    currentNow += 12_001;
    const second = await uiMeteoraSummaryCache.listUiSummaryByAddresses([
      'So11111111111111111111111111111111111111112',
    ]);

    assert.equal(callCount, 2);
    assert.notEqual(first, second);
    assert.equal(second[0].currentTvl, 2);
  });
});

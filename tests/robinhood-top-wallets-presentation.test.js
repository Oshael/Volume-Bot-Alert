const assert = require('node:assert/strict');
const { it } = require('node:test');

it('marks incomplete ranking coverage or an unknown list limit as partial', async () => {
  const { rankingIsPartial } = await import('../frontend/src/utils/robinhood-top-wallets.ts');
  assert.equal(rankingIsPartial({ coverage: 'complete', rankingIsComplete: true,
    rankingListTruncated: false }), false);
  assert.equal(rankingIsPartial({ coverage: 'partial', rankingIsComplete: false,
    rankingListTruncated: false }), true);
  assert.equal(rankingIsPartial({ coverage: 'complete', rankingIsComplete: true,
    rankingListTruncated: null }), true);
});

it('does not display invalid USD as a numeric gain', async () => {
  const { formatRankingGain } = await import('../frontend/src/utils/robinhood-top-wallets.ts');
  assert.equal(formatRankingGain('12.5'), '+$12.50');
  assert.equal(formatRankingGain('-3.5'), '−$3.50');
  assert.equal(formatRankingGain(''), 'Unavailable');
  assert.equal(formatRankingGain('not-a-number'), 'Unavailable');
});

it('validates ranking invalidations and coalesces versioned refreshes with a minimum interval', async () => {
  const { normalizeWalletRankingInvalidation, createWalletRankingRefreshGate } =
    await import('../frontend/src/utils/robinhood-ranking-refresh.ts');
  const event = (revisions) => ({
    type: 'wallet-ranking:invalidate', chain: 'robinhood', version: 1,
    revisions, publishedAt: '2026-09-29T12:00:00.000Z',
  });
  assert.equal(normalizeWalletRankingInvalidation(event({ positions: '0' })), null);
  assert.equal(normalizeWalletRankingInvalidation(event({ positions: '9'.repeat(100) })), null);
  assert.equal(normalizeWalletRankingInvalidation(event({ unknown: '1' })), null);
  assert.equal(normalizeWalletRankingInvalidation({ ...event({ prices: '1' }), chain: 'solana' }), null);
  assert.ok(normalizeWalletRankingInvalidation(event({ positions: '1' })));

  let time = 1000;
  let release;
  const timers = [];
  const calls = [];
  const gate = createWalletRankingRefreshGate(() => {
    calls.push(time);
    return new Promise((resolve) => { release = resolve; });
  }, {
    now: () => time,
    setTimer: (callback, delay) => {
      const timer = { callback, at: time + delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = async (ms) => {
    time += ms;
    for (const timer of [...timers]) {
      if (timer.at <= time) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
    }
    await Promise.resolve();
  };

  assert.equal(gate.accept(event({ positions: '1' })), true);
  assert.equal(gate.accept(event({ positions: '1' })), false);
  await advance(0);
  assert.deepEqual(calls, [1000]);
  assert.equal(gate.accept(event({ positions: '2' })), true);
  assert.equal(gate.accept(event({ positions: '1' })), false);
  assert.equal(gate.accept(event({ prices: '1' })), true);
  await advance(500);
  assert.deepEqual(calls, [1000]);
  release();
  await Promise.resolve();
  await Promise.resolve();
  await advance(0);
  assert.deepEqual(calls, [1000, 1500]);
  release();
  gate.recover();
  await advance(249);
  assert.deepEqual(calls, [1000, 1500]);
  await advance(1);
  assert.deepEqual(calls, [1000, 1500, 1750]);
  release();
  gate.clear();
});

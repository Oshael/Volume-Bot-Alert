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

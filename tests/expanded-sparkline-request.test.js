const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

describe('expanded sparkline request policy', () => {
  it('loads complete Robinhood aggregates only for 5m, 15m, and 30m', async () => {
    const {
      resolveExpandedSparklineRequestShape,
    } = await import('../frontend/src/state/expanded-sparkline-request.ts');
    const cases = [
      ['robinhood', 5, true, 10_000],
      ['robinhood', 15, true, 10_000],
      ['robinhood', 30, true, 10_000],
      ['robinhood', 1, false, 720],
      ['robinhood', 60, false, 720],
      ['solana', 5, false, 720],
    ];

    for (const [chain, granularityMinutes, allAvailable, points] of cases) {
      assert.deepEqual(resolveExpandedSparklineRequestShape(chain, granularityMinutes), {
        allAvailable,
        points,
      });
    }
  });
});

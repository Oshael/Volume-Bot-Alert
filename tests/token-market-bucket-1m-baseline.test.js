const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const dashboardRouter = require('../src/routes/dashboard');

const { selectPreferredMarketBaseline } = dashboardRouter.__private;

describe('token market 1m baseline selection', () => {
  it('prefers bucket data when a 5m baseline exists', () => {
    const primaryRow = { token_address: 'a', baseline_mcap: 123 };
    const fallbackRow = { token_address: 'a', baseline_mcap: 999 };
    assert.deepEqual(selectPreferredMarketBaseline(primaryRow, fallbackRow), primaryRow);
  });

  it('falls back to raw snapshots when the bucket baseline is missing', () => {
    const primaryRow = { token_address: 'a', baseline_mcap: null };
    const fallbackRow = { token_address: 'a', baseline_mcap: 999 };
    assert.deepEqual(selectPreferredMarketBaseline(primaryRow, fallbackRow), fallbackRow);
  });
});

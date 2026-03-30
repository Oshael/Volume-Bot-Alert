const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const dashboardRouter = require('../src/routes/dashboard');

const {
  buildMarketBaseline,
} = dashboardRouter.__private;

describe('token market 1m baseline selection', () => {
  it('builds the response baseline from separate MCAP and volume sources', () => {
    const mcapRow = {
      current_mcap: 150,
      baseline_mcap: 100,
    };
    const volumeRow = {
      baseline_vol_5m: 80,
    };

    assert.deepEqual(buildMarketBaseline(mcapRow, volumeRow), {
      prevMcap: 100,
      mcapDelta: 50,
      prevVolume5mCanonical: 80,
    });
  });
});

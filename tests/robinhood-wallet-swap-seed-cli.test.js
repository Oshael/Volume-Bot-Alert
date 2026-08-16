const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  __private: { assertSchema },
} = require('../src/utils/robinhood-wallet-swap-seed');

function database(transactionPositions) {
  return {
    query: async () => ({ rows: [{
      swaps: 'robinhood_wallet_swaps',
      cursors: 'robinhood_wallet_swap_cursors',
      attribution_index: 'idx_robinhood_market_observations_attribution',
      transaction_positions: transactionPositions,
    }] }),
  };
}

describe('Robinhood wallet-swap seed CLI preflight', () => {
  it('requires Stage 139 before forward position capture starts', async () => {
    await assert.rejects(
      assertSchema(database(null)),
      /robinhood_transaction_positions \(run db-init-stage139\.js\)/
    );
    await assert.doesNotReject(assertSchema(database('robinhood_transaction_positions')));
  });
});

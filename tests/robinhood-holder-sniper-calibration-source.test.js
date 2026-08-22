const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createRobinhoodHolderSniperCalibrationSource,
} = require('../src/models/robinhood-holder-sniper-calibration-source');

const WALLET = `0x${'1'.repeat(40)}`;
const TOKEN = `0x${'2'.repeat(40)}`;

test('reads population recurrence for candidate wallets without writing', async () => {
  const calls = [];
  const source = createRobinhoodHolderSniperCalibrationSource({
    database: { query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{
        wallet_address: WALLET, token_address: TOKEN, volume_usd: '25.5',
        delta_blocks: '1', position_ready: true,
      }] };
    } },
  });

  assert.deepEqual(await source.loadPopulationRecurrence([WALLET, WALLET], {
    historicalFromBlock: '90', completeThroughBlock: '250',
  }), [{
    walletAddress: WALLET, tokenAddress: TOKEN, volumeUsd: '25.5',
    deltaBlocks: '1', positionReady: true,
  }]);
  assert.deepEqual(calls[0].params, [[WALLET], 'robinhood', '90', '250']);
  assert.match(calls[0].sql, /candidate_wallets AS MATERIALIZED/);
  assert.match(calls[0].sql, /launch\.launch_block \+ 1/);
  assert.match(calls[0].sql, /robinhood_infrastructure_registry/);
  assert.equal(await source.loadPopulationRecurrence([], {
    historicalFromBlock: 'invalid', completeThroughBlock: 'invalid',
  }).then((rows) => rows.length), 0);
  assert.equal(calls.length, 1);
});

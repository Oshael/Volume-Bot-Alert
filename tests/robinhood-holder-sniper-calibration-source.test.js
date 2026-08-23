const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createRobinhoodHolderSniperCalibrationSource,
} = require('../src/models/robinhood-holder-sniper-calibration-source');

const WALLET = `0x${'1'.repeat(40)}`;
const WALLET_B = `0x${'3'.repeat(40)}`;
const TOKEN = `0x${'2'.repeat(40)}`;
const TOKEN_B = `0x${'4'.repeat(40)}`;

test('reads population recurrence and reuses proven launch anchors', async () => {
  const calls = [];
  const anchorCache = new Map();
  let rawAnchorQueries = 0;
  const source = createRobinhoodHolderSniperCalibrationSource({
    database: { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM robinhood_wallet_token_first_buys')) return { rows: [{
        wallet_address: params[0],
        token_address: params[0] === WALLET ? TOKEN : TOKEN_B,
        volume_usd: '25.5',
        first_buy_block: '101', first_pool_block: '90', live_through_block: '250',
        position_ready: true, buyer_rank: 2,
      }] };
      if (sql.includes('WITH requested_anchors AS')) return { rows: params[0]
        .filter((tokenAddress) => anchorCache.has(tokenAddress))
        .map((token_address) => ({
          token_address, launch_block: anchorCache.get(token_address),
        })) };
      if (sql.includes('INSERT INTO robinhood_token_launch_anchors')) {
        params[1].forEach((tokenAddress, index) => {
          anchorCache.set(tokenAddress, params[3][index]);
        });
        return { rows: [] };
      }
      rawAnchorQueries += 1;
      return { rows: params[0].map((token_address) => ({
        token_address, launch_block: '100',
      })) };
    } },
  });

  assert.deepEqual(await source.loadPopulationRecurrence([WALLET_B, WALLET, WALLET], {
    historicalFromBlock: '90', completeThroughBlock: '250',
  }), [WALLET, WALLET_B].map((walletAddress, index) => ({
    walletAddress, tokenAddress: index ? TOKEN_B : TOKEN, volumeUsd: '25.5',
    deltaBlocks: '1', anchorReady: true, withinOneBlock: true, buyerRank: 2,
    positionReady: true,
  })));
  assert.deepEqual(calls[0].params, [WALLET, 'robinhood', '90', '250']);
  assert.deepEqual(calls[1].params, [WALLET_B, 'robinhood', '90', '250']);
  assert.match(calls[0].sql, /WITH wallet_buys AS MATERIALIZED/);
  assert.match(calls[0].sql, /wallet_address = \$1/);
  assert.match(calls[0].sql, /INNER JOIN LATERAL/);
  assert.match(calls[0].sql, /ORDER BY registry\.discovery_block\s+LIMIT 1/);
  assert.doesNotMatch(calls[0].sql, /pool_origins/);
  assert.match(calls[0].sql, /LIMIT 5/);
  assert.doesNotMatch(calls[0].sql, /candidate_buy_blocks/);
  assert.match(calls[0].sql, /robinhood_infrastructure_registry/);
  assert.deepEqual(calls[2].params, [
    [TOKEN, TOKEN_B], ['90', '90'], ['250', '250'], 'robinhood',
  ]);
  assert.deepEqual(calls[3].params, [
    [TOKEN, TOKEN_B], ['90', '90'], ['250', '250'], 'robinhood',
  ]);
  assert.match(calls[3].sql, /LEFT JOIN LATERAL/);
  assert.match(calls[3].sql, /ORDER BY swap\.block_time/);
  assert.equal(anchorCache.size, 2);
  assert.equal(rawAnchorQueries, 1);

  await source.loadPopulationRecurrence([WALLET_B, WALLET], {
    historicalFromBlock: '90', completeThroughBlock: '250',
  });
  assert.equal(rawAnchorQueries, 1);
  assert.equal(await source.loadPopulationRecurrence([], {
    historicalFromBlock: 'invalid', completeThroughBlock: 'invalid',
  }).then((rows) => rows.length), 0);
  assert.equal(calls.length, 8);
});

test('fails closed until the canonical first-buy projection is caught up', async () => {
  const now = new Date('2026-08-22T01:00:00Z');
  const source = createRobinhoodHolderSniperCalibrationSource({
    database: { query: async () => ({ rows: [{
      next_time: now, source_through: now, source_next_block: '251',
    }] }) },
  });
  const result = await source.loadHighConfidenceRecurrence([], {
    historicalFromBlock: '90', completeThroughBlock: '250',
  });
  assert.deepEqual(result, {
    ready: true, completeThroughBlock: '250', rows: [],
  });

  const behind = createRobinhoodHolderSniperCalibrationSource({
    database: { query: async () => ({ rows: [{
      next_time: new Date('2026-08-22T00:59:59Z'), source_through: now,
      source_next_block: '251',
    }] }) },
  });
  assert.deepEqual(await behind.loadHighConfidenceRecurrence([WALLET], {
    historicalFromBlock: '90', completeThroughBlock: '250',
  }), { ready: false, reason: 'first_buy_projection_behind' });
});

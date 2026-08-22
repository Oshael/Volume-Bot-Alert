process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  parseArgs, runCalibration,
} = require('../src/utils/calibrate-robinhood-holder-snipers');
const stage63 = require('../src/utils/db-init-stage63');
const stage116 = require('../src/utils/db-init-stage116');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKENS = Array.from({ length: 5 }, (_, index) => (
  `0x${String(index + 1).repeat(40)}`
));
const QUOTE = `0x${'a'.repeat(40)}`;
const HASH = `0x${'b'.repeat(64)}`;
const TX = `0x${'c'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_pool_registry WHERE token_address = ANY($1)', [TOKENS]);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = ANY($1)', [TOKENS]);
}

async function insertPool(tokenAddress, suffix, block) {
  await db.query(
    `INSERT INTO robinhood_pool_registry (
       protocol, market_key, pool_address, token_address, quote_address,
       currency0, currency1, discovery_block, discovery_block_hash,
       discovery_tx_hash, discovery_log_index, discovered_at
     ) VALUES ('uniswap-v2', $1, $2, $3, $4, $3, $4, $5, $6, $7, 0, NOW())`,
    [`sniper-calibration-${suffix}`, `0x${suffix.repeat(40)}`, tokenAddress, QUOTE, block, HASH, TX]
  );
}

describe('Robinhood SNIPER calibration eligibility integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage116.init({ closePool: false });
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_holder_token_states (
         token_address, ledger_status, live_through_block, live_through_hash
       ) SELECT token_address, 'live', frontier, $2
           FROM UNNEST($1::varchar[], ARRAY[200,200,200,200,260]::bigint[])
             AS item(token_address, frontier)`,
      [TOKENS, HASH]
    );
    await insertPool(TOKENS[0], '6', 100);
    await insertPool(TOKENS[1], '7', 50);
    await insertPool(TOKENS[3], '8', 210);
    await insertPool(TOKENS[4], '9', 100);
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('uses first pool creation and both frontiers to count truly eligible tokens', async () => {
    const selected = [];
    const report = await runCalibration({
      database: db,
      coverageSource: { loadBackfillFrontier: async () => ({
        ready: true, historicalFromBlock: '90', completeThroughBlock: '250',
      }) },
      source: { loadLaunchEvidence: async (tokenAddress) => {
        selected.push(tokenAddress);
        return { ready: true, firstBuys: [], exclusions: [] };
      } },
    }, parseArgs(['--limit=25', '--seed=integration']));

    assert.deepEqual(report.population, {
      liveTokens: 5, eligibleTokens: 1, firstPoolBeforeCoverage: 1,
      firstPoolAheadOfHolderFrontier: 1, holderFrontierBeyondCoverage: 1,
      firstPoolUnavailable: 1,
    });
    assert.deepEqual(selected, [TOKENS[0]]);
    assert.equal(report.tokens.ready, 1);
  });
});

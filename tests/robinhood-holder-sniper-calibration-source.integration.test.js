process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderSniperCalibrationSource,
} = require('../src/models/robinhood-holder-sniper-calibration-source');
const stage63 = require('../src/utils/db-init-stage63');
const stage90 = require('../src/utils/db-init-stage90');
const stage110 = require('../src/utils/db-init-stage110');
const stage116 = require('../src/utils/db-init-stage116');
const stage139 = require('../src/utils/db-init-stage139');
const stage145 = require('../src/utils/db-init-stage145');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const WALLET = `0x${'d'.repeat(40)}`;

describe('Robinhood SNIPER population calibration source integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage63, stage90, stage110, stage116, stage139, stage145]) {
      await stage.init({ closePool: false });
    }
  });

  after(async () => {
    await db.pool.end();
  });

  it('executes the read-only population recurrence query against PostgreSQL', async () => {
    const source = createRobinhoodHolderSniperCalibrationSource({ database: db });
    const rows = await source.loadPopulationRecurrence([WALLET], {
      historicalFromBlock: '48954', completeThroughBlock: '48954',
    });

    assert.deepEqual(rows, []);
  });
});

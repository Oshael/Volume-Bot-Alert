process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderSniperCalibrationSource, __private,
} = require('../src/models/robinhood-holder-sniper-calibration-source');
const stage63 = require('../src/utils/db-init-stage63');
const stage90 = require('../src/utils/db-init-stage90');
const stage110 = require('../src/utils/db-init-stage110');
const stage116 = require('../src/utils/db-init-stage116');
const stage139 = require('../src/utils/db-init-stage139');
const stage145 = require('../src/utils/db-init-stage145');
const stage149 = require('../src/utils/db-init-stage149');
const stage155 = require('../src/utils/db-init-stage155');
const stage156 = require('../src/utils/db-init-stage156');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const WALLET = `0x${'d'.repeat(40)}`;
const TOKEN = `0x${'e'.repeat(40)}`;

describe('Robinhood SNIPER population calibration source integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [
      stage63, stage90, stage110, stage116, stage139, stage145, stage149, stage155,
      stage156,
    ]) {
      await stage.init({ closePool: false });
    }
    await db.query('DELETE FROM robinhood_token_launch_anchors');
  });

  after(async () => {
    await db.query('DELETE FROM robinhood_token_launch_anchors');
    await db.pool.end();
  });

  it('executes the read-only population recurrence query against PostgreSQL', async () => {
    const source = createRobinhoodHolderSniperCalibrationSource({ database: db });
    const rows = await source.loadPopulationRecurrence([WALLET], {
      historicalFromBlock: '48954', completeThroughBlock: '48954',
    });

    assert.deepEqual(rows, []);
    assert.deepEqual((await db.query(__private.ANCHORS_SQL, [
      [], [], [], 'robinhood',
    ])).rows, []);
    assert.deepEqual((await db.query(__private.CACHED_ANCHORS_SQL, [
      [], [], [], 'robinhood',
    ])).rows, []);
  });

  it('persists and reads a proven launch anchor by token and pool frontier', async () => {
    await db.query(__private.UPSERT_ANCHORS_SQL, [
      'robinhood', [TOKEN], ['90'], ['100'], ['250'], 'rh_launch_anchor_v1',
    ]);
    assert.deepEqual((await db.query(__private.CACHED_ANCHORS_SQL, [
      [TOKEN], ['90'], ['250'], 'robinhood',
    ])).rows, [{ token_address: TOKEN, launch_block: '100' }]);
    assert.deepEqual((await db.query(__private.CACHED_ANCHORS_SQL, [
      [TOKEN], ['91'], ['250'], 'robinhood',
    ])).rows, []);
  });
});

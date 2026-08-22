process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodSniperShadowCandidateRepository,
} = require('../src/models/robinhood-sniper-shadow-candidate');
const stage63 = require('../src/utils/db-init-stage63');
const stage90 = require('../src/utils/db-init-stage90');
const stage110 = require('../src/utils/db-init-stage110');
const stage116 = require('../src/utils/db-init-stage116');
const stage139 = require('../src/utils/db-init-stage139');
const stage143 = require('../src/utils/db-init-stage143');
const stage145 = require('../src/utils/db-init-stage145');
const stage149 = require('../src/utils/db-init-stage149');
const stage151 = require('../src/utils/db-init-stage151');
const stage152 = require('../src/utils/db-init-stage152');
const { assertUsingTestDatabase } = require('./helpers/test-db');

describe('Robinhood SNIPER shadow candidate integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [
      stage63, stage90, stage110, stage116, stage139,
      stage143, stage145, stage149, stage151, stage152,
    ]) await stage.init({ closePool: false });
  });

  after(async () => db.pool.end());

  it('executes the cursor-gated candidate query against PostgreSQL', async () => {
    const repository = createRobinhoodSniperShadowCandidateRepository({ database: db });
    assert.deepEqual(await repository.listCandidates({ limit: 1 }), []);
  });
});

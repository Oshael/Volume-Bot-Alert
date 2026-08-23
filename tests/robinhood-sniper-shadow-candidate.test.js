const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createRobinhoodSniperShadowCandidateRepository,
} = require('../src/models/robinhood-sniper-shadow-candidate');

test('requeues positive snapshots produced by an older SNIPER policy', async () => {
  let captured;
  const repository = createRobinhoodSniperShadowCandidateRepository({
    database: { query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    } },
  });
  await repository.listCandidates({ limit: 10 });

  assert.match(captured.sql, /FROM robinhood_holder_classifications legacy/);
  assert.match(captured.sql, /evidenceVersion/);
  assert.equal(captured.params[4], 'rh_sniper_high_v2');
});

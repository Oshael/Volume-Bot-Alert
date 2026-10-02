process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const adminBlockedToken = require('../src/models/admin-blocked-token');
const monitoredTokenExitEvent = require('../src/models/monitored-token-exit-event');
const tokenCatalog = require('../src/models/token-catalog');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const ADDRESS = 'So11111111111111111111111111111111111111112';
const ROBINHOOD_ONLY = `0x${'a'.repeat(40)}`;
const EVALUATION = {
  evaluationSource: 'gmgn', eligibilityState: 'gmgn-high',
  eligibleForMonitoring: true, monitorPriority: 'high', mcap: 300000,
  vol1h: 0, vol6h: 0, vol24h: 0,
};

after(() => db.pool.end());

async function withEvaluationFixture(t, run) {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE token_catalog
      (LIKE public.token_catalog INCLUDING DEFAULTS) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE admin_blocked_tokens
      (chain text, address text, PRIMARY KEY (chain, address)) ON COMMIT DROP`);
    // Repeated addresses exercise composite identity independently of upstream validation.
    await client.query(`INSERT INTO token_catalog (
      id, chain, address, source, eligible_for_monitoring, monitor_priority,
      last_mcap, last_vol_1h, last_vol_6h, last_vol_24h
    ) VALUES
      (1, 'robinhood', $1, 'robinhood-onchain', true, 'high', 900000, 900, 900, 900),
      (2, 'solana', $1, 'gmgn', true, 'high', 300000, 100, 200, 300),
      (3, 'robinhood', $2, 'robinhood-onchain', true, 'high', 900000, 900, 900, 900)`,
    [ADDRESS, ROBINHOOD_ONLY]);
    t.mock.method(db, 'query', client.query.bind(client));
    t.mock.method(adminBlockedToken, 'ensureTable', async () => {});
    t.mock.method(monitoredTokenExitEvent, 'recordIfExited', async () => null);
    const { rows: before } = await client.query(
      "SELECT * FROM token_catalog WHERE chain = 'robinhood' ORDER BY id"
    );
    await run(client);
    const { rows: afterRows } = await client.query(
      "SELECT * FROM token_catalog WHERE chain = 'robinhood' ORDER BY id"
    );
    assert.deepEqual(afterRows, before, 'legacy evaluation must preserve Robinhood rows');
  } finally {
    t.mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
  }
}

for (const snapshot of ['worker', 'lookup', 'volume-fallback']) {
  it(`evaluates only Solana and preserves GMGN volumes with ${snapshot}`, async (t) => {
    await withEvaluationFixture(t, async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM token_catalog WHERE chain = 'solana' AND address = $1", [ADDRESS]
      );
      const options = snapshot === 'lookup' ? {} : {
        previousMonitoringRow: snapshot === 'worker' ? rows[0] : null,
      };
      const updated = await tokenCatalog.applyEvaluationResult(ADDRESS, EVALUATION, options);
      assert.equal(updated.chain, 'solana');
      assert.equal(updated.eligibility_state, 'gmgn-high');
      assert.equal(updated.eligible_for_monitoring, true);
      assert.deepEqual(
        [updated.last_vol_1h, updated.last_vol_6h, updated.last_vol_24h].map(Number),
        [100, 200, 300]
      );
    });
  });
}

for (const blockChain of ['solana', 'robinhood']) {
  it(`honors only Solana admin blocks when the block belongs to ${blockChain}`, async (t) => {
    await withEvaluationFixture(t, async (client) => {
      await client.query('INSERT INTO admin_blocked_tokens VALUES ($1, $2)',
        [blockChain, ADDRESS]);
      const updated = await tokenCatalog.applyEvaluationResult(ADDRESS, EVALUATION);
      assert.equal(updated.chain, 'solana');
      assert.equal(updated.eligible_for_monitoring, blockChain !== 'solana');
      if (blockChain === 'solana') {
        assert.equal(updated.source, 'admin-blocked');
        assert.equal(updated.suppressed_reason, 'admin_blocked');
        assert.equal(updated.is_active_monitor_candidate, false);
        assert.ok(updated.next_evaluation_at.getTime() > Date.now() + 9 * 365 * 86400000);
      } else {
        assert.equal(updated.source, 'gmgn');
        assert.equal(updated.eligibility_state, 'gmgn-high');
      }
    });
  });
}

it('returns null when legacy evaluation has no Solana row', async (t) => {
  await withEvaluationFixture(t, async () => {
    assert.equal(await tokenCatalog.applyEvaluationResult(ROBINHOOD_ONLY, EVALUATION), null);
  });
});

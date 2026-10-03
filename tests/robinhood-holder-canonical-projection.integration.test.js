'use strict';

process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createRobinhoodHolderIntelligenceCandidateRepository } = require('../src/models/robinhood-holder-intelligence-candidate');
const { createRobinhoodHolderClassificationRepository } = require('../src/models/robinhood-holder-classification');
const { createRobinhoodHolderDistributionMetricRepository } = require('../src/models/robinhood-holder-distribution-metric');
const { lockRobinhoodCanonicalProjection } = require('../src/models/robinhood-canonical-projection-fence');
const { main, CONFIRM_FLAG } = require('../src/utils/repair-robinhood-holder-frontier-anchors');
const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const FORK = `0x${'b'.repeat(64)}`;
const HEAD = `0x${'c'.repeat(64)}`;
const TIME = '2026-10-01T00:00:00.000Z';
const fenceConflict = (error) => error.code === 'canonical_projection_fence_conflict';
before(() => assertUsingTestDatabase(db));
after(() => db.pool.end());

async function fixture(action) {
  const client = await db.getClient(); let savepoint = 0;
  const database = { getClient: async () => {
    let active;
    return { release() {}, async query(sql, params) {
      if (sql.startsWith('BEGIN')) {
        active = `projection_${savepoint += 1}`;
        return client.query(`SAVEPOINT ${active}`);
      }
      if (sql === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${active}`);
      if (sql === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${active}`);
      return client.query(sql, params);
    } };
  } };
  try {
    await client.query('BEGIN');
    for (const table of ['robinhood_holder_token_states', 'robinhood_holder_legacy_coverage_manifest',
      'robinhood_holder_classification_states', 'robinhood_holder_classifications',
      'robinhood_holder_distribution_metrics', 'robinhood_chain_blocks',
      'robinhood_chain_block_anchors', 'robinhood_chain_capture_cursor', 'robinhood_chain_recoveries']) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await client.query(`INSERT INTO robinhood_chain_capture_cursor
      (chain,next_block,checkpoint_block,checkpoint_hash) VALUES ('robinhood',101,100,$1)`, [HEAD]);
    await client.query(`INSERT INTO robinhood_holder_token_states
      (token_address,ledger_status,coverage_generation,deployment_block,backfill_next_block,
        live_through_block,live_through_hash,holder_count)
      VALUES ($1,'live',1,0,51,50,$2,2)`, [TOKEN, HASH]);
    await client.query(`INSERT INTO robinhood_holder_legacy_coverage_manifest
      (chain,token_address,coverage_generation,baseline_status,baseline_deployment_block,
        baseline_backfill_next_block,baseline_live_through_block,baseline_live_through_hash,baseline_holder_count)
      VALUES ('robinhood',$1,1,'live',0,51,50,$2,2)`, [TOKEN, HASH]);
    const raw = (number, hash, canonical = true) => client.query(`INSERT INTO robinhood_chain_blocks
      (chain,block_number,block_hash,parent_hash,capture_digest,block_timestamp,
        canonical,head_observed_at,receipts_available_at)
      VALUES ('robinhood',$1,$2,$2,$2,$3,$4,$3,$3)`, [number, hash, TIME, canonical]);
    const anchor = (number = 50, hash = HASH) => client.query(`INSERT INTO robinhood_chain_block_anchors
      (chain,block_number,block_hash,block_timestamp,created_at)
      VALUES ('robinhood',$1,$2,$3,$3)`, [number, hash, TIME]);
    await raw(100, HEAD);
    const classes = createRobinhoodHolderClassificationRepository({ database });
    const metrics = createRobinhoodHolderDistributionMetricRepository({ database });
    const candidates = createRobinhoodHolderIntelligenceCandidateRepository({ database: client });
    const classification = (overrides = {}) => classes.replaceClassifierSnapshot({
      tokenAddress: TOKEN, classifier: 'lp', status: 'ready', statusReason: 'materialized',
      throughBlockNumber: '50', throughBlockHash: HASH, observedAt: TIME, records: [], ...overrides,
    });
    const metric = (overrides = {}) => metrics.replaceMetricSnapshot({
      tokenAddress: TOKEN, metric: 'top10', status: 'ready', statusReason: 'materialized',
      throughBlockNumber: '50', throughBlockHash: HASH, observedAt: TIME,
      valueNumeratorRaw: '25', valueDenominatorRaw: '100', walletCount: '1',
      evidence: { source: 'holder_ledger' }, ...overrides,
    });
    await action({ client, database, raw, anchor, candidates, classification, metric });
  } finally { await client.query('ROLLBACK'); client.release(); }
}

it('selects and publishes ledger intelligence from verified historical proof and preserves future proofs', async () => {
  await fixture(async ({ client, raw, anchor, candidates, classification, metric }) => {
    await assert.rejects(classification(), fenceConflict);
    await assert.rejects(metric(), fenceConflict);
    await anchor();
    assert.deepEqual(await candidates.listCandidates(), [TOKEN]);
    assert.equal((await classification()).status, 'published');
    assert.equal((await classification({ classifier: 'cex' })).status, 'published');
    assert.equal((await metric()).status, 'published');
    assert.equal((await metric({ metric: 'dev_hold' })).status, 'published');
    assert.equal((await metric({ metric: 'top50' })).status, 'published');
    await assert.rejects(lockRobinhoodCanonicalProjection(client, {
      blockNumber: '50', blockHash: HASH,
    }), fenceConflict, 'other domains retain the raw canonical contract');
    await assert.rejects(classification({ classifier: 'sniper' }), fenceConflict);
    await assert.rejects(metric({ metric: 'lp_locked' }), fenceConflict);
    await client.query(`UPDATE robinhood_holder_token_states SET
      live_through_block=60,live_through_hash=$1 WHERE token_address=$2`, [FORK, TOKEN]);
    await raw(60, FORK);
    assert.equal((await classification({ throughBlockNumber: '60', throughBlockHash: FORK })).status, 'published');
    await client.query('DELETE FROM robinhood_chain_blocks WHERE block_number=60');
    assert.equal((await metric({ throughBlockNumber: '60', throughBlockHash: FORK })).status, 'published');
    assert.equal((await client.query(`SELECT holder_count::text FROM robinhood_holder_token_states
      WHERE token_address=$1`, [TOKEN])).rows[0].holder_count, '2');
  });
});

for (const name of ['ambiguous', 'orphaned', 'canonical mismatch', 'manifest stale',
  'tracked tail', 'recovery', 'different frontier', 'missing capture cursor']) {
  it(`rejects ${name} proof in both selection and persistence`, async () => {
    await fixture(async ({ client, raw, anchor, candidates, classification, metric }) => {
      await anchor();
      if (name === 'ambiguous') await anchor(50, FORK);
      if (name === 'orphaned') await raw(50, HASH, false);
      if (name === 'canonical mismatch') await raw(50, FORK);
      if (name === 'manifest stale') await client.query(`UPDATE robinhood_holder_legacy_coverage_manifest
        SET coverage_generation=0`);
      if (name === 'tracked tail') await client.query('UPDATE robinhood_holder_token_states SET tail_capture_from_block=20');
      if (name === 'different frontier') await client.query('UPDATE robinhood_holder_token_states SET live_through_block=51');
      if (name === 'missing capture cursor') await client.query('DELETE FROM robinhood_chain_capture_cursor');
      if (name === 'recovery') await client.query(`UPDATE robinhood_chain_capture_cursor SET
        recovery_state='recovery_required',recovery_plan='{}',recovery_detected_at=NOW()`);
      assert.deepEqual(await candidates.listCandidates(), []);
      await assert.rejects(classification(), fenceConflict);
      await assert.rejects(metric(), fenceConflict);
      assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_holder_classification_states')).rows[0].n, 0);
      assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_holder_distribution_metrics')).rows[0].n, 0);
    });
  });
}

it('preserves frontierless unavailable publication and commits no proof if the snapshot fails', async () => {
  await fixture(async ({ client, raw, classification, metric }) => {
    assert.equal((await metric({ metric: 'dev_hold', status: 'unavailable',
      statusReason: 'source_unavailable', throughBlockNumber: null, throughBlockHash: null,
      valueNumeratorRaw: null, valueDenominatorRaw: null, walletCount: null,
    })).status, 'published');
    await raw(50, HASH);
    // Conflict at the snapshot layer occurs after the projection has preserved the raw header.
    await client.query(`INSERT INTO robinhood_holder_classification_states
      (chain,token_address,classifier,classification_version,status,status_reason,
        through_block_number,through_block_hash,observed_at)
      VALUES ('robinhood',$1,'lp','rh_holder_v1','ready','materialized',50,$2,$3)`, [TOKEN, FORK, TIME]);
    await assert.rejects(classification(), /fork/);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM robinhood_chain_block_anchors')).rows[0].n, 0);
  });
});

it('requires fresh verification after a known fork affecting a durable proof', async () => {
  await fixture(async ({ client, database, anchor, candidates, classification }) => {
    await anchor();
    await client.query('UPDATE robinhood_chain_capture_cursor SET generation=2');
    for (let generation = 0; generation < 2; generation += 1) {
      await client.query(`INSERT INTO robinhood_chain_recoveries
        (chain,generation,status,plan,detected_at,completed_at)
        VALUES ('robinhood',$1,'complete',$2,'2026-10-02T00:00:00Z','2026-10-02T00:01:00Z')`,
      [generation, { generation: String(generation), affectedRange: { fromBlock: '40' } }]);
    }
    assert.deepEqual(await candidates.listCandidates(), []);
    await assert.rejects(classification(), fenceConflict);
    const report = await main(['--apply', CONFIRM_FLAG], { database, logger: { log() {} },
      resolveBlock: async (number, hash) => ({ blockNumber: number, blockHash: hash, blockTime: TIME }),
    });
    assert.equal(report.outcomes[0].status, 'already_present');
    assert.deepEqual(await candidates.listCandidates(), [TOKEN]);
    assert.equal((await classification()).status, 'published');
    await client.query('UPDATE robinhood_chain_block_anchors SET created_at=$1', [TIME]);
    await client.query(`UPDATE robinhood_chain_recoveries
      SET plan=jsonb_set(plan,'{affectedRange,fromBlock}','"60"')`);
    assert.deepEqual(await candidates.listCandidates(), [TOKEN], 'an unaffected older proof survives a later fork');
  });
});

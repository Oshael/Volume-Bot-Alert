'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { coverageFloor, decide } = require('../src/services/robinhood-chain-transaction-partition-retention');

after(() => db.pool.end());

const base = () => ({
  safety: { chain_events: { ready_for_pilot: true, candidate_cutoff_block: '250000' } },
  cursor: { finalized_head: '500100', recovery_state: 'running',
    observed_at: '2026-09-27T21:00:00Z' },
  parts: [{ start: 0, end: 250000, name: 'public.robinhood_chain_transactions_shadow_b0',
    event: 'public.robinhood_chain_events_shadow_b0', bytes: '100' }],
  remainingFloor: 250000,
  firstRemainingTime: '2026-09-24T20:59:00Z',
  candidateRecent: false, pendingBundle: false, pinnedDeployment: false,
  pendingRedistribution: false, oldestUnappliedBlock: '500050',
  eventFks: [{ name: 'rh_chain_events_transaction_shadow_fkey', validated: true,
    references_parent: true }],
});

it('keeps a continuous full 72-hour window after removing the oldest partition', () => {
  const parts = [0, 250000, 500000].map((start) => ({ start }));
  assert.equal(coverageFloor(parts, 500100, 0), 250000);
  assert.equal(coverageFloor([parts[0], parts[2]], 500100, 0), 500000);
  assert.equal(coverageFloor(parts.slice(0, 2), 500100, 0), null);
  assert.equal(decide(base()).ready, true);
  assert.equal(decide({ ...base(), firstRemainingTime: '2026-09-24T21:00:01Z' })
    .blockers.includes('less_than_72h_remaining'), true);
});

it('blocks unfinished consumers, recent raw, and unexpected foreign keys', () => {
  const variants = [
    [{ candidateRecent: true }, 'transaction_partition_within_72h'],
    [{ oldestUnappliedBlock: '100' }, 'unapplied_holder_event_in_partition'],
    [{ oldestUnappliedBlock: 'invalid' }, 'invalid_holder_pending_block'],
    [{ pendingBundle: true }, 'pending_bundle_funding_in_partition'],
    [{ pinnedDeployment: true }, 'deployment_mint_in_partition'],
    [{ pendingRedistribution: true }, 'redistribution_in_partition'],
    [{ eventFks: [{ name: 'unexpected', validated: true, references_parent: true }] },
      'unexpected_event_fk'],
    [{ cursor: { ...base().cursor, finalized_head: null } },
      'capture_not_running'],
    [{ safety: { ...base().safety, chain_events: {
      ready_for_pilot: true, candidate_cutoff_block: null } } },
    'consumer_frontier_before_partition_end'],
    [{ safety: { ...base().safety, chain_events: {
      ready_for_pilot: false, candidate_cutoff_block: '250000' } } },
    'consumer_safety_blocked'],
  ];
  for (const [change, blocker] of variants) {
    assert.ok(decide({ ...base(), ...change }).blockers.includes(blocker), blocker);
  }
});

it('drops only the expired transaction leaf and its event FK in one transaction', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE rh_tx_retention_probe (
      chain text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
      transaction_hash text NOT NULL,
      PRIMARY KEY (chain, block_number, block_hash, transaction_hash)
    ) PARTITION BY RANGE (block_number)`);
    await client.query(`CREATE TABLE rh_tx_retention_probe_old
      PARTITION OF rh_tx_retention_probe FOR VALUES FROM (0) TO (250000)`);
    await client.query(`CREATE TABLE rh_tx_retention_probe_new
      PARTITION OF rh_tx_retention_probe FOR VALUES FROM (250000) TO (500000)`);
    await client.query(`CREATE TABLE rh_event_retention_probe (
      chain text NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
      transaction_hash text NOT NULL
    ) PARTITION BY RANGE (block_number)`);
    await client.query(`CREATE TABLE rh_event_retention_probe_old
      PARTITION OF rh_event_retention_probe FOR VALUES FROM (0) TO (250000)`);
    await client.query(`ALTER TABLE rh_event_retention_probe_old ADD CONSTRAINT rh_probe_fk
      FOREIGN KEY (chain, block_number, block_hash, transaction_hash)
      REFERENCES rh_tx_retention_probe(chain, block_number, block_hash, transaction_hash)
      ON DELETE CASCADE`);
    await client.query(`INSERT INTO rh_tx_retention_probe VALUES
      ('robinhood',100,'old','old'), ('robinhood',250100,'new','new')`);
    await client.query(`INSERT INTO rh_event_retention_probe VALUES
      ('robinhood',100,'old','old')`);

    await client.query('ALTER TABLE rh_event_retention_probe_old DROP CONSTRAINT rh_probe_fk');
    await client.query('ALTER TABLE rh_tx_retention_probe DETACH PARTITION rh_tx_retention_probe_old');
    await client.query('DROP TABLE rh_tx_retention_probe_old RESTRICT');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM rh_event_retention_probe'))
      .rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM rh_tx_retention_probe'))
      .rows[0].n, 1);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid='rh_event_retention_probe_old'::regclass AND contype='f'`))
      .rows[0].n, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

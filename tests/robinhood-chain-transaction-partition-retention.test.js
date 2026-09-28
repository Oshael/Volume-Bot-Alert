'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { coverageFloor, decide, run } = require('../src/services/robinhood-chain-transaction-partition-retention');

after(() => db.pool.end());

const base = () => ({
  safety: { chain_events: { ready_for_pilot: true, candidate_cutoff_block: '250000' } },
  cursor: { finalized_head: '500100', recovery_state: 'running',
    observed_at: '2026-09-27T21:00:00Z' },
  parts: [{ start: 0, end: 250000, name: 'public.robinhood_chain_transactions_shadow_b0',
    event: 'public.robinhood_chain_events_shadow_b0', bytes: '100' }],
  remainingFloor: 250000,
  firstRemainingTime: '2026-09-24T20:59:00Z',
  candidateRecent: false, pending_bundle: false, pinned_deployment: false,
  oldestUnappliedBlock: '500050',
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
    [{ pending_bundle: true }, 'pending_bundle_funding_in_partition'],
    [{ pinned_deployment: true }, 'deployment_mint_in_partition'],
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
  assert.equal(decide({ ...base(), pending_redistribution: true }).ready, true);
});

function fakeMutation(sql, state) {
  if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') state.inTransaction = true;
  if (sql === 'COMMIT' || sql === 'ROLLBACK') {
    state.inTransaction = false;
    state.queueLocked = false;
  }
  if (sql.includes('LOCK TABLE robinhood_token_deployment_outbox')) state.queueLocked = true;
  if (sql === "SET statement_timeout='5min'") state.timeout = '5min';
  if (sql.includes('DROP CONSTRAINT')) state.eventFk = false;
  if (sql.includes('DETACH PARTITION')) {
    assert.equal(state.inTransaction, false);
    assert.equal(state.queueLocked, false);
    assert.equal(state.timeout, '5min');
    assert.equal(state.eventFk, false);
    assert.match(sql, /CONCURRENTLY/);
    state.detached = true;
  }
  if (sql.startsWith('DROP TABLE public.robinhood_chain_transactions_shadow_b0')) {
    assert.equal(state.inTransaction, true);
    assert.equal(state.detached, true);
    state.dropped = true;
  }
}

function fakeSelection(sql, state) {
  if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
  if (sql.includes('AS transactions')) return {
    rows: [{ transactions: 'p', events: 'p' }],
  };
  if (sql.includes('AS detach_pending')) return {
    rows: (state.detached ? [250000, 500000] : [0, 250000, 500000]).map((start) => ({
      name: `robinhood_chain_transactions_shadow_b${start}`,
      bound: `FOR VALUES FROM ('${start}') TO ('${start + 250000}')`,
      bytes: '100', detach_pending: false,
    })),
  };
  if (sql.includes('child.relname ~')) return {
    rows: state.detached && !state.dropped
      ? [{ relname: 'robinhood_chain_transactions_shadow_b0' }] : [],
  };
  if (sql.includes('FROM robinhood_chain_capture_cursor')) return {
    rows: [{ finalized_head: '500100', recovery_state: 'running',
      observed_at: '2026-09-27T21:00:00Z' }],
  };
  if (sql.includes('SELECT block_timestamp FROM robinhood_chain_blocks')) return {
    rows: [{ block_timestamp: '2026-09-24T20:59:00Z' }],
  };
  if (sql.includes('AS present')) return { rows: [{ present: false }] };
  if (sql.includes('AS pending_bundle')) return {
    rows: [{ pending_bundle: false, pinned_deployment: false }],
  };
  if (sql.includes('FROM robinhood_holder_transfer_journal')) return {
    rows: [{ block_number: '500050' }],
  };
  if (sql.includes('AS bound') && sql.includes('FROM pg_inherits')) return {
    rows: [{ bound: "FOR VALUES FROM ('0') TO ('250000')" }],
  };
  if (sql.includes('FROM pg_constraint')) return {
    rows: state.eventFk ? [{ name: 'rh_chain_events_transaction_shadow_fkey',
      validated: true, references_parent: true }] : [],
  };
  return { rows: [] };
}

function fakePartitionClient() {
  const state = { inTransaction: false, detached: false, dropped: false,
    eventFk: true, queueLocked: false, timeout: null };
  const client = { release() {}, async query(sql) {
    fakeMutation(sql, state);
    return fakeSelection(sql, state);
  } };
  return { client, state: () => ({ detached: state.detached,
    dropped: state.dropped, eventFk: state.eventFk }) };
}

it('detaches concurrently without queue locks and drops only after a fresh audit', async () => {
  const { client, state } = fakePartitionClient();
  let audits = 0;
  const report = await run({ apply: true }, {
    database: { getClient: async () => client },
    audit: { inspect: async () => { audits += 1; return base().safety; } },
  });
  assert.equal(report.action, 'dropped_transaction_partition');
  assert.deepEqual(state(), { detached: true, dropped: true, eventFk: false });
  assert.equal(audits, 2);
});

it('retains the detached table when the consumer gate changes after detach', async () => {
  const { client, state } = fakePartitionClient();
  let audits = 0;
  await assert.rejects(run({ apply: true }, {
    database: { getClient: async () => client },
    audit: { inspect: async () => {
      audits += 1;
      return audits === 1 ? base().safety : {
        chain_events: { ready_for_pilot: false, candidate_cutoff_block: '250000' },
      };
    } },
  }), /detached partition remains on disk/);
  assert.deepEqual(state(), { detached: true, dropped: false, eventFk: false });
  await assert.rejects(run({}, {
    database: { getClient: async () => client },
    audit: { inspect: async () => base().safety },
  }), /detached transaction partition requires recovery/);
});

it('detaches concurrently and drops only the expired transaction leaf', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
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
    await client.query(`CREATE TABLE rh_event_retention_probe_new
      PARTITION OF rh_event_retention_probe FOR VALUES FROM (250000) TO (500000)`);
    await client.query(`ALTER TABLE rh_event_retention_probe_old ADD CONSTRAINT rh_probe_fk
      FOREIGN KEY (chain, block_number, block_hash, transaction_hash)
      REFERENCES rh_tx_retention_probe(chain, block_number, block_hash, transaction_hash)
      ON DELETE CASCADE`);
    await client.query(`ALTER TABLE rh_event_retention_probe_new ADD CONSTRAINT rh_probe_new_fk
      FOREIGN KEY (chain, block_number, block_hash, transaction_hash)
      REFERENCES rh_tx_retention_probe(chain, block_number, block_hash, transaction_hash)
      ON DELETE CASCADE`);
    await client.query(`INSERT INTO rh_tx_retention_probe VALUES
      ('robinhood',100,'old','old'), ('robinhood',250100,'new','new')`);
    await client.query(`INSERT INTO rh_event_retention_probe VALUES
      ('robinhood',100,'old','old'), ('robinhood',250100,'new','new')`);
    await client.query('LOCK TABLE ONLY rh_tx_retention_probe IN SHARE UPDATE EXCLUSIVE MODE');
    await client.query('LOCK TABLE rh_event_retention_probe_old IN ACCESS EXCLUSIVE MODE');
    await client.query('ALTER TABLE rh_event_retention_probe_old DROP CONSTRAINT rh_probe_fk');
    await client.query('COMMIT');
    inTransaction = false;
    await client.query(`ALTER TABLE rh_tx_retention_probe
      DETACH PARTITION rh_tx_retention_probe_old CONCURRENTLY`);
    await client.query('DROP TABLE rh_tx_retention_probe_old RESTRICT');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM rh_event_retention_probe'))
      .rows[0].n, 2);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM rh_tx_retention_probe'))
      .rows[0].n, 1);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid='rh_event_retention_probe_old'::regclass AND contype='f'`))
      .rows[0].n, 0);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid='rh_event_retention_probe_new'::regclass
        AND contype='f' AND conparentid=0`))
      .rows[0].n, 1);
  } finally {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    await client.query('DROP TABLE IF EXISTS rh_event_retention_probe').catch(() => {});
    await client.query('DROP TABLE IF EXISTS rh_tx_retention_probe').catch(() => {});
    await client.query('DROP TABLE IF EXISTS rh_tx_retention_probe_old').catch(() => {});
    client.release();
  }
});

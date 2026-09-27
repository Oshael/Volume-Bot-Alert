'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const {
  buildReport, chooseFloor, partitionMap,
} = require('../src/utils/plan-robinhood-chain-transaction-retention');

after(() => db.pool.end());

const timestamp = (day) => new Date(`2026-09-${day}T00:00:00Z`);
const state = () => ({
  observed_at: timestamp('27'), cutoff_at: timestamp('24'),
  first_block: '100', finalized_head: '500100',
  checkpoint_block: '500102', next_block: '500103', node_head: '500103',
  recovery_state: 'running',
});
const boundaries = () => [
  { start_block: '0', first_block: '100', block_timestamp: timestamp('20') },
  { start_block: '250000', first_block: '250000', block_timestamp: timestamp('23') },
  { start_block: '500000', first_block: '500000', block_timestamp: timestamp('25') },
];
function partition(parent, start) {
  const prefix = parent === 'robinhood_chain_events'
    ? 'robinhood_chain_events_shadow' : parent;
  return { parent, child: `${prefix}_b${start}`,
    bound: `FOR VALUES FROM ('${start}') TO ('${start + 250000}')` };
}

it('keeps the whole partition containing the three-day boundary', () => {
  const events = 'robinhood_chain_events';
  const shadow = 'robinhood_chain_transactions_shadow';
  const partitions = [0, 250000, 500000].map((start) => partition(events, start));
  partitions.push(partition(shadow, 500000));
  const fks = [0, 250000, 500000].map((start) => ({
    child: `${events}_shadow_b${start}`,
    conname: 'rh_chain_events_shadow_transaction_fkey', convalidated: true,
  }));
  fks.push({ child: `${events}_shadow_b500000`,
    conname: 'rh_chain_events_transaction_shadow_fkey', convalidated: true });
  const report = buildReport(state(), boundaries(), partitions, fks);
  assert.deepEqual(report.candidate, {
    fromBlock: 250000, throughBlock: 500100, firstCanonicalBlock: 100,
    historicalEventPartitions: 1, retainedEventPartitions: 2,
  });
  assert.deepEqual(report.layout, {
    eventPartitions: 3, shadowPartitions: 1, legacyEventFks: 3,
    validatedReplacementFks: 1,
    missingEventPartitions: [], missingShadowPartitions: [250000],
  });
  assert.equal(report.action, 'none');
});

it('keeps all available history when the journal starts within three days', () => {
  assert.equal(chooseFloor(boundaries(), 100, timestamp('19')), 0);
});

it('rejects incomplete or nonmonotonic canonical boundaries', () => {
  const rows = boundaries();
  rows[1].block_timestamp = timestamp('18');
  assert.throws(() => chooseFloor(rows, 100, timestamp('24')), /nonmonotonic/);
  const missing = boundaries();
  missing[1].first_block = null;
  assert.throws(() => chooseFloor(missing, 100, timestamp('24')), /invalid/);
  assert.throws(() => buildReport(state(), boundaries().slice(1), [], []),
    /coverage is incomplete/);
});

it('rejects an unexpected event partition bound', () => {
  assert.throws(() => partitionMap([{
    parent: 'robinhood_chain_events', child: 'robinhood_chain_events_b0',
    bound: "FOR VALUES FROM ('0') TO ('500000')",
  }], 'robinhood_chain_events'), /unexpected partition layout/);
});

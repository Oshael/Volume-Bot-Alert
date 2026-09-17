'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage233 = require('../src/utils/db-init-stage233');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { eligibility } = require('../src/services/robinhood-holder-legacy-manifest-builder');
const { parseArgs } = require('../src/utils/build-robinhood-holder-legacy-manifest');

function state(overrides = {}) {
  return {
    ledger_status: 'shadow', deployment_block: '100', backfill_next_block: '100',
    live_through_block: null, live_through_hash: null, holder_count: '0',
    buffer_floor_block: '90', journal_floor_block: '95', next_block: '200',
    raw_floor_block: '80', checkpoint_canonical: null,
    pending_before_deployment: false, ...overrides,
  };
}

it('accepts only durable legacy baselines', () => {
  assert.equal(eligibility(state()), null);
  assert.equal(eligibility(state({ pending_before_deployment: true })),
    'pending_before_deployment');
  assert.equal(eligibility(state({ holder_count: '1' })), 'shadow_nonzero_holders');
  assert.equal(eligibility(state({ deployment_block: '80' })), 'shadow_cursor_moved');
  assert.equal(eligibility(state({ deployment_block: '80', backfill_next_block: '80' })),
    'below_coverage_floor');
  assert.equal(eligibility(state({ ledger_status: 'live' })), 'live_without_checkpoint');
  assert.equal(eligibility(state({ ledger_status: 'live', live_through_block: '150',
    live_through_hash: `0x${'a'.repeat(64)}`, checkpoint_canonical: true })), null);
  assert.equal(eligibility(state({ live_through_block: '150',
    live_through_hash: `0x${'a'.repeat(64)}`, checkpoint_canonical: false })),
  'noncanonical_checkpoint');
  assert.equal(eligibility(state({ live_through_block: '70',
    live_through_hash: `0x${'a'.repeat(64)}`, checkpoint_canonical: null })), null);
  assert.equal(eligibility(state({ live_through_block: '80',
    live_through_hash: `0x${'a'.repeat(64)}`, checkpoint_canonical: null })),
  'missing_retained_checkpoint');
  assert.equal(eligibility(state({ live_through_block: '70', raw_floor_block: null,
    live_through_hash: `0x${'a'.repeat(64)}`, checkpoint_canonical: null })),
  'missing_raw_floor');
});

it('is preview-only by default and bounds every batch', () => {
  assert.deepEqual(parseArgs([]), { apply: false, restart: false, limit: 100 });
  assert.deepEqual(parseArgs(['--apply', '--limit=1000']),
    { apply: true, restart: false, limit: 1000 });
  assert.throws(() => parseArgs(['--limit=1001']), /between 1 and 1000/);
  assert.throws(() => parseArgs(['--write']), /unknown argument/);
});

it('defines a durable cursor and permits the observed initial generation', () => {
  const sql = stage233.STATEMENTS.join('\n');
  assert.match(sql, /coverage_generation >= 0/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_legacy_coverage_builds/);
  assert.match(sql, /after_token_address/);
  const group = SCHEMA_GROUPS.find(({ key }) =>
    key === 'stage233-robinhood-holder-legacy-manifest-builder');
  assert.equal(group.repair, 'node src/utils/db-init-stage233.js');
});

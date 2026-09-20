'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage241 = require('../src/utils/db-init-stage241');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet-classification anchor schema', () => {
  it('stores only referenced block identity and time', () => {
    const sql = stage241.STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_chain_block_anchors/);
    assert.match(sql, /PRIMARY KEY \(\s*chain, block_number, block_hash/);
    assert.match(sql, /capture_robinhood_chain_block_anchor/);
    assert.match(sql, /block anchor hash mismatch/);
    assert.match(sql, /block anchor timestamp mismatch/);
    assert.doesNotMatch(sql, /transaction_hash|receipt|topics JSONB|data TEXT/);
  });

  it('adds nullable all-or-none queue frontiers and event-driven capture', () => {
    const sql = stage241.STATEMENTS.join('\n');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS source_requested_version BIGINT/);
    assert.match(sql, /source_requested_version IS NULL\)::integer\) IN \(0, 4\)/);
    assert.match(sql, /source_requested_version <= requested_version/);
    assert.match(sql, /BEFORE INSERT OR UPDATE OF observation_from_block, requested_version/);
    assert.match(sql, /NEW\.requested_version IS DISTINCT FROM OLD\.requested_version/);
    assert.match(sql, /NEW\.source_requested_version := NULL/);
    assert.match(sql, /AFTER INSERT OR UPDATE OF live_through_block, live_through_hash/);
    assert.match(sql, /observation_anchor_fkey/);
    assert.match(sql, /source_anchor_fkey/);
  });

  it('registers the complete Stage 241 contract in the runtime guard', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage241-robinhood-wallet-classification-anchors'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage241.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_chain_block_anchors',
      'robinhood_bundle_redistribution_activations',
      'robinhood_bundle_redistribution_queue',
      'robinhood_holder_token_states',
    ]);
  });
});

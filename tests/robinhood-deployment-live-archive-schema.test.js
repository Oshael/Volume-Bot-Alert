'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage242 = require('../src/utils/db-init-stage242');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood deployment live/Archive lane schema', () => {
  it('stores an explicit live deadline and terminal Archive-required state', () => {
    const sql = stage242.STATEMENTS.join('\n');
    assert.match(sql, /live_deadline_at TIMESTAMPTZ/);
    assert.match(sql, /archive_required_at TIMESTAMPTZ/);
    assert.match(sql, /created_at \+ INTERVAL '72 hours'/);
    assert.match(sql, /status IN \('pending', 'leased', 'archive_required'\)/);
    assert.match(sql, /idx_rh_token_deployment_outbox_live_deadline/);
  });

  it('registers Stage 242 in the runtime schema guard', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage242-robinhood-deployment-live-archive-lanes'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage242.js');
    assert.deepEqual(group.tables[0].columns, ['live_deadline_at', 'archive_required_at']);
  });
});

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { STATEMENTS, init } = require('../src/utils/db-init-stage206');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood canonical recovery journal schema', () => {
  it('defines restart-safe recovery phases and an at-least-once event outbox', () => {
    const sql = STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_chain_recoveries/);
    assert.match(sql, /'detected', 'rewound', 'awaiting_domains'/);
    assert.match(sql, /plan ->> 'generation' = generation::text/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_chain_recovery_outbox/);
    assert.match(sql, /'detected', 'rewound', 'domain_ready', 'recaptured'/);
    assert.match(sql, /\(event_kind = 'domain_ready'\) = \(event_key <> ''\)/);
    assert.match(sql, /REFERENCES robinhood_chain_recoveries\(chain, generation\) ON DELETE CASCADE/);
    assert.match(sql, /status IN \('pending', 'leased', 'complete', 'blocked'\)/);
  });

  it('backfills an already-fenced cursor idempotently', () => {
    const sql = STATEMENTS.join('\n');
    assert.match(sql, /FROM robinhood_chain_capture_cursor/);
    assert.match(sql, /WHERE recovery_state = 'recovery_required'/);
    assert.match(sql, /ON CONFLICT \(chain, generation\) DO NOTHING/);
    assert.match(sql, /ON CONFLICT \(chain, generation, event_kind, event_key\) DO NOTHING/);
  });

  it('runs sequentially and is registered in the runtime guard', async () => {
    const calls = [];
    await init({ database: { query: async (sql) => calls.push(sql) }, closePool: false });
    assert.deepEqual(calls, STATEMENTS);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage206-robinhood-chain-recovery-journal'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage206.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_chain_recoveries', 'robinhood_chain_recovery_outbox',
    ]);
  });
});

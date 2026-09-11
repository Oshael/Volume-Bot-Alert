'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { STATEMENTS, init: initStage204 } = require('../src/utils/db-init-stage204');
const stage207 = require('../src/utils/db-init-stage207');
const stage209 = require('../src/utils/db-init-stage209');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet-swap realtime lifecycle outbox schema', () => {
  it('defines an append-only lifecycle queue with durable delivery state', () => {
    const sql = STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_wallet_swap_realtime_outbox/);
    assert.match(sql, /PRIMARY KEY \([\s\S]*block_hash[\s\S]*event_kind/);
    assert.match(sql, /event_kind IN \('observed', 'finalized', 'invalidate'\)/);
    assert.match(sql, /status IN \('pending', 'leased', 'complete', 'blocked'\)/);
    assert.match(sql, /\(status = 'complete'\) = \(published_at IS NOT NULL\)/);
    assert.match(sql, /WHERE event_kind = 'observed' AND status = 'complete'/);
  });

  it('runs sequentially and is registered in the runtime schema guard', async () => {
    const calls = [];
    await initStage204({
      database: { query: async (sql) => calls.push(sql) },
      closePool: false,
    });
    assert.deepEqual(calls, STATEMENTS);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage204-robinhood-wallet-swap-realtime-outbox'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage204.js');
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), [
      'idx_rh_wallet_swap_realtime_outbox_claim',
      'idx_rh_wallet_swap_realtime_outbox_lease',
      'idx_rh_wallet_swap_realtime_outbox_canonical',
      'idx_rh_wallet_swap_realtime_outbox_promote',
    ]);
  });

  it('migrates an existing lifecycle queue to branch-aware identity', async () => {
    const sql = stage207.STATEMENTS.join('\n');
    assert.match(sql, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/);
    assert.match(sql, /chain, transaction_hash, log_index, block_hash, event_kind/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS rh_wallet_swap_realtime_outbox_pkey/);
    assert.match(sql, /PRIMARY KEY USING INDEX rh_wallet_swap_realtime_outbox_cycle_pkey/);

    const calls = [];
    const database = {
      query: async (statement, params) => {
        calls.push({ statement, params });
        if (/SELECT 1 FROM pg_constraint/.test(statement)) return { rowCount: 0, rows: [] };
        if (/SELECT indisvalid FROM pg_index/.test(statement)) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      },
    };
    await stage207.init({ database, closePool: false });
    assert.ok(calls.some(({ statement }) => (
      statement === stage207.BUILD_IDENTITY_INDEX_STATEMENT
    )));
    assert.ok(calls.some(({ statement }) => (
      statement === stage207.PROMOTE_IDENTITY_STATEMENT
    )));
    assert.match(calls[0].statement, /pg_advisory_lock/);
    assert.match(calls.at(-1).statement, /pg_advisory_unlock/);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage207-robinhood-wallet-swap-realtime-branch-identity'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage207.js');
    assert.deepEqual(group.tables[0].constraints[0].includes, [
      'PRIMARY KEY', 'chain', 'transaction_hash', 'log_index', 'block_hash',
      'event_kind',
    ]);
  });

  it('adds shadow audit state without consuming publication state', async () => {
    const sql = stage209.STATEMENTS.join('\n');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS audit_status/);
    assert.match(sql, /audit_status IN \('pending', 'leased', 'complete', 'blocked'\)/);
    assert.match(sql, /idx_rh_wallet_swap_realtime_outbox_audit_claim/);
    assert.match(sql, /event_kind='observed' AND audit_status='complete'/);
    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    assert.doesNotMatch(sql, /SET status=/);
    assert.doesNotMatch(sql, /published_at=NOW/);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage209-robinhood-wallet-swap-shadow-audit'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage209.js');
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), [
      'idx_rh_wallet_swap_realtime_outbox_audit_claim',
      'idx_rh_wallet_swap_realtime_outbox_audit_lease',
      'idx_rh_wallet_swap_realtime_outbox_audit_observed',
    ]);

    const calls = [];
    await stage209.init({
      database: {
        query: async (statement) => {
          calls.push(statement);
          return calls.length === 1
            ? { rows: [{ name: stage209.INDEX_NAMES[0] }] }
            : { rows: [] };
        },
      },
      closePool: false,
    });
    assert.match(calls[1], /DROP INDEX CONCURRENTLY IF EXISTS/);
    assert.deepEqual(calls.slice(2), stage209.STATEMENTS);
  });
});

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  normalizeOptions, runPilot,
} = require('../src/services/robinhood-chain-event-pruner');
const { parseArgs } = require('../src/utils/prune-robinhood-chain-events');

function harness(input = {}) {
  const calls = [];
  let deletion = 0;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SET LOCAL')) {
        return { rows: [] };
      }
      if (sql.includes('chain-event-prune:lock')) return { rows: [{ locked: true }] };
      if (sql.includes('chain-event-prune:indexes')) return { rows: [{ ready_indexes: 2 }] };
      if (sql.includes('chain-event-prune:delete')) return { rows: [{
        deleted_events: Array.isArray(input.deletedEvents)
          ? input.deletedEvents[deletion++] : input.deletedEvents ?? 1000,
        first_deleted_block: '10', last_deleted_block: '20',
      }] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, database: { getClient: async () => client } };
}

function safety(overrides = {}) {
  return { chain_events: {
    ready_for_pilot: true, candidate_cutoff_block: '56397387', blockers: [], ...overrides,
  } };
}

describe('Robinhood chain event pruner', () => {
  it('requires an explicit write flag and bounded pilot options', () => {
    assert.deepEqual(parseArgs(['--write']), {
      batchLimit: 1000, maxBatches: 1, pauseMs: 1000, untilDrained: false,
    });
    assert.deepEqual(parseArgs([
      '--write', '--batch-limit=5000', '--max-batches=2', '--pause-ms=500',
    ]), { batchLimit: 5000, maxBatches: 2, pauseMs: 500, untilDrained: false });
    assert.deepEqual(parseArgs(['--write', '--until-drained', '--pause-ms=100']), {
      batchLimit: 1000, maxBatches: 1, pauseMs: 100, untilDrained: true,
    });
    assert.throws(() => parseArgs([]), /--write is required/);
    assert.throws(() => parseArgs(['--write', '--batch-limit=5001']), /between 1 and 5000/);
    assert.throws(() => parseArgs(['--write', '--write']), /unknown or repeated/);
    assert.throws(() => parseArgs([
      '--write', '--until-drained', '--max-batches=2',
    ]), /cannot be combined/);
  });

  it('continues until the audited prefix is fully drained', async () => {
    const context = harness({ deletedEvents: [1000, 1000, 12] });
    const report = await runPilot({
      batchLimit: 1000, untilDrained: true, pauseMs: 100,
    }, {
      database: context.database,
      audit: { inspect: async () => safety() },
      pause: async () => {},
    });
    assert.deepEqual(report, {
      status: 'finished', stopReason: 'prefix_drained', cutoffBlock: '56397387',
      batches: 3, totalDeleted: 2012,
    });
  });

  it('uses the audited cutoff and deletes one bounded ordered batch', async () => {
    const context = harness();
    const progress = [];
    const report = await runPilot(normalizeOptions(), {
      database: context.database,
      audit: { inspect: async () => safety() },
      progress: (entry) => progress.push(entry),
    });
    assert.deepEqual(report, {
      status: 'finished', stopReason: 'batch_limit', cutoffBlock: '56397387',
      batches: 1, totalDeleted: 1000,
    });
    const deletion = context.calls.find(({ sql }) => sql.includes('chain-event-prune:delete'));
    assert.deepEqual(deletion.params, ['robinhood', '56397387', 1000]);
    assert.match(deletion.sql, /ORDER BY event\.block_number/);
    assert.match(deletion.sql, /FOR UPDATE OF event SKIP LOCKED/);
    assert.equal(progress[0].deletedEvents, 1000);
    assert.ok(context.calls.some(({ sql }) => sql === 'COMMIT'));
  });

  it('refuses all writes when the chain-specific audit is blocked', async () => {
    const context = harness();
    const report = await runPilot({}, {
      database: context.database,
      audit: { inspect: async () => safety({
        ready_for_pilot: false, blockers: [{ code: 'capture_lag_exceeded' }],
      }) },
    });
    assert.equal(report.status, 'blocked');
    assert.equal(report.totalDeleted, 0);
    assert.equal(context.calls.length, 0);
  });

  it('rolls back when either Stage 201 index is unavailable', async () => {
    const context = harness();
    const original = context.database.getClient;
    context.database.getClient = async () => {
      const client = await original();
      const query = client.query.bind(client);
      client.query = (sql, params) => sql.includes('chain-event-prune:indexes')
        ? Promise.resolve({ rows: [{ ready_indexes: 1 }] }) : query(sql, params);
      return client;
    };
    await assert.rejects(runPilot({}, {
      database: context.database, audit: { inspect: async () => safety() },
    }), { code: 'chain_event_prune_indexes_unavailable' });
    assert.ok(context.calls.some(({ sql }) => sql === 'ROLLBACK'));
    assert.equal(context.calls.some(({ sql }) => sql.includes('chain-event-prune:delete')), false);
  });
});

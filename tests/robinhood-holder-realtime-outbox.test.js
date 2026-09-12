'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage213 = require('../src/utils/db-init-stage213');
const {
  NOTIFY_CHANNEL,
  createRobinhoodHolderRealtimeOutboxRepository,
  enqueuePublications,
} = require('../src/models/robinhood-holder-realtime-outbox');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'2'.repeat(64)}`;

describe('Robinhood holder realtime outbox', () => {
  it('registers an idempotent leased outbox with observable dead letters', async () => {
    const sql = stage213.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage213-robinhood-holder-realtime-outbox'
    ));
    assert.match(sql, /UNIQUE \(chain, token_address, ledger_version, event_kind\)/);
    assert.match(sql, /event_kind IN \('observed', 'finalized', 'invalidate'\)/);
    assert.match(sql, /status IN \('pending', 'leased', 'complete', 'blocked'\)/);
    assert.match(sql, /WHERE status = 'pending'/);
    assert.equal(group.repair, 'node src/utils/db-init-stage213.js');
    const calls = [];
    await stage213.init({
      database: { query: async (statement) => calls.push(statement) },
      closePool: false,
    });
    assert.deepEqual(calls, stage213.STATEMENTS);
  });

  it('enqueues a normalized publication and transaction-bound notification', async () => {
    const calls = [];
    const client = { query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ inserted: 1 }] };
    } };
    const inserted = await enqueuePublications(client, [{
      tokenAddress: TOKEN, holderCount: '7', ledgerVersion: '3',
      observedAt: '2026-09-12T01:00:00.000Z', liveThroughBlock: '100',
      liveThroughHash: HASH, latency: { projectionCommittedAt: '2026-09-12T01:00:00.000Z' },
    }]);
    const input = JSON.parse(calls[0].params[0]);
    assert.equal(inserted, 1);
    assert.deepEqual(input[0], {
      token_address: TOKEN, ledger_version: '3', event_kind: 'observed', holder_count: '7',
      observed_at: '2026-09-12T01:00:00.000Z', live_through_block: '100',
      live_through_hash: HASH,
      latency: { projectionCommittedAt: '2026-09-12T01:00:00.000Z' },
    });
    assert.equal(calls[0].params[1], NOTIFY_CHANNEL);
    assert.match(calls[0].sql, /ON CONFLICT .* DO NOTHING/);
    assert.match(calls[0].sql, /pg_notify/);
  });

  it('claims, retries, blocks and exposes the durable backlog', async () => {
    const calls = [];
    const responses = [
      { rows: [{ id: '4', attempt_count: 2, payload: { type: 'holder:count' } }] },
      { rows: [{ status: 'pending' }, { status: 'complete' }, { status: 'blocked' }] },
      { rowCount: 2 },
      { rows: [{
        pending: 3, due: 2, leased: 1, expired_leases: 1, blocked: 4,
        max_attempts: 5, oldest_age_seconds: 12.5,
      }] },
    ];
    const repository = createRobinhoodHolderRealtimeOutboxRepository({ database: {
      query: async (sql, params) => { calls.push({ sql, params }); return responses.shift(); },
    } });

    assert.deepEqual(await repository.claimOutbox({ owner: 'holder-a', limit: 10, leaseMs: 5000 }), [{
      id: '4', payload: { type: 'holder:count' }, attemptCount: 2,
    }]);
    assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(calls[0].sql, /attempt_count=outbox\.attempt_count\+1/);
    assert.deepEqual(await repository.settleOutbox({
      owner: 'holder-a', maxAttempts: 5, delivered: ['4'],
      retry: [{ id: '5', error: 'relay down', backoffMs: 1000 }, { id: '6', error: 'bad', backoffMs: 1 }],
    }), { delivered: 1, retried: 1, blocked: 1 });
    assert.match(calls[1].sql, /published_at=CASE/);
    assert.equal(await repository.reclaimExpiredLeases(), 2);
    assert.deepEqual(await repository.readBacklog(), {
      pending: 3, due: 2, leased: 1, expiredLeases: 1, blocked: 4,
      maxAttempts: 5, oldestAgeSeconds: 12.5,
    });
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const workerLease = require('../src/models/worker-lease');
const { createWorkerLeaseManager } = require('../src/services/worker-lease-manager');

async function waitFor(predicate, attempts = 10) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for condition');
}

function leaseRow(overrides = {}) {
  return {
    lease_key: 'catalog-worker',
    owner_id: 'owner-a',
    owner_pid: 123,
    owner_hostname: 'host-a',
    acquired_at: new Date('2026-07-09T10:00:00.000Z'),
    heartbeat_at: new Date('2026-07-09T10:00:10.000Z'),
    lease_until: new Date('2026-07-09T10:02:10.000Z'),
    metadata: { group: 'core' },
    ...overrides,
  };
}

function mappedLease(overrides = {}) {
  return workerLease.__private.mapRow(leaseRow(overrides));
}

describe('worker lease model', () => {
  it('maps acquired lease rows to stable status fields', async () => {
    const calls = [];
    const runner = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [leaseRow()] };
      },
    };

    const result = await workerLease.acquire('catalog-worker', 'owner-a', {
      ttlMs: 120000,
      metadata: { group: 'core' },
    }, runner);

    assert.equal(result.key, 'catalog-worker');
    assert.equal(result.ownerId, 'owner-a');
    assert.equal(result.ownerPid, 123);
    assert.equal(result.ownerHostname, 'host-a');
    assert.equal(result.leaseUntil, '2026-07-09T10:02:10.000Z');
    assert.deepEqual(result.metadata, { group: 'core' });
    assert.match(calls[0].sql, /ON CONFLICT \(lease_key\)/);
    assert.deepEqual(calls[0].params.slice(0, 2), ['catalog-worker', 'owner-a']);
  });

  it('returns null when another owner still holds the lease', async () => {
    const runner = {
      async query() {
        return { rows: [] };
      },
    };

    const result = await workerLease.acquire('catalog-worker', 'owner-b', {}, runner);

    assert.equal(result, null);
  });

  it('clamps invalid ttl values to a safe range', () => {
    assert.equal(workerLease.__private.normalizeTtlMs(1), 5000);
    assert.equal(workerLease.__private.normalizeTtlMs(20 * 60 * 1000), 10 * 60 * 1000);
  });
});

describe('worker lease manager', () => {
  it('starts a worker only after acquiring its lease', async () => {
    let starts = 0;
    const manager = createWorkerLeaseManager({
      ownerId: 'owner-a',
      leaseStore: {
        acquire: async () => mappedLease(),
        heartbeat: async () => mappedLease(),
        release: async () => true,
      },
    });

    const started = await manager.__private.attemptStart({
      key: 'catalog-worker',
      label: 'Catalog worker',
      start: () => { starts += 1; },
    });

    assert.equal(started, true);
    assert.equal(starts, 1);
    assert.equal(manager.getStatus()[0].state, 'running');
    assert.equal(manager.getStatus()[0].started, true);
    await manager.stop();
  });

  it('keeps a worker in standby when the lease is held elsewhere', async () => {
    let starts = 0;
    const manager = createWorkerLeaseManager({
      ownerId: 'owner-b',
      retryMs: 60000,
      leaseStore: {
        acquire: async () => null,
        heartbeat: async () => null,
        release: async () => true,
      },
    });

    const started = await manager.__private.attemptStart({
      key: 'catalog-worker',
      label: 'Catalog worker',
      start: () => { starts += 1; },
    });

    assert.equal(started, false);
    assert.equal(starts, 0);
    assert.equal(manager.getStatus()[0].state, 'standby');
    assert.equal(manager.getStatus()[0].started, false);
    await manager.stop();
  });

  it('marks the process unsafe when a running worker loses heartbeat ownership', async () => {
    let lost = null;
    const manager = createWorkerLeaseManager({
      ownerId: 'owner-a',
      leaseStore: {
        acquire: async () => mappedLease(),
        heartbeat: async () => null,
        release: async () => true,
      },
      onLeaseLost: (entry) => {
        lost = entry;
      },
    });

    await manager.__private.attemptStart({
      key: 'catalog-worker',
      label: 'Catalog worker',
      start: () => {},
    });
    await manager.__private.renew(manager.getStatus()[0]);

    assert.equal(lost.key, 'catalog-worker');
    assert.equal(lost.state, 'lost');
    assert.equal(lost.lastError, 'Lease heartbeat was not renewed');
    await manager.stop();
  });

  it('releases acquired leases on graceful stop', async () => {
    const released = [];
    const manager = createWorkerLeaseManager({
      ownerId: 'owner-a',
      leaseStore: {
        acquire: async () => mappedLease(),
        heartbeat: async () => mappedLease(),
        release: async (key, ownerId) => {
          released.push({ key, ownerId });
          return true;
        },
      },
    });

    await manager.__private.attemptStart({
      key: 'catalog-worker',
      label: 'Catalog worker',
      start: () => {},
    });
    await manager.stop();

    assert.deepEqual(released, [{ key: 'catalog-worker', ownerId: 'owner-a' }]);
    assert.equal(manager.getStatus()[0].state, 'released');
    assert.equal(manager.getStatus()[0].started, false);
  });

  it('releases acquired leases even before the worker start promise resolves', async () => {
    const released = [];
    let acquired;
    const acquiredPromise = new Promise((resolve) => {
      acquired = resolve;
    });
    let resolveStart;
    const startPromise = new Promise((resolve) => {
      resolveStart = resolve;
    });
    const manager = createWorkerLeaseManager({
      ownerId: 'owner-a',
      leaseStore: {
        acquire: async () => {
          const row = mappedLease();
          acquired();
          return row;
        },
        heartbeat: async () => mappedLease(),
        release: async (key, ownerId) => {
          released.push({ key, ownerId });
          return true;
        },
      },
    });

    const starting = manager.__private.attemptStart({
      key: 'catalog-worker',
      label: 'Catalog worker',
      start: () => startPromise,
    });
    await acquiredPromise;
    await waitFor(() => manager.getStatus()[0]?.leaseUntil);
    const stopResult = await manager.stop();
    resolveStart();
    await starting;

    assert.deepEqual(released, [{ key: 'catalog-worker', ownerId: 'owner-a' }]);
    assert.deepEqual(stopResult, { released: 1, missed: 0, errors: 0 });
    assert.equal(manager.getStatus()[0].state, 'released');
  });

  it('does not release leases it never acquired', async () => {
    let releaseCount = 0;
    const manager = createWorkerLeaseManager({
      ownerId: 'owner-b',
      retryMs: 60000,
      leaseStore: {
        acquire: async () => null,
        heartbeat: async () => null,
        release: async () => {
          releaseCount += 1;
          return true;
        },
      },
    });

    await manager.__private.attemptStart({
      key: 'catalog-worker',
      label: 'Catalog worker',
      start: () => {},
    });
    const stopResult = await manager.stop();

    assert.equal(releaseCount, 0);
    assert.deepEqual(stopResult, { released: 0, missed: 0, errors: 0 });
    assert.equal(manager.getStatus()[0].state, 'stopped');
  });
});

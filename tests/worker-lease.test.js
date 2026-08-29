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
    assert.match(calls[0].sql, /metadata->>'state'.*<> 'halted'/s);
    assert.deepEqual(calls[0].params.slice(0, 2), ['catalog-worker', 'owner-a']);
  });

  it('persists fatal state as an expired lease tombstone', async () => {
    const calls = [];
    const haltedAt = new Date('2026-07-09T10:00:30.000Z');
    const runner = {
      async query(sql, params) {
        calls.push({ sql, params });
        const metadata = JSON.parse(params[2]);
        return {
          rows: [leaseRow({
            heartbeat_at: haltedAt,
            lease_until: haltedAt,
            metadata,
          })],
        };
      },
    };
    const error = Object.assign(new Error('checkpoint changed'), { code: 'persistent_reorg' });

    const result = await workerLease.halt('catalog-worker', 'owner-a', error, runner);

    assert.equal(result.metadata.state, 'halted');
    assert.equal(result.metadata.haltCode, 'persistent_reorg');
    assert.equal(result.metadata.haltMessage, 'checkpoint changed');
    assert.match(calls[0].sql, /lease_until = NOW\(\)/);
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

  it('updates bounded operational metadata in the existing heartbeat write', async () => {
    const calls = [];
    const runner = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [leaseRow({ metadata: JSON.parse(params[3]) })],
        };
      },
    };

    const result = await workerLease.heartbeat('catalog-worker', 'owner-a', {
      ttlMs: 120000,
      metadata: { group: 'core', telemetry: { version: 1 } },
    }, runner);

    assert.deepEqual(result.metadata, { group: 'core', telemetry: { version: 1 } });
    assert.match(calls[0].sql, /metadata = CASE/);
    assert.equal(calls[0].params.length, 4);
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

  it('publishes dynamic metadata without making telemetry generation a lease dependency', async () => {
    const heartbeatOptions = [];
    let telemetryFails = false;
    const manager = createWorkerLeaseManager({
      ownerId: 'owner-a',
      leaseStore: {
        acquire: async () => mappedLease(),
        heartbeat: async (_key, _ownerId, options) => {
          heartbeatOptions.push(options);
          return mappedLease({ metadata: options.metadata });
        },
        release: async () => true,
      },
      onLeaseLost: () => assert.fail('telemetry failure must not lose the lease'),
    });

    await manager.__private.attemptStart({
      key: 'catalog-worker',
      label: 'Catalog worker',
      metadata: { group: 'core' },
      metadataProvider: () => {
        if (telemetryFails) throw new Error('snapshot failed');
        return { telemetry: { version: 1 } };
      },
      start: () => {},
    });
    await manager.__private.renew(manager.getStatus()[0]);
    telemetryFails = true;
    await manager.__private.renew(manager.getStatus()[0]);

    assert.equal(heartbeatOptions[0].metadata.group, 'core');
    assert.deepEqual(heartbeatOptions[0].metadata.telemetry, { version: 1 });
    assert.equal(typeof heartbeatOptions[0].metadata.runtime.rssBytes, 'number');
    assert.equal(heartbeatOptions[1].metadata.group, 'core');
    assert.match(heartbeatOptions[1].metadata.metadataProviderError.message, /snapshot failed/);
    assert.equal(manager.getStatus()[0].state, 'running');
    assert.equal(manager.getStatus()[0].lastMetadataError, 'snapshot failed');
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

  it('preserves a fatal lease tombstone during graceful stop', async () => {
    const released = [];
    const manager = createWorkerLeaseManager({
      ownerId: 'owner-a',
      leaseStore: {
        acquire: async () => mappedLease(),
        heartbeat: async () => mappedLease(),
        halt: async (_key, _ownerId, error) => mappedLease({
          heartbeat_at: new Date('2026-07-09T10:00:30.000Z'),
          lease_until: new Date('2026-07-09T10:00:30.000Z'),
          metadata: {
            state: 'halted',
            haltCode: error.code,
            haltMessage: error.message,
            haltedAt: '2026-07-09T10:00:30.000Z',
          },
        }),
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
    const error = Object.assign(new Error('checkpoint changed'), { code: 'persistent_reorg' });

    const halted = await manager.halt('catalog-worker', error);
    const stopResult = await manager.stop();

    assert.equal(halted.state, 'halted');
    assert.equal(halted.started, false);
    assert.equal(halted.haltCode, 'persistent_reorg');
    assert.equal(halted.lastError, 'checkpoint changed');
    assert.deepEqual(released, []);
    assert.deepEqual(stopResult, { released: 0, missed: 0, errors: 0 });
  });

  it('keeps ownership and retries when fatal tombstone persistence fails transiently', async () => {
    const released = [];
    let haltAttempts = 0;
    const error = Object.assign(new Error('checkpoint changed'), { code: 'persistent_reorg' });
    const manager = createWorkerLeaseManager({
      ownerId: 'owner-a',
      leaseStore: {
        acquire: async () => mappedLease(),
        heartbeat: async () => mappedLease(),
        halt: async () => {
          haltAttempts += 1;
          if (haltAttempts === 1) throw new Error('database temporarily unavailable');
          return mappedLease({
            lease_until: new Date('2026-07-09T10:00:30.000Z'),
            metadata: {
              state: 'halted',
              haltCode: error.code,
              haltMessage: error.message,
              haltedAt: '2026-07-09T10:00:30.000Z',
            },
          });
        },
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

    await assert.rejects(manager.halt('catalog-worker', error), /temporarily unavailable/);
    assert.equal(manager.getStatus()[0].state, 'halt-pending');
    await manager.__private.renew(manager.getStatus()[0]);
    assert.equal(manager.getStatus()[0].state, 'halted');
    assert.equal(manager.getStatus()[0].haltCode, 'persistent_reorg');
    await manager.stop();

    assert.equal(haltAttempts, 2);
    assert.deepEqual(released, []);
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

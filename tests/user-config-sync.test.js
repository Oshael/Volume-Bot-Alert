const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const userConfigSync = require('../src/services/user-config-sync');

afterEach(async () => {
  await userConfigSync.stop();
});

describe('user config sync', () => {
  it('publishes a compact invalidation payload with the current config version', async () => {
    const queries = [];
    const version = '2026-07-09T12:00:00.000Z';
    const payload = await userConfigSync.publishUserConfigInvalidated(42, {
      db: {
        async query(sql, params) {
          queries.push({ sql, params });
          return { rows: [] };
        },
      },
      userConfigModel: {
        async getVersion(userId) {
          assert.equal(userId, 42);
          return version;
        },
      },
    });

    assert.deepEqual(payload, {
      type: 'user_config_invalidated',
      userId: 42,
      version,
    });
    assert.equal(queries[0].sql, 'SELECT pg_notify($1, $2)');
    assert.equal(queries[0].params[0], userConfigSync.CHANNEL);
    assert.deepEqual(JSON.parse(queries[0].params[1]), payload);
  });

  it('ignores invalid listener payloads and invalidates only the target user', () => {
    const invalidations = [];
    const profileCache = {
      invalidateUserProfile(userId, options) {
        invalidations.push({ userId, options });
      },
    };

    assert.equal(userConfigSync.handleNotification({
      channel: 'other',
      payload: '{}',
    }, { profileCache }), null);
    assert.equal(userConfigSync.handleNotification({
      channel: userConfigSync.CHANNEL,
      payload: '{"type":"wrong","userId":7}',
    }, { profileCache }), null);

    const payload = userConfigSync.handleNotification({
      channel: userConfigSync.CHANNEL,
      payload: JSON.stringify({
        type: 'user_config_invalidated',
        userId: 7,
        version: '2026-07-09T13:00:00.000Z',
      }),
    }, { profileCache });

    assert.deepEqual(payload, {
      type: 'user_config_invalidated',
      userId: 7,
      version: '2026-07-09T13:00:00.000Z',
    });
    assert.deepEqual(invalidations, [{
      userId: 7,
      options: { configVersion: '2026-07-09T13:00:00.000Z' },
    }]);
  });

  it('starts a dedicated LISTEN connection and releases it on stop', async () => {
    class FakeClient extends EventEmitter {
      constructor() {
        super();
        this.queries = [];
        this.released = false;
      }

      async query(sql) {
        this.queries.push(sql);
        return { rows: [] };
      }

      release() {
        this.released = true;
      }
    }

    const client = new FakeClient();
    const invalidations = [];
    await userConfigSync.start({
      pool: {
        async connect() {
          return client;
        },
      },
      profileCache: {
        invalidateUserProfile(userId) {
          invalidations.push(userId);
        },
      },
    });

    assert.deepEqual(client.queries, [`LISTEN ${userConfigSync.CHANNEL}`]);
    client.emit('notification', {
      channel: userConfigSync.CHANNEL,
      payload: JSON.stringify({ type: 'user_config_invalidated', userId: 9 }),
    });
    assert.deepEqual(invalidations, [9]);

    await userConfigSync.stop();
    assert.deepEqual(client.queries, [
      `LISTEN ${userConfigSync.CHANNEL}`,
      `UNLISTEN ${userConfigSync.CHANNEL}`,
    ]);
    assert.equal(client.released, true);
  });

  it('reconciles cached config versions in bounded batches', async () => {
    const userIds = Array.from({ length: 1001 }, (_, index) => index + 1);
    const batches = [];
    const invalidatedVersions = [];
    const result = await userConfigSync.reconcileCachedProfiles({
      profileCache: {
        listCachedProfileVersions() {
          return new Map(userIds.map((userId) => [userId, null]));
        },
        invalidateProfilesWithDifferentVersions(versions) {
          invalidatedVersions.push(versions);
          return versions.size;
        },
      },
      userConfigModel: {
        async getVersions(batch) {
          batches.push(batch);
          return new Map(batch.map((userId) => [userId, '2026-07-22T12:00:00.000Z']));
        },
      },
    });

    assert.deepEqual(batches.map((batch) => batch.length), [1000, 1]);
    assert.deepEqual(invalidatedVersions.map((versions) => versions.size), [1000, 1]);
    assert.deepEqual(result, { checked: 1001, invalidated: 1001 });
  });

  it('reconnects the distributed listener after its connection ends', async () => {
    class FakeClient extends EventEmitter {
      constructor() {
        super();
        this.queries = [];
      }

      async query(sql) {
        this.queries.push(sql);
        return { rows: [] };
      }

      release() {}
    }

    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const clients = [firstClient, secondClient];
    let connectCalls = 0;
    let reconnectCallback = null;
    await userConfigSync.start({
      pool: {
        async connect() {
          const client = clients[connectCalls];
          connectCalls += 1;
          return client;
        },
      },
      setTimeoutFn(callback) {
        reconnectCallback = callback;
        return { unref() {} };
      },
      clearTimeoutFn() {},
    });

    firstClient.emit('end');
    assert.equal(userConfigSync.getStatus().listening, false);
    assert.equal(typeof reconnectCallback, 'function');
    reconnectCallback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(connectCalls, 2);
    assert.deepEqual(secondClient.queries, [`LISTEN ${userConfigSync.CHANNEL}`]);
    assert.equal(userConfigSync.getStatus().listening, true);
  });

  it('schedules recovery when the initial listener connection fails', async () => {
    const client = new EventEmitter();
    client.queries = [];
    client.query = async (sql) => {
      client.queries.push(sql);
      return { rows: [] };
    };
    client.release = () => {};
    let connectCalls = 0;
    let reconnectCallback = null;

    await assert.rejects(userConfigSync.start({
      pool: {
        async connect() {
          connectCalls += 1;
          if (connectCalls === 1) throw new Error('database unavailable');
          return client;
        },
      },
      setTimeoutFn(callback) {
        reconnectCallback = callback;
        return { unref() {} };
      },
      clearTimeoutFn() {},
    }), /database unavailable/);

    reconnectCallback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connectCalls, 2);
    assert.equal(userConfigSync.getStatus().listening, true);
  });
});

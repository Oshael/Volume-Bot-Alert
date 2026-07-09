const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const backendAlertRealtime = require('../src/services/backend-alert-realtime');

afterEach(async () => {
  await backendAlertRealtime.stop();
});

describe('backend alert realtime transport', () => {
  it('publishes only type, event id and user id', async () => {
    const queries = [];
    const payload = await backendAlertRealtime.publishEventCreated({
      id: 91,
      userId: 7,
      ruleKey: 'monitored-vol',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      payload: { shouldNotLeak: true },
    }, {
      db: {
        async query(sql, params) {
          queries.push({ sql, params });
          return { rows: [] };
        },
      },
    });

    assert.deepEqual(payload, {
      type: backendAlertRealtime.PAYLOAD_TYPE,
      eventId: 91,
      userId: 7,
    });
    assert.equal(queries[0].sql, 'SELECT pg_notify($1, $2)');
    assert.equal(queries[0].params[0], backendAlertRealtime.CHANNEL);
    assert.deepEqual(JSON.parse(queries[0].params[1]), payload);
  });

  it('publishes global GMGN claim alerts without leaking event payload details', async () => {
    const queries = [];
    const payload = await backendAlertRealtime.publishEventCreated({
      id: 92,
      ruleKey: 'gmgn-claim-signal',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      payload: { shouldNotLeak: true },
    }, {
      db: {
        async query(sql, params) {
          queries.push({ sql, params });
          return { rows: [] };
        },
      },
    });

    assert.deepEqual(payload, {
      type: backendAlertRealtime.GLOBAL_ALERT_PAYLOAD_TYPE,
      eventId: 92,
      userId: null,
    });
    assert.deepEqual(JSON.parse(queries[0].params[1]), payload);
  });

  it('reloads the persisted event before emitting to the user room', async () => {
    const calls = [];
    const result = await backendAlertRealtime.emitPersistedEvent({
      type: backendAlertRealtime.PAYLOAD_TYPE,
      eventId: 12,
      userId: 5,
    }, {
      userAlertEventModel: {
        async getEventForUser(eventId, userId) {
          calls.push({ type: 'load', eventId, userId });
          return {
            id: eventId,
            userId,
            ruleKey: 'monitored-vol',
            tokenAddress: 'So11111111111111111111111111111111111111112',
          };
        },
      },
      backendAlertFeed: {
        async buildDashboardAlertEventFromEvent(event) {
          calls.push({ type: 'build', event });
          return { id: event.id, ruleKey: event.ruleKey };
        },
      },
      socketHub: {
        emitBackendAlertEvent(payload, options) {
          calls.push({ type: 'emit', payload, options });
          return true;
        },
      },
    });

    assert.equal(result.emitted, true);
    assert.deepEqual(calls.map((call) => call.type), ['load', 'build', 'emit']);
    assert.deepEqual(calls[2].options, { userId: 5 });
  });

  it('does not emit when the notified event id does not belong to the user', async () => {
    let emitted = false;
    const result = await backendAlertRealtime.emitPersistedEvent({
      type: backendAlertRealtime.PAYLOAD_TYPE,
      eventId: 12,
      userId: 5,
    }, {
      userAlertEventModel: {
        async getEventForUser() {
          return null;
        },
      },
      backendAlertFeed: {
        async buildDashboardAlertEventFromEvent() {
          throw new Error('must not build payload for mismatched event');
        },
      },
      socketHub: {
        emitBackendAlertEvent() {
          emitted = true;
          return true;
        },
      },
    });

    assert.equal(result.emitted, false);
    assert.equal(result.reason, 'event_not_found');
    assert.equal(emitted, false);
  });

  it('reloads and broadcasts persisted global alert events', async () => {
    const calls = [];
    const result = await backendAlertRealtime.emitPersistedEvent({
      type: backendAlertRealtime.GLOBAL_ALERT_PAYLOAD_TYPE,
      eventId: 44,
      userId: null,
    }, {
      gmgnClaimAlertEventModel: {
        async getEventById(eventId) {
          calls.push({ type: 'load-global', eventId });
          return {
            id: eventId,
            ruleKey: 'gmgn-claim-signal',
            tokenAddress: 'So11111111111111111111111111111111111111112',
          };
        },
      },
      backendAlertFeed: {
        async buildDashboardAlertEventFromEvent(event) {
          calls.push({ type: 'build', event });
          return { id: event.id, ruleKey: event.ruleKey };
        },
      },
      socketHub: {
        emitBackendAlertEvent(payload, options) {
          calls.push({ type: 'emit', payload, options });
          return true;
        },
      },
    });

    assert.equal(result.emitted, true);
    assert.deepEqual(calls.map((call) => call.type), ['load-global', 'build', 'emit']);
    assert.deepEqual(calls[2].options, { userId: null });
  });

  it('starts a dedicated LISTEN connection and handles notifications', async () => {
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
    const emitted = [];
    await backendAlertRealtime.start({
      pool: {
        async connect() {
          return client;
        },
      },
      userAlertEventModel: {
        async getEventForUser(eventId, userId) {
          return { id: eventId, userId, ruleKey: 'monitored-vol' };
        },
      },
      backendAlertFeed: {
        async buildDashboardAlertEventFromEvent(event) {
          return { id: event.id, ruleKey: event.ruleKey };
        },
      },
      socketHub: {
        emitBackendAlertEvent(payload, options) {
          emitted.push({ payload, options });
          return true;
        },
      },
    });

    assert.deepEqual(client.queries, [`LISTEN ${backendAlertRealtime.CHANNEL}`]);
    client.emit('notification', {
      channel: backendAlertRealtime.CHANNEL,
      payload: JSON.stringify({
        type: backendAlertRealtime.PAYLOAD_TYPE,
        eventId: 33,
        userId: 8,
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(emitted, [{
      payload: { id: 33, ruleKey: 'monitored-vol' },
      options: { userId: 8 },
    }]);

    await backendAlertRealtime.stop();
    assert.deepEqual(client.queries, [
      `LISTEN ${backendAlertRealtime.CHANNEL}`,
      `UNLISTEN ${backendAlertRealtime.CHANNEL}`,
    ]);
    assert.equal(client.released, true);
  });
});

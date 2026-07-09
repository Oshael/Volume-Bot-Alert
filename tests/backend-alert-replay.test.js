const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const backendAlertRealtime = require('../src/services/backend-alert-realtime');
const backendAlertReplay = require('../src/services/backend-alert-replay');

const USER_RULE = Object.freeze({
  ruleKey: 'monitored-vol',
  scope: 'user-token',
  dashboardFeedEnabled: true,
});

function createCursorModel(initialSeenByRule = {}) {
  const marked = [];
  const state = new Map(Object.entries(initialSeenByRule));
  return {
    marked,
    async getCursor(userId, ruleKey) {
      const lastSeenEventId = state.get(ruleKey) || null;
      return lastSeenEventId == null
        ? null
        : { userId, ruleKey, lastSeenEventId, lastAckedEventId: null };
    },
    async markSeen(userId, ruleKey, lastSeenEventId) {
      const previous = state.get(ruleKey) || 0;
      const next = Math.max(previous, lastSeenEventId);
      state.set(ruleKey, next);
      marked.push({ userId, ruleKey, lastSeenEventId });
      return { userId, ruleKey, lastSeenEventId: next, lastAckedEventId: null };
    },
  };
}

function createEventModel(events) {
  return {
    queries: [],
    async listRecentEvents(filters) {
      this.queries.push({ ...filters });
      const afterId = Number(filters.afterId) || 0;
      return events
        .filter((event) => event.userId === filters.userId)
        .filter((event) => event.ruleKey === filters.ruleKey)
        .filter((event) => event.id > afterId)
        .sort((a, b) => a.id - b.id)
        .slice(0, filters.limit);
    },
    async getLatestEventId(filters) {
      const ids = events
        .filter((event) => event.userId === filters.userId)
        .filter((event) => event.ruleKey === filters.ruleKey)
        .map((event) => event.id);
      return ids.length ? Math.max(...ids) : null;
    },
  };
}

function createPresenceModel(activeUserIds = []) {
  const active = new Set(activeUserIds);
  return {
    async listActive(filters) {
      return active.has(filters.userId)
        ? [{ userId: filters.userId, mode: 'foreground' }]
        : [];
    },
  };
}

describe('backend alert replay', () => {
  it('replays user events after the stored cursor and advances lastSeen monotonically', async () => {
    const cursorModel = createCursorModel({ 'monitored-vol': 10 });
    const eventModel = createEventModel([
      { id: 8, userId: 7, ruleKey: 'monitored-vol' },
      { id: 11, userId: 7, ruleKey: 'monitored-vol' },
      { id: 12, userId: 7, ruleKey: 'monitored-vol' },
      { id: 13, userId: 9, ruleKey: 'monitored-vol' },
    ]);
    const emitted = [];

    const result = await backendAlertReplay.replayUserBacklog(7, {
      alertDeliveryCursor: cursorModel,
      userAlertEventModel: eventModel,
      backendAlertRealtime: {
        USER_ALERT_PAYLOAD_TYPE: backendAlertRealtime.USER_ALERT_PAYLOAD_TYPE,
        async emitPersistedEvent(payload) {
          emitted.push(payload);
          return { emitted: true };
        },
      },
      listBackendAlertRules: () => [USER_RULE],
      pageLimit: 50,
    });

    assert.equal(result.emitted, 2);
    assert.deepEqual(emitted.map((payload) => payload.eventId), [11, 12]);
    assert.deepEqual(cursorModel.marked, [
      { userId: 7, ruleKey: 'monitored-vol', lastSeenEventId: 12 },
    ]);
    assert.deepEqual(eventModel.queries.map((query) => query.afterId), [10]);
  });

  it('drains a backlog in pages using the cursor from the previous page', async () => {
    const cursorModel = createCursorModel({ 'monitored-vol': 20 });
    const eventModel = createEventModel([
      { id: 21, userId: 7, ruleKey: 'monitored-vol' },
      { id: 22, userId: 7, ruleKey: 'monitored-vol' },
      { id: 23, userId: 7, ruleKey: 'monitored-vol' },
      { id: 24, userId: 7, ruleKey: 'monitored-vol' },
      { id: 25, userId: 7, ruleKey: 'monitored-vol' },
    ]);
    const emitted = [];

    const result = await backendAlertReplay.replayUserBacklog(7, {
      alertDeliveryCursor: cursorModel,
      userAlertEventModel: eventModel,
      backendAlertRealtime: {
        USER_ALERT_PAYLOAD_TYPE: backendAlertRealtime.USER_ALERT_PAYLOAD_TYPE,
        async emitPersistedEvent(payload) {
          emitted.push(payload.eventId);
          return { emitted: true };
        },
      },
      listBackendAlertRules: () => [USER_RULE],
      pageLimit: 2,
    });

    assert.equal(result.emitted, 5);
    assert.equal(result.pages, 3);
    assert.deepEqual(emitted, [21, 22, 23, 24, 25]);
    assert.deepEqual(eventModel.queries.map((query) => query.afterId), [20, 22, 24]);
    assert.deepEqual(cursorModel.marked.map((item) => item.lastSeenEventId), [22, 24, 25]);
  });

  it('does not run two simultaneous replays for the same user across sockets', async () => {
    let resolveReplay;
    let markReplayStarted;
    let calls = 0;
    const replayStarted = new Promise((resolve) => {
      markReplayStarted = resolve;
    });
    const firstSocket = { id: 'socket-1', user: { id: 7 } };
    const secondSocket = { id: 'socket-2', user: { id: 7 } };
    const options = {
      alertDeliveryCursor: {
        async getCursor() {
          return null;
        },
        async markSeen() {
          return null;
        },
      },
      userAlertEventModel: {
        async listRecentEvents() {
          calls += 1;
          markReplayStarted();
          await new Promise((resolve) => {
            resolveReplay = resolve;
          });
          return [];
        },
      },
      backendAlertRealtime: {
        USER_ALERT_PAYLOAD_TYPE: backendAlertRealtime.USER_ALERT_PAYLOAD_TYPE,
        async emitPersistedEvent() {
          return { emitted: true };
        },
      },
      userAlertPresenceModel: createPresenceModel([7]),
      listBackendAlertRules: () => [USER_RULE],
    };

    const first = backendAlertReplay.replayForSocket(firstSocket, options);
    await replayStarted;
    const second = await backendAlertReplay.replayForSocket(secondSocket, options);
    resolveReplay();
    const firstResult = await first;

    assert.equal(calls, 1);
    assert.equal(second.started, false);
    assert.equal(second.reason, 'replay_in_flight');
    assert.equal(second.replayKey, 'user:7');
    assert.equal(firstResult.started, true);
  });

  it('does not replay offline backlog and advances the cursor to the latest event', async () => {
    const cursorModel = createCursorModel({ 'monitored-vol': 40 });
    const eventModel = createEventModel([
      { id: 41, userId: 7, ruleKey: 'monitored-vol' },
      { id: 42, userId: 7, ruleKey: 'monitored-vol' },
      { id: 43, userId: 7, ruleKey: 'monitored-vol' },
    ]);
    const emitted = [];

    const result = await backendAlertReplay.replayForSocket({ id: 'socket-1', user: { id: 7 } }, {
      alertDeliveryCursor: cursorModel,
      userAlertEventModel: eventModel,
      userAlertPresenceModel: createPresenceModel(),
      backendAlertRealtime: {
        USER_ALERT_PAYLOAD_TYPE: backendAlertRealtime.USER_ALERT_PAYLOAD_TYPE,
        async emitPersistedEvent(payload) {
          emitted.push(payload.eventId);
          return { emitted: true };
        },
      },
      listBackendAlertRules: () => [USER_RULE],
    });

    assert.equal(result.started, true);
    assert.equal(result.skippedReplay, true);
    assert.equal(result.reason, 'inactive_presence');
    assert.equal(result.emitted, 0);
    assert.deepEqual(emitted, []);
    assert.deepEqual(cursorModel.marked, [
      { userId: 7, ruleKey: 'monitored-vol', lastSeenEventId: 43 },
    ]);
  });

  it('replays missed events when the user still has active shared presence', async () => {
    const cursorModel = createCursorModel({ 'monitored-vol': 50 });
    const eventModel = createEventModel([
      { id: 51, userId: 7, ruleKey: 'monitored-vol' },
      { id: 52, userId: 7, ruleKey: 'monitored-vol' },
    ]);
    const emitted = [];

    const result = await backendAlertReplay.replayForSocket({ id: 'socket-1', user: { id: 7 } }, {
      alertDeliveryCursor: cursorModel,
      userAlertEventModel: eventModel,
      userAlertPresenceModel: createPresenceModel([7]),
      backendAlertRealtime: {
        USER_ALERT_PAYLOAD_TYPE: backendAlertRealtime.USER_ALERT_PAYLOAD_TYPE,
        async emitPersistedEvent(payload) {
          emitted.push(payload.eventId);
          return { emitted: true };
        },
      },
      listBackendAlertRules: () => [USER_RULE],
      pageLimit: 50,
    });

    assert.equal(result.started, true);
    assert.equal(result.skippedReplay, undefined);
    assert.equal(result.emitted, 2);
    assert.deepEqual(emitted, [51, 52]);
    assert.deepEqual(cursorModel.marked.map((item) => item.lastSeenEventId), [52]);
  });

  it('skips global or realtime-only rules during historical replay', async () => {
    const eventModel = createEventModel([
      { id: 31, userId: 7, ruleKey: 'gmgn-claim-signal' },
      { id: 32, userId: 7, ruleKey: 'monitored-vol' },
    ]);
    const emitted = [];

    const result = await backendAlertReplay.replayUserBacklog(7, {
      alertDeliveryCursor: createCursorModel(),
      userAlertEventModel: eventModel,
      backendAlertRealtime: {
        USER_ALERT_PAYLOAD_TYPE: backendAlertRealtime.USER_ALERT_PAYLOAD_TYPE,
        async emitPersistedEvent(payload) {
          emitted.push(payload.eventId);
          return { emitted: true };
        },
      },
      listBackendAlertRules: () => [
        {
          ruleKey: 'gmgn-claim-signal',
          scope: 'global-signal',
          dashboardFeedEnabled: true,
          historicalReplayEnabled: false,
        },
        {
          ruleKey: 'monitored-vol',
          scope: 'user-token',
          dashboardFeedEnabled: true,
          historicalReplayEnabled: false,
        },
        USER_RULE,
      ],
      pageLimit: 50,
    });

    assert.equal(result.rules, 1);
    assert.deepEqual(emitted, [32]);
    assert.deepEqual(eventModel.queries.map((query) => query.ruleKey), ['monitored-vol']);
  });
});

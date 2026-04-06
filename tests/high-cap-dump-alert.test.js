const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenAlertEvent = require('../src/models/token-alert-event');
const tokenAlertRuleState = require('../src/models/token-alert-rule-state');
const backendAlertPublisher = require('../src/services/backend-alert-publisher');
const highCapDumpAlert = require('../src/services/high-cap-dump-alert');

const TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112';

function createClient(log) {
  return {
    async query(sql) {
      log.push(String(sql).trim());
      return { rows: [] };
    },
    release() {
      log.push('RELEASE');
    },
  };
}

describe('high cap dump alert service', () => {
  it('creates a first event and marks the rule as triggered', async () => {
    const originalGetClient = db.getClient;
    const originalCreateEvent = tokenAlertEvent.createEvent;
    const originalGetState = tokenAlertRuleState.getState;
    const originalUpsertState = tokenAlertRuleState.upsertState;
    const originalPublishEventSafe = backendAlertPublisher.publishEventSafe;
    const clientLog = [];
    const stateWrites = [];
    const eventWrites = [];
    const publishedEvents = [];

    db.getClient = async () => createClient(clientLog);
    tokenAlertRuleState.getState = async () => null;
    tokenAlertEvent.createEvent = async (payload) => {
      eventWrites.push(payload);
      return {
        id: 11,
        ruleKey: payload.ruleKey,
        tokenAddress: payload.tokenAddress,
        triggeredAt: '2026-04-05T18:05:05.000Z',
      };
    };
    tokenAlertRuleState.upsertState = async (payload) => {
      stateWrites.push(payload);
      return {
        ruleKey: payload.ruleKey,
        tokenAddress: payload.tokenAddress,
        status: payload.status,
        lastAlertedAt: payload.lastAlertedAt,
        rearmRequired: payload.rearmRequired,
        metadata: payload.metadata,
      };
    };
    backendAlertPublisher.publishEventSafe = async (event) => {
      publishedEvents.push(event);
      return { payload: { id: event.id }, delivered: true };
    };

    try {
      const result = await highCapDumpAlert.evaluateDetection({
        tokenAddress: TOKEN_ADDRESS,
        baselineTs: '2026-04-05T18:00:00.000Z',
        baselineMcap: 8000000,
        currentTs: '2026-04-05T18:05:00.000Z',
        currentCloseMcap: 4200000,
        windowLowMcap: 3200000,
        latestBucketAgeMs: 15000,
        bucketCount: 5,
        dumpPct: -60,
      });

      assert.equal(result.action, 'triggered');
      assert.equal(result.emitted, true);
      assert.equal(result.rearmed, false);
      assert.equal(eventWrites.length, 1);
      assert.equal(eventWrites[0].thresholdPct, 50);
      assert.equal(stateWrites.length, 1);
      assert.equal(stateWrites[0].status, 'triggered');
      assert.equal(stateWrites[0].rearmRequired, true);
      assert.equal(stateWrites[0].lastAlertedPct, -60);
      assert.deepEqual(publishedEvents, [{
        id: 11,
        ruleKey: highCapDumpAlert.HIGH_CAP_DUMP_RULE_KEY,
        tokenAddress: TOKEN_ADDRESS,
        triggeredAt: '2026-04-05T18:05:05.000Z',
      }]);
      assert.deepEqual(clientLog, ['BEGIN', 'COMMIT', 'RELEASE']);
    } finally {
      db.getClient = originalGetClient;
      tokenAlertEvent.createEvent = originalCreateEvent;
      tokenAlertRuleState.getState = originalGetState;
      tokenAlertRuleState.upsertState = originalUpsertState;
      backendAlertPublisher.publishEventSafe = originalPublishEventSafe;
    }
  });

  it('suppresses duplicate detections while the same collapse leg is still triggered', async () => {
    const originalGetClient = db.getClient;
    const originalCreateEvent = tokenAlertEvent.createEvent;
    const originalGetState = tokenAlertRuleState.getState;
    const originalUpsertState = tokenAlertRuleState.upsertState;
    const clientLog = [];
    const stateWrites = [];
    let createEventCalls = 0;

    db.getClient = async () => createClient(clientLog);
    tokenAlertRuleState.getState = async () => ({
      ruleKey: highCapDumpAlert.HIGH_CAP_DUMP_RULE_KEY,
      tokenAddress: TOKEN_ADDRESS,
      status: 'triggered',
      lastBaselineTs: '2026-04-05T18:00:00.000Z',
      lastBaselineMcap: 8000000,
      lastWindowLowMcap: 3200000,
      lastCurrentTs: '2026-04-05T18:05:00.000Z',
      lastCurrentCloseMcap: 4200000,
      lastAlertedAt: '2026-04-05T18:05:05.000Z',
      lastAlertedPct: -60,
      rearmRequired: true,
      metadata: { lastDecision: 'triggered' },
    });
    tokenAlertEvent.createEvent = async () => {
      createEventCalls += 1;
      throw new Error('should not create a duplicate event');
    };
    tokenAlertRuleState.upsertState = async (payload) => {
      stateWrites.push(payload);
      return payload;
    };

    try {
      const result = await highCapDumpAlert.evaluateDetection({
        tokenAddress: TOKEN_ADDRESS,
        baselineTs: '2026-04-05T18:01:00.000Z',
        baselineMcap: 7900000,
        currentTs: '2026-04-05T18:06:00.000Z',
        currentCloseMcap: 4100000,
        windowLowMcap: 3000000,
        latestBucketAgeMs: 12000,
        bucketCount: 5,
        dumpPct: -62,
      });

      assert.equal(result.action, 'suppressed');
      assert.equal(result.emitted, false);
      assert.equal(result.rearmed, false);
      assert.equal(createEventCalls, 0);
      assert.equal(stateWrites.length, 0);
      assert.deepEqual(clientLog, ['BEGIN', 'COMMIT', 'RELEASE']);
    } finally {
      db.getClient = originalGetClient;
      tokenAlertEvent.createEvent = originalCreateEvent;
      tokenAlertRuleState.getState = originalGetState;
      tokenAlertRuleState.upsertState = originalUpsertState;
    }
  });

  it('rearms without emitting when recovery reaches 85% of the baseline and the dump condition no longer passes', async () => {
    const originalGetClient = db.getClient;
    const originalCreateEvent = tokenAlertEvent.createEvent;
    const originalGetState = tokenAlertRuleState.getState;
    const originalUpsertState = tokenAlertRuleState.upsertState;
    const clientLog = [];
    const stateWrites = [];
    let createEventCalls = 0;

    db.getClient = async () => createClient(clientLog);
    tokenAlertRuleState.getState = async () => ({
      ruleKey: highCapDumpAlert.HIGH_CAP_DUMP_RULE_KEY,
      tokenAddress: TOKEN_ADDRESS,
      status: 'triggered',
      lastBaselineTs: '2026-04-05T18:00:00.000Z',
      lastBaselineMcap: 8000000,
      lastWindowLowMcap: 3200000,
      lastCurrentTs: '2026-04-05T18:05:00.000Z',
      lastCurrentCloseMcap: 4200000,
      lastAlertedAt: '2026-04-05T18:05:05.000Z',
      lastAlertedPct: -60,
      rearmRequired: true,
      metadata: { lastDecision: 'triggered' },
    });
    tokenAlertEvent.createEvent = async () => {
      createEventCalls += 1;
      throw new Error('should not create a new event on pure recovery');
    };
    tokenAlertRuleState.upsertState = async (payload) => {
      stateWrites.push(payload);
      return payload;
    };

    try {
      const result = await highCapDumpAlert.evaluateDetection({
        tokenAddress: TOKEN_ADDRESS,
        baselineTs: '2026-04-05T18:10:00.000Z',
        baselineMcap: 7600000,
        currentTs: '2026-04-05T18:15:00.000Z',
        currentCloseMcap: 6900000,
        windowLowMcap: 6800000,
        latestBucketAgeMs: 14000,
        bucketCount: 5,
        dumpPct: -10.53,
      });

      assert.equal(result.action, 'rearmed');
      assert.equal(result.emitted, false);
      assert.equal(result.rearmed, true);
      assert.equal(result.rearmReason, 'recovery');
      assert.equal(createEventCalls, 0);
      assert.equal(stateWrites.length, 1);
      assert.equal(stateWrites[0].status, 'rearmed');
      assert.equal(stateWrites[0].rearmRequired, false);
      assert.equal(stateWrites[0].metadata.lastRearmReason, 'recovery');
      assert.deepEqual(clientLog, ['BEGIN', 'COMMIT', 'RELEASE']);
    } finally {
      db.getClient = originalGetClient;
      tokenAlertEvent.createEvent = originalCreateEvent;
      tokenAlertRuleState.getState = originalGetState;
      tokenAlertRuleState.upsertState = originalUpsertState;
    }
  });

  it('allows a new alert after 6h even if the token did not recover to 85% of the original baseline', async () => {
    const originalGetClient = db.getClient;
    const originalCreateEvent = tokenAlertEvent.createEvent;
    const originalGetState = tokenAlertRuleState.getState;
    const originalUpsertState = tokenAlertRuleState.upsertState;
    const clientLog = [];
    const stateWrites = [];
    const eventWrites = [];

    db.getClient = async () => createClient(clientLog);
    tokenAlertRuleState.getState = async () => ({
      ruleKey: highCapDumpAlert.HIGH_CAP_DUMP_RULE_KEY,
      tokenAddress: TOKEN_ADDRESS,
      status: 'triggered',
      lastBaselineTs: '2026-04-05T10:00:00.000Z',
      lastBaselineMcap: 8000000,
      lastWindowLowMcap: 3200000,
      lastCurrentTs: '2026-04-05T10:05:00.000Z',
      lastCurrentCloseMcap: 4200000,
      lastAlertedAt: '2026-04-05T10:05:05.000Z',
      lastAlertedPct: -60,
      rearmRequired: true,
      metadata: { lastDecision: 'triggered' },
    });
    tokenAlertEvent.createEvent = async (payload) => {
      eventWrites.push(payload);
      return {
        id: 12,
        ruleKey: payload.ruleKey,
        tokenAddress: payload.tokenAddress,
        triggeredAt: '2026-04-05T16:15:05.000Z',
      };
    };
    tokenAlertRuleState.upsertState = async (payload) => {
      stateWrites.push(payload);
      return payload;
    };

    try {
      const result = await highCapDumpAlert.evaluateDetection({
        tokenAddress: TOKEN_ADDRESS,
        baselineTs: '2026-04-05T16:10:00.000Z',
        baselineMcap: 5000000,
        currentTs: '2026-04-05T16:15:00.000Z',
        currentCloseMcap: 3100000,
        windowLowMcap: 2400000,
        latestBucketAgeMs: 15000,
        bucketCount: 5,
        dumpPct: -52,
      });

      assert.equal(result.action, 'retriggered');
      assert.equal(result.emitted, true);
      assert.equal(result.rearmed, true);
      assert.equal(result.rearmReason, 'timeout');
      assert.equal(eventWrites.length, 1);
      assert.equal(eventWrites[0].metadata.rearmedBy, 'timeout');
      assert.equal(stateWrites.length, 1);
      assert.equal(stateWrites[0].status, 'triggered');
      assert.equal(stateWrites[0].metadata.lastRearmReason, 'timeout');
      assert.deepEqual(clientLog, ['BEGIN', 'COMMIT', 'RELEASE']);
    } finally {
      db.getClient = originalGetClient;
      tokenAlertEvent.createEvent = originalCreateEvent;
      tokenAlertRuleState.getState = originalGetState;
      tokenAlertRuleState.upsertState = originalUpsertState;
    }
  });
});

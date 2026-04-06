const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const backendAlertFeed = require('../src/services/backend-alert-feed');
const backendAlertPublisher = require('../src/services/backend-alert-publisher');
const socketHub = require('../src/services/socket-hub');

describe('backend alert publisher', () => {
  it('builds and emits the realtime payload for a persisted backend alert event', async () => {
    const originalBuildDashboardAlertEventFromEvent = backendAlertFeed.buildDashboardAlertEventFromEvent;
    const originalEmitBackendAlertEvent = socketHub.emitBackendAlertEvent;
    const emittedPayloads = [];

    backendAlertFeed.buildDashboardAlertEventFromEvent = async (event) => ({
      id: event.id,
      kind: 'high-cap-dump-5m',
      ruleKey: event.ruleKey,
      address: event.tokenAddress,
    });
    socketHub.emitBackendAlertEvent = (payload) => {
      emittedPayloads.push(payload);
      return true;
    };

    try {
      const result = await backendAlertPublisher.publishEvent({
        id: 11,
        ruleKey: 'high-cap-dump-5m',
        tokenAddress: 'So11111111111111111111111111111111111111112',
      });

      assert.equal(result.delivered, true);
      assert.deepEqual(result.payload, {
        id: 11,
        kind: 'high-cap-dump-5m',
        ruleKey: 'high-cap-dump-5m',
        address: 'So11111111111111111111111111111111111111112',
      });
      assert.deepEqual(emittedPayloads, [result.payload]);
    } finally {
      backendAlertFeed.buildDashboardAlertEventFromEvent = originalBuildDashboardAlertEventFromEvent;
      socketHub.emitBackendAlertEvent = originalEmitBackendAlertEvent;
    }
  });

  it('swallows publishing errors in safe mode and reports the failure', async () => {
    const originalBuildDashboardAlertEventFromEvent = backendAlertFeed.buildDashboardAlertEventFromEvent;

    backendAlertFeed.buildDashboardAlertEventFromEvent = async () => {
      throw new Error('boom');
    };

    try {
      const result = await backendAlertPublisher.publishEventSafe({
        id: 12,
        ruleKey: 'high-cap-dump-5m',
        tokenAddress: 'So11111111111111111111111111111111111111112',
      });

      assert.equal(result.payload, null);
      assert.equal(result.delivered, false);
      assert.equal(result.error?.message, 'boom');
    } finally {
      backendAlertFeed.buildDashboardAlertEventFromEvent = originalBuildDashboardAlertEventFromEvent;
    }
  });
});

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
    const emittedOptions = [];

    backendAlertFeed.buildDashboardAlertEventFromEvent = async (event) => ({
      id: event.id,
      kind: 'gmgn-claim-signal',
      ruleKey: event.ruleKey,
      address: event.tokenAddress,
    });
    socketHub.emitBackendAlertEvent = (payload, options) => {
      emittedPayloads.push(payload);
      emittedOptions.push(options || null);
      return true;
    };

    try {
      const result = await backendAlertPublisher.publishEvent({
        id: 11,
        ruleKey: 'gmgn-claim-signal',
        tokenAddress: 'So11111111111111111111111111111111111111112',
      });

      assert.equal(result.delivered, true);
      assert.deepEqual(result.payload, {
        id: 11,
        kind: 'gmgn-claim-signal',
        ruleKey: 'gmgn-claim-signal',
        address: 'So11111111111111111111111111111111111111112',
      });
      assert.deepEqual(emittedPayloads, [result.payload]);
      assert.deepEqual(emittedOptions, [{ userId: null }]);
    } finally {
      backendAlertFeed.buildDashboardAlertEventFromEvent = originalBuildDashboardAlertEventFromEvent;
      socketHub.emitBackendAlertEvent = originalEmitBackendAlertEvent;
    }
  });

  it('targets user-owned realtime events to the matching authenticated sockets', async () => {
    const originalBuildDashboardAlertEventFromEvent = backendAlertFeed.buildDashboardAlertEventFromEvent;
    const originalEmitBackendAlertEvent = socketHub.emitBackendAlertEvent;
    const emittedOptions = [];

    backendAlertFeed.buildDashboardAlertEventFromEvent = async (event) => ({
      id: event.id,
      kind: 'monitored-vol',
      ruleKey: event.ruleKey,
      address: event.tokenAddress,
    });
    socketHub.emitBackendAlertEvent = (_payload, options) => {
      emittedOptions.push(options || null);
      return true;
    };

    try {
      const result = await backendAlertPublisher.publishEvent({
        id: 12,
        userId: 15,
        ruleKey: 'monitored-vol',
        tokenAddress: 'So11111111111111111111111111111111111111112',
      });

      assert.equal(result.delivered, true);
      assert.deepEqual(emittedOptions, [{ userId: 15 }]);
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
        ruleKey: 'gmgn-claim-signal',
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

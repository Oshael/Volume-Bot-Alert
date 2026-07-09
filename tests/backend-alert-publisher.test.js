const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const backendAlertFeed = require('../src/services/backend-alert-feed');
const backendAlertPublisher = require('../src/services/backend-alert-publisher');
const backendAlertRealtime = require('../src/services/backend-alert-realtime');

describe('backend alert publisher', () => {
  it('builds the dashboard payload and notifies the web runtime for a user event', async () => {
    const originalBuildDashboardAlertEventFromEvent = backendAlertFeed.buildDashboardAlertEventFromEvent;
    const originalPublishEventCreated = backendAlertRealtime.publishEventCreated;
    const notifications = [];

    backendAlertFeed.buildDashboardAlertEventFromEvent = async (event) => ({
      id: event.id,
      kind: 'monitored-vol',
      ruleKey: event.ruleKey,
      address: event.tokenAddress,
    });
    backendAlertRealtime.publishEventCreated = async (event) => {
      notifications.push(event);
      return {
        type: backendAlertRealtime.PAYLOAD_TYPE,
        eventId: event.id,
        userId: event.userId,
      };
    };

    try {
      const event = {
        id: 12,
        userId: 15,
        ruleKey: 'monitored-vol',
        tokenAddress: 'So11111111111111111111111111111111111111112',
      };
      const result = await backendAlertPublisher.publishEvent(event);

      assert.equal(result.delivered, false);
      assert.equal(result.notified, true);
      assert.deepEqual(result.payload, {
        id: 12,
        kind: 'monitored-vol',
        ruleKey: 'monitored-vol',
        address: 'So11111111111111111111111111111111111111112',
      });
      assert.deepEqual(notifications, [event]);
    } finally {
      backendAlertFeed.buildDashboardAlertEventFromEvent = originalBuildDashboardAlertEventFromEvent;
      backendAlertRealtime.publishEventCreated = originalPublishEventCreated;
    }
  });

  it('notifies the web runtime for global GMGN claim events', async () => {
    const originalBuildDashboardAlertEventFromEvent = backendAlertFeed.buildDashboardAlertEventFromEvent;
    const originalPublishEventCreated = backendAlertRealtime.publishEventCreated;
    const notifications = [];

    backendAlertFeed.buildDashboardAlertEventFromEvent = async (event) => ({
      id: event.id,
      kind: 'gmgn-claim-signal',
      ruleKey: event.ruleKey,
      address: event.tokenAddress,
    });
    backendAlertRealtime.publishEventCreated = async (event) => {
      notifications.push(event);
      return {
        type: backendAlertRealtime.GLOBAL_ALERT_PAYLOAD_TYPE,
        eventId: event.id,
        userId: null,
      };
    };

    try {
      const event = {
        id: 13,
        ruleKey: 'gmgn-claim-signal',
        tokenAddress: 'So11111111111111111111111111111111111111112',
      };
      const result = await backendAlertPublisher.publishEvent(event);

      assert.equal(result.delivered, false);
      assert.equal(result.notified, true);
      assert.deepEqual(notifications, [event]);
    } finally {
      backendAlertFeed.buildDashboardAlertEventFromEvent = originalBuildDashboardAlertEventFromEvent;
      backendAlertRealtime.publishEventCreated = originalPublishEventCreated;
    }
  });

  it('does not notify unsupported global events without a realtime transport contract', async () => {
    const originalBuildDashboardAlertEventFromEvent = backendAlertFeed.buildDashboardAlertEventFromEvent;
    const originalPublishEventCreated = backendAlertRealtime.publishEventCreated;
    let notified = false;

    backendAlertFeed.buildDashboardAlertEventFromEvent = async (event) => ({
      id: event.id,
      kind: event.ruleKey,
      ruleKey: event.ruleKey,
    });
    backendAlertRealtime.publishEventCreated = async () => {
      notified = true;
    };

    try {
      const result = await backendAlertPublisher.publishEvent({
        id: 14,
        ruleKey: 'unknown-global',
      });

      assert.equal(result.delivered, false);
      assert.equal(result.notified, false);
      assert.equal(notified, false);
    } finally {
      backendAlertFeed.buildDashboardAlertEventFromEvent = originalBuildDashboardAlertEventFromEvent;
      backendAlertRealtime.publishEventCreated = originalPublishEventCreated;
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
      assert.equal(result.notified, false);
      assert.equal(result.error?.message, 'boom');
    } finally {
      backendAlertFeed.buildDashboardAlertEventFromEvent = originalBuildDashboardAlertEventFromEvent;
    }
  });
});

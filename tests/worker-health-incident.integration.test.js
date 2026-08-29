'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const db = require('../src/models/db');
const incidents = require('../src/models/worker-health-incident');
const stage176 = require('../src/utils/db-init-stage176');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const suffix = `${Date.now()}-${process.pid}`;
const componentKey = `health-test-${suffix}`;
const incident = {
  id: `${componentKey}:telemetry:component_stopped`,
  componentKey,
  componentLabel: 'Health integration worker',
  group: 'test', code: 'component_stopped', severity: 'critical',
  path: 'telemetry', observedValue: false, threshold: true,
};

async function cleanup() {
  await db.query('DELETE FROM worker_health_incidents WHERE component_key LIKE $1',
    [`health-test-${suffix}%`]);
  await db.query('DELETE FROM worker_health_maintenance WHERE component_key LIKE $1',
    [`health-test-${suffix}%`]);
}

describe('worker health incident persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage176.init({ closePool: false });
  });
  beforeEach(cleanup);
  after(async () => {
    await cleanup().catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('debounces observations, deduplicates an open incident and publishes one recovery', async () => {
    const first = await incidents.reconcile({
      issues: [incident], evaluatedComponents: [componentKey], minimumObservations: 2,
    });
    const second = await incidents.reconcile({
      issues: [incident], evaluatedComponents: [componentKey], minimumObservations: 2,
    });
    assert.equal(first[0].status, 'observing');
    assert.equal(second[0].status, 'open');
    assert.equal(second[0].consecutiveObservations, 2);

    const [claimed] = await incidents.claimNotifications({
      owner: 'health-integration-a', cooldownMs: 60_000,
    });
    assert.equal(claimed.notificationKind, 'incident');
    await incidents.releaseNotificationClaim({
      incidentKey: incident.id, owner: 'health-integration-a', kind: 'incident', retryMs: 60_000,
    });
    assert.deepEqual(await incidents.claimNotifications({
      owner: 'health-integration-retry', cooldownMs: 60_000,
    }), []);
    await db.query(`UPDATE worker_health_incidents SET notification_next_attempt_at = NOW()
      WHERE incident_key = $1`, [incident.id]);
    const [reclaimed] = await incidents.claimNotifications({
      owner: 'health-integration-a', cooldownMs: 60_000,
    });
    assert.equal(reclaimed.notificationKind, 'incident');
    const stale = await incidents.markNotificationSent({
      incidentKey: incident.id, owner: 'stale-owner', kind: 'incident',
    });
    assert.equal(stale, null);
    const sent = await incidents.markNotificationSent({
      incidentKey: incident.id, owner: 'health-integration-a', kind: 'incident',
    });
    assert.equal(sent.notificationCount, 1);
    assert.deepEqual(await incidents.claimNotifications({
      owner: 'health-integration-b', cooldownMs: 60_000,
    }), []);

    const [resolved] = await incidents.reconcile({
      issues: [], evaluatedComponents: [componentKey], minimumObservations: 2,
    });
    assert.equal(resolved.status, 'resolved');
    const [recovery] = await incidents.claimNotifications({
      owner: 'health-integration-b', cooldownMs: 60_000,
    });
    assert.equal(recovery.notificationKind, 'recovery');
    await incidents.markNotificationSent({
      incidentKey: incident.id, owner: 'health-integration-b', kind: 'recovery',
    });
    assert.deepEqual(await incidents.claimNotifications({
      owner: 'health-integration-c', cooldownMs: 60_000,
    }), []);
    await db.query(`UPDATE worker_health_incidents
      SET notification_next_attempt_at = NOW() + INTERVAL '1 hour' WHERE incident_key = $1`,
    [incident.id]);
    await incidents.reconcile({ issues: [incident], evaluatedComponents: [componentKey] });
    await incidents.reconcile({ issues: [incident], evaluatedComponents: [componentKey] });
    const [reopened] = await incidents.claimNotifications({
      owner: 'health-integration-reopen', cooldownMs: 60_000,
    });
    assert.equal(reopened.notificationKind, 'incident');
  });

  it('suppresses incidents during declared maintenance and resumes after cancellation', async () => {
    const maintenance = await incidents.scheduleMaintenance({
      componentKey, reason: 'planned deploy', createdBy: 'integration-test',
      startsAt: new Date(Date.now() - 1_000), endsAt: new Date(Date.now() + 60_000),
    });
    const suppressed = await incidents.reconcile({
      issues: [incident], evaluatedComponents: [componentKey], minimumObservations: 1,
    });
    assert.deepEqual(suppressed, []);
    assert.deepEqual(await incidents.claimNotifications({
      owner: 'health-maintenance-a', cooldownMs: 60_000,
    }), []);

    await incidents.cancelMaintenance(maintenance.id);
    const [opened] = await incidents.reconcile({
      issues: [incident], evaluatedComponents: [componentKey], minimumObservations: 1,
    });
    assert.equal(opened.status, 'open');
    const claims = await Promise.all([
      incidents.claimNotifications({ owner: 'health-maintenance-a', cooldownMs: 60_000 }),
      incidents.claimNotifications({ owner: 'health-maintenance-b', cooldownMs: 60_000 }),
    ]);
    assert.equal(claims.flat().length, 1);
  });
});

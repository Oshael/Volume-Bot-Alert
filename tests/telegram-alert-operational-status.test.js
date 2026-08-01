const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTelegramAlertTelemetryRepository,
} = require('../src/models/telegram-alert-telemetry');
const {
  buildTelegramAlertHealthSummary,
  createTelegramAlertOperationalStatus,
} = require('../src/services/telegram-alert-operational-status');

const NOW = Date.parse('2026-08-01T20:00:00.000Z');

describe('Telegram alert telemetry repository', () => {
  it('collects bounded operational aggregates without message payloads', async () => {
    const calls = [];
    const repository = createTelegramAlertTelemetryRepository({
      database: {
        async query(sql) {
          calls.push(sql);
          return { rows: [{
            connections_by_status: { active: '2', access_suspended: 1 },
            enabled_profiles_by_chain: { solana: '2', robinhood: 1 },
            deliveries_by_status: { pending: '3', sent: 8 },
            oldest_ready_age_seconds: '42.5',
            delivery_latency_p50_ms: '120.25',
            delivery_latency_p95_ms: 450,
            delivery_latency_sample_size: '8',
            errors_by_code_24h: { rate_limited: '2', bot_blocked: 1 },
            rate_limited_24h: '2',
            last_update_at: '2026-08-01T19:59:00.000Z',
          }] };
        },
      },
    });

    const result = await repository.load();

    assert.match(calls[0], /percentile_cont\(0\.5\)/);
    assert.match(calls[0], /status IN \('pending', 'retry'\)/);
    assert.match(calls[0], /profiles\.connection_id/);
    assert.match(calls[0], /connections\.status <> 'disconnected'/);
    assert.match(calls[0], /ORDER BY update_id DESC LIMIT 1/);
    assert.doesNotMatch(calls[0], /event_payload|chat_id|bot_token/);
    assert.deepEqual(result.deliveryLatencyMs, { p50: 120.25, p95: 450, sampleSize: 8 });
    assert.deepEqual(result.deliveriesByStatus, { pending: 3, sent: 8 });
    assert.equal(result.rateLimited24h, 2);
    assert.equal(result.lastUpdateAt, '2026-08-01T19:59:00.000Z');
  });
});

describe('Telegram alert operational status', () => {
  it('prefers shared lease telemetry and never exposes configured secrets', async () => {
    const metrics = { deliveriesByStatus: { pending: 3 } };
    const status = createTelegramAlertOperationalStatus({
      settings: {
        enabled: true,
        botToken: '123456:secret-token',
        webhookSecret: 'webhook-secret',
        webhookPublicUrl: 'https://api.example.test/telegram',
        appBaseUrl: 'https://app.example.test',
      },
      runtime: {
        getStatus() { return { enabled: true, running: false, totalRuns: 1 }; },
      },
      metricsRepository: { async load() { return metrics; } },
      now: () => NOW,
    });
    const sharedLease = {
      key: 'telegram-alert-runtime',
      ownerHostname: 'worker-2',
      ownerPid: 4321,
      acquiredAt: '2026-08-01T19:00:00.000Z',
      heartbeatAt: '2026-08-01T19:59:55.000Z',
      leaseUntil: '2026-08-01T20:01:00.000Z',
      metadata: {
        telemetry: {
          enabled: true,
          running: true,
          totalRuns: 12,
          sparklineFallbacks: 3,
          lastSummary: {
            errors: 0,
            delivery: { claimed: 2, sent: 2 },
            reactivation: { scanned: 1, reactivated: 1 },
          },
        },
      },
    };

    const result = await status.load({ sharedLease });
    const serialized = JSON.stringify(result);

    assert.equal(result.health, 'ok');
    assert.equal(result.runtime.totalRuns, 12);
    assert.equal(result.runtime.sparklineFallbacks, 3);
    assert.deepEqual(result.metrics, metrics);
    assert.deepEqual(result.configured, {
      enabled: true, bot: true, webhook: true, appUrl: true,
    });
    assert.doesNotMatch(serialized, /secret-token|webhook-secret|chat_id|payload/);
  });

  it('reports disabled and stale-lease states without failing metrics', async () => {
    const build = (enabled) => createTelegramAlertOperationalStatus({
      settings: { enabled },
      runtime: { getStatus() { return { enabled, running: enabled }; } },
      metricsRepository: { async load() { return {}; } },
      now: () => NOW,
    });

    assert.equal((await build(false).load()).health, 'disabled');
    assert.equal((await build(true).load({
      sharedLease: {
        leaseUntil: '2026-08-01T19:59:00.000Z',
        metadata: { telemetry: { enabled: true, running: true } },
      },
    })).health, 'degraded');
  });

  it('degrades safely when metrics fail and builds a public bounded summary', async () => {
    const status = createTelegramAlertOperationalStatus({
      settings: { enabled: true, botToken: 'secret-token' },
      runtime: {
        getStatus() {
          return { running: true, lastError: 'database password leaked here' };
        },
      },
      metricsRepository: {
        async load() { throw new Error('database password leaked here'); },
      },
      now: () => NOW,
    });

    const result = await status.load();
    const summary = buildTelegramAlertHealthSummary(result);
    const serialized = JSON.stringify(summary);

    assert.equal(result.health, 'degraded');
    assert.equal(result.metricsAvailable, false);
    assert.equal(result.metrics, null);
    assert.equal(summary.status, 'degraded');
    assert.equal(summary.runtime.running, true);
    assert.equal(Object.hasOwn(summary, 'lease'), false);
    assert.equal(Object.hasOwn(summary.runtime, 'lastError'), false);
    assert.doesNotMatch(serialized, /secret-token|password leaked/);
  });
});

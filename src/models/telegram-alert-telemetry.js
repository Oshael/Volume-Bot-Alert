const db = require('./db');

function count(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function optionalTimestamp(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function countMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, total]) => [String(key), count(total)]),
  ));
}

function mapTelemetry(row = {}) {
  return Object.freeze({
    connectionsByStatus: countMap(row.connections_by_status),
    enabledProfilesByChain: countMap(row.enabled_profiles_by_chain),
    deliveriesByStatus: countMap(row.deliveries_by_status),
    oldestReadyAgeSeconds: optionalNumber(row.oldest_ready_age_seconds),
    deliveryLatencyMs: Object.freeze({
      p50: optionalNumber(row.delivery_latency_p50_ms),
      p95: optionalNumber(row.delivery_latency_p95_ms),
      sampleSize: count(row.delivery_latency_sample_size),
    }),
    errorsByCode24h: countMap(row.errors_by_code_24h),
    rateLimited24h: count(row.rate_limited_24h),
    lastUpdateAt: optionalTimestamp(row.last_update_at),
  });
}

function createTelegramAlertTelemetryRepository(options = {}) {
  const database = options.database || db;
  if (typeof database?.query !== 'function') {
    throw new TypeError('Telegram alert telemetry database is required');
  }

  async function load() {
    const { rows } = await database.query(
      `WITH latency AS (
         SELECT EXTRACT(EPOCH FROM (delivered_at - created_at)) * 1000 AS duration_ms
         FROM telegram_alert_deliveries
         WHERE status = 'sent'
           AND delivered_at >= NOW() - INTERVAL '24 hours'
       ), errors AS (
         SELECT last_error_code AS code, COUNT(*)::integer AS total
         FROM telegram_alert_deliveries
         WHERE last_error_code IS NOT NULL
           AND updated_at >= NOW() - INTERVAL '24 hours'
         GROUP BY last_error_code
       )
       SELECT
         COALESCE((
           SELECT jsonb_object_agg(status, total)
           FROM (
             SELECT status, COUNT(*)::integer AS total
             FROM telegram_connections GROUP BY status
           ) counts
         ), '{}'::jsonb) AS connections_by_status,
         COALESCE((
           SELECT jsonb_object_agg(chain, total)
           FROM (
             SELECT chain, COUNT(*)::integer AS total
             FROM telegram_alert_profiles profiles
             JOIN telegram_connections connections
               ON connections.id = profiles.connection_id
              AND connections.user_id = profiles.user_id
             WHERE profiles.enabled = TRUE
               AND connections.status <> 'disconnected'
             GROUP BY chain
           ) counts
         ), '{}'::jsonb) AS enabled_profiles_by_chain,
         COALESCE((
           SELECT jsonb_object_agg(status, total)
           FROM (
             SELECT status, COUNT(*)::integer AS total
             FROM telegram_alert_deliveries GROUP BY status
           ) counts
         ), '{}'::jsonb) AS deliveries_by_status,
         (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))
          FROM telegram_alert_deliveries
          WHERE status IN ('pending', 'retry')) AS oldest_ready_age_seconds,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
          FROM latency) AS delivery_latency_p50_ms,
         (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
          FROM latency) AS delivery_latency_p95_ms,
         (SELECT COUNT(*)::integer FROM latency) AS delivery_latency_sample_size,
         COALESCE((SELECT jsonb_object_agg(code, total) FROM errors), '{}'::jsonb)
           AS errors_by_code_24h,
         COALESCE((SELECT total FROM errors WHERE code = 'rate_limited'), 0)
           AS rate_limited_24h,
         (SELECT received_at FROM telegram_updates ORDER BY update_id DESC LIMIT 1)
           AS last_update_at`,
    );
    return mapTelemetry(rows[0]);
  }

  return Object.freeze({ load });
}

module.exports = {
  createTelegramAlertTelemetryRepository,
};

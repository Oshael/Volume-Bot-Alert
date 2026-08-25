'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { createCalloutSpool } = require('../services/callout-spool');
const { createFomoLocalCollector } = require('../services/fomo-local-collector');

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function jwtProvider() {
  const file = String(process.env.FOMO_WS_JWT_FILE || '').trim();
  if (!file) return undefined;
  const resolved = path.resolve(file);
  return async () => (await fs.readFile(resolved, 'utf8')).trim();
}

async function main() {
  const spoolRoot = path.resolve(required(process.env.FOMO_CAPTURE_SPOOL_DIR, 'FOMO_CAPTURE_SPOOL_DIR'));
  const eventMaxBytes = positiveInteger(process.env.FOMO_CAPTURE_EVENT_MAX_TOTAL_MB, 100, 10_000) * 1024 * 1024;
  const identityMaxBytes = positiveInteger(process.env.FOMO_CAPTURE_IDENTITY_MAX_TOTAL_MB, 50, 10_000) * 1024 * 1024;
  const provider = jwtProvider();
  const origin = String(process.env.FOMO_WS_ORIGIN || '').trim();
  const collector = createFomoLocalCollector({
    eventSpool: createCalloutSpool({ directory: path.join(spoolRoot, 'events'), prefix: 'fomo-events', maxTotalBytes: eventMaxBytes }),
    identitySpool: createCalloutSpool({ directory: path.join(spoolRoot, 'identities'), prefix: 'fomo-identities', maxTotalBytes: identityMaxBytes }),
    wsUrl: process.env.FOMO_WS_URL,
    headers: origin ? { Origin: origin } : undefined,
    topicId: required(process.env.FOMO_WS_TOPIC_ID, 'FOMO_WS_TOPIC_ID'),
    authenticationJwt: provider ? undefined : process.env.FOMO_WS_JWT,
    authenticationJwtProvider: provider,
    reconcileIntervalMs: positiveInteger(process.env.FOMO_CAPTURE_RECONCILE_SECONDS, 900, 86_400) * 1000,
    tradeLookupLimit: positiveInteger(process.env.FOMO_CAPTURE_TRADE_LOOKUP_LIMIT, 10, 50),
    threshold: positiveInteger(process.env.FOMO_CAPTURE_THRESHOLD, 1000),
    onError: (error) => console.error(JSON.stringify({ scope: 'fomo_capture', error: error.code })),
  });

  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => finish(signal));
  const durationSeconds = positiveInteger(process.env.FOMO_CAPTURE_DURATION_SECONDS, 0, 86_400);
  const durationTimer = durationSeconds ? setTimeout(() => finish('duration'), durationSeconds * 1000) : null;
  const reportMs = positiveInteger(process.env.FOMO_CAPTURE_REPORT_SECONDS, 60, 3600) * 1000;
  const reporter = setInterval(() => console.log(JSON.stringify({ scope: 'fomo_capture', status: collector.getStatus() })), reportMs);

  collector.start();
  const stopReason = await done;
  if (durationTimer) clearTimeout(durationTimer);
  clearInterval(reporter);
  await collector.stop();
  console.log(JSON.stringify({ scope: 'fomo_capture', stopReason, status: collector.getStatus() }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.code || error.name || 'FOMO_CAPTURE_ERROR', message: error.message }));
    process.exitCode = 1;
  });
}

module.exports = { jwtProvider, main, positiveInteger };

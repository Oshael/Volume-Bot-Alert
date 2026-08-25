'use strict';

require('dotenv').config();

const { appendFile } = require('node:fs/promises');
const { createPumpCalloutClient } = require('../services/pump-callout-client');
const {
  normalizePumpActivity,
  normalizePumpProfile,
  sanitizePumpPayload,
} = require('../services/pump-callout-normalizer');

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function items(body) {
  if (Array.isArray(body)) return body;
  for (const key of ['data', 'items', 'alerts', 'leaderboard', 'callouts']) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

async function capture(client, stream) {
  if (stream === 'profile') {
    const result = await client.getMyProfile();
    return { result, normalized: normalizePumpProfile(result.body || {}) };
  }
  if (stream === 'leaderboard') {
    const result = await client.getLeaderboard({ limit: argument('limit', '50') });
    return { result, normalized: items(result.body).map(normalizePumpProfile) };
  }
  if (stream === 'following-alerts') {
    const result = await client.listFollowingAlerts({
      pageSize: argument('page-size', '50'),
      cursor: argument('cursor'),
    });
    return { result, normalized: items(result.body).map(normalizePumpActivity) };
  }
  throw new TypeError('stream must be profile, leaderboard or following-alerts');
}

async function main() {
  const stream = argument('stream', 'leaderboard');
  const { result, normalized } = await capture(createPumpCalloutClient(), stream);
  const envelope = {
    spoolVersion: 1,
    platform: 'pump',
    stream,
    capturedAt: new Date().toISOString(),
    sequence: Date.now(),
    payload: sanitizePumpPayload(result.body),
    normalized,
    rateLimit: result.rateLimit,
  };
  const line = `${JSON.stringify(envelope)}\n`;
  const outputPath = String(process.env.PUMP_CALLOUT_CAPTURE_PATH || '').trim();
  if (outputPath) {
    await appendFile(outputPath, line, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({ captured: true, stream, outputPath, records: Array.isArray(normalized) ? normalized.length : 1 }));
    return;
  }
  process.stdout.write(line);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      error: error.code || error.name || 'PUMP_PROBE_ERROR',
      message: error.message,
      status: error.status || null,
      retryAfterMs: error.retryAfterMs ?? null,
    }));
    process.exitCode = 1;
  });
}

module.exports = { capture, items };

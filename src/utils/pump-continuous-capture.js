'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { createCalloutSpool } = require('../services/callout-spool');
const { createPumpCalloutClient } = require('../services/pump-callout-client');
const { createPumpLocalCollector } = require('../services/pump-local-collector');

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function createStateStore(filePath) {
  const resolved = path.resolve(filePath);
  return {
    async load() {
      try { return JSON.parse(await fs.readFile(resolved, 'utf8')); } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw Object.assign(new Error('Pump capture state is invalid'), { code: 'PUMP_STATE_INVALID' });
      }
    },
    async save(state) {
      await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
      const temporary = `${resolved}.tmp-${process.pid}`;
      await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await fs.rename(temporary, resolved);
    },
  };
}

function tokenProvider() {
  const file = String(process.env.PUMP_AUTH_TOKEN_FILE || '').trim();
  return file ? async () => (await fs.readFile(path.resolve(file), 'utf8')).trim() : undefined;
}

async function main() {
  const root = path.resolve(required(process.env.PUMP_CAPTURE_SPOOL_DIR, 'PUMP_CAPTURE_SPOOL_DIR'));
  const provider = tokenProvider();
  const eventMax = positiveInteger(process.env.PUMP_CAPTURE_EVENT_MAX_TOTAL_MB, 100, 10_000) * 1024 * 1024;
  const identityMax = positiveInteger(process.env.PUMP_CAPTURE_IDENTITY_MAX_TOTAL_MB, 50, 10_000) * 1024 * 1024;
  const collector = createPumpLocalCollector({
    client: createPumpCalloutClient({ authToken: provider ? undefined : process.env.PUMP_AUTH_TOKEN, authTokenProvider: provider }),
    eventSpool: createCalloutSpool({ directory: path.join(root, 'events'), prefix: 'pump-events', maxTotalBytes: eventMax }),
    identitySpool: createCalloutSpool({ directory: path.join(root, 'identities'), prefix: 'pump-identities', maxTotalBytes: identityMax }),
    stateStore: createStateStore(path.join(root, 'state.json')),
    activityIntervalMs: positiveInteger(process.env.PUMP_CAPTURE_ACTIVITY_SECONDS, 60, 3600) * 1000,
    leaderboardIntervalMs: positiveInteger(process.env.PUMP_CAPTURE_LEADERBOARD_SECONDS, 900, 86_400) * 1000,
    usersPerRound: positiveInteger(process.env.PUMP_CAPTURE_USERS_PER_ROUND, 5, 50),
    userPages: positiveInteger(process.env.PUMP_CAPTURE_USER_PAGES, 2, 5),
    roundDeadlineMs: positiveInteger(process.env.PUMP_CAPTURE_DEADLINE_SECONDS, 45, 300) * 1000,
    onError: (error) => console.error(JSON.stringify({ scope: 'pump_capture', error: error.code })),
  });

  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => finish(signal));
  const duration = positiveInteger(process.env.PUMP_CAPTURE_DURATION_SECONDS, 0, 86_400);
  const durationTimer = duration ? setTimeout(() => finish('duration'), duration * 1000) : null;
  const reporter = setInterval(() => console.log(JSON.stringify({ scope: 'pump_capture', status: collector.getStatus() })),
    positiveInteger(process.env.PUMP_CAPTURE_REPORT_SECONDS, 60, 3600) * 1000);

  await collector.start();
  const stopReason = await done;
  if (durationTimer) clearTimeout(durationTimer);
  clearInterval(reporter);
  collector.stop();
  console.log(JSON.stringify({ scope: 'pump_capture', stopReason, status: collector.getStatus() }));
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ error: error.code || error.name || 'PUMP_CAPTURE_ERROR', message: error.message }));
  process.exitCode = 1;
});

module.exports = { createStateStore, main, positiveInteger, tokenProvider };

'use strict';

const db = require('../models/db');
const { createCalloutCaptureRepository } = require('../models/callout-capture');
const { createPumpCalloutClient } = require('../services/pump-callout-client');
const { normalizePumpProfile } = require('../services/pump-callout-normalizer');
const {
  createProfileObservation, createProfileObservationEnvelope,
} = require('../services/profile-wallet-domain');

const CANDIDATES_SQL = `SELECT platform_user_id
FROM callout_profiles
WHERE platform = 'pump'
  AND username IS NULL
  AND ($1::text IS NULL OR platform_user_id > $1)
ORDER BY platform_user_id
LIMIT $2::int`;

function positiveInteger(value, fallback, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function parseArgs(argv = []) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new TypeError(`Unknown argument: ${item}`);
    const separator = item.indexOf('=');
    if (separator > 2) values[item.slice(2, separator)] = item.slice(separator + 1);
    else values[item.slice(2)] = argv[++index];
  }
  const mode = values.mode || 'dry-run';
  if (!['dry-run', 'write'].includes(mode)) throw new TypeError('mode must be dry-run or write');
  return Object.freeze({
    mode,
    limit: positiveInteger(values.limit, 100, 1_000),
    concurrency: positiveInteger(values.concurrency, 3, 10),
    after: String(values.after || '').trim() || null,
  });
}

async function concurrentMap(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

function profileEnvelope(identifier, body, observedAt, sequence) {
  const normalized = normalizePumpProfile({ ...(body || {}), platformUserId: identifier });
  if (!normalized.username && !normalized.profilePictureUrl) return null;
  const observation = createProfileObservation({
    ...normalized, observedAt, source: 'user_profile_backfill',
    wallets: normalized.wallets.map((wallet) => ({
      ...wallet, relationType: 'profile_wallet', sourceType: 'platform_reported',
      confidence: 'high', sourceRecordId: identifier,
    })),
  });
  return createProfileObservationEnvelope(observation, {
    capturedAt: observedAt, stream: 'user_profile_backfill', sequence,
  });
}

async function runPumpProfileBackfill(options = {}, dependencies = {}) {
  const database = dependencies.database || db;
  const client = dependencies.client || createPumpCalloutClient();
  const repository = dependencies.repository || createCalloutCaptureRepository({ database });
  const result = await database.query(CANDIDATES_SQL, [options.after || null, options.limit || 100]);
  const identifiers = result.rows.map((row) => String(row.platform_user_id));
  const base = {
    mode: options.mode || 'dry-run', candidates: identifiers.length,
    nextAfter: identifiers.at(-1) || null,
  };
  if (base.mode !== 'write' || identifiers.length === 0) {
    return { ...base, enriched: 0, failures: 0, errors: {} };
  }

  const observedAt = new Date((dependencies.now || Date.now)()).toISOString();
  const errors = {};
  const fetched = await concurrentMap(identifiers, options.concurrency || 3, async (identifier, index) => {
    try {
      const response = await client.getUserProfile(identifier);
      return profileEnvelope(identifier, response.body, observedAt, index);
    } catch (error) {
      const code = String(error?.code || error?.name || 'PUMP_PROFILE_ERROR');
      errors[code] = (errors[code] || 0) + 1;
      return null;
    }
  });
  const envelopes = fetched.filter(Boolean);
  if (envelopes.length) {
    await repository.commitCapture({
      profileEnvelopes: envelopes, calloutEnvelopes: [],
      checkpointKey: 'pump:profile-enrichment',
      checkpointState: {
        version: 1, lastAttemptedId: identifiers.at(-1),
        attempted: identifiers.length, enriched: envelopes.length,
      },
      committedAt: observedAt,
    });
  }
  return {
    ...base, enriched: envelopes.length,
    failures: identifiers.length - envelopes.length, errors,
  };
}

async function main() {
  try {
    console.log(JSON.stringify(
      await runPumpProfileBackfill(parseArgs(process.argv.slice(2))), null, 2
    ));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ error: error.code || error.name, message: error.message }));
  process.exitCode = 1;
});

module.exports = {
  runPumpProfileBackfill,
  __private: { CANDIDATES_SQL, concurrentMap, parseArgs, profileEnvelope },
};

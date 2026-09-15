'use strict';

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) ? status : null;
}

function resultUsers(response) {
  const users = response?.body?.responseObject?.users;
  return Array.isArray(users) ? users : null;
}

function errorCode(status, error) {
  if (status) return `FOMO_PROFILE_SEARCH_HTTP_${status}`;
  return String(error?.code || 'FOMO_PROFILE_SEARCH_REQUEST');
}

async function readSeeds(persistence, cursor, rounds, batchSize) {
  let seeds = await persistence.listSearchSeeds({ afterId: cursor, limit: batchSize });
  if (seeds.length || !cursor) return { cursor, rounds, seeds };
  seeds = await persistence.listSearchSeeds({ afterId: null, limit: batchSize });
  return { cursor: null, rounds: rounds + 1, seeds };
}

async function requestSeed(request, seed) {
  try {
    const term = String(seed?.username || '').trim();
    const response = await request(
      `/v2/users/fuzzy-search?searchTerm=${encodeURIComponent(term)}`
    );
    const status = responseStatus(response);
    const users = status === 200 ? resultUsers(response) : null;
    if (users) return { ok: true, status, users };
    return {
      ok: false, status,
      code: status === 200
        ? 'FOMO_PROFILE_SEARCH_INVALID_RESPONSE' : errorCode(status),
    };
  } catch (error) {
    return { ok: false, status: null, code: errorCode(null, error) };
  }
}

async function collectSeedResults(input) {
  const users = new Map();
  let cursor = input.cursor;
  let returnedProfiles = 0;
  for (let index = 0; index < input.seeds.length; index += 1) {
    const result = await requestSeed(input.request, input.seeds[index]);
    if (!result.ok) {
      return { cursor, users, returnedProfiles, processedTerms: index, failure: result };
    }
    cursor = String(input.seeds[index].platform_user_id);
    returnedProfiles += result.users.length;
    for (const user of result.users) {
      const id = String(user?.id || '').trim();
      if (id && !users.has(id)) users.set(id, user);
    }
    if (index < input.seeds.length - 1) await input.wait(input.delayMs);
  }
  return {
    cursor, users, returnedProfiles, processedTerms: input.seeds.length, failure: null,
  };
}

function runtimeOptions(options) {
  return {
    request: options.request,
    persistence: options.persistence,
    batchSize: positiveInteger(options.batchSize, 20, 100),
    delayMs: positiveInteger(options.delayMs, 1_000, 60_000),
    backoffMs: positiveInteger(options.backoffMs, 60_000, 24 * 60 * 60_000),
    wait: options.wait || waitFor,
    now: options.now || Date.now,
  };
}

function validateDependencies(request, persistence) {
  if (typeof request !== 'function') throw new TypeError('Fomo profile search requires request');
  if (!persistence?.loadSearchState || !persistence?.listSearchSeeds
    || !persistence?.persistSearch) {
    throw new TypeError('Fomo profile search requires persistence');
  }
}

function buildCheckpoint(batch, input) {
  const completedAt = new Date(input.now()).toISOString();
  const nextAttemptAt = batch.failure
    ? new Date(input.now() + input.backoffMs).toISOString() : null;
  return {
    cursor: input.cursor, rounds: input.rounds, completedAt, nextAttemptAt,
    processedTerms: batch.processedTerms, returnedProfiles: batch.returnedProfiles,
    uniqueProfiles: batch.users.size,
    lastHttpStatus: batch.failure?.status || (batch.processedTerms ? 200 : null),
    lastErrorCode: batch.failure?.code || null,
  };
}

async function runFomoProfileSearchBatch(options = {}) {
  const runtime = runtimeOptions(options);
  const {
    request, persistence, batchSize, delayMs, backoffMs, wait, now,
  } = runtime;
  validateDependencies(request, persistence);

  const previous = await persistence.loadSearchState();
  const currentTime = now();
  if (Date.parse(previous.nextAttemptAt) > currentTime) {
    return { skipped: true, reason: 'backoff', nextAttemptAt: previous.nextAttemptAt };
  }

  let rounds = Number(previous.rounds) || 0;
  let cursor = String(previous.cursor || '').trim() || null;
  const seedState = await readSeeds(persistence, cursor, rounds, batchSize);
  ({ cursor, rounds } = seedState);
  const batch = await collectSeedResults({
    cursor, seeds: seedState.seeds, request, wait, delayMs,
  });
  ({ cursor } = batch);
  const { users, failure } = batch;

  if (!failure && seedState.seeds.length < batchSize) {
    cursor = null;
    rounds += 1;
  }
  const checkpoint = buildCheckpoint(batch, {
    cursor, rounds, now, backoffMs,
  });
  const persisted = await persistence.persistSearch([...users.values()], checkpoint);
  return {
    skipped: false, complete: !failure, ...checkpoint,
    persistedProfiles: persisted.profiles, persistedWallets: persisted.wallets,
  };
}

module.exports = { runFomoProfileSearchBatch };

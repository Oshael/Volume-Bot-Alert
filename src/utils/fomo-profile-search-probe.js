'use strict';

require('dotenv').config();

const db = require('../models/db');
const {
  createFomoBrowserApi, responseStatus,
} = require('../services/fomo-browser-follow-queue');

const PROFILE_QUERY = `SELECT platform_user_id, username
  FROM callout_profiles
 WHERE platform = 'fomo'
 ORDER BY last_observed_at DESC, platform_user_id`;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function buildSearchTerms(profiles = [], limit = 100) {
  const terms = [];
  const seen = new Set();
  for (const profile of profiles) {
    const term = String(profile?.username || '').trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

function percentile(values, percentage) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil((percentage / 100) * ordered.length) - 1];
}

function increment(target, key) {
  const normalized = String(key || 'unknown');
  target[normalized] = (target[normalized] || 0) + 1;
}

function resultUsers(response) {
  const users = response?.body?.responseObject?.users;
  return Array.isArray(users) ? users : null;
}

function publicSample(user) {
  return {
    handle: String(user?.userHandle || '').trim() || null,
    hasSolana: Boolean(String(user?.address || '').trim()),
    hasEvm: Boolean(String(user?.evmAddress || '').trim()),
  };
}

async function runFomoProfileSearchProbe(options = {}) {
  const profiles = Array.isArray(options.profiles) ? options.profiles : [];
  const termLimit = boundedInteger(options.termLimit, 100, 1, 100);
  const delayMs = boundedInteger(options.delayMs, 1_000, 250, 10_000);
  const request = options.request;
  const wait = options.wait || ((milliseconds) => new Promise(
    (resolve) => setTimeout(resolve, milliseconds)
  ));
  const now = options.now || Date.now;
  if (typeof request !== 'function') throw new TypeError('Fomo profile search probe requires request');

  const terms = buildSearchTerms(profiles, termLimit);
  const knownIds = new Set(profiles.map(({ platform_user_id: id }) => String(id || '').trim())
    .filter(Boolean));
  const uniqueUsers = new Map();
  const statusCounts = {};
  const errorCounts = {};
  const termReports = [];
  let returnedUsers = 0;
  const startedAt = now();

  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index];
    const requestStartedAt = now();
    try {
      const response = await request(
        `/v2/users/fuzzy-search?searchTerm=${encodeURIComponent(term)}`
      );
      const status = responseStatus(response) || 0;
      increment(statusCounts, status);
      const users = status === 200 ? resultUsers(response) : null;
      if (!users) {
        increment(errorCounts, status === 200 ? 'invalid_shape' : `http_${status || 'unknown'}`);
        termReports.push({ term, status, ok: false, elapsedMs: now() - requestStartedAt });
      } else {
        const newIds = new Set();
        returnedUsers += users.length;
        for (const user of users) {
          const id = String(user?.id || '').trim();
          if (!id) {
            increment(errorCounts, 'missing_user_id');
            continue;
          }
          if (!knownIds.has(id)) newIds.add(id);
          if (!uniqueUsers.has(id)) uniqueUsers.set(id, user);
        }
        termReports.push({
          term, status, ok: true, results: users.length,
          newProfiles: newIds.size, elapsedMs: now() - requestStartedAt,
        });
      }
    } catch (error) {
      increment(errorCounts, error?.code || error?.name || 'request_error');
      termReports.push({
        term, status: null, ok: false, elapsedMs: now() - requestStartedAt,
        errorCode: String(error?.code || error?.name || 'request_error'),
      });
    }
    if (index < terms.length - 1) await wait(delayMs);
  }

  const unique = [...uniqueUsers.entries()];
  const newUsers = unique.filter(([id]) => !knownIds.has(id)).map(([, user]) => user);
  const successful = termReports.filter(({ ok }) => ok);
  const resultCounts = successful.map(({ results }) => results);
  const latencies = termReports.map(({ elapsedMs }) => elapsedMs);
  const observedMax = resultCounts.length ? Math.max(...resultCounts) : null;
  const withSolana = unique.filter(([, user]) => String(user?.address || '').trim()).length;
  const withEvm = unique.filter(([, user]) => String(user?.evmAddress || '').trim()).length;
  const withAnyWallet = unique.filter(([, user]) => (
    String(user?.address || '').trim() || String(user?.evmAddress || '').trim()
  )).length;

  return {
    complete: terms.length > 0 && successful.length === terms.length,
    readOnly: true,
    endpoint: '/v2/users/fuzzy-search',
    knownProfiles: knownIds.size,
    requestedTerms: termLimit,
    testedTerms: terms.length,
    successfulTerms: successful.length,
    failedTerms: terms.length - successful.length,
    delayMs,
    durationMs: now() - startedAt,
    httpStatusCounts: statusCounts,
    errorCounts,
    results: {
      returned: returnedUsers,
      unique: unique.length,
      repeated: Math.max(0, returnedUsers - unique.length),
      alreadyKnown: unique.length - newUsers.length,
      newProfiles: newUsers.length,
      observedMaxPerTerm: observedMax,
      termsAtObservedMax: observedMax == null ? 0
        : successful.filter(({ results }) => results === observedMax).length,
      countPerTerm: {
        min: resultCounts.length ? Math.min(...resultCounts) : null,
        p50: percentile(resultCounts, 50),
        p95: percentile(resultCounts, 95),
        max: observedMax,
      },
    },
    walletCoverage: {
      withAnyWallet, withSolana, withEvm,
      withoutWallet: unique.length - withAnyWallet,
    },
    latencyMs: {
      p50: percentile(latencies, 50), p95: percentile(latencies, 95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    highestNewYieldTerms: successful.sort((left, right) => (
      right.newProfiles - left.newProfiles || right.results - left.results
    )).slice(0, 20).map(({ term, results, newProfiles }) => ({ term, results, newProfiles })),
    newProfileSample: newUsers.slice(0, 20).map(publicSample),
  };
}

function readConfig(env = process.env) {
  return {
    cdpEndpoint: String(env.FOMO_BROWSER_CDP_ENDPOINT || 'http://127.0.0.1:9222').trim(),
    currentUserId: String(env.FOMO_FOLLOW_USER_ID || '').trim() || null,
    termLimit: boundedInteger(env.FOMO_PROFILE_SEARCH_PROBE_LIMIT, 100, 1, 100),
    delayMs: boundedInteger(env.FOMO_PROFILE_SEARCH_PROBE_DELAY_MS, 1_000, 250, 10_000),
    authWaitMs: boundedInteger(env.FOMO_FOLLOW_AUTH_WAIT_SECONDS, 60, 1, 300) * 1_000,
    requestTimeoutMs: boundedInteger(
      env.FOMO_FOLLOW_REQUEST_TIMEOUT_SECONDS, 15, 1, 60
    ) * 1_000,
  };
}

async function main(deps = {}) {
  const database = deps.database || db;
  const createBrowserApi = deps.createBrowserApi || createFomoBrowserApi;
  const config = deps.config || readConfig();
  let api;
  try {
    const profiles = (await database.query(PROFILE_QUERY)).rows;
    api = await createBrowserApi(config);
    const report = await runFomoProfileSearchProbe({
      profiles, request: api.request, termLimit: config.termLimit, delayMs: config.delayMs,
    });
    console.log(JSON.stringify({
      ...report,
      browser: {
        authSource: api.diagnostics?.authSource || null,
        identitySource: api.diagnostics?.identitySource || null,
      },
    }, null, 2));
    return report;
  } finally {
    await api?.close?.().catch(() => {});
    await database.pool?.end?.().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`Fomo profile search probe failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  PROFILE_QUERY, boundedInteger, buildSearchTerms, main, readConfig,
  runFomoProfileSearchProbe,
};

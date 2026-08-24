'use strict';

// Observer-only experiment for X Web Push delivery at cohort scale. Push is the
// live path; a slow private-list read is ground truth for loss measurement only.

const { chromium } = require('@playwright/test');
const { normalizeTimeline } = require('../services/x-timeline-normalizer');
const { graphqlOperation, secureAppend } = require('./x-push-latency-probe');

const OPERATION = 'ListLatestTweetsTimeline';
const SAFE_HEADERS = new Set([
  'accept', 'authorization', 'content-type', 'x-csrf-token', 'x-twitter-active-user',
  'x-twitter-auth-type', 'x-twitter-client-language',
]);

function readPositiveInt(name, fallback, minimum = 1) {
  const value = Number.parseInt(String(process.env[name] || ''), 10);
  return Number.isInteger(value) && value >= minimum ? value : fallback;
}

function validateEndpoint() {
  const value = String(process.env.X_PUSH_OBSERVER_CDP || '').trim();
  if (!/^https?:\/\/(127\.0\.0\.1|localhost):\d+\/?$/i.test(value)) {
    throw new Error('X_PUSH_OBSERVER_CDP must be a localhost CDP URL');
  }
  return value;
}

function percentile(values, proportion) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)];
}

function latencySummary(values) {
  const samples = values.filter(Number.isFinite);
  return {
    samples: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: samples.length ? Math.max(...samples) : null,
    within200: samples.filter((value) => value <= 200).length,
    within500: samples.filter((value) => value <= 500).length,
  };
}

function parsePushEvent(event, observedAt = new Date().toISOString()) {
  if (event?.service !== 'pushMessaging' || event?.eventName !== 'Push message received') return null;
  const raw = event.eventMetadata?.find(({ key }) => key === 'Payload')?.value;
  if (!raw) return null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const match = String(payload.tag || '').match(/^tweet-(\d+)$/);
  if (!match) return null;
  const payloadTimestamp = Number(payload.timestamp);
  const observedMs = Date.parse(observedAt);
  return {
    postId: match[1],
    tag: payload.tag,
    title: typeof payload.title === 'string' ? payload.title : null,
    body: typeof payload.body === 'string' ? payload.body : null,
    payloadTimestamp: Number.isFinite(payloadTimestamp) ? payloadTimestamp : null,
    observedAt,
    transportLatencyMs: Number.isFinite(payloadTimestamp) && Number.isFinite(observedMs)
      ? observedMs - payloadTimestamp
      : null,
  };
}

function headRequestUrl(rawUrl, count) {
  const url = new URL(rawUrl);
  const variables = JSON.parse(url.searchParams.get('variables') || '{}');
  delete variables.cursor;
  variables.count = count;
  url.searchParams.set('variables', JSON.stringify(variables));
  return url.toString();
}

function buildScaleSummary(state) {
  const groundTruthIds = [...state.groundTruth.keys()];
  const missingIds = groundTruthIds.filter((id) => !state.pushes.has(id));
  const unmatchedPushIds = [...state.pushes.keys()].filter((id) => !state.groundTruth.has(id));
  const duplicateIds = [...state.pushCounts].filter(([, count]) => count > 1).map(([id]) => id);
  const matchedIds = groundTruthIds.filter((id) => state.pushes.has(id));
  const endToEnd = matchedIds.map((id) => {
    const postedAt = Date.parse(state.groundTruth.get(id).postedAt);
    const observedAt = Date.parse(state.pushes.get(id).observedAt);
    return Number.isFinite(postedAt) && Number.isFinite(observedAt) ? observedAt - postedAt : null;
  });
  const transport = [...state.pushes.values()].map((push) => push.transportLatencyMs);
  return {
    groundTruthEvents: groundTruthIds.length,
    matched: matchedIds.length,
    missing: missingIds.length,
    coveragePct: groundTruthIds.length ? (matchedIds.length / groundTruthIds.length) * 100 : null,
    missingIds,
    pushes: state.pushes.size,
    unmatchedPushes: unmatchedPushIds.length,
    unmatchedPushIds,
    duplicateEvents: [...state.pushCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    duplicateIds,
    groundTruthErrors: state.groundTruthErrors,
    transportLatency: latencySummary(transport),
    endToEndLatency: latencySummary(endToEnd),
  };
}

function createRecorder(outputPath) {
  let sequence = 0;
  return (type, details = {}) => {
    const record = { sequence: ++sequence, type, observedAt: new Date().toISOString(), ...details };
    const line = JSON.stringify(record);
    console.log(line);
    secureAppend(outputPath, line);
    return record;
  };
}

async function captureListTemplate(page, count) {
  if (!/^https:\/\/x\.com\/i\/lists\/\d+/i.test(page.url())) {
    throw new Error('Keep the private cohort list page open in the observer Chrome');
  }
  const pending = page.waitForResponse((response) => graphqlOperation(response.url()) === OPERATION, {
    timeout: 30000,
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const response = await pending;
  const allHeaders = await response.request().allHeaders();
  const headers = Object.fromEntries(Object.entries(allHeaders).filter(([key]) => SAFE_HEADERS.has(key)));
  return { url: headRequestUrl(response.url(), count), headers, initialBody: await response.json() };
}

function addGroundTruth(state, normalized, emit, baseline = false) {
  for (const item of normalized.posts) {
    const post = item.post;
    if (!post.postId || state.seenTimeline.has(post.postId)) continue;
    state.seenTimeline.add(post.postId);
    if (baseline) continue;
    state.groundTruth.set(post.postId, post);
    emit('ground_truth', {
      postId: post.postId,
      authorScreenName: post.authorScreenName,
      postedAt: post.postedAt,
      kind: post.retweetOfPostId ? 'repost' : 'post',
    });
  }
}

async function observePush(page, startedEpochMs, state, emit) {
  const session = await page.context().newCDPSession(page);
  session.on('BackgroundService.backgroundServiceEventReceived', ({ backgroundServiceEvent }) => {
    const event = backgroundServiceEvent;
    if (!event || Number(event.timestamp) * 1000 < startedEpochMs - 1000) return;
    const browserTimestampMs = Number(event.timestamp) * 1000;
    const observedAt = Number.isFinite(browserTimestampMs)
      ? new Date(browserTimestampMs).toISOString()
      : new Date().toISOString();
    const push = parsePushEvent(event, observedAt);
    if (!push) return;
    state.pushCounts.set(push.postId, (state.pushCounts.get(push.postId) || 0) + 1);
    if (!state.pushes.has(push.postId)) state.pushes.set(push.postId, push);
    emit('push', push);
  });
  await session.send('BackgroundService.setRecording', { service: 'pushMessaging', shouldRecord: true });
  await session.send('BackgroundService.startObserving', { service: 'pushMessaging' });
}

async function main() {
  const endpoint = validateEndpoint();
  const outputPath = String(process.env.X_PUSH_SCALE_OUTPUT || '/tmp/x-push-scale-probe.jsonl');
  const intervalMs = readPositiveInt('X_PUSH_GROUND_TRUTH_MS', 5000, 2000);
  const count = readPositiveInt('X_PUSH_GROUND_TRUTH_COUNT', 100);
  const browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /^https:\/\/x\.com\/i\/lists\/\d+/i.test(candidate.url()));
  if (!page) throw new Error('Observer Chrome must keep the private cohort list page open');

  const emit = createRecorder(outputPath);
  const state = {
    pushes: new Map(), pushCounts: new Map(), groundTruth: new Map(), seenTimeline: new Set(),
    groundTruthErrors: 0,
  };
  const startedEpochMs = Date.now();
  await observePush(page, startedEpochMs, state, emit);
  const template = await captureListTemplate(page, count);
  addGroundTruth(state, normalizeTimeline(template.initialBody), emit, true);

  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const response = await page.context().request.get(template.url, { headers: template.headers });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      addGroundTruth(state, normalizeTimeline(await response.json()), emit);
    } catch (error) {
      state.groundTruthErrors += 1;
      emit('ground_truth_error', { message: error.message });
    } finally {
      polling = false;
    }
  };
  const pollTimer = setInterval(poll, intervalMs);
  const progressTimer = setInterval(() => emit('progress', buildScaleSummary(state)), 60000);
  emit('armed', {
    outputPath, groundTruthIntervalMs: intervalMs, groundTruthCount: count,
    instruction: 'Publish normally from cohort accounts; Ctrl+C emits the final summary.',
  });

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(pollTimer);
    clearInterval(progressTimer);
    emit('summary', { signal, ...buildScaleSummary(state) });
    setImmediate(() => process.exit(0));
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`X push scale probe failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildScaleSummary, headRequestUrl, parsePushEvent };

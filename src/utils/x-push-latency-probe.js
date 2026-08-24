'use strict';

// Read-only experiment for the X push hypothesis. The operator publishes
// manually from one disposable Chrome profile while this process observes the
// CreateTweet submission and Push Messaging events in another profile.
// It never calls an X endpoint or publishes a post itself.
//
// Start two Chrome instances with distinct non-default profiles and localhost
// CDP ports, log in, keep one x.com tab open in each, then run the probe:
//   X_PUSH_PUBLISHER_CDP=http://127.0.0.1:9222
//   X_PUSH_OBSERVER_CDP=http://127.0.0.1:9223
// Optional:
//   X_PUSH_TARGET_MS=200
//   X_PUSH_OUTPUT=/absolute/path/x-push-probe.jsonl

const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const CREATE_POST_OPERATION = /\/i\/api\/graphql\/[^/]+\/CreateTweet(?:[/?]|$)/i;
const POLLING_OPERATIONS = new Set([
  'ListLatestTweetsTimeline',
  'HomeLatestTimeline',
  'HomeTimeline',
  'NotificationsTimeline',
  'UserTweets',
  'UserTweetsAndReplies',
]);

function readPositiveInt(name, fallback) {
  const value = Number.parseInt(String(process.env[name] || ''), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function graphqlOperation(url) {
  const match = String(url).match(/\/i\/api\/graphql\/[^/]+\/([^/?]+)/i);
  return match ? match[1] : null;
}

function isCreatePostUrl(url) {
  return CREATE_POST_OPERATION.test(String(url));
}

function isTimelinePollUrl(url) {
  return POLLING_OPERATIONS.has(graphqlOperation(url));
}

function percentile(values, proportion) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)];
}

function summarize(acks, targetMs) {
  const eligible = acks.filter((ack) => !ack.rejected);
  const latencies = eligible
    .filter((ack) => Number.isFinite(ack.latencyMs))
    .map((ack) => ack.latencyMs);
  const p95Ms = percentile(latencies, 0.95);
  return {
    published: eligible.length,
    rejected: acks.length - eligible.length,
    matched: latencies.length,
    missed: eligible.length - latencies.length,
    targetMs,
    p50Ms: percentile(latencies, 0.5),
    p95Ms,
    maxMs: latencies.length ? Math.max(...latencies) : null,
    withinTarget: latencies.filter((value) => value <= targetMs).length,
    verdict: eligible.length > 0 && latencies.length === eligible.length && p95Ms <= targetMs
      ? 'pass'
      : 'fail',
  };
}

const SENSITIVE_METADATA_KEY = /auth|cookie|token|secret|registration|subscription|endpoint|p256dh/i;
const FCM_ENDPOINT = /https:\/\/fcm\.googleapis\.com\/(?:fcm\/send|wp)\/[^\s"'\\]+/gi;

function redactSensitiveValue(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_METADATA_KEY.test(key) ? '[redacted]' : redactSensitiveValue(nested),
    ]));
  }
  return value;
}

function redactSensitiveText(value) {
  const text = String(value);
  try {
    return JSON.stringify(redactSensitiveValue(JSON.parse(text)), null, 2);
  } catch {
    return text
      .replace(FCM_ENDPOINT, (endpoint) => `${endpoint.slice(0, endpoint.lastIndexOf('/') + 1)}[redacted]`)
      .replace(/("registration_ids?"\s*:\s*)\[[^\]]*\]/gi, '$1["[redacted]"]')
      .replace(/("(?:registration_ids?|endpoint|auth|cookie|token|secret|p256dh)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
  }
}

function safeMetadata(items) {
  return (items || []).slice(0, 30).map(({ key, value }) => ({
    key: String(key).slice(0, 120),
    value: SENSITIVE_METADATA_KEY.test(String(key))
      ? '[redacted]'
      : redactSensitiveText(value).slice(0, 500),
  }));
}

function secureAppend(outputPath, line) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
    | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(outputPath, flags, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeSync(descriptor, `${line}\n`, null, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function createRecorder({ outputPath, targetMs }) {
  const startedEpochMs = Date.now();
  const startedNs = process.hrtime.bigint();
  const acks = [];
  const polls = [];
  let sequence = 0;

  function emit(type, details = {}) {
    const record = {
      sequence: ++sequence,
      type,
      observedAt: new Date().toISOString(),
      elapsedMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
      ...details,
    };
    const line = JSON.stringify(record);
    console.log(line);
    if (outputPath) secureAppend(outputPath, line);
    return record;
  }

  function publishStarted() {
    const attempt = {
      sequence: acks.length + 1,
      observedNs: process.hrtime.bigint(),
      observedAt: new Date().toISOString(),
      acknowledgedNs: null,
      status: null,
      postId: null,
      latencyMs: null,
      ackToPushMs: null,
    };
    acks.push(attempt);
    emit('publish_started', { publishSequence: attempt.sequence });
    return attempt;
  }

  function publishAcknowledged(attempt, status) {
    attempt.acknowledgedNs = process.hrtime.bigint();
    attempt.status = status;
    if (attempt.signalNs) {
      attempt.ackToPushMs = Number(attempt.signalNs - attempt.acknowledgedNs) / 1e6;
    }
    emit('publish_ack', {
      publishSequence: attempt.sequence,
      status,
      postId: attempt.postId,
      submitToPushMs: attempt.latencyMs,
      ackToPushMs: attempt.ackToPushMs,
    });
  }

  function publishRejected(attempt, status) {
    attempt.rejected = true;
    attempt.status = status;
    emit('publish_rejected', { publishSequence: attempt.sequence, status });
  }

  function matchSignal(channel, event) {
    const observedNs = process.hrtime.bigint();
    const ack = acks.find((candidate) => (
      !candidate.rejected && candidate.latencyMs === null && candidate.observedNs <= observedNs
    ));
    const details = {
      channel,
      eventName: event.eventName || null,
      instanceId: event.instanceId || null,
      origin: event.origin || null,
      browserTimestamp: event.timestamp || null,
      metadata: safeMetadata(event.eventMetadata),
    };
    if (!ack) return emit('unpaired_push_signal', details);
    ack.signalNs = observedNs;
    ack.latencyMs = Number(observedNs - ack.observedNs) / 1e6;
    if (ack.acknowledgedNs) {
      ack.ackToPushMs = Number(observedNs - ack.acknowledgedNs) / 1e6;
    }
    emit('push_match', {
      ...details,
      publishSequence: ack.sequence,
      postId: ack.postId,
      submitToPushMs: ack.latencyMs,
      ackToPushMs: ack.ackToPushMs,
      targetMs,
      withinTarget: ack.latencyMs <= targetMs,
    });
    return ack;
  }

  function recordPoll(url, method) {
    const operation = graphqlOperation(url);
    polls.push({ operation, method, observedAt: new Date().toISOString() });
    emit('observer_poll_detected', { operation, method });
  }

  function report() {
    const summary = { ...summarize(acks, targetMs), observerPolls: polls.length };
    emit('summary', summary);
    return summary;
  }

  return {
    startedEpochMs, emit, publishStarted, publishAcknowledged, publishRejected,
    matchSignal, recordPoll, report,
  };
}

function extractPostId(body) {
  return body?.data?.create_tweet?.tweet_results?.result?.rest_id
    || body?.data?.create_tweet?.tweet_results?.result?.tweet?.rest_id
    || null;
}

async function observePublisher(browser, recorder) {
  for (const context of browser.contexts()) {
    const attempts = new WeakMap();
    context.on('request', (request) => {
      if (request.method() !== 'POST' || !isCreatePostUrl(request.url())) return;
      attempts.set(request, recorder.publishStarted());
    });
    context.on('response', (response) => {
      if (response.request().method() !== 'POST' || !isCreatePostUrl(response.url())) return;
      const attempt = attempts.get(response.request()) || recorder.publishStarted();
      if (response.status() < 200 || response.status() >= 300) {
        recorder.publishRejected(attempt, response.status());
        return;
      }
      recorder.publishAcknowledged(attempt, response.status());
      response.json()
        .then((body) => {
          attempt.postId = extractPostId(body);
          recorder.emit('publish_identified', {
            publishSequence: attempt.sequence, postId: attempt.postId,
          });
        })
        .catch(() => recorder.emit('publish_body_unreadable', { publishSequence: attempt.sequence }));
    });
  }
}

async function observeReceiverNetwork(browser, recorder) {
  for (const context of browser.contexts()) {
    context.on('request', (request) => {
      if (isTimelinePollUrl(request.url())) recorder.recordPoll(request.url(), request.method());
    });
  }
}

async function observeBackgroundServices(browser, recorder) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => /^https:\/\/(x\.com|twitter\.com)(?:\/|$)/i.test(candidate.url()));
  if (!page) throw new Error('Observer Chrome must keep one logged-in x.com tab open');
  const session = await page.context().newCDPSession(page);
  session.on('BackgroundService.backgroundServiceEventReceived', ({ backgroundServiceEvent }) => {
    const event = backgroundServiceEvent;
    if (!event || !['pushMessaging', 'notifications'].includes(event.service)) return;
    if (Number(event.timestamp) * 1000 < recorder.startedEpochMs - 1000) return;
    recorder.matchSignal(event.service, event);
  });
  for (const service of ['pushMessaging', 'notifications']) {
    await session.send('BackgroundService.setRecording', { service, shouldRecord: true });
    await session.send('BackgroundService.startObserving', { service });
  }
  return session;
}

function validateEndpoint(name) {
  const value = String(process.env[name] || '').trim();
  if (!/^https?:\/\/(127\.0\.0\.1|localhost):\d+\/?$/i.test(value)) {
    throw new Error(`${name} must be a localhost CDP URL such as http://127.0.0.1:9222`);
  }
  return value;
}

async function main() {
  const publisherEndpoint = validateEndpoint('X_PUSH_PUBLISHER_CDP');
  const observerEndpoint = validateEndpoint('X_PUSH_OBSERVER_CDP');
  if (publisherEndpoint === observerEndpoint) throw new Error('Publisher and observer need distinct Chrome profiles/ports');

  const targetMs = readPositiveInt('X_PUSH_TARGET_MS', 200);
  const outputPath = String(process.env.X_PUSH_OUTPUT || '').trim() || null;
  const recorder = createRecorder({ outputPath, targetMs });
  const publisher = await chromium.connectOverCDP(publisherEndpoint);
  const observer = await chromium.connectOverCDP(observerEndpoint);

  await observePublisher(publisher, recorder);
  await observeReceiverNetwork(observer, recorder);
  await observeBackgroundServices(observer, recorder);
  recorder.emit('armed', {
    targetMs,
    outputPath,
    instruction: 'Publish one post manually; wait for push_match before publishing the next.',
  });

  const stop = (signal) => {
    recorder.emit('stopping', { signal });
    recorder.report();
    setImmediate(() => process.exit(0));
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`X push probe failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  graphqlOperation, isCreatePostUrl, isTimelinePollUrl, redactSensitiveText, safeMetadata,
  secureAppend, summarize,
};

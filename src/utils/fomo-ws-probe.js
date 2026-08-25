'use strict';

require('dotenv').config();

const { appendFile } = require('node:fs/promises');
const { createFomoTradingActivityStream } = require('../services/fomo-trading-activity-stream');

function boundedInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function optionalSubscribePayload() {
  const raw = String(process.env.FOMO_WS_SUBSCRIBE_JSON || '').trim();
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch (_error) { throw new TypeError('FOMO_WS_SUBSCRIBE_JSON must be valid JSON'); }
}

function sessionHeaders() {
  const headers = {};
  const cookie = String(process.env.FOMO_WS_COOKIE || '').trim();
  const authorization = String(process.env.FOMO_WS_AUTHORIZATION || '').trim();
  const origin = String(process.env.FOMO_WS_ORIGIN || '').trim();
  if (cookie) headers.Cookie = cookie;
  if (authorization) headers.Authorization = authorization;
  if (origin) headers.Origin = origin;
  return headers;
}

async function main() {
  const durationMs = boundedInteger(process.env.FOMO_WS_DURATION_SECONDS, 25, 300) * 1000;
  const maxFrames = boundedInteger(process.env.FOMO_WS_MAX_FRAMES, 100, 1000);
  const evidence = [];
  const states = [];
  const errors = [];
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const stream = createFomoTradingActivityStream({
    wsUrl: process.env.FOMO_WS_URL,
    headers: sessionHeaders(),
    authenticationJwt: process.env.FOMO_WS_JWT,
    subscribePayload: optionalSubscribePayload(),
    onEvidence: (frame) => {
      evidence.push(frame);
      if (evidence.length >= maxFrames) finish('max_frames');
    },
    onStatus: ({ state, delayMs, code }) => {
      if (states.length < 50) states.push({ state, delayMs: delayMs ?? null, code: code ?? null });
    },
    onError: (error) => {
      if (errors.length < 10) errors.push({ code: error.code, statusCode: error.statusCode });
    },
  });

  const timer = setTimeout(() => finish('duration'), durationMs);
  stream.start();
  const stopReason = await done;
  clearTimeout(timer);
  stream.stop();

  const envelope = {
    spoolVersion: 1,
    platform: 'fomo',
    stream: 'trading_activity_evidence',
    capturedAt: new Date().toISOString(),
    stopReason,
    states,
    errors,
    metrics: stream.getStatus(),
    evidence,
  };
  const line = `${JSON.stringify(envelope)}\n`;
  const outputPath = String(process.env.FOMO_WS_CAPTURE_PATH || '').trim();
  if (outputPath) {
    await appendFile(outputPath, line, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({ captured: true, outputPath, frames: evidence.length, stopReason }));
    return;
  }
  process.stdout.write(line);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.code || error.name, message: error.message }));
    process.exitCode = 1;
  });
}

module.exports = { optionalSubscribePayload, sessionHeaders };

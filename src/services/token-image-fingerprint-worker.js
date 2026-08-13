'use strict';

// Bloco 1 worker: keeps token_image_fingerprint in sync with the catalog. Each
// cycle it pulls a bounded batch of tokens whose image is new or changed,
// downloads the image, computes pHash/dHash plus the mirrored-image hashes, and
// upserts. It never touches the X ingestion path and is disabled by default; it
// only reads the catalog and writes its own table.

const sharp = require('sharp');
const fingerprintModel = require('../models/token-image-fingerprint');
const { fingerprint } = require('../utils/image-fingerprint');

const DEFAULTS = {
  intervalMs: 60_000,
  batchLimit: 25,
  retryIntervalMs: 6 * 60 * 60_000,
  downloadTimeoutMs: 8_000,
};

async function defaultDownload(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fingerprint the image in both orientations. The mirror hash is computed from
// the flipped buffer, so it costs one extra CPU transform and no extra download.
async function defaultFingerprintBoth(buffer) {
  const base = await fingerprint(buffer);
  const mirrored = await sharp(buffer, { failOn: 'none' }).flop().toBuffer();
  const mirror = await fingerprint(mirrored);
  return { phash: base.phash, dhash: base.dhash, phashMirror: mirror.phash, dhashMirror: mirror.dhash };
}

function createTokenImageFingerprintWorker(options = {}) {
  const model = options.model || fingerprintModel;
  const download = options.download || defaultDownload;
  const fingerprintBoth = options.fingerprintBoth || defaultFingerprintBoth;
  const now = options.now || Date.now;
  const logger = options.logger || console;

  let timer = null;
  let running = false;
  let draining = false;
  const settings = { ...DEFAULTS };
  const metrics = {
    cycles: 0, candidates: 0, computed: 0, failed: 0, errors: 0, lastRunAt: null,
  };

  async function processOne(candidate) {
    const buffer = await download(candidate.sourceImageUrl, settings.downloadTimeoutMs);
    if (!buffer) {
      await model.upsertFingerprint({ ...candidate, ok: false });
      metrics.failed += 1;
      return;
    }
    try {
      const hashes = await fingerprintBoth(buffer);
      await model.upsertFingerprint({ ...candidate, ...hashes, ok: true });
      metrics.computed += 1;
    } catch (err) {
      await model.upsertFingerprint({ ...candidate, ok: false });
      metrics.failed += 1;
      metrics.errors += 1;
      logger.warn?.(`[TokenImageFingerprint] decode failed for ${candidate.tokenAddress}: ${err.message}`);
    }
  }

  async function runOnce() {
    if (draining) return;
    draining = true;
    try {
      const candidates = await model.selectCandidates({
        limit: settings.batchLimit,
        retryIntervalMs: settings.retryIntervalMs,
        now,
      });
      metrics.cycles += 1;
      metrics.candidates += candidates.length;
      metrics.lastRunAt = now();
      for (const candidate of candidates) {
        await processOne(candidate);
      }
    } catch (err) {
      metrics.errors += 1;
      logger.error?.(`[TokenImageFingerprint] cycle error: ${err.message}`);
    } finally {
      draining = false;
    }
  }

  function start(config = {}) {
    if (running) return;
    // retryIntervalMs allows 0 (retry every cycle), so guard NaN explicitly
    // rather than with `||`, which would swallow a legitimate zero.
    const retry = Number(config.retryIntervalMs);
    Object.assign(settings, {
      intervalMs: Math.max(1_000, Number(config.intervalMs) || DEFAULTS.intervalMs),
      batchLimit: Math.max(1, Number(config.batchLimit) || DEFAULTS.batchLimit),
      retryIntervalMs: Number.isFinite(retry) ? Math.max(0, retry) : DEFAULTS.retryIntervalMs,
      downloadTimeoutMs: Math.max(1_000, Number(config.downloadTimeoutMs) || DEFAULTS.downloadTimeoutMs),
    });
    running = true;
    void runOnce();
    timer = setInterval(() => { void runOnce(); }, settings.intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return { running, settings: { ...settings }, ...metrics };
  }

  return { start, stop, runOnce, getStatus };
}

module.exports = createTokenImageFingerprintWorker();
module.exports.createTokenImageFingerprintWorker = createTokenImageFingerprintWorker;

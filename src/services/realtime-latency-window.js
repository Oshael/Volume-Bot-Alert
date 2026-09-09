'use strict';

const DEFAULT_LIMIT = 512;
const STAGES = Object.freeze({
  receiptToPublishedMs: 'receiptsAvailableAt',
  captureToPublishedMs: 'captureCommittedAt',
  projectionToPublishedMs: 'projectionCommittedAt',
});

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? null,
  };
}

function createRealtimeLatencyWindow(options = {}) {
  const limit = Math.max(10, Number(options.limit) || DEFAULT_LIMIT);
  const now = options.now || Date.now;
  const stages = options.stages || STAGES;
  const samples = [];
  let lastEventAt = null;

  function record(marks, publishedAtValue) {
    const publishedAt = timestampMs(publishedAtValue);
    if (publishedAt == null || !marks || typeof marks !== 'object') return false;
    const sample = {};
    for (const [stage, source] of Object.entries(stages)) {
      const startedAt = timestampMs(marks[source]);
      if (startedAt != null && publishedAt >= startedAt) sample[stage] = publishedAt - startedAt;
    }
    if (!Object.keys(sample).length) return false;
    samples.push(sample);
    if (samples.length > limit) samples.splice(0, samples.length - limit);
    lastEventAt = new Date(publishedAt).toISOString();
    return true;
  }

  function snapshot() {
    return {
      sampleCount: samples.length,
      lastEventAt,
      lastEventAgeMs: lastEventAt == null ? null : Math.max(0, now() - Date.parse(lastEventAt)),
      windowLimit: limit,
      stages: Object.fromEntries(Object.keys(stages).map((stage) => [
        stage,
        summarize(samples.map((sample) => sample[stage]).filter(Number.isFinite)),
      ])),
    };
  }

  return Object.freeze({ record, snapshot });
}

module.exports = { createRealtimeLatencyWindow, __private: { percentile, summarize, timestampMs } };

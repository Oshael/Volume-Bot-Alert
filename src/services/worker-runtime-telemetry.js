'use strict';

const fs = require('node:fs');
const os = require('node:os');
const v8 = require('node:v8');
const { monitorEventLoopDelay } = require('node:perf_hooks');

function createWorkerRuntimeTelemetry(options = {}) {
  const histogram = options.histogram || monitorEventLoopDelay({ resolution: 20 });
  const memoryUsage = options.memoryUsage || process.memoryUsage;
  const heapStatistics = options.heapStatistics || v8.getHeapStatistics;
  const statfs = options.statfs || fs.statfsSync;
  const now = options.now || Date.now;
  const cacheMs = Number(options.cacheMs) || 15_000;
  let cached = null;
  let cachedAt = 0;
  histogram.enable?.();

  function snapshot() {
    const capturedAt = now();
    if (cached && capturedAt - cachedAt < cacheMs) return cached;
    const memory = memoryUsage();
    const heapLimit = Number(heapStatistics().heap_size_limit) || 1;
    let disk = null;
    try {
      const value = statfs(process.cwd());
      const totalBytes = Number(value.blocks) * Number(value.bsize);
      const freeBytes = Number(value.bavail) * Number(value.bsize);
      disk = { totalBytes, freeBytes, freePercent: totalBytes > 0 ? freeBytes / totalBytes * 100 : null };
    } catch (_) {}
    cached = {
      hostname: os.hostname(), pid: process.pid, capturedAt: new Date(capturedAt).toISOString(),
      uptimeSeconds: Math.round(process.uptime()), rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed, heapLimitBytes: heapLimit,
      heapUsedPercent: memory.heapUsed / heapLimit * 100,
      eventLoopP99Ms: Number(histogram.percentile?.(99) || 0) / 1e6,
      eventLoopMaxMs: Number(histogram.max || 0) / 1e6,
      disk,
    };
    cachedAt = capturedAt;
    histogram.reset?.();
    return cached;
  }

  return { snapshot, stop: () => histogram.disable?.() };
}

module.exports = { createWorkerRuntimeTelemetry };

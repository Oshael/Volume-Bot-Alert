const { performance } = require('node:perf_hooks');

function createProcessingPersistenceTiming({ now = () => performance.now() } = {}) {
  const totals = {
    attempts: 0, commits: 0, failures: 0, totalMs: 0,
    connectionMs: 0, beginMs: 0, logsMs: 0, v4DeltasMs: 0,
    observationsMs: 0, hourlyMs: 0, outboxMs: 0, commitMs: 0, rollbackMs: 0,
  };

  async function measure(phase, operation) {
    const started = now();
    try {
      return await operation();
    } finally {
      totals[phase] += Math.max(0, now() - started);
    }
  }

  async function attempt(operation) {
    totals.attempts += 1;
    try {
      const result = await measure('totalMs', operation);
      totals.commits += 1;
      return result;
    } catch (error) {
      totals.failures += 1;
      throw error;
    }
  }

  return Object.freeze({
    measure,
    attempt,
    snapshot: () => Object.fromEntries(Object.entries(totals)
      .map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
  });
}

module.exports = { createProcessingPersistenceTiming };

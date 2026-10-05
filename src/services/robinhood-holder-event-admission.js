'use strict';
const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const { CHANNEL, createRobinhoodHolderAdmissionQueue } = require('../models/robinhood-holder-admission-queue');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

function createRobinhoodHolderEventAdmission(deps) {
  const now = deps.now || Date.now;
  const queue = deps.queue || createRobinhoodHolderAdmissionQueue({ database: deps.database });
  const owner = deps.owner || `holder-admission:${process.pid}:${randomUUID()}`;
  let dirty = true; let nextCheck = 0; let retryAfter = 0; let listener;
  const status = { runs: 0, claimed: 0, completed: 0, deferred: 0, reclaimed: 0,
    seeded: 0, errors: 0, lastError: null, listenerError: null,
    lastRunAt: null, lastDurationMs: null, oldestClaimedAgeMs: null };
  function wake() { dirty = true; deps.onWake?.(); }
  function start() {
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({
      channel: CHANNEL, label: 'RobinhoodHolderEventAdmission', shared: true,
      pool: (deps.database || db).pool, onNotification: wake,
      onConnected: () => { status.listenerError = null; wake(); },
      onConnectionError: (error) => { status.listenerError = error.message; },
    });
    void listener.start().catch((error) => { status.listenerError = error.message; });
  }
  async function runDue(input) {
    const started = now();
    if (started < retryAfter || (!dirty && started < nextCheck)) return [];
    dirty = false; nextCheck = started + 5000;
    let tasks = [];
    status.runs += 1; status.lastRunAt = new Date(started).toISOString();
    try {
      tasks = await queue.claim({ owner, limit: Math.min(input.limit, 100) });
      status.claimed += tasks.length;
      status.reclaimed += tasks.filter((task) => task.reclaimed).length;
      status.oldestClaimedAgeMs = tasks.length
        ? Math.max(...tasks.map((task) => Math.max(0, started - new Date(task.created_at).getTime()))) : null;
      if (tasks.length === Math.min(input.limit, 100)) dirty = true;
      if (!tasks.length) { status.lastError = null; return []; }
      const addresses = tasks.map((task) => task.token_address);
      const seeded = await deps.bootstrap.seedNewTokens({ ...input, tokenAddresses: addresses });
      const completed = await queue.completedAddresses(addresses, input.admittedAfter);
      const settled = await queue.settle({ owner, tasks, completed });
      status.seeded += seeded.length; status.completed += settled.completed;
      status.deferred += settled.deferred; status.lastError = null;
      return seeded;
    } catch (error) {
      status.errors += 1; status.lastError = error.message; retryAfter = now() + 5000;
      const settled = await queue.settle({ owner, tasks, error: error.message }).catch(() => null);
      if (settled) status.deferred += settled.deferred;
      // Admission failures retain their own retry; replay must still get its turn.
      return [];
    } finally { status.lastDurationMs = now() - started; }
  }
  return Object.freeze({ start, runDue, getStatus: () => ({ ...status }),
    stop: async () => { await listener?.stop(); } });
}
module.exports = { createRobinhoodHolderEventAdmission };

const { randomUUID } = require('crypto');
const db = require('../models/db');
const {
  createRobinhoodLaunchAnchorOutboxRepository,
} = require('../models/robinhood-launch-anchor-outbox');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const NOTIFY_CHANNEL = 'robinhood_launch_anchor_outbox';
const bounded = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
};
const normalizeOptions = (input = {}) => Object.freeze({
  enabled: input.enabled === true,
  intervalMs: bounded(input.intervalMs, 1000, 100, 60_000),
  leaseMs: bounded(input.leaseMs, 180_000, 10_000, 900_000),
  retryMs: bounded(input.retryMs, 15_000, 1000, 3_600_000),
  maxRetryMs: bounded(input.maxRetryMs, 3_600_000, 60_000, 86_400_000),
  timeoutMs: bounded(input.timeoutMs, 120_000, 1000, 900_000),
});

function createRobinhoodLaunchAnchorLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancel = deps.cancelSchedule || clearTimeout;
  const owner = deps.owner || `launch-anchor-${process.pid}-${randomUUID()}`;
  let options = normalizeOptions(); let timer; let listener; let running = false; let active;
  const status = { enabled: false, running: false, inFlight: false, totalRuns: 0,
    totalWritten: 0, totalDeferred: 0, lastResult: null, lastError: null,
    lastCompletedAt: null };
  const repository = () => deps.repository || (deps.repository ||= (
    deps.repositoryFactory || createRobinhoodLaunchAnchorOutboxRepository
  )({ database: deps.database || db, timeoutMs: options.timeoutMs }));
  const retryDelay = (attempt) => Math.min(options.maxRetryMs,
    options.retryMs * (2 ** Math.min(Math.max(attempt - 1, 0), 8)));
  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    let task;
    try {
      task = await repository().claim({ owner, leaseMs: options.leaseMs });
      if (!task) return { status: 'caught-up' };
      if (!await repository().materialize(task.tokenAddress)) {
        throw Object.assign(new Error('launch inputs are not ready'), { code: 'anchor_not_ready' });
      }
      await repository().complete({ owner, tokenAddress: task.tokenAddress });
      status.totalWritten += 1;
      return { status: 'materialized', tokenAddress: task.tokenAddress };
    } catch (error) {
      if (task) {
        await repository().retry({ owner, tokenAddress: task.tokenAddress,
          retryMs: retryDelay(task.attemptCount), error: `${error.code || 'anchor_error'}:${error.message}`
        }).catch(() => {});
        status.totalDeferred += 1;
      }
      if (error.code === 'anchor_not_ready') {
        return { status: 'deferred', reason: error.code, tokenAddress: task?.tokenAddress || null };
      }
      status.lastError = { code: error.code || 'anchor_error', message: error.message };
      return null;
    } finally { status.inFlight = false; status.lastCompletedAt = new Date().toISOString(); }
  }
  async function runOnce() {
    if (active) return active;
    active = execute().then((result) => {
      if (result) { status.lastResult = result; status.lastError = null; }
      return result;
    }).finally(() => { active = null; });
    return active;
  }
  function queue(delay = options.intervalMs) {
    if (!running) return;
    timer = schedule(async () => { timer = null; await runOnce(); queue(); }, delay);
    timer?.unref?.();
  }
  function wake() { if (running && !active) { if (timer) cancel(timer); timer = null; queue(0); } }
  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input); status.enabled = options.enabled;
    if (!options.enabled) return false;
    running = true; status.running = true;
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({
      channel: NOTIFY_CHANNEL, label: 'RobinhoodLaunchAnchorLiveWorker',
      pool: deps.pool || db.pool, onNotification: wake,
    });
    Promise.resolve(listener.start()).catch((error) => { status.lastError = { message: error.message }; });
    queue(0); return true;
  }
  async function stop() {
    running = false; status.running = false;
    if (timer) cancel(timer); timer = null;
    await Promise.resolve(listener?.stop?.()).catch(() => {});
    if (active) await active.catch(() => {});
  }
  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodLaunchAnchorLiveWorker();
module.exports = { NOTIFY_CHANNEL, createRobinhoodLaunchAnchorLiveWorker,
  getStatus: worker.getStatus, runOnce: worker.runOnce, start: worker.start, stop: worker.stop,
  __private: { normalizeOptions } };

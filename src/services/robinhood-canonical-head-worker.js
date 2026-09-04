'use strict';

const db = require('../models/db');
const { DOMAIN_NOTIFY_CHANNEL } = require('../models/robinhood-chain-capture-journal');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const { createRobinhoodCanonicalHeadRuntime } = require('./robinhood-canonical-head-runtime');

function createRobinhoodCanonicalHeadWorker(deps = {}, options = {}) {
  const database = deps.database || db;
  const idlePollMs = Number(options.idlePollMs) || 100;
  const errorPollMs = Number(options.errorPollMs) || 1000;
  const schedule = deps.schedule || setTimeout;
  const cancel = deps.cancel || clearTimeout;
  const status = {
    running: false, halted: false, listening: false, inFlight: false,
    mode: 'canonical_capture', lastTickAt: null, lastNotifyAt: null,
    lastResult: null, lastError: null, runtime: null,
    totalNotifies: 0, totalErrors: 0, totalClaimed: 0,
    totalInserted: 0, totalDuplicates: 0, totalIgnored: 0,
  };
  let runtime = deps.runtime || null;
  let timer = null; let listener = null; let tickPromise = null;
  let wakePending = false; let onFatal = null;

  async function ensureRuntime() {
    runtime ||= await (deps.runtimeFactory || createRobinhoodCanonicalHeadRuntime)({
      database, rpcClient: deps.rpcClient,
    }, options);
    status.runtime = runtime.snapshot();
    return runtime;
  }

  async function runOnce() {
    status.inFlight = true;
    try {
      const active = await ensureRuntime();
      const result = await active.runOnce();
      status.lastTickAt = new Date().toISOString();
      status.lastResult = result; status.lastError = null;
      status.totalClaimed += result.claimed || 0;
      status.totalInserted += result.inserted || 0;
      status.totalDuplicates += result.duplicates || 0;
      status.totalIgnored += result.ignored || 0;
      status.runtime = active.snapshot();
      return result;
    } catch (error) {
      status.totalErrors += 1;
      status.lastError = {
        code: error.code || 'canonical_head_failed',
        message: String(error.message || error).slice(0, 1000),
      };
      throw error;
    } finally {
      status.inFlight = false;
    }
  }

  async function halt(code, message) {
    const error = Object.assign(new Error(message), { code });
    status.running = false; status.halted = true; status.listening = false;
    status.lastError = { code, message };
    if (timer) cancel(timer);
    timer = null;
    if (listener) await listener.stop().catch(() => {});
    listener = null;
    try { await onFatal?.(error); } catch (fatalError) {
      status.totalErrors += 1;
      status.lastError.propagation = String(fatalError?.message || fatalError).slice(0, 500);
    }
  }

  function scheduleTick(delayMs) {
    if (!status.running || timer) return;
    timer = schedule(() => {
      timer = null;
      tickPromise = runOnce().then(async (result) => {
        const forbidden = status.runtime?.rpcGuard?.forbiddenAttempts || 0;
        if (forbidden > 0) {
          await halt('live_rpc_method_forbidden', 'canonical head attempted eth_getLogs');
          return;
        }
        if ((result.blocked || 0) > 0) {
          await halt('canonical_head_blocked', 'canonical head blocked its block frontier');
          return;
        }
        const delay = wakePending || (result.claimed || 0) > 0 ? 0 : idlePollMs;
        wakePending = false; scheduleTick(delay);
      }).catch(() => {
        const delay = wakePending ? 0 : errorPollMs;
        wakePending = false; scheduleTick(delay);
      }).finally(() => { tickPromise = null; });
    }, delayMs);
    timer?.unref?.();
  }

  function wake() {
    if (!status.running) return;
    if (tickPromise) { wakePending = true; return; }
    if (timer) cancel(timer);
    timer = null; scheduleTick(0);
  }

  async function start(input = {}) {
    if (status.running) return;
    onFatal = typeof input.onFatal === 'function' ? input.onFatal : null;
    await ensureRuntime();
    status.running = true; status.halted = false;
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({
      channel: DOMAIN_NOTIFY_CHANNEL, label: 'RobinhoodCanonicalHead',
      pool: deps.pool || database.pool,
      onNotification: (message) => {
        if (message?.channel !== DOMAIN_NOTIFY_CHANNEL) return;
        status.lastNotifyAt = new Date().toISOString(); status.totalNotifies += 1; wake();
      },
      onConnected: () => { status.listening = true; wake(); },
      onConnectionError: () => { status.listening = false; },
    });
    try { await listener.start(); } catch (error) {
      status.totalErrors += 1;
      status.lastError = { code: 'listener_error', message: String(error.message || error) };
    }
    scheduleTick(0);
  }

  async function stop() {
    status.running = false; status.listening = false;
    if (timer) cancel(timer);
    timer = null;
    if (listener) await listener.stop().catch(() => {});
    listener = null;
    if (tickPromise) await tickPromise.catch(() => {});
  }

  return Object.freeze({ getStatus: () => structuredClone(status), runOnce, start, stop });
}

module.exports = { createRobinhoodCanonicalHeadWorker };

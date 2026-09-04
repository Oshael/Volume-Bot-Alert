'use strict';

const db = require('../models/db');
const {
  createRobinhoodChainDomainOutboxRepository,
} = require('../models/robinhood-chain-domain-outbox');
const { DOMAIN_NOTIFY_CHANNEL } = require('../models/robinhood-chain-capture-journal');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const {
  createRobinhoodChainDomainShadowRunner,
} = require('./robinhood-chain-domain-shadow-runner');

const DOMAINS = Object.freeze(['discovery', 'market']);

function createDomainStatus() {
  return {
    lastResult: null, lastError: null, totalClaimed: 0, totalMatched: 0,
    totalCanonicalOnly: 0, totalDivergent: 0,
  };
}

function createRobinhoodChainDomainShadowWorker(deps = {}, options = {}) {
  const database = deps.database || db;
  const repository = deps.repository
    || createRobinhoodChainDomainOutboxRepository({ database });
  const batchSize = Number(options.batchSize) || 1000;
  const leaseMs = Number(options.leaseMs) || 60_000;
  const maxAttempts = Number(options.maxAttempts) || 5;
  const idlePollMs = Number(options.idlePollMs) || 1000;
  const schedule = deps.schedule || setTimeout;
  const cancel = deps.cancel || clearTimeout;
  const status = {
    running: false, mode: 'shadow_compare', listening: false,
    lastTickAt: null, lastNotifyAt: null, totalNotifies: 0, totalErrors: 0,
    domains: { discovery: createDomainStatus(), market: createDomainStatus() },
  };
  const runners = Object.fromEntries(DOMAINS.map((domain, index) => [domain,
    deps.runners?.[domain] || createRobinhoodChainDomainShadowRunner({
      repository,
      options: {
        domain, batchSize, leaseMs, maxAttempts,
        owner: `${options.owner || `robinhood-chain-domain-shadow:${process.pid}`}:${domain}`,
        reclaim: index === 0,
      },
    }),
  ]));
  let timer = null; let listener = null; let tickPromise = null; let wakePending = false;

  async function runDomain(domain) {
    try {
      const result = await runners[domain].runOnce();
      const current = status.domains[domain];
      current.lastResult = result; current.lastError = null;
      current.totalClaimed += result.claimed;
      current.totalMatched += result.matched;
      current.totalCanonicalOnly += result.canonicalOnly;
      current.totalDivergent += result.divergent;
      return result;
    } catch (error) {
      status.totalErrors += 1;
      status.domains[domain].lastError = String(error?.message || error).slice(0, 1000);
      return null;
    }
  }

  async function runOnce() {
    const results = await Promise.all(DOMAINS.map(runDomain));
    status.lastTickAt = new Date().toISOString();
    return Object.fromEntries(DOMAINS.map((domain, index) => [domain, results[index]]));
  }

  function scheduleTick(delayMs) {
    if (!status.running || timer) return;
    timer = schedule(() => {
      timer = null;
      tickPromise = runOnce().then((results) => {
        const fullBatch = Object.values(results).some((result) => result?.claimed >= batchSize);
        const delay = wakePending || fullBatch ? 0 : idlePollMs;
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

  function handleNotification(message) {
    if (message?.channel !== DOMAIN_NOTIFY_CHANNEL) return;
    status.lastNotifyAt = new Date().toISOString(); status.totalNotifies += 1; wake();
  }

  async function start() {
    if (status.running) return;
    status.running = true;
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({
      channel: DOMAIN_NOTIFY_CHANNEL, label: 'RobinhoodChainDomainShadow',
      pool: deps.pool || database.pool, onNotification: handleNotification,
      onConnected: () => { status.listening = true; wake(); },
      onConnectionError: () => { status.listening = false; },
    });
    try { await listener.start(); } catch (error) {
      status.totalErrors += 1;
      status.domains.discovery.lastError = `listener: ${String(error?.message || error)}`;
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

module.exports = { createRobinhoodChainDomainShadowWorker };

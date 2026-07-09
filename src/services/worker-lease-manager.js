const { randomUUID } = require('crypto');
const os = require('os');
const workerLease = require('../models/worker-lease');

const DEFAULT_RETRY_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_TTL_MS = workerLease.DEFAULT_TTL_MS;

function buildOwnerId() {
  return `${os.hostname()}:${process.pid}:${randomUUID()}`;
}

function toIso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function createWorkerLeaseManager(options = {}) {
  const leaseStore = options.leaseStore || workerLease;
  const ownerId = options.ownerId || buildOwnerId();
  const retryMs = Math.max(1000, Math.trunc(Number(options.retryMs) || DEFAULT_RETRY_MS));
  const heartbeatMs = Math.max(1000, Math.trunc(Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS));
  const ttlMs = Math.max(heartbeatMs * 2, Math.trunc(Number(options.ttlMs) || DEFAULT_TTL_MS));
  const onLeaseLost = typeof options.onLeaseLost === 'function'
    ? options.onLeaseLost
    : (entry) => {
        console.error(`[WorkerLease] Lost lease for ${entry.key}; exiting to avoid duplicate worker execution.`);
        process.exit(1);
      };
  const entries = new Map();
  let stopping = false;

  function getOrCreateEntry(definition) {
    const key = String(definition.key || '').trim();
    if (!key) {
      throw new Error('Worker lease definition key is required');
    }
    if (!entries.has(key)) {
      entries.set(key, {
        key,
        label: definition.label || key,
        state: 'pending',
        started: false,
        ownerId,
        leaseUntil: null,
        acquiredAt: null,
        heartbeatAt: null,
        standbyOwnerId: null,
        lastError: null,
        updatedAt: toIso(new Date()),
        retryTimer: null,
        heartbeatTimer: null,
      });
    }
    return entries.get(key);
  }

  function publicStatus(entry) {
    return {
      key: entry.key,
      label: entry.label,
      state: entry.state,
      started: entry.started,
      ownerId: entry.ownerId,
      leaseUntil: entry.leaseUntil,
      acquiredAt: entry.acquiredAt,
      heartbeatAt: entry.heartbeatAt,
      standbyOwnerId: entry.standbyOwnerId,
      lastError: entry.lastError,
      updatedAt: entry.updatedAt,
    };
  }

  async function renew(entry) {
    if (stopping) {
      return;
    }
    try {
      const lease = await leaseStore.heartbeat(entry.key, ownerId, { ttlMs });
      if (!lease) {
        entry.state = 'lost';
        entry.lastError = 'Lease heartbeat was not renewed';
        entry.updatedAt = toIso(new Date());
        onLeaseLost(publicStatus(entry));
        return;
      }
      entry.state = 'running';
      entry.leaseUntil = lease.leaseUntil;
      entry.heartbeatAt = lease.heartbeatAt;
      entry.lastError = null;
      entry.updatedAt = toIso(new Date());
    } catch (err) {
      entry.state = 'lost';
      entry.lastError = err.message;
      entry.updatedAt = toIso(new Date());
      onLeaseLost(publicStatus(entry));
    }
  }

  function scheduleHeartbeat(entry) {
    if (stopping) return;
    if (entry.heartbeatTimer) return;
    entry.heartbeatTimer = setInterval(() => {
      void renew(entry);
    }, heartbeatMs);
    entry.heartbeatTimer.unref?.();
  }

  function scheduleRetry(entry, definition) {
    if (stopping) return;
    if (entry.retryTimer || entry.started) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      void attemptStart(definition);
    }, retryMs);
    entry.retryTimer.unref?.();
  }

  async function attemptStart(definition) {
    const entry = getOrCreateEntry(definition);
    if (stopping) {
      entry.state = 'stopping';
      entry.updatedAt = toIso(new Date());
      return false;
    }
    if (entry.started) {
      return true;
    }
    try {
      const lease = await leaseStore.acquire(entry.key, ownerId, {
        ttlMs,
        metadata: definition.metadata || {},
      });
      if (stopping) {
        if (lease) {
          await leaseStore.release?.(entry.key, ownerId).catch(() => {});
        }
        entry.state = 'stopped';
        entry.updatedAt = toIso(new Date());
        return false;
      }
      if (!lease) {
        entry.state = 'standby';
        entry.lastError = null;
        entry.updatedAt = toIso(new Date());
        scheduleRetry(entry, definition);
        return false;
      }

      entry.state = 'running';
      entry.acquiredAt = lease.acquiredAt;
      entry.heartbeatAt = lease.heartbeatAt;
      entry.leaseUntil = lease.leaseUntil;
      entry.lastError = null;
      entry.updatedAt = toIso(new Date());
      scheduleHeartbeat(entry);

      await Promise.resolve(definition.start());
      entry.started = true;
      return true;
    } catch (err) {
      entry.state = entry.started ? 'error' : 'standby';
      entry.lastError = err.message;
      entry.updatedAt = toIso(new Date());
      if (!entry.started) {
        if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
        entry.heartbeatTimer = null;
        await leaseStore.release?.(entry.key, ownerId).catch(() => {});
        scheduleRetry(entry, definition);
      }
      return false;
    }
  }

  function start(definition) {
    const entry = getOrCreateEntry(definition);
    if (stopping) {
      entry.state = 'stopping';
      entry.updatedAt = toIso(new Date());
      return publicStatus(entry);
    }
    void attemptStart(definition);
    return publicStatus(entry);
  }

  function getStatus() {
    return Array.from(entries.values()).map(publicStatus);
  }

  async function stop(options = {}) {
    stopping = true;
    const releaseLeases = options.releaseLeases !== false;
    const releasePromises = [];
    let releasedCount = 0;
    let missedCount = 0;
    let errorCount = 0;

    for (const entry of entries.values()) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
      entry.retryTimer = null;
      entry.heartbeatTimer = null;

      if (releaseLeases && (entry.started || entry.acquiredAt || entry.leaseUntil)) {
        releasePromises.push(
          leaseStore.release(entry.key, ownerId)
            .then((released) => {
              entry.state = released ? 'released' : 'release-missed';
              if (released) {
                releasedCount += 1;
              } else {
                missedCount += 1;
              }
              entry.started = false;
              entry.acquiredAt = null;
              entry.leaseUntil = null;
              entry.heartbeatAt = null;
              entry.lastError = null;
              entry.updatedAt = toIso(new Date());
            })
            .catch((err) => {
              errorCount += 1;
              entry.state = 'release-error';
              entry.lastError = err.message;
              entry.updatedAt = toIso(new Date());
            })
        );
      } else if (entry.state !== 'released') {
        entry.state = 'stopped';
        entry.updatedAt = toIso(new Date());
      }
    }

    await Promise.all(releasePromises);
    return {
      released: releasedCount,
      missed: missedCount,
      errors: errorCount,
    };
  }

  return {
    ownerId,
    start,
    getStatus,
    stop,
    __private: {
      attemptStart,
      renew,
    },
  };
}

module.exports = {
  DEFAULT_RETRY_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_TTL_MS,
  createWorkerLeaseManager,
};

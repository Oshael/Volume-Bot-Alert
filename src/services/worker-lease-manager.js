const { randomUUID } = require('crypto');
const os = require('os');
const workerLease = require('../models/worker-lease');
const { createWorkerRuntimeTelemetry } = require('./worker-runtime-telemetry');

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
  let runtimeTelemetry = options.runtimeTelemetry || null;
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
        haltedAt: null,
        haltCode: null,
        standbyOwnerId: null,
        lastError: null,
        lastMetadataError: null,
        updatedAt: toIso(new Date()),
        retryTimer: null,
        heartbeatTimer: null,
        pendingHaltError: null,
        preserveLeaseRecord: false,
        baseMetadata: {},
        metadataProvider: null,
      });
    }
    const entry = entries.get(key);
    entry.baseMetadata = definition.metadata && typeof definition.metadata === 'object'
      ? { ...definition.metadata }
      : {};
    entry.metadataProvider = typeof definition.metadataProvider === 'function'
      ? definition.metadataProvider
      : null;
    return entry;
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
      haltedAt: entry.haltedAt,
      haltCode: entry.haltCode,
      standbyOwnerId: entry.standbyOwnerId,
      lastError: entry.lastError,
      lastMetadataError: entry.lastMetadataError,
      updatedAt: entry.updatedAt,
    };
  }

  async function heartbeatMetadata(entry) {
    runtimeTelemetry ||= createWorkerRuntimeTelemetry();
    const runtime = runtimeTelemetry.snapshot();
    if (!entry.metadataProvider) return { ...entry.baseMetadata, runtime };
    try {
      const dynamicMetadata = await entry.metadataProvider();
      if (!dynamicMetadata || typeof dynamicMetadata !== 'object' || Array.isArray(dynamicMetadata)) {
        throw new TypeError('Worker lease metadata provider must return an object');
      }
      entry.lastMetadataError = null;
      return { ...entry.baseMetadata, ...dynamicMetadata, runtime };
    } catch (error) {
      entry.lastMetadataError = String(error?.message || error).slice(0, 500);
      return {
        ...entry.baseMetadata,
        runtime,
        metadataProviderError: {
          message: entry.lastMetadataError,
          capturedAt: toIso(new Date()),
        },
      };
    }
  }

  function applyHaltedLease(entry, lease, error) {
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
    entry.state = 'halted';
    entry.started = false;
    entry.heartbeatAt = lease.heartbeatAt;
    entry.leaseUntil = lease.leaseUntil;
    entry.haltedAt = lease.metadata?.haltedAt || toIso(new Date());
    entry.haltCode = lease.metadata?.haltCode || error?.code || error?.name || 'fatal_error';
    entry.lastError = lease.metadata?.haltMessage || String(error?.message || error);
    entry.pendingHaltError = null;
    entry.preserveLeaseRecord = true;
    entry.updatedAt = toIso(new Date());
    return publicStatus(entry);
  }

  async function renew(inputEntry) {
    const entry = entries.get(inputEntry.key) || inputEntry;
    if (stopping) {
      return;
    }
    try {
      if (entry.pendingHaltError) {
        try {
          const haltedLease = await leaseStore.halt(entry.key, ownerId, entry.pendingHaltError);
          if (haltedLease) {
            applyHaltedLease(entry, haltedLease, entry.pendingHaltError);
            return;
          }
        } catch (haltError) {
          entry.lastError = `Fatal state persistence retry failed: ${haltError.message}`;
        }
      }
      const metadata = await heartbeatMetadata(entry);
      const lease = await leaseStore.heartbeat(entry.key, ownerId, { ttlMs, metadata });
      if (entry.state === 'halting' || entry.state === 'halted') {
        return;
      }
      if (!lease) {
        entry.state = 'lost';
        entry.lastError = 'Lease heartbeat was not renewed';
        entry.updatedAt = toIso(new Date());
        onLeaseLost(publicStatus(entry));
        return;
      }
      entry.state = entry.pendingHaltError ? 'halt-pending' : 'running';
      entry.leaseUntil = lease.leaseUntil;
      entry.heartbeatAt = lease.heartbeatAt;
      if (!entry.pendingHaltError) {
        entry.lastError = null;
        entry.haltedAt = null;
        entry.haltCode = null;
        entry.preserveLeaseRecord = false;
      }
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
        metadata: entry.baseMetadata,
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
      entry.haltedAt = null;
      entry.haltCode = null;
      entry.preserveLeaseRecord = false;
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

  async function halt(key, error) {
    const entry = entries.get(String(key || '').trim());
    if (!entry) throw new Error(`Worker lease is not registered: ${key}`);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    entry.state = 'halting';
    entry.started = false;
    entry.haltedAt = toIso(new Date());
    entry.haltCode = error?.code || error?.name || 'fatal_error';
    entry.pendingHaltError = error;
    entry.preserveLeaseRecord = true;
    entry.updatedAt = toIso(new Date());
    try {
      const lease = await leaseStore.halt(entry.key, ownerId, error);
      if (!lease) throw new Error(`Worker lease halt was not persisted: ${entry.key}`);
      return applyHaltedLease(entry, lease, error);
    } catch (haltError) {
      entry.state = 'halt-pending';
      entry.lastError = `Fatal state persistence failed: ${haltError.message}`;
      entry.updatedAt = toIso(new Date());
      throw haltError;
    }
  }

  function getStatus() {
    return Array.from(entries.values()).map(publicStatus);
  }

  async function stop(options = {}) {
    stopping = true;
    runtimeTelemetry?.stop?.();
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

      if (
        releaseLeases
        && !entry.preserveLeaseRecord
        && (entry.started || entry.acquiredAt || entry.leaseUntil)
      ) {
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
    halt,
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

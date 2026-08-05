/**
 * robinhood-derived consumer loop (Corte 5, slice 4b).
 *
 * One tick reclaims abandoned leases, claims a batch of pending outbox rows, and
 * fans each built market:bucket payload out through the shared hub (socket push,
 * relay, realtime alerts, live catalog, aggregates). Delivered rows are deleted;
 * a fan-out that throws is retried with backoff and dead-lettered once it burns
 * through its attempts. It owns no cursor and never touches capture or
 * processing: a derived failure isolates its own outbox row.
 *
 * A fan-out that returns falsy (no live subscriber, or the relay declined a
 * malformed/oversized payload) is still a delivery: retrying cannot change it and
 * the durable data already lives in the bucket tables. Only a thrown error — a
 * transient fault such as a failed pg_notify publish — reschedules the row.
 */
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;

function backoffFor(attempt, baseMs, maxMs) {
  const exponential = baseMs * 2 ** Math.max(0, Number(attempt) - 1);
  return Math.max(1, Math.min(maxMs, exponential));
}

function createRobinhoodDerivedRunner(deps = {}) {
  const repository = deps.repository;
  const fanout = deps.fanout;
  if (typeof repository?.claimOutbox !== 'function') throw new Error('derived outbox repository is required');
  if (typeof fanout !== 'function') throw new Error('market bucket fanout is required');

  const options = deps.options || {};
  const owner = String(options.owner || `robinhood-derived:${process.pid}`);
  const batchSize = Number(options.batchSize) || DEFAULT_BATCH_SIZE;
  const leaseMs = Number(options.leaseMs) || DEFAULT_LEASE_MS;
  const maxAttempts = Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = Number(options.baseBackoffMs) || DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = Number(options.maxBackoffMs) || DEFAULT_MAX_BACKOFF_MS;
  const logger = deps.logger || console;

  async function runOnce() {
    const reclaimed = await repository.reclaimExpiredLeases();
    const rows = await repository.claimOutbox({ owner, limit: batchSize, leaseMs });
    if (!rows.length) {
      return { reclaimed, claimed: 0, delivered: 0, retried: 0, blocked: 0 };
    }

    const delivered = [];
    const retry = [];
    for (const row of rows) {
      try {
        await fanout(row.payload);
        delivered.push(row.id);
      } catch (error) {
        logger.error?.('[robinhood-derived] fan-out failed, retrying row', error?.message || error);
        retry.push({
          id: row.id,
          error: String(error?.message || error).slice(0, 200),
          backoffMs: backoffFor(row.attemptCount, baseBackoffMs, maxBackoffMs),
        });
      }
    }

    const settlement = await repository.settleOutbox({ owner, maxAttempts, delivered, retry });
    return { reclaimed, claimed: rows.length, ...settlement };
  }

  return Object.freeze({ runOnce, owner });
}

module.exports = { createRobinhoodDerivedRunner, backoffFor };

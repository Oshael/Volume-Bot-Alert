const os = require('os');
const db = require('../models/db');
const {
  createRobinhoodMarketAggregateRepository,
} = require('../models/robinhood-market-aggregate');

const FINE_GRANULARITIES = Object.freeze([5, 15, 30]);
const COARSE_GRANULARITIES = Object.freeze([60, 240, 1440]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

function normalizeOptions(input = {}) {
  const owner = String(input.owner || `${os.hostname()}:${process.pid}:aggregation`).trim();
  if (!owner || owner.length > 128) throw new Error('Backfill aggregation owner is invalid');
  return {
    owner,
    claimLimit: boundedInteger(input.claimLimit, 10_000, 1, 100_000),
    leaseMs: boundedInteger(input.leaseMs, 900_000, 10_000, 86_400_000),
    retryDelayMs: boundedInteger(input.retryDelayMs, 5000, 0, 604_800_000),
    maxAttempts: boundedInteger(input.maxAttempts, 5, 1, 100),
    tokenLimit: boundedInteger(input.tokenLimit, 25, 1, 1000),
  };
}

function createOutboxRepository(database = db) {
  async function claim(input) {
    const result = await database.query(
      `WITH candidates AS MATERIALIZED (
         SELECT chain, transaction_hash, log_index
         FROM robinhood_backfill_aggregation_outbox
         WHERE (
           status = 'pending' AND next_attempt_at <= NOW()
         ) OR (
           status = 'leased' AND lease_until <= NOW()
         )
         ORDER BY bucket_ts, transaction_hash, log_index
         LIMIT $3::int
         FOR UPDATE SKIP LOCKED
       ),
       claimed AS (
         UPDATE robinhood_backfill_aggregation_outbox target
         SET status = 'leased',
             lease_owner = $1,
             lease_until = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
             attempt_count = target.attempt_count + 1,
             last_error = NULL,
             updated_at = NOW()
         FROM candidates candidate
         WHERE (target.chain, target.transaction_hash, target.log_index)
           = (candidate.chain, candidate.transaction_hash, candidate.log_index)
         RETURNING target.bucket_ts
       )
       SELECT bucket_ts, COUNT(*)::int AS target_count
       FROM claimed
       GROUP BY bucket_ts
       ORDER BY bucket_ts`,
      [input.owner, input.leaseMs, input.claimLimit]
    );
    return result.rows.map((row) => ({
      bucketTs: new Date(row.bucket_ts).toISOString(),
      targetCount: Number(row.target_count),
    }));
  }

  async function completeHour(input) {
    const result = await database.query(
      `UPDATE robinhood_backfill_aggregation_outbox
       SET status = 'completed', lease_owner = NULL, lease_until = NULL,
           completed_at = NOW(), last_error = NULL, updated_at = NOW()
       WHERE status = 'leased' AND lease_owner = $1
         AND bucket_ts = $2::timestamptz`,
      [input.owner, input.bucketTs]
    );
    return result.rowCount;
  }

  async function failOwner(input) {
    const result = await database.query(
      `UPDATE robinhood_backfill_aggregation_outbox
       SET status = CASE WHEN attempt_count >= $2::int THEN 'blocked' ELSE 'pending' END,
           lease_owner = NULL,
           lease_until = NULL,
           next_attempt_at = CASE
             WHEN attempt_count >= $2::int THEN next_attempt_at
             ELSE NOW() + ($3::bigint * INTERVAL '1 millisecond')
           END,
           last_error = $4,
           updated_at = NOW()
       WHERE status = 'leased' AND lease_owner = $1
       RETURNING status`,
      [input.owner, input.maxAttempts, input.retryDelayMs, input.error.slice(0, 2000)]
    );
    return result.rows.reduce(
      (counts, row) => ({ ...counts, [row.status]: counts[row.status] + 1 }),
      { pending: 0, blocked: 0 }
    );
  }

  return Object.freeze({ claim, completeHour, failOwner });
}

function addCounts(total, counts) {
  for (const field of ['sourceBuckets', 'targetBuckets', 'writtenBuckets', 'tokenCount']) {
    total[field] += Number(counts[field] || 0);
  }
}

async function refreshPaged(refresh, input, tokenLimit) {
  const total = { sourceBuckets: 0, targetBuckets: 0, writtenBuckets: 0, tokenCount: 0 };
  let afterToken = null;
  let hasMoreTokens = true;
  while (hasMoreTokens) {
    const counts = await refresh({ ...input, afterToken, tokenLimit });
    addCounts(total, counts);
    hasMoreTokens = counts.hasMoreTokens === true;
    if (!hasMoreTokens) continue;
    if (!counts.lastToken || counts.lastToken === afterToken) {
      throw new Error('Backfill aggregation pagination did not advance');
    }
    afterToken = counts.lastToken;
  }
  return total;
}

async function aggregateHour(repository, bucketTs, tokenLimit) {
  const from = new Date(bucketTs);
  if (!Number.isFinite(from.getTime()) || from.getTime() % 3_600_000 !== 0) {
    throw new Error('Backfill aggregation bucket is not aligned to an hour');
  }
  const range = { from: from.toISOString(), to: new Date(from.getTime() + 3_600_000).toISOString() };
  const fine = await refreshPaged(
    (input) => repository.refreshAggregateRange(input),
    { ...range, granularities: FINE_GRANULARITIES },
    tokenLimit
  );
  const hourly = await refreshPaged(
    (input) => repository.refreshHourlyRange(input),
    range,
    tokenLimit
  );
  const coarse = await refreshPaged(
    (input) => repository.refreshAggregateRange(input),
    { ...range, granularities: COARSE_GRANULARITIES },
    tokenLimit
  );
  return { fine, hourly, coarse };
}

function createRobinhoodBackfillAggregationWorker(deps = {}) {
  const outbox = deps.outboxRepository || createOutboxRepository(deps.database);
  const aggregates = deps.aggregateRepository
    || createRobinhoodMarketAggregateRepository(deps.database);

  async function runOnce(rawOptions = {}) {
    const options = normalizeOptions(rawOptions);
    const hours = await outbox.claim(options);
    if (hours.length === 0) {
      return { status: 'idle', claimedTargets: 0, completedTargets: 0, hours: [] };
    }
    let completedTargets = 0;
    const completedHours = [];
    try {
      for (const hour of hours) {
        const counts = await aggregateHour(aggregates, hour.bucketTs, options.tokenLimit);
        const completed = await outbox.completeHour({
          owner: options.owner,
          bucketTs: hour.bucketTs,
        });
        if (completed !== hour.targetCount) {
          throw new Error('Backfill aggregation lease changed before completion');
        }
        completedTargets += completed;
        completedHours.push({ ...hour, completedTargets: completed, counts });
      }
    } catch (error) {
      const failure = await outbox.failOwner({
        ...options,
        error: String(error?.message || error),
      });
      error.outboxFailure = failure;
      throw error;
    }
    return {
      status: 'completed',
      claimedTargets: hours.reduce((sum, hour) => sum + hour.targetCount, 0),
      completedTargets,
      hours: completedHours,
    };
  }

  return Object.freeze({ runOnce });
}

module.exports = {
  createRobinhoodBackfillAggregationWorker,
  __private: {
    aggregateHour,
    createOutboxRepository,
    normalizeOptions,
    refreshPaged,
  },
};

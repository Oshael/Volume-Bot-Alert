/**
 * Corte 6C: rebuilds standard-alert signals from a delivered derived payload.
 * Publication remains opt-in and uses the existing idempotent event/state path.
 */
const db = require('../models/db');
const {
  createRobinhoodStandardAlertSignalSource,
} = require('./robinhood-standard-alert-signal-source');
const {
  createRobinhoodStandardAlertPublication,
} = require('./robinhood-standard-alert-publication');

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function alertIdentity(payload) {
  const input = payload || {};
  const market = input.market || {};
  const ordering = input.ordering || {};
  const protocol = String(market.protocol || '');
  const marketKey = String(market.key || '').toLowerCase();
  const nextBlock = String(ordering.cursorNextBlock || '');
  const frontierTimestamp = ordering.frontierTimestamp;
  if (input.type !== 'market:bucket' || input.chain !== 'robinhood') {
    throw new Error('invalid derived standard-alert payload');
  }
  if (!/^uniswap-v[234]$/.test(protocol)
    || !marketKey.startsWith(`robinhood:${protocol}:`)) {
    throw new Error('invalid derived standard-alert payload');
  }
  if (!/^\d+$/.test(nextBlock) || !frontierTimestamp) {
    throw new Error('invalid derived standard-alert payload');
  }
  return { protocol, marketKey, nextBlock, frontierTimestamp, ordering };
}

function toCommittedInput(payload) {
  const { protocol, marketKey, nextBlock, frontierTimestamp, ordering } = alertIdentity(payload);
  const activity = payload.activity || {};
  const valuation = payload.valuation || {};
  return {
    buckets: [{
      tokenAddress: payload.address,
      valuationProtocol: protocol,
      valuationMarketKey: marketKey,
      lastObservedAt: valuation.observedAt,
      lastBlockNumber: ordering.lastBlockNumber,
      lastLogIndex: ordering.lastLogIndex,
      closePriceUsd: valuation.priceUsd,
      closeFdvUsd: valuation.fdvUsd,
      currentVolume5mUsd: activity.currentVolume5mUsd,
      prevVolume5mCanonical: activity.prevVolume5mCanonical,
      volume5mBaselineAt: activity.volume5mBaselineAt,
      volume5mWindowEnd: activity.volume5mWindowEnd,
      volume5mDeltaCoverage: activity.volume5mDeltaCoverage,
    }],
    cursor: {
      nextBlock,
      checkpointTimestamp: new Date(frontierTimestamp),
      coverageEndAt: new Date(frontierTimestamp),
      coverageCaughtUp: true,
    },
  };
}

function createRobinhoodDerivedStandardAlertSink(options = {}) {
  const database = options.database || db;
  const source = options.source || createRobinhoodStandardAlertSignalSource({
    database,
    statementTimeoutMs: boundedInteger(options.statementTimeoutMs, 10_000, 1000, 60_000),
  });
  const publication = options.publication || createRobinhoodStandardAlertPublication();
  const now = options.now || Date.now;
  const maxEventLagMs = boundedInteger(options.maxEventLagMs, 30_000, 1000, 300_000);
  const alertsRequested = options.alertsRequested === true;
  const publishable = alertsRequested && options.publishable === true;
  const status = {
    attempted: 0, eligible: 0, skippedIneligible: 0, skippedStale: 0,
    generatedSignals: 0, shadowRuns: 0, publishedRuns: 0, disabledRuns: 0,
    errors: 0, lastSummary: null, lastError: null,
  };

  async function consume(payload) {
    status.attempted += 1;
    if (payload?.derived?.standardAlertEligible !== true) {
      status.skippedIneligible += 1;
      return { status: 'skipped', reason: 'not_latest_bucket_in_commit' };
    }
    status.eligible += 1;
    try {
      const input = toCommittedInput(payload);
      const observedAtMs = new Date(input.buckets[0].lastObservedAt).getTime();
      const ageMs = now() - observedAtMs;
      if (!Number.isFinite(observedAtMs) || ageMs < -5000 || ageMs > maxEventLagMs) {
        status.skippedStale += 1;
        return { status: 'skipped', reason: 'stale_event' };
      }
      const signals = await source.buildFromCommittedBuckets(input);
      const summary = await publication.consume({
        signals,
        alertsRequested,
        publishable,
        commitCompletedAt: new Date(payload.generatedAt),
      });
      status.generatedSignals += signals.length;
      if (!alertsRequested) status.disabledRuns += 1;
      else if (publishable) status.publishedRuns += 1;
      else status.shadowRuns += 1;
      status.lastSummary = summary;
      status.lastError = null;
      return summary;
    } catch (error) {
      status.errors += 1;
      status.lastError = String(error?.message || error).slice(0, 500);
      throw error;
    }
  }

  return Object.freeze({ consume, getStatus: () => ({ ...status }) });
}

module.exports = {
  createRobinhoodDerivedStandardAlertSink,
  __private: { alertIdentity, boundedInteger, toCommittedInput },
};

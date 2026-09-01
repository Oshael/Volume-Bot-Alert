const express = require('express');
const config = require('../../config');
const { authenticate } = require('../middleware/auth');
const {
  rejectHiddenRobinhoodRoute,
} = require('../middleware/token-chain-visibility');
const {
  createRobinhoodTokenHolderSummaryRepository,
} = require('../models/robinhood-token-holder-summary');
const {
  createRobinhoodHolderPageRepository,
  isLedgerCursor,
  validateLedgerCursor,
} = require('../models/robinhood-holder-page');
const {
  createRobinhoodHolderIntelligenceReadRepository,
} = require('../models/robinhood-holder-intelligence-read');
const {
  createCalloutWalletProfileReadRepository,
} = require('../models/callout-wallet-profile-read');
const {
  HOLDER_CLASSIFICATION_VERSION,
  HOLDER_DISTRIBUTION_METRICS,
} = require('../services/robinhood-holder-classification-domain');
const {
  createRobinhoodBlockscoutHoldersClient,
  validateHoldersCursor,
} = require('../services/robinhood-blockscout-holders');
const {
  createRobinhoodHolderRequestScheduler,
  parseRetryAfterMs,
} = require('../services/robinhood-holder-request-scheduler');
const {
  createRobinhoodNativeBalanceProvider,
} = require('../services/robinhood-native-balance-provider');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  buildDailyHolderHistory,
  buildHourlyHolderSeries,
} = require('../utils/robinhood-holder-summary-view');

const DEFAULT_REFRESH_MS = 5 * 60_000;
const DEFAULT_FAILURE_RETRY_MS = 5 * 60_000;
const DEFAULT_HISTORY_DAYS = 30;
const MAX_HISTORY_DAYS = 90;

function parseHistoryDays(value) {
  const parsed = Number(value ?? DEFAULT_HISTORY_DAYS);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY_DAYS) {
    throw new RangeError('days is invalid');
  }
  return parsed;
}

function parseHolderFilter(value) {
  const normalized = String(value ?? 'top').trim().toLowerCase();
  if (!['top', 'snipers', 'bundled', 'insiders'].includes(normalized)) {
    throw new RangeError('holder filter is invalid');
  }
  return normalized;
}

function publicSummary(row, nowMs, refreshMs) {
  if (!row) return Object.freeze({
    holderCount: null,
    totalSupplyRaw: null,
    source: 'blockscout',
    observedAt: null,
    checkedAt: null,
    freshness: 'unavailable',
  });
  const freshnessAt = row.source === 'ledger_live' ? row.checkedAt : row.observedAt;
  const freshnessMs = freshnessAt == null ? NaN : Date.parse(freshnessAt);
  const freshness = row.holderCount == null
    ? 'unavailable'
    : (Number.isFinite(freshnessMs) && nowMs - freshnessMs <= refreshMs ? 'fresh' : 'stale');
  return Object.freeze({
    holderCount: row.holderCount,
    totalSupplyRaw: row.totalSupplyRaw ?? null,
    source: row.source,
    observedAt: row.observedAt,
    checkedAt: row.checkedAt,
    freshness,
  });
}

function shouldQueueRefresh(row, hasCursor, nowMs, refreshMs) {
  if (hasCursor || row?.source === 'ledger_live') return false;
  if (!row) return true;
  const retryAfterMs = row.retryAfterAt == null ? NaN : Date.parse(row.retryAfterAt);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > nowMs) return false;
  const checkedMs = Date.parse(row.checkedAt);
  return !Number.isFinite(checkedMs) || nowMs - checkedMs >= refreshMs;
}

function safeErrorCode(error) {
  const normalized = String(error?.code || 'provider_error').trim().toLowerCase();
  return normalized.replace(/[^a-z0-9_:-]+/g, '_').slice(0, 64) || 'provider_error';
}

function parsePageCursor(value, filter = 'top') {
  if (isLedgerCursor(value)) {
    return Object.freeze({
      source: 'ledger', ledgerCursor: validateLedgerCursor(value, filter), blockscoutCursor: null,
    });
  }
  if (filter !== 'top') {
    if (value != null && value !== '') throw new RangeError('filtered cursor is invalid');
    return Object.freeze({ source: 'ledger', ledgerCursor: null, blockscoutCursor: null });
  }
  const blockscoutCursor = validateHoldersCursor(value);
  return Object.freeze({
    source: blockscoutCursor ? 'blockscout' : 'auto',
    ledgerCursor: null, blockscoutCursor,
  });
}

async function sendPublishedLedgerPage(input) {
  if (input.cursor.source === 'blockscout') return false;
  try {
    const page = await input.repository.listPublishedPage({
      tokenAddress: input.tokenAddress, cursor: input.cursor.ledgerCursor, filter: input.filter,
    });
    if (page) {
      const nativeItems = await enrichNativeBalances(
        page.items, input.nativeBalances, input.logger
      );
      const intelligence = await enrichIntelligence(
        nativeItems, input.intelligence, input.tokenAddress, input.logger
      );
      const holders = await enrichHolderProfiles(
        intelligence.holders, input.holderProfiles, input.logger
      );
      input.response.json({
        token: input.tokenAddress, filter: input.filter,
        summary: publicSummary({
          holderCount: page.holderCount, totalSupplyRaw: page.totalSupplyRaw,
          source: page.source, observedAt: page.observedAt, checkedAt: page.checkedAt,
        }, input.nowMs, input.refreshMs),
        holders,
        classificationVersion: intelligence.classificationVersion,
        classificationStatus: intelligence.classificationStatus,
        classificationThroughBlock: intelligence.classificationThroughBlock,
        distribution: intelligence.distribution,
        hasMore: page.hasMore, nextCursor: page.nextCursor,
        observedAt: page.observedAt, refreshQueued: false,
      });
      return true;
    }
    if (input.cursor.source === 'ledger') {
      input.response.status(503).json({
        error: 'Holder ledger is not currently published', code: 'HOLDERS_NOT_READY',
      });
      return true;
    }
    return false;
  } catch (error) {
    const invalid = error?.code === 'invalid_cursor';
    input.logger.warn?.('[RobinhoodHoldersRoute] holder ledger page unavailable', {
      code: safeErrorCode(error),
    });
    input.response.status(invalid ? 400 : 503).json(invalid
      ? { error: 'token or cursor is invalid', code: 'INVALID_REQUEST' }
      : { error: 'Holder data is temporarily unavailable', code: 'HOLDERS_UNAVAILABLE' });
    return true;
  }
}

function unavailableIntelligence(items) {
  return Object.freeze({
    classificationVersion: HOLDER_CLASSIFICATION_VERSION,
    classificationStatus: 'unavailable',
    classificationThroughBlock: null,
    holders: items.map((item) => Object.freeze({
      ...item, tags: [], primaryTag: 'unknown',
      classificationVersion: HOLDER_CLASSIFICATION_VERSION,
      classificationStatus: 'unavailable', classifications: [],
    })),
    distribution: HOLDER_DISTRIBUTION_METRICS.map((metric) => Object.freeze({
      metric, status: 'unavailable', value: null, walletCount: null, groupCount: null,
      classificationVersion: HOLDER_CLASSIFICATION_VERSION,
      throughBlock: null, observedAt: null,
    })),
  });
}

async function enrichIntelligence(items, repository, tokenAddress, logger) {
  if (!repository) return unavailableIntelligence(items);
  try {
    const intelligence = await repository.loadPage({
      tokenAddress, walletAddresses: items.map(({ address }) => address),
    });
    const byAddress = new Map(intelligence.holders.map((holder) => [holder.address, holder]));
    return Object.freeze({
      ...intelligence,
      holders: items.map((item) => Object.freeze({
        ...item, tags: [], primaryTag: 'unknown',
        classificationVersion: intelligence.classificationVersion,
        classificationStatus: intelligence.classificationStatus,
        classifications: [],
        ...byAddress.get(item.address.toLowerCase()),
      })),
    });
  } catch (error) {
    logger.warn?.('[RobinhoodHoldersRoute] holder intelligence unavailable', {
      code: safeErrorCode(error),
    });
    return unavailableIntelligence(items);
  }
}

async function enrichNativeBalances(items, provider, logger) {
  if (!provider || items.length === 0) return items;
  try {
    const balances = await provider.readBalances(items.map((item) => item.address));
    return items.map((item) => Object.freeze({
      ...item, nativeBalanceRaw: balances[item.address.toLowerCase()] ?? null,
    }));
  } catch (error) {
    logger.warn?.('[RobinhoodHoldersRoute] native balances unavailable', {
      code: safeErrorCode(error),
    });
    return items.map((item) => Object.freeze({ ...item, nativeBalanceRaw: null }));
  }
}

async function enrichHolderProfiles(items, repository, logger) {
  const withoutProfile = () => items.map((item) => Object.freeze({
    ...item, profile: null,
  }));
  if (!repository || items.length === 0) return withoutProfile();
  try {
    const profiles = await repository.findByWalletAddresses(
      items.map(({ address }) => address),
    );
    const byAddress = new Map(profiles.map((profile) => [profile.address, profile]));
    return items.map((item) => {
      const match = byAddress.get(item.address.toLowerCase());
      const profile = match ? Object.freeze({
        platform: match.platform,
        platformUserId: match.platformUserId,
        username: match.username,
        xUsername: match.xUsername,
        displayName: match.displayName,
        profilePictureUrl: match.profilePictureUrl,
      }) : null;
      return Object.freeze({ ...item, profile });
    });
  } catch (error) {
    logger.warn?.('[RobinhoodHoldersRoute] holder profiles unavailable', {
      code: safeErrorCode(error),
    });
    return withoutProfile();
  }
}

function resolveNativeBalanceProvider(options) {
  if (options.nativeBalanceProvider !== undefined) return options.nativeBalanceProvider;
  if (!config.robinhoodHolderNativeBalance.enabled) return null;
  return createRobinhoodNativeBalanceProvider(config.robinhoodHolderNativeBalance);
}

function resolveHolderIntelligenceRepository(options) {
  return options.holderIntelligenceRepository
    || createRobinhoodHolderIntelligenceReadRepository();
}

function resolveHolderProfileRepository(options) {
  if (options.holderProfileRepository !== undefined) return options.holderProfileRepository;
  return createCalloutWalletProfileReadRepository();
}

function createRobinhoodHoldersRouter(options = {}) {
  const router = express.Router();
  const auth = options.authenticate || authenticate;
  const visibility = options.visibility || rejectHiddenRobinhoodRoute;
  const repository = options.repository || createRobinhoodTokenHolderSummaryRepository();
  const holderPageRepository = options.holderPageRepository
    || createRobinhoodHolderPageRepository();
  const holderIntelligenceRepository = resolveHolderIntelligenceRepository(options);
  const holderProfileRepository = resolveHolderProfileRepository(options);
  const client = options.client || createRobinhoodBlockscoutHoldersClient();
  const scheduler = options.scheduler || createRobinhoodHolderRequestScheduler(
    options.requestOptions || config.robinhoodHolderRequests
  );
  const logger = options.logger || console;
  const nativeBalances = resolveNativeBalanceProvider(options);
  const now = options.now || Date.now;
  const refreshMs = Number(options.refreshMs) || config.robinhoodHolderSummaryWorker?.hotRefreshMs
    || DEFAULT_REFRESH_MS;
  const failureRetryMs = Number(options.failureRetryMs) || DEFAULT_FAILURE_RETRY_MS;
  const unavailableRetryMs = Number(options.unavailableRetryMs)
    || config.robinhoodHolderSummaryWorker?.unavailableRetryMs || 24 * 60 * 60_000;
  const refreshInFlight = new Set();

  function queueSummaryRefresh(tokenAddress) {
    if (refreshInFlight.has(tokenAddress)) return false;
    refreshInFlight.add(tokenAddress);
    void scheduler.schedule(() => client.getTokenHolderSummary(tokenAddress))
      .then(
        (summary) => {
          const write = summary.available
            ? repository.recordSuccess({
                tokenAddress,
                holderCount: summary.holderCount,
                observedAt: summary.observedAt,
              })
            : repository.recordFailure({
                tokenAddress,
                errorCode: 'unavailable',
                retryAfterAt: new Date(now() + unavailableRetryMs).toISOString(),
              });
          return write.catch((error) => logger.warn?.(
            '[RobinhoodHoldersRoute] summary refresh persistence failed',
            { code: safeErrorCode(error) }
          ));
        },
        (error) => repository.recordFailure({
          tokenAddress,
          errorCode: safeErrorCode(error),
          retryAfterAt: new Date(
            now() + (parseRetryAfterMs(error, now()) ?? failureRetryMs)
          ).toISOString(),
        }).catch((persistenceError) => logger.warn?.(
          '[RobinhoodHoldersRoute] summary refresh persistence failed',
          { code: safeErrorCode(persistenceError) }
        ))
      )
      .finally(() => refreshInFlight.delete(tokenAddress));
    return true;
  }

  router.get('/holder-history', auth, visibility, async (req, res) => {
    let tokenAddress;
    let days;
    try {
      tokenAddress = normalizeTokenAddress('robinhood', req.query?.token);
      days = parseHistoryDays(req.query?.days);
    } catch (_) {
      return res.status(400).json({ error: 'token or days is invalid', code: 'INVALID_REQUEST' });
    }

    const asOf = new Date(now()).toISOString();
    try {
      const snapshots = await repository.listDailySnapshots({
        tokenAddress, days, asOf,
      });
      return res.json({ token: tokenAddress, days, asOf,
        ...buildDailyHolderHistory(snapshots, days) });
    } catch (error) {
      logger.warn?.('[RobinhoodHoldersRoute] daily history unavailable', {
        code: safeErrorCode(error),
      });
      return res.status(500).json({
        error: 'Holder history is temporarily unavailable',
        code: 'HOLDER_HISTORY_UNAVAILABLE',
      });
    }
  });

  router.get('/holder-count-series', auth, visibility, async (req, res) => {
    let tokenAddress;
    try {
      tokenAddress = normalizeTokenAddress('robinhood', req.query?.token);
    } catch (_) {
      return res.status(400).json({ error: 'token is invalid', code: 'INVALID_REQUEST' });
    }
    const asOf = new Date(now()).toISOString();
    try {
      const [buckets, summaries] = await Promise.all([
        repository.listHourlyBuckets({
          tokenAddress, asOf,
        }),
        repository.getPublishedSummaries([tokenAddress]),
      ]);
      return res.json({ token: tokenAddress, asOf,
        ...buildHourlyHolderSeries(buckets, summaries[0] || null, asOf) });
    } catch (error) {
      logger.warn?.('[RobinhoodHoldersRoute] holder count series unavailable', {
        code: safeErrorCode(error),
      });
      return res.status(500).json({
        error: 'Holder count series is temporarily unavailable',
        code: 'HOLDER_COUNT_SERIES_UNAVAILABLE',
      });
    }
  });

  router.get('/holders', auth, visibility, async (req, res) => {
    let tokenAddress;
    let pageCursor;
    let holderFilter;
    try {
      tokenAddress = normalizeTokenAddress('robinhood', req.query?.token);
      holderFilter = parseHolderFilter(req.query?.filter);
      pageCursor = parsePageCursor(req.query?.cursor, holderFilter);
    } catch (_) {
      return res.status(400).json({ error: 'token or cursor is invalid', code: 'INVALID_REQUEST' });
    }

    if (await sendPublishedLedgerPage({
      repository: holderPageRepository, tokenAddress, cursor: pageCursor,
      filter: holderFilter,
      intelligence: holderIntelligenceRepository,
      holderProfiles: holderProfileRepository,
      response: res, logger, nativeBalances, nowMs: now(), refreshMs,
    })) return undefined;
    const cursor = pageCursor.blockscoutCursor;

    const pagePromise = scheduler.schedule(
      () => client.getTokenHoldersPage(tokenAddress, cursor)
    );
    let cached = null;
    try {
      [cached] = await repository.getPublishedSummaries([tokenAddress]);
    } catch (error) {
      logger.warn?.('[RobinhoodHoldersRoute] summary cache unavailable', {
        code: safeErrorCode(error),
      });
    }
    const nowMs = now();
    const refreshQueued = shouldQueueRefresh(cached, cursor != null, nowMs, refreshMs)
      ? queueSummaryRefresh(tokenAddress) : false;

    try {
      const page = await pagePromise;
      const nativeItems = await enrichNativeBalances(page.items, nativeBalances, logger);
      const intelligence = await enrichIntelligence(
        nativeItems, holderIntelligenceRepository, tokenAddress, logger
      );
      const holders = await enrichHolderProfiles(
        intelligence.holders, holderProfileRepository, logger
      );
      return res.json({
        token: tokenAddress, filter: holderFilter,
        summary: publicSummary(cached, nowMs, refreshMs),
        holders,
        classificationVersion: intelligence.classificationVersion,
        classificationStatus: intelligence.classificationStatus,
        classificationThroughBlock: intelligence.classificationThroughBlock,
        distribution: intelligence.distribution,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        observedAt: page.observedAt,
        refreshQueued,
      });
    } catch (error) {
      const retryAfterMs = parseRetryAfterMs(error, now());
      if (retryAfterMs !== null) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      }
      logger.warn?.('[RobinhoodHoldersRoute] page unavailable', {
        code: safeErrorCode(error),
        httpStatus: Number(error?.httpStatus) || null,
      });
      return res.status(503).json({
        error: 'Holder data is temporarily unavailable',
        code: 'HOLDERS_UNAVAILABLE',
      });
    }
  });

  return router;
}

const router = createRobinhoodHoldersRouter();
router.createRobinhoodHoldersRouter = createRobinhoodHoldersRouter;
router.__private = {
  enrichIntelligence, enrichNativeBalances, parseHistoryDays, parseHolderFilter, publicSummary,
  resolveNativeBalanceProvider,
  safeErrorCode, shouldQueueRefresh,
};

module.exports = router;

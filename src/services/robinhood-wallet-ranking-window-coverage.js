const {
  createRobinhoodWalletRankingWindowEventsRepository,
} = require('../models/robinhood-wallet-ranking-window-events');
const {
  createRobinhoodWalletRankingTransferAvailabilityRepository,
} = require('../models/robinhood-wallet-ranking-transfer-availability');
const {
  createRobinhoodWalletRankingSwapAvailabilityRepository,
} = require('../models/robinhood-wallet-ranking-swap-availability');
const {
  createRobinhoodWalletRankingSourceFrontiersRepository,
} = require('../models/robinhood-wallet-ranking-source-frontiers');
const {
  createRobinhoodWalletRankingTransferClassificationRepository,
} = require('../models/robinhood-wallet-ranking-transfer-classification');
const {
  createRobinhoodWalletRankingReadSnapshot,
} = require('../models/robinhood-wallet-ranking-read-snapshot');
const {
  createRobinhoodWalletRankingWindowBlockBoundsRepository,
} = require('../models/robinhood-wallet-ranking-window-block-bounds');
const {
  createRobinhoodWalletRankingTransferScanCoverageRepository,
} = require('../models/robinhood-wallet-ranking-transfer-scan-coverage');

function pairKey(item) {
  return `${item.tokenAddress}:${item.walletAddress}`;
}

function failedReasons(ready, values, fallback) {
  if (ready === true) return [];
  return values?.length ? values : [fallback];
}

function globalReasons(availability, swapAvailability, frontiers) {
  const partitionReasons = availability?.partitions?.flatMap((day) => day.reasons || []);
  const swapReasons = swapAvailability?.partitions?.flatMap((day) => day.reasons || []);
  const frontierReasons = frontiers?.sources?.flatMap((source) => source.reasons || []);
  return [
    ...failedReasons(availability?.rawTransferAvailable, partitionReasons,
      'raw_transfer_availability_unverified'),
    ...failedReasons(swapAvailability?.swapPartitionsAvailable, swapReasons,
      'swap_partition_availability_unverified'),
    ...failedReasons(frontiers?.cursorChecksPassed, frontierReasons,
      'source_frontiers_unverified'),
  ];
}

function sourceReasons(bounds, scan) {
  if (bounds.verified !== true) {
    return bounds.reasons?.length ? bounds.reasons : ['transfer_window_bounds_unverified'];
  }
  return failedReasons(scan?.scanProofReady, scan?.coverageReasons,
    'transfer_scan_coverage_unverified');
}

function allChecksPassed(checks, sourceCoverageVerified) {
  return checks.rawTransferAvailable && checks.swapPartitionsAvailable
    && checks.sourceFrontiersReady && checks.rawRowsClassified
    && sourceCoverageVerified && checks.orderingComplete
    && checks.canonicalEventsVerified && !checks.truncated;
}

function classifyPair(events, classification, availability, swapAvailability,
  frontiers, bounds, scan, globals) {
  const reasons = [...globals];
  if (events.truncated) reasons.push('window_events_truncated');
  if (!events.orderingComplete) reasons.push('window_event_order_unverified');
  if (events.canonicalEventsVerified !== true) reasons.push('window_event_canonicality_unverified');
  reasons.push(...failedReasons(classification?.rawRowsClassified,
    classification?.reasons, 'transfer_classification_unverified'));
  reasons.push(...sourceReasons(bounds, scan));
  const sourceCoverageVerified = bounds.verified === true
    && scan?.scanProofReady === true && frontiers?.cursorChecksPassed === true;
  const checks = {
    rawTransferAvailable: availability?.rawTransferAvailable === true,
    swapPartitionsAvailable: swapAvailability?.swapPartitionsAvailable === true,
    sourceFrontiersReady: frontiers?.cursorChecksPassed === true,
    rawRowsClassified: classification?.rawRowsClassified === true,
    transferWindowBoundsVerified: bounds.verified === true,
    transferScanReady: scan?.scanProofReady === true,
    orderingComplete: events.orderingComplete === true,
    canonicalEventsVerified: events.canonicalEventsVerified === true,
    truncated: events.truncated === true,
  };
  const preconditionsSatisfied = allChecksPassed(checks, sourceCoverageVerified);
  return {
    ...events,
    checks,
    preconditionsSatisfied,
    eventsComplete: preconditionsSatisfied,
    sourceCoverageVerified,
    coverageReasons: [...new Set(reasons)].sort(),
  };
}

function transferBlockBounds(frontiers) {
  if (frontiers?.cursorChecksPassed !== true) return null;
  const transfer = frontiers.sources?.find((source) => source.source === 'transfer');
  const origin = String(transfer?.seedOriginBlock ?? '');
  const next = String(transfer?.liveNextBlock ?? '');
  if (!/^\d+$/.test(origin) || !/^\d+$/.test(next)
      || BigInt(next) <= BigInt(origin) + 1n) {
    return null;
  }
  return { originBlock: origin, throughBlock: (BigInt(next) - 1n).toString() };
}

async function inspectSourceCoverage(database, options, events, frontiers, availability,
  windowStart, asOf, classificationVersion) {
  const limits = transferBlockBounds(frontiers);
  if (!limits) return { bounds: { verified: false,
    reasons: ['transfer_window_frontier_unverified'] }, scans: [] };
  const boundsRepository = options.boundsRepository
    || createRobinhoodWalletRankingWindowBlockBoundsRepository({ database });
  const bounds = await boundsRepository.resolveWindow({ windowStart, asOf, ...limits });
  if (bounds.verified !== true) return { bounds, scans: [] };
  const scanRepository = options.scanCoverageRepository
    || createRobinhoodWalletRankingTransferScanCoverageRepository({
      database, availabilityRepository: { inspectWindow: async () => availability },
    });
  const scans = await scanRepository.inspectBlockRange({
    tokenAddresses: [...new Set(events.map((item) => item.tokenAddress))],
    fromBlock: bounds.fromBlock, throughBlock: bounds.throughBlock,
    windowStart, asOf, classificationVersion,
  });
  return { bounds, scans };
}

async function readRobinhoodWalletRankingWindowCoverage(database, input = {}, options = {}) {
  const repositoryOptions = { database };
  const eventsRepository = options.eventsRepository
    || createRobinhoodWalletRankingWindowEventsRepository(repositoryOptions);
  const availabilityRepository = options.availabilityRepository
    || createRobinhoodWalletRankingTransferAvailabilityRepository(repositoryOptions);
  const swapAvailabilityRepository = options.swapAvailabilityRepository
    || createRobinhoodWalletRankingSwapAvailabilityRepository(repositoryOptions);
  const frontiersRepository = options.frontiersRepository
    || createRobinhoodWalletRankingSourceFrontiersRepository(repositoryOptions);
  const classificationRepository = options.classificationRepository
    || createRobinhoodWalletRankingTransferClassificationRepository(repositoryOptions);
  const events = await eventsRepository.getWindowEvents(input);
  if (!events.length) return [];
  const windowStart = events[0].windowStart;
  const asOf = events[0].asOf;
  const pairs = events.map(({ tokenAddress, walletAddress }) => ({
    tokenAddress, walletAddress,
  }));
  const availability = await availabilityRepository.inspectWindow({ windowStart, asOf });
  const swapAvailability = await swapAvailabilityRepository.inspectWindow({ windowStart, asOf });
  const frontiers = await frontiersRepository.inspectAsOf({
    windowStart, asOf, transferVersion: input.classificationVersion,
  });
  const classifications = await classificationRepository.inspectWindow({
    pairs, windowStart, asOf, classificationVersion: input.classificationVersion,
  });
  const { bounds, scans } = await inspectSourceCoverage(database, options, events,
    frontiers, availability, windowStart, asOf, input.classificationVersion);
  const globals = globalReasons(availability, swapAvailability, frontiers);
  const byPair = new Map(classifications.map((item) => [pairKey(item), item]));
  const byToken = new Map(scans.map((item) => [item.tokenAddress, item]));
  return events.map((item) => classifyPair(
    item, byPair.get(pairKey(item)), availability, swapAvailability, frontiers,
    bounds, byToken.get(item.tokenAddress), globals,
  ));
}

function createRobinhoodWalletRankingWindowCoverage(options = {}) {
  const snapshotRunner = options.snapshotRunner
    || createRobinhoodWalletRankingReadSnapshot({ database: options.database });

  return {
    async getWindowEvents(input = {}) {
      return snapshotRunner.run((database) => (
        readRobinhoodWalletRankingWindowCoverage(database, input, options)
      ));
    },
  };
}

module.exports = {
  createRobinhoodWalletRankingWindowCoverage,
  readRobinhoodWalletRankingWindowCoverage,
};

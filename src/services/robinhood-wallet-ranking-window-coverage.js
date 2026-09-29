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

function classifyPair(events, classification, availability, swapAvailability, frontiers, globals) {
  const reasons = [...globals];
  if (events.truncated) reasons.push('window_events_truncated');
  if (!events.orderingComplete) reasons.push('window_event_order_unverified');
  reasons.push(...failedReasons(classification?.rawRowsClassified,
    classification?.reasons, 'transfer_classification_unverified'));
  reasons.push('source_coverage_unverified');
  const checks = {
    rawTransferAvailable: availability?.rawTransferAvailable === true,
    swapPartitionsAvailable: swapAvailability?.swapPartitionsAvailable === true,
    sourceFrontiersReady: frontiers?.cursorChecksPassed === true,
    rawRowsClassified: classification?.rawRowsClassified === true,
    orderingComplete: events.orderingComplete === true,
    truncated: events.truncated === true,
  };
  return {
    ...events,
    checks,
    preconditionsSatisfied: checks.rawTransferAvailable && checks.swapPartitionsAvailable
      && checks.sourceFrontiersReady
      && checks.rawRowsClassified && checks.orderingComplete && !checks.truncated,
    eventsComplete: false,
    sourceCoverageVerified: false,
    coverageReasons: [...new Set(reasons)].sort(),
  };
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
  const globals = globalReasons(availability, swapAvailability, frontiers);
  const byPair = new Map(classifications.map((item) => [pairKey(item), item]));
  return events.map((item) => classifyPair(
    item, byPair.get(pairKey(item)), availability, swapAvailability, frontiers, globals,
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

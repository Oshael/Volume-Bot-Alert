const {
  createRobinhoodWalletRankingWindowEventsRepository,
} = require('../models/robinhood-wallet-ranking-window-events');
const {
  createRobinhoodWalletRankingTransferAvailabilityRepository,
} = require('../models/robinhood-wallet-ranking-transfer-availability');
const {
  createRobinhoodWalletRankingSourceFrontiersRepository,
} = require('../models/robinhood-wallet-ranking-source-frontiers');
const {
  createRobinhoodWalletRankingTransferClassificationRepository,
} = require('../models/robinhood-wallet-ranking-transfer-classification');

function pairKey(item) {
  return `${item.tokenAddress}:${item.walletAddress}`;
}

function failedReasons(ready, values, fallback) {
  if (ready === true) return [];
  return values?.length ? values : [fallback];
}

function globalReasons(availability, frontiers) {
  const partitionReasons = availability?.partitions?.flatMap((day) => day.reasons || []);
  const frontierReasons = frontiers?.sources?.flatMap((source) => source.reasons || []);
  return [
    ...failedReasons(availability?.rawTransferAvailable, partitionReasons,
      'raw_transfer_availability_unverified'),
    ...failedReasons(frontiers?.cursorChecksPassed, frontierReasons,
      'source_frontiers_unverified'),
  ];
}

function classifyPair(events, classification, availability, frontiers, globals) {
  const reasons = [...globals];
  if (events.truncated) reasons.push('window_events_truncated');
  if (!events.orderingComplete) reasons.push('window_event_order_unverified');
  reasons.push(...failedReasons(classification?.rawRowsClassified,
    classification?.reasons, 'transfer_classification_unverified'));
  reasons.push('source_coverage_unverified');
  const checks = {
    rawTransferAvailable: availability?.rawTransferAvailable === true,
    sourceFrontiersReady: frontiers?.cursorChecksPassed === true,
    rawRowsClassified: classification?.rawRowsClassified === true,
    orderingComplete: events.orderingComplete === true,
    truncated: events.truncated === true,
  };
  return {
    ...events,
    checks,
    preconditionsSatisfied: checks.rawTransferAvailable && checks.sourceFrontiersReady
      && checks.rawRowsClassified && checks.orderingComplete && !checks.truncated,
    eventsComplete: false,
    sourceCoverageVerified: false,
    coverageReasons: [...new Set(reasons)].sort(),
  };
}

function createRobinhoodWalletRankingWindowCoverage(options = {}) {
  const repositoryOptions = { database: options.database };
  const eventsRepository = options.eventsRepository
    || createRobinhoodWalletRankingWindowEventsRepository(repositoryOptions);
  const availabilityRepository = options.availabilityRepository
    || createRobinhoodWalletRankingTransferAvailabilityRepository(repositoryOptions);
  const frontiersRepository = options.frontiersRepository
    || createRobinhoodWalletRankingSourceFrontiersRepository(repositoryOptions);
  const classificationRepository = options.classificationRepository
    || createRobinhoodWalletRankingTransferClassificationRepository(repositoryOptions);

  return {
    async getWindowEvents(input = {}) {
      const events = await eventsRepository.getWindowEvents(input);
      if (!events.length) return [];
      const windowStart = events[0].windowStart;
      const asOf = events[0].asOf;
      const pairs = events.map(({ tokenAddress, walletAddress }) => ({
        tokenAddress, walletAddress,
      }));
      const [availability, frontiers, classifications] = await Promise.all([
        availabilityRepository.inspectWindow({ windowStart, asOf }),
        frontiersRepository.inspectAsOf({ asOf, transferVersion: input.classificationVersion }),
        classificationRepository.inspectWindow({
          pairs, windowStart, asOf, classificationVersion: input.classificationVersion,
        }),
      ]);
      const globals = globalReasons(availability, frontiers);
      const byPair = new Map(classifications.map((item) => [pairKey(item), item]));
      return events.map((item) => classifyPair(
        item, byPair.get(pairKey(item)), availability, frontiers, globals,
      ));
    },
  };
}

module.exports = { createRobinhoodWalletRankingWindowCoverage };

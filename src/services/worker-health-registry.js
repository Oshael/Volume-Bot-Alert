'use strict';

const PROFILES = Object.freeze({
  live: Object.freeze({
    startupGraceMs: 180_000, freshnessMs: 180_000, maxInFlightMs: 120_000,
    maxConsecutiveErrors: 3, maxLagBlocks: 50, maxLagMs: 60_000,
    maxLoopOverrunMs: 30_000, maxQueue: 1_000,
  }),
  polling: Object.freeze({
    startupGraceMs: 600_000, freshnessMs: 1_800_000, maxInFlightMs: 600_000,
    maxConsecutiveErrors: 3, maxLagBlocks: 500, maxLagMs: 300_000,
    maxLoopOverrunMs: 120_000, maxQueue: 5_000,
  }),
  maintenance: Object.freeze({
    startupGraceMs: 3_600_000, freshnessMs: 7_200_000, maxInFlightMs: 3_600_000,
    maxConsecutiveErrors: 2, maxLagBlocks: 10_000, maxLagMs: 3_600_000,
    maxLoopOverrunMs: 600_000, maxQueue: 50_000,
  }),
});

const DEFINITIONS = [
  ['core-support-runtime', 'Core support runtime', 'core', 'maintenance'],
  ['web-realtime-runtime', 'Web realtime runtime', 'web', 'live'],
  ['telegram-alert-runtime', 'Telegram alert runtime', 'core', 'live'],
  ['catalog-worker', 'Catalog worker', 'core', 'polling'],
  ['dex-discovery-worker', 'Dex discovery worker', 'core', 'polling'],
  ['token-risk-enrichment-worker', 'Token risk enrichment worker', 'core', 'polling'],
  ['token-risk-review-sync-worker', 'Token risk review sync worker', 'core', 'polling'],
  ['meteora-snapshot-worker', 'Meteora snapshot worker', 'market', 'polling'],
  ['bid-zone-worker', 'Bid-zone worker', 'market', 'polling'],
  ['gmgn-discovery-worker', 'GMGN discovery worker', 'market', 'polling'],
  ['gmgn-claim-signal-worker', 'GMGN claim signal worker', 'market', 'polling'],
  ['catalog-cleanup-worker', 'Catalog cleanup worker', 'solana-maintenance|maintenance', 'maintenance'],
  ['robinhood-retention-worker', 'Robinhood retention worker', 'robinhood-maintenance|maintenance', 'maintenance'],
  ['mock-trading-take-profit-worker', 'Mock trading take-profit worker', 'maintenance', 'polling'],
  ['robinhood-ingestion-worker', 'Robinhood ingestion worker', 'robinhood', 'live'],
  ['robinhood-head-capture-worker', 'Robinhood head capture worker', 'robinhood-head', 'live'],
  ['robinhood-processing-worker', 'Robinhood processing worker', 'robinhood-processing', 'live'],
  ['robinhood-derived-worker', 'Robinhood derived worker', 'robinhood-derived', 'live'],
  ['robinhood-catalog-staging-worker', 'Robinhood catalog staging worker', 'robinhood', 'live'],
  ['robinhood-catalog-projection-worker', 'Robinhood catalog projection worker', 'robinhood-derived|robinhood', 'polling'],
  ['robinhood-wallet-swap-live-worker', 'Robinhood wallet-swap LIVE worker', 'robinhood-wallet', 'live'],
  ['robinhood-direct-creator-live-worker', 'Robinhood direct creator LIVE worker', 'robinhood-wallet', 'live'],
  ['robinhood-token-deployment-worker', 'Robinhood token deployment LIVE worker', 'robinhood-wallet-classification', 'live'],
  ['robinhood-sniper-shadow-worker', 'Robinhood SNIPER shadow worker', 'robinhood-wallet-classification', 'polling'],
  ['robinhood-insider-shadow-worker', 'Robinhood INSIDER shadow worker', 'robinhood-wallet-classification', 'polling'],
  ['robinhood-first-buy-live-worker', 'Robinhood first-buy LIVE worker', 'robinhood-wallet-classification', 'live'],
  ['robinhood-launch-anchor-live-worker', 'Robinhood launch-anchor LIVE worker', 'robinhood-wallet-classification', 'live'],
  ['robinhood-bundle-funding-live-worker', 'Robinhood BUNDLED funding LIVE worker', 'robinhood-wallet-classification', 'live'],
  ['robinhood-wallet-position-live-worker', 'Robinhood wallet-position LIVE worker', 'robinhood-wallet-classification', 'live'],
  ['robinhood-wallet-transfer-live-worker', 'Robinhood wallet-transfer LIVE worker', 'robinhood-wallet-classification', 'live'],
  ['robinhood-holder-live-worker', 'Robinhood holder LIVE worker', 'robinhood-holders', 'live'],
  ['robinhood-holder-live-apply-worker', 'Robinhood holder LIVE apply worker', 'robinhood-holders', 'live'],
  ['robinhood-holder-intelligence-worker', 'Robinhood holder intelligence worker', 'robinhood-holders', 'polling'],
  ['robinhood-holder-backfill-worker', 'Robinhood holder backfill worker', 'robinhood-holders', 'polling'],
  ['robinhood-holder-cold-worker', 'Robinhood holder cold worker', 'robinhood-holders', 'maintenance'],
  ['robinhood-holder-reconciliation-worker', 'Robinhood holder reconciliation worker', 'robinhood-holders', 'polling'],
  ['robinhood-holder-journal-prune-worker', 'Robinhood holder journal prune worker', 'robinhood-holders', 'maintenance'],
  ['robinhood-holder-snapshot-worker', 'Robinhood holder snapshot worker', 'robinhood-holders', 'maintenance'],
  ['robinhood-holder-summary-worker', 'Robinhood holder summary worker', 'robinhood-derived', 'polling'],
  ['robinhood-holder-global-backfill-worker', 'Robinhood holder global backfill worker', 'robinhood-holder-global|robinhood-holders', 'maintenance'],
  ['robinhood-backfill-discovery-scanner', 'Robinhood backfill discovery scanner', 'robinhood-backfill|robinhood', 'polling'],
  ['robinhood-backfill-market-scanner', 'Robinhood backfill market scanner', 'robinhood-backfill|robinhood', 'polling'],
  ['robinhood-backfill-enrichment-worker', 'Robinhood backfill enrichment worker', 'robinhood-backfill|robinhood', 'polling'],
  ['robinhood-backfill-finalizer-worker', 'Robinhood backfill finalizer worker', 'robinhood-backfill|robinhood', 'polling'],
  ['robinhood-backfill-watchdog-worker', 'Robinhood backfill watchdog worker', 'robinhood-backfill|robinhood', 'polling'],
  ['robinhood-backfill-aggregation-worker', 'Robinhood backfill aggregation worker', 'robinhood-backfill|robinhood', 'polling'],
  ['callout-capture-worker', 'Pump/Fomo callout capture worker', 'callouts', 'live'],
  ['token-image-fingerprint-worker', 'Token image fingerprint worker', 'x-match', 'polling'],
  ['x-ingestion-worker', 'X ingestion worker', 'x-ingest', 'live'],
  ['robinhood-pool-liquidity-worker', 'Robinhood pool liquidity worker', 'robinhood-liquidity', 'live'],
  ['robinhood-wallet-transfer-backfill-worker', 'Robinhood wallet-transfer backfill worker', 'robinhood-wallet-classification', 'maintenance'],
].map(([key, label, groupList, profile]) => Object.freeze({
  key, label, group: groupList.split('|')[0], groups: Object.freeze(groupList.split('|')),
  profile, thresholds: PROFILES[profile],
}));

const BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

function getWorkerHealthDefinition(key) {
  return BY_KEY.get(String(key || '').trim()) || null;
}

module.exports = {
  PROFILES,
  getWorkerHealthDefinition,
  listWorkerHealthDefinitions: () => [...DEFINITIONS],
};

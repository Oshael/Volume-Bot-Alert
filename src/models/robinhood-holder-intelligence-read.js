const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  HOLDER_CLASSIFICATION_VERSION,
  HOLDER_DISTRIBUTION_METRICS,
  normalizeHolderTags,
  primaryHolderTag,
} = require('../services/robinhood-holder-classification-domain');

const STATUS_PRIORITY = Object.freeze(['reorged', 'stale', 'pending', 'unavailable', 'ready']);
const MAX_PAGE_WALLETS = 50;
const DEFAULT_PUBLIC_TAGS = Object.freeze(['lp', 'cex']);
const DEFAULT_PUBLIC_METRICS = Object.freeze(['top10', 'top50', 'dev_hold', 'lp_locked']);
const TAG_METRICS = Object.freeze({
  sniper: 'snipers', fresh: 'fresh_wallets', insider: 'insiders',
});

function iso(value) {
  return value?.toISOString?.() || value || null;
}

function aggregateState(rows) {
  if (!rows.length) return Object.freeze({ status: 'unavailable', throughBlock: null });
  let status = STATUS_PRIORITY.find((candidate) => rows.some((row) => row.status === candidate))
    || 'unavailable';
  const frontiers = rows.filter((row) => row.through_block_number != null).map((row) => ({
    blockNumber: String(row.through_block_number), blockHash: row.through_block_hash,
  }));
  if (!frontiers.length) return Object.freeze({ status, throughBlock: null });
  const throughBlock = frontiers.reduce((earliest, candidate) => (
    BigInt(candidate.blockNumber) < BigInt(earliest.blockNumber) ? candidate : earliest
  ));
  const sameBlockFork = frontiers.some((candidate) => (
    candidate.blockNumber === throughBlock.blockNumber
      && candidate.blockHash !== throughBlock.blockHash
  ));
  const mixedFrontiers = frontiers.some((candidate) => (
    candidate.blockNumber !== throughBlock.blockNumber
  ));
  if (sameBlockFork) status = 'reorged';
  else if (mixedFrontiers && status === 'ready') status = 'stale';
  return Object.freeze({ status, throughBlock: Object.freeze(throughBlock) });
}

function publicMetric(metric, row) {
  return Object.freeze({
    metric,
    status: row?.status || 'unavailable',
    value: row?.value_numerator_raw == null ? null : Object.freeze({
      numeratorRaw: String(row.value_numerator_raw),
      denominatorRaw: String(row.value_denominator_raw),
    }),
    walletCount: row?.wallet_count == null ? null : String(row.wallet_count),
    groupCount: row?.group_count == null ? null : String(row.group_count),
    classificationVersion: row?.classification_version || HOLDER_CLASSIFICATION_VERSION,
    throughBlock: row?.through_block_number == null ? null : Object.freeze({
      blockNumber: String(row.through_block_number), blockHash: row.through_block_hash,
    }),
    observedAt: iso(row?.observed_at),
  });
}

function publicHolder(address, records, state) {
  const tags = normalizeHolderTags(records.map(({ tag }) => tag));
  return Object.freeze({
    address,
    tags,
    primaryTag: primaryHolderTag(tags),
    classificationVersion: HOLDER_CLASSIFICATION_VERSION,
    classificationStatus: state.status,
    classifications: Object.freeze(records.map((row) => Object.freeze({
      tag: row.tag,
      confidence: row.confidence,
      reasonCode: row.reason_code,
      observedAt: iso(row.observed_at),
      expiresAt: iso(row.expires_at),
    }))),
  });
}

function createRobinhoodHolderIntelligenceReadRepository(options = {}) {
  const database = options.database || db;
  const publicTags = new Set(options.publicTags || DEFAULT_PUBLIC_TAGS);
  const publicMetrics = new Set(DEFAULT_PUBLIC_METRICS);
  for (const tag of publicTags) if (TAG_METRICS[tag]) publicMetrics.add(TAG_METRICS[tag]);

  async function loadPage(input = {}) {
    const tokenAddress = normalizeTokenAddress('robinhood', input.tokenAddress);
    if (!Array.isArray(input.walletAddresses) || input.walletAddresses.length > MAX_PAGE_WALLETS) {
      throw new Error(`walletAddresses must contain at most ${MAX_PAGE_WALLETS} addresses`);
    }
    const walletAddresses = [...new Set(input.walletAddresses.map((value) => (
      normalizeTokenAddress('robinhood', value)
    )))];
    const [statesResult, classificationsResult, metricsResult] = await Promise.all([
      database.query(
        `SELECT classifier, status, through_block_number, through_block_hash, observed_at
           FROM robinhood_holder_classification_states
          WHERE chain = 'robinhood' AND token_address = $1
            AND classification_version = $2
            AND classifier = ANY($3::varchar[]) ORDER BY classifier`,
        [tokenAddress, HOLDER_CLASSIFICATION_VERSION, [...publicTags]]
      ),
      walletAddresses.length ? database.query(
        `SELECT wallet_address, tag, confidence, reason_code, observed_at, expires_at
           FROM robinhood_holder_classifications
          WHERE chain = 'robinhood' AND token_address = $1
            AND classification_version = $2 AND wallet_address = ANY($3::varchar[])
            AND tag = ANY($4::varchar[])
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY wallet_address, tag`,
        [tokenAddress, HOLDER_CLASSIFICATION_VERSION, walletAddresses, [...publicTags]]
      ) : Promise.resolve({ rows: [] }),
      database.query(
        `SELECT metric, classification_version, status, value_numerator_raw,
                value_denominator_raw, wallet_count, group_count,
                through_block_number, through_block_hash, observed_at
           FROM robinhood_holder_distribution_metrics
          WHERE chain = 'robinhood' AND token_address = $1
            AND classification_version = $2
            AND metric = ANY($3::varchar[]) ORDER BY metric`,
        [tokenAddress, HOLDER_CLASSIFICATION_VERSION, [...publicMetrics]]
      ),
    ]);
    const publicStates = statesResult.rows.filter(({ classifier }) => publicTags.has(classifier));
    const publicRecords = classificationsResult.rows.filter(({ tag }) => publicTags.has(tag));
    const state = aggregateState(publicStates);
    const recordsByWallet = new Map(walletAddresses.map((address) => [address, []]));
    for (const row of publicRecords) recordsByWallet.get(row.wallet_address)?.push(row);
    const metricsByName = new Map(metricsResult.rows
      .filter(({ metric }) => publicMetrics.has(metric)).map((row) => [row.metric, row]));
    return Object.freeze({
      classificationVersion: HOLDER_CLASSIFICATION_VERSION,
      classificationStatus: state.status,
      classificationThroughBlock: state.throughBlock,
      holders: Object.freeze(walletAddresses.map((address) => (
        publicHolder(address, recordsByWallet.get(address), state)
      ))),
      distribution: Object.freeze(HOLDER_DISTRIBUTION_METRICS.map((metric) => (
        publicMetric(metric, metricsByName.get(metric))
      ))),
    });
  }

  return Object.freeze({ loadPage });
}

module.exports = {
  createRobinhoodHolderIntelligenceReadRepository,
  __private: {
    aggregateState, DEFAULT_PUBLIC_METRICS, DEFAULT_PUBLIC_TAGS, publicHolder, publicMetric,
  },
};

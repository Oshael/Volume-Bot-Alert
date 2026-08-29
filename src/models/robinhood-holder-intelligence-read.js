const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  HOLDER_CLASSIFICATION_VERSION,
  HOLDER_DISTRIBUTION_METRICS,
  normalizeHolderTags,
  primaryHolderTag,
} = require('../services/robinhood-holder-classification-domain');
const {
  SNIPER_HIGH_CONFIDENCE_RULE,
} = require('../services/robinhood-holder-sniper-policy');

const STATUS_PRIORITY = Object.freeze(['reorged', 'stale', 'pending', 'unavailable', 'ready']);
const MAX_PAGE_WALLETS = 50;
const DEFAULT_PUBLIC_TAGS = Object.freeze(['lp', 'cex', 'sniper', 'bundled']);
const DEFAULT_PUBLIC_METRICS = Object.freeze([
  'top10', 'top50', 'dev_hold', 'lp_locked', 'bundled',
]);
const TAG_METRICS = Object.freeze({
  sniper: 'snipers', bundled: 'bundled', fresh: 'fresh_wallets', insider: 'insiders',
});
const BUNDLE_RULE_VERSION = 'rh_possible_bundle_v1';

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
            AND classification_version = $2 AND classifier = ANY($3::varchar[])
         UNION ALL
         SELECT 'bundled', status, through_block_number, through_block_hash, observed_at
           FROM robinhood_possible_bundle_states
          WHERE $4::boolean AND chain = 'robinhood' AND token_address = $1
            AND rule_version = $5
          ORDER BY classifier`,
        [tokenAddress, HOLDER_CLASSIFICATION_VERSION, [...publicTags],
          publicTags.has('bundled'), BUNDLE_RULE_VERSION]
      ),
      walletAddresses.length ? database.query(
        `SELECT wallet_address, tag, confidence, reason_code, observed_at, expires_at
           FROM robinhood_holder_classifications
          WHERE chain = 'robinhood' AND token_address = $1
            AND classification_version = $2 AND wallet_address = ANY($3::varchar[])
            AND tag = ANY($4::varchar[])
            AND (tag <> 'sniper' OR (
              confidence = 'high'
              AND evidence_json #>> '{rule,evidenceVersion}' = $5
            ))
            AND (expires_at IS NULL OR expires_at > NOW())
         UNION ALL
         SELECT member.wallet_address, 'bundled', 'heuristic',
                'connected_funding_launch_cluster', state.observed_at, NULL::timestamptz
           FROM robinhood_possible_bundle_members member
           INNER JOIN robinhood_possible_bundle_states state
             ON state.chain = member.chain AND state.token_address = member.token_address
            AND state.rule_version = member.rule_version
          WHERE $6::boolean AND member.chain = 'robinhood' AND member.token_address = $1
            AND member.rule_version = $7 AND member.wallet_address = ANY($3::varchar[])
            AND state.status = 'ready'
          ORDER BY wallet_address, tag`,
        [
          tokenAddress, HOLDER_CLASSIFICATION_VERSION, walletAddresses, [...publicTags],
          SNIPER_HIGH_CONFIDENCE_RULE.evidenceVersion, publicTags.has('bundled'),
          BUNDLE_RULE_VERSION,
        ]
      ) : Promise.resolve({ rows: [] }),
      database.query(
        `WITH stored_metrics AS MATERIALIZED (
           SELECT metric, classification_version, status, value_numerator_raw,
                  value_denominator_raw, wallet_count, group_count,
                  through_block_number, through_block_hash, observed_at
             FROM robinhood_holder_distribution_metrics
            WHERE chain = 'robinhood' AND token_address = $1
              AND classification_version = $2
              AND metric = ANY($3::varchar[])
              AND metric <> 'bundled'
              AND (metric <> 'snipers'
                OR evidence_json #>> '{rule,evidenceVersion}' = $5)
         ), current_snipers AS MATERIALIZED (
           SELECT COALESCE(SUM(balance.balance_raw), 0) AS balance_raw,
                  COUNT(balance.wallet_address)::bigint AS wallet_count
             FROM robinhood_holder_classifications classification
             LEFT JOIN robinhood_holder_balances balance
               ON balance.chain = classification.chain
              AND balance.token_address = classification.token_address
              AND balance.wallet_address = classification.wallet_address
            WHERE $4::boolean
              AND classification.chain = 'robinhood'
              AND classification.token_address = $1
              AND classification.classification_version = $2
              AND classification.tag = 'sniper'
              AND classification.confidence = 'high'
              AND classification.evidence_json #>> '{rule,evidenceVersion}' = $5
              AND (classification.expires_at IS NULL OR classification.expires_at > NOW())
         ), current_supply AS MATERIALIZED (
           SELECT observation.token_total_supply_raw
             FROM robinhood_market_observations observation
            WHERE ($4::boolean OR $6::boolean) AND observation.chain = 'robinhood'
              AND observation.token_address = $1 AND observation.status = 'accepted'
              AND observation.token_total_supply_raw > 0
            ORDER BY observation.observed_at DESC LIMIT 1
         ), derived_snipers AS (
           SELECT 'snipers'::varchar AS metric, state.classification_version,
                  CASE WHEN supply.token_total_supply_raw IS NULL
                       THEN 'unavailable' ELSE state.status END AS status,
                  CASE WHEN supply.token_total_supply_raw IS NULL THEN NULL
                       ELSE LEAST(snipers.balance_raw, supply.token_total_supply_raw) END
                    AS value_numerator_raw,
                  supply.token_total_supply_raw AS value_denominator_raw,
                  CASE WHEN supply.token_total_supply_raw IS NULL
                       THEN NULL ELSE snipers.wallet_count END AS wallet_count,
                  NULL::bigint AS group_count,
                  CASE WHEN supply.token_total_supply_raw IS NULL THEN NULL
                       ELSE state.through_block_number END AS through_block_number,
                  CASE WHEN supply.token_total_supply_raw IS NULL THEN NULL
                       ELSE state.through_block_hash END AS through_block_hash,
                  state.observed_at
             FROM robinhood_holder_classification_states state
             CROSS JOIN current_snipers snipers
             LEFT JOIN current_supply supply ON TRUE
            WHERE $4::boolean AND state.chain = 'robinhood'
              AND state.token_address = $1 AND state.classifier = 'sniper'
              AND state.classification_version = $2
              AND state.status IN ('ready', 'stale', 'reorged')
              AND NOT EXISTS (SELECT 1 FROM stored_metrics WHERE metric = 'snipers')
         ), current_bundled AS MATERIALIZED (
           SELECT COALESCE(SUM(balance.balance_raw), 0) AS balance_raw,
                  COUNT(balance.wallet_address)::bigint AS wallet_count,
                  COUNT(DISTINCT member.bundle_id)
                    FILTER (WHERE balance.wallet_address IS NOT NULL)::bigint AS group_count
             FROM robinhood_possible_bundle_members member
             INNER JOIN robinhood_possible_bundle_states state
               ON state.chain = member.chain AND state.token_address = member.token_address
              AND state.rule_version = member.rule_version
             LEFT JOIN robinhood_holder_balances balance
               ON balance.chain = member.chain AND balance.token_address = member.token_address
              AND balance.wallet_address = member.wallet_address
            WHERE $6::boolean AND member.chain = 'robinhood' AND member.token_address = $1
              AND member.rule_version = $7 AND state.status = 'ready'
         ), derived_bundled AS (
           SELECT 'bundled'::varchar AS metric, $2::varchar AS classification_version,
                  CASE WHEN supply.token_total_supply_raw IS NULL
                       THEN 'unavailable' ELSE state.status END AS status,
                  CASE WHEN supply.token_total_supply_raw IS NULL THEN NULL
                       ELSE LEAST(bundle.balance_raw, supply.token_total_supply_raw) END
                    AS value_numerator_raw,
                  supply.token_total_supply_raw AS value_denominator_raw,
                  CASE WHEN supply.token_total_supply_raw IS NULL
                       THEN NULL ELSE bundle.wallet_count END AS wallet_count,
                  CASE WHEN supply.token_total_supply_raw IS NULL
                       THEN NULL ELSE bundle.group_count END AS group_count,
                  CASE WHEN supply.token_total_supply_raw IS NULL
                       THEN NULL ELSE state.through_block_number END AS through_block_number,
                  CASE WHEN supply.token_total_supply_raw IS NULL
                       THEN NULL ELSE state.through_block_hash END AS through_block_hash,
                  state.observed_at
             FROM robinhood_possible_bundle_states state
             CROSS JOIN current_bundled bundle LEFT JOIN current_supply supply ON TRUE
            WHERE $6::boolean AND state.chain = 'robinhood' AND state.token_address = $1
              AND state.rule_version = $7 AND state.status = 'ready'
         )
         SELECT * FROM stored_metrics
         UNION ALL SELECT * FROM derived_snipers
         UNION ALL SELECT * FROM derived_bundled
         ORDER BY metric`,
        [
          tokenAddress, HOLDER_CLASSIFICATION_VERSION, [...publicMetrics],
          publicTags.has('sniper'), SNIPER_HIGH_CONFIDENCE_RULE.evidenceVersion,
          publicTags.has('bundled'), BUNDLE_RULE_VERSION,
        ]
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

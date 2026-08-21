const db = require('./db');
const {
  CLASSIFICATION_STATUSES,
  HOLDER_CLASSIFICATION_VERSION,
  HOLDER_DISTRIBUTION_METRICS,
  compareClassificationFrontiers,
} = require('../services/robinhood-holder-classification-domain');

const FRONTIER_STATUSES = new Set(['ready', 'stale', 'reorged']);

function text(value, label, pattern) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function integer(value, label, optional = false) {
  if (optional && value == null) return null;
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('evidence must contain finite values');
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map(canonicalJson));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const canonical = {};
    for (const key of Object.keys(value).sort()) canonical[key] = canonicalJson(value[key]);
    return Object.freeze(canonical);
  }
  throw new Error('evidence must be JSON-compatible');
}

function evidence(value) {
  const canonical = canonicalJson(value);
  if (!canonical || Array.isArray(canonical) || Object.keys(canonical).length === 0) {
    throw new Error('evidence must be a non-empty object');
  }
  return canonical;
}

function normalizeFrontier(input, status) {
  const hasFrontier = input.throughBlockNumber != null || input.throughBlockHash != null;
  if ((input.throughBlockNumber == null) !== (input.throughBlockHash == null)
      || FRONTIER_STATUSES.has(status) !== hasFrontier) {
    throw new Error(`${status} metric snapshot has an incoherent frontier`);
  }
  return Object.freeze({
    blockNumber: hasFrontier ? integer(input.throughBlockNumber, 'throughBlockNumber') : null,
    blockHash: hasFrontier
      ? text(input.throughBlockHash, 'throughBlockHash', /^0x[0-9a-f]{64}$/) : null,
  });
}

function normalizePayload(input, metric, status) {
  const numerator = integer(input.valueNumeratorRaw, 'valueNumeratorRaw', true);
  const denominator = integer(input.valueDenominatorRaw, 'valueDenominatorRaw', true);
  const walletCount = integer(input.walletCount, 'walletCount', true);
  const groupCount = integer(input.groupCount, 'groupCount', true);
  const readyPayload = FRONTIER_STATUSES.has(status);
  if (!readyPayload && [numerator, denominator, walletCount, groupCount].some((v) => v != null)) {
    throw new Error(`${status} metric snapshot cannot publish values`);
  }
  if (readyPayload && metric === 'bundled'
      && (numerator != null || denominator != null || walletCount == null || groupCount == null)) {
    throw new Error('bundled metric snapshot requires count-only values');
  }
  if (readyPayload && metric !== 'bundled'
      && (numerator == null || denominator == null || groupCount != null
        || BigInt(denominator) === 0n || BigInt(numerator) > BigInt(denominator))) {
    throw new Error(`${metric} metric snapshot requires a valid ratio`);
  }
  return Object.freeze({ numerator, denominator, walletCount, groupCount });
}

function normalizeSnapshot(input = {}) {
  const status = text(input.status, 'status', /^[a-z]+$/);
  const metric = text(input.metric, 'metric', /^[a-z0-9_]+$/);
  if (!CLASSIFICATION_STATUSES.includes(status)) throw new Error(`Unsupported status: ${status}`);
  if (!HOLDER_DISTRIBUTION_METRICS.includes(metric)) throw new Error(`Unsupported metric: ${metric}`);
  const frontier = normalizeFrontier(input, status);
  const payload = normalizePayload(input, metric, status);
  const observedAt = new Date(input.observedAt);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('observedAt is invalid');
  return Object.freeze({
    tokenAddress: text(input.tokenAddress, 'tokenAddress', /^0x[0-9a-f]{40}$/),
    metric,
    classificationVersion: text(
      input.classificationVersion || HOLDER_CLASSIFICATION_VERSION,
      'classificationVersion', /^rh_holder_v[1-9]\d*$/
    ),
    status,
    statusReason: text(input.statusReason, 'statusReason', /^[a-z0-9][a-z0-9_-]{0,63}$/),
    valueNumeratorRaw: payload.numerator,
    valueDenominatorRaw: payload.denominator,
    walletCount: payload.walletCount,
    groupCount: payload.groupCount,
    evidence: evidence(input.evidence),
    throughBlockNumber: frontier.blockNumber,
    throughBlockHash: frontier.blockHash,
    observedAt: observedAt.toISOString(),
  });
}

function signature(snapshot) {
  const { observedAt: _observedAt, ...semantic } = snapshot;
  return JSON.stringify(semantic);
}

function assertSameMetric(left, right) {
  const keys = ['tokenAddress', 'metric', 'classificationVersion'];
  if (keys.some((key) => left[key] !== right[key])) {
    throw new Error('Cannot transition different metric snapshots');
  }
}

function planTransition(currentInput, candidateInput, options = {}) {
  if (!currentInput) return 'replace';
  const current = normalizeSnapshot(currentInput);
  const candidate = normalizeSnapshot(candidateInput);
  assertSameMetric(current, candidate);
  const currentFrontier = current.throughBlockNumber == null ? null : {
    blockNumber: current.throughBlockNumber, blockHash: current.throughBlockHash,
  };
  const candidateFrontier = candidate.throughBlockNumber == null ? null : {
    blockNumber: candidate.throughBlockNumber, blockHash: candidate.throughBlockHash,
  };
  if (currentFrontier && !candidateFrontier) {
    if (options.allowReset === true) return 'replace';
    throw new Error('Metric frontier reset requires explicit replacement');
  }
  if (!currentFrontier && candidateFrontier) return 'replace';
  if (currentFrontier && candidateFrontier) {
    const relation = compareClassificationFrontiers(candidateFrontier, currentFrontier);
    if (relation === 'behind') return 'ignore';
    if (relation === 'ahead') return 'replace';
    if (relation === 'fork') {
      if (options.allowForkReplacement === true) return 'replace';
      throw new Error('Metric frontier fork requires explicit replacement');
    }
  }
  if (signature(current) !== signature(candidate)) {
    throw new Error('Conflicting metric snapshot at the same frontier');
  }
  return 'unchanged';
}

function rowSnapshot(row) {
  return row ? normalizeSnapshot({
    tokenAddress: row.token_address, metric: row.metric,
    classificationVersion: row.classification_version, status: row.status,
    statusReason: row.status_reason, valueNumeratorRaw: row.value_numerator_raw,
    valueDenominatorRaw: row.value_denominator_raw, walletCount: row.wallet_count,
    groupCount: row.group_count, evidence: row.evidence_json,
    throughBlockNumber: row.through_block_number, throughBlockHash: row.through_block_hash,
    observedAt: row.observed_at,
  }) : null;
}

function createRobinhoodHolderDistributionMetricRepository(options = {}) {
  const database = options.database || db;

  async function replaceMetricSnapshot(input, transitionOptions = {}) {
    const candidate = normalizeSnapshot(input);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        ['robinhood', candidate.tokenAddress, candidate.metric,
          candidate.classificationVersion].join(':'),
      ]);
      const loaded = await client.query(
        `SELECT * FROM robinhood_holder_distribution_metrics
          WHERE chain = 'robinhood' AND token_address = $1 AND metric = $2
            AND classification_version = $3 FOR UPDATE`,
        [candidate.tokenAddress, candidate.metric, candidate.classificationVersion]
      );
      const transition = planTransition(rowSnapshot(loaded.rows[0]), candidate, transitionOptions);
      if (transition === 'ignore' || transition === 'unchanged') {
        await client.query('COMMIT');
        return Object.freeze({ status: transition === 'ignore' ? 'stale_ignored' : 'unchanged' });
      }
      await client.query(
        `INSERT INTO robinhood_holder_distribution_metrics (
           chain, token_address, metric, classification_version, status, status_reason,
           value_numerator_raw, value_denominator_raw, wallet_count, group_count,
           evidence_json, through_block_number, through_block_hash, observed_at
         ) VALUES ('robinhood', $1, $2, $3, $4, $5, $6::numeric, $7::numeric,
           $8::bigint, $9::bigint, $10::jsonb, $11::bigint, $12, $13::timestamptz)
         ON CONFLICT (chain, token_address, metric, classification_version) DO UPDATE SET
           status = EXCLUDED.status, status_reason = EXCLUDED.status_reason,
           value_numerator_raw = EXCLUDED.value_numerator_raw,
           value_denominator_raw = EXCLUDED.value_denominator_raw,
           wallet_count = EXCLUDED.wallet_count, group_count = EXCLUDED.group_count,
           evidence_json = EXCLUDED.evidence_json,
           through_block_number = EXCLUDED.through_block_number,
           through_block_hash = EXCLUDED.through_block_hash,
           observed_at = EXCLUDED.observed_at, updated_at = NOW()`,
        [
          candidate.tokenAddress, candidate.metric, candidate.classificationVersion,
          candidate.status, candidate.statusReason, candidate.valueNumeratorRaw,
          candidate.valueDenominatorRaw, candidate.walletCount, candidate.groupCount,
          JSON.stringify(candidate.evidence), candidate.throughBlockNumber,
          candidate.throughBlockHash, candidate.observedAt,
        ]
      );
      await client.query('COMMIT');
      return Object.freeze({ status: 'published' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ replaceMetricSnapshot });
}

module.exports = {
  createRobinhoodHolderDistributionMetricRepository,
  __private: { normalizeSnapshot, planTransition },
};

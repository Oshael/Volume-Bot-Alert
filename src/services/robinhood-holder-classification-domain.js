const HOLDER_CLASSIFICATION_VERSION = 'rh_holder_v1';

const HOLDER_TAGS = Object.freeze(['lp', 'cex', 'sniper', 'bundled', 'fresh', 'insider']);
const HOLDER_DISTRIBUTION_METRICS = Object.freeze([
  'top10', 'top50', 'snipers', 'fresh_wallets', 'insiders',
  'dev_hold', 'lp_locked', 'bundled',
]);
const CLASSIFICATION_STATUSES = Object.freeze([
  'unavailable', 'pending', 'ready', 'stale', 'reorged',
]);
const PRIMARY_TAG_PRIORITY = Object.freeze(['sniper', 'bundled', 'fresh', 'cex', 'lp']);
const CONFIDENCE_LEVELS = new Set(['deterministic', 'high', 'heuristic']);
const REASON_CODES_BY_TAG = Object.freeze({
  lp: Object.freeze(['registered_token_pool', 'registered_v4_pool_manager']),
  cex: Object.freeze(['known_cex_address']),
  sniper: Object.freeze(['early_launch_buy']),
  bundled: Object.freeze(['connected_funding_launch_cluster']),
  fresh: Object.freeze(['new_wallet_at_first_buy']),
  insider: Object.freeze(['creator_token_distribution', 'creator_direct_funding']),
});

function text(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function address(value, label) {
  const normalized = text(value, label);
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a 20-byte address`);
  }
  return normalized;
}

function blockHash(value, label) {
  const normalized = text(value, label);
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 32-byte hash`);
  }
  return normalized;
}

function blockNumber(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function instant(value, label, optional = false) {
  if (optional && (value == null || value === '')) return null;
  const normalized = String(value ?? '').trim();
  const timestamp = Date.parse(normalized);
  if (!normalized || !Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO instant`);
  return new Date(timestamp).toISOString();
}

function canonicalJson(value, label = 'evidence') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite JSON values`);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => canonicalJson(item, label)));
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new Error(`${label} must not contain undefined`);
      normalized[key] = canonicalJson(value[key], label);
    }
    return Object.freeze(normalized);
  }
  throw new Error(`${label} must be JSON-compatible`);
}

function tag(value) {
  const normalized = text(value, 'tag');
  if (!HOLDER_TAGS.includes(normalized)) throw new Error(`Unsupported holder tag: ${normalized}`);
  return normalized;
}

function version(value) {
  const normalized = String(value ?? HOLDER_CLASSIFICATION_VERSION).trim();
  if (!/^rh_holder_v[1-9]\d*$/.test(normalized)) {
    throw new Error('classificationVersion must match rh_holder_vN');
  }
  return normalized;
}

function chain(value) {
  const normalized = value == null ? 'robinhood' : text(value, 'chain');
  if (normalized !== 'robinhood') throw new Error(`Unsupported holder classification chain: ${normalized}`);
  return normalized;
}

function reasonCode(holderTag, value) {
  const normalized = text(value, 'reasonCode');
  if (!REASON_CODES_BY_TAG[holderTag].includes(normalized)) {
    throw new Error(`Unsupported reasonCode for ${holderTag}: ${normalized}`);
  }
  return normalized;
}

function confidence(holderTag, value) {
  const normalized = text(value, 'confidence');
  if (!CONFIDENCE_LEVELS.has(normalized)) {
    throw new Error(`Unsupported holder classification confidence: ${normalized}`);
  }
  if (['lp', 'cex'].includes(holderTag) && normalized !== 'deterministic') {
    throw new Error(`${holderTag} classifications must be deterministic`);
  }
  return normalized;
}

function normalizeClassificationFrontier(input = {}, label = 'frontier') {
  return Object.freeze({
    blockNumber: blockNumber(
      input.blockNumber ?? input.block_number ?? input.throughBlockNumber,
      `${label}.blockNumber`,
    ),
    blockHash: blockHash(
      input.blockHash ?? input.block_hash ?? input.throughBlockHash,
      `${label}.blockHash`,
    ),
  });
}

function compareClassificationFrontiers(leftInput, rightInput) {
  const left = normalizeClassificationFrontier(leftInput, 'leftFrontier');
  const right = normalizeClassificationFrontier(rightInput, 'rightFrontier');
  const leftBlock = BigInt(left.blockNumber);
  const rightBlock = BigInt(right.blockNumber);
  if (leftBlock < rightBlock) return 'behind';
  if (leftBlock > rightBlock) return 'ahead';
  return left.blockHash === right.blockHash ? 'same' : 'fork';
}

function normalizeHolderClassification(input = {}) {
  const holderTag = tag(input.tag);
  const observedAt = instant(input.observedAt ?? input.observed_at, 'observedAt');
  const expiresAt = instant(input.expiresAt ?? input.expires_at, 'expiresAt', true);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new Error('expiresAt must be after observedAt');
  }
  const frontier = normalizeClassificationFrontier({
    blockNumber: input.throughBlockNumber ?? input.through_block_number,
    blockHash: input.throughBlockHash ?? input.through_block_hash,
  });
  const evidence = canonicalJson(input.evidence ?? input.evidenceJson ?? input.evidence_json);
  if (!evidence || Array.isArray(evidence) || Object.keys(evidence).length === 0) {
    throw new Error('evidence must be a non-empty JSON object');
  }
  return Object.freeze({
    chain: chain(input.chain),
    tokenAddress: address(input.tokenAddress ?? input.token_address, 'tokenAddress'),
    walletAddress: address(input.walletAddress ?? input.wallet_address, 'walletAddress'),
    tag: holderTag,
    classificationVersion: version(input.classificationVersion ?? input.classification_version),
    confidence: confidence(holderTag, input.confidence),
    reasonCode: reasonCode(holderTag, input.reasonCode ?? input.reason_code),
    evidence,
    throughBlockNumber: frontier.blockNumber,
    throughBlockHash: frontier.blockHash,
    observedAt,
    expiresAt,
  });
}

function classificationKey(input) {
  const record = normalizeHolderClassification(input);
  return [
    record.chain, record.tokenAddress, record.walletAddress,
    record.tag, record.classificationVersion,
  ].join(':');
}

function normalizeHolderTags(input = []) {
  if (!Array.isArray(input)) throw new Error('tags must be a list');
  const unique = new Set(input.map(tag));
  return Object.freeze(HOLDER_TAGS.filter((candidate) => unique.has(candidate)));
}

function primaryHolderTag(input = []) {
  const tags = normalizeHolderTags(input);
  return PRIMARY_TAG_PRIORITY.find((candidate) => tags.includes(candidate)) ?? 'unknown';
}

function deriveClassificationStatus(input = {}) {
  if (input.sourceAvailable !== true) return 'unavailable';
  if (!input.classificationFrontier) return 'pending';
  if (!input.requiredFrontier) return 'ready';
  const relation = compareClassificationFrontiers(
    input.classificationFrontier, input.requiredFrontier,
  );
  if (relation === 'fork') return 'reorged';
  return relation === 'behind' ? 'stale' : 'ready';
}

function semanticRecord(record) {
  const { observedAt: _observedAt, ...semantic } = record;
  return JSON.stringify(semantic);
}

function selectClassificationRecord(currentInput, candidateInput, options = {}) {
  if (!currentInput) return normalizeHolderClassification(candidateInput);
  const current = normalizeHolderClassification(currentInput);
  const candidate = normalizeHolderClassification(candidateInput);
  if (classificationKey(current) !== classificationKey(candidate)) {
    throw new Error('Cannot reconcile different holder classifications');
  }
  const relation = compareClassificationFrontiers(
    { blockNumber: candidate.throughBlockNumber, blockHash: candidate.throughBlockHash },
    { blockNumber: current.throughBlockNumber, blockHash: current.throughBlockHash },
  );
  if (relation === 'behind') return current;
  if (relation === 'ahead') return candidate;
  if (relation === 'fork') {
    if (options.allowForkReplacement === true) return candidate;
    throw new Error('Holder classification frontier fork requires explicit replacement');
  }
  if (semanticRecord(current) !== semanticRecord(candidate)) {
    throw new Error('Conflicting holder classification at the same frontier');
  }
  return current;
}

module.exports = {
  CLASSIFICATION_STATUSES,
  HOLDER_CLASSIFICATION_VERSION,
  HOLDER_DISTRIBUTION_METRICS,
  HOLDER_TAGS,
  PRIMARY_TAG_PRIORITY,
  REASON_CODES_BY_TAG,
  classificationKey,
  compareClassificationFrontiers,
  deriveClassificationStatus,
  normalizeClassificationFrontier,
  normalizeHolderClassification,
  normalizeHolderTags,
  primaryHolderTag,
  selectClassificationRecord,
};

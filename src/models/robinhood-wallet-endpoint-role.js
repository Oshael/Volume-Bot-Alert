const db = require('./db');

const CHAIN = 'robinhood';
const ROLES = new Set(['wallet', 'contract']);
const MAX_ADDRESSES = 10_000;

function fixedHex(value, label, bytes) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function enumValue(value, label, allowed) {
  const normalized = String(value ?? '').trim();
  if (!allowed.has(normalized)) throw new Error(`${label} is unsupported`);
  return normalized;
}

function identifier(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase identifier`);
  }
  return normalized;
}

function blockNumber(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function normalizeEvidence(input = {}) {
  return Object.freeze({
    endpoint_address: fixedHex(input.endpointAddress, 'endpointAddress', 20),
    endpoint_role: enumValue(input.endpointRole, 'endpointRole', ROLES),
    evidence_source: identifier(input.evidenceSource, 'evidenceSource'),
    evidence_block: blockNumber(input.evidenceBlock, 'evidenceBlock'),
    evidence_block_hash: fixedHex(input.evidenceBlockHash, 'evidenceBlockHash', 32),
    resolver_version: identifier(input.resolverVersion, 'resolverVersion'),
  });
}

function compactEvidence(inputs) {
  if (!Array.isArray(inputs)) throw new TypeError('endpoint role evidence must be a list');
  if (inputs.length > MAX_ADDRESSES) throw new RangeError(`endpoint role evidence exceeds ${MAX_ADDRESSES}`);
  const compacted = new Map();
  for (const input of inputs) {
    const item = normalizeEvidence(input);
    const current = compacted.get(item.endpoint_address);
    if (!current) {
      compacted.set(item.endpoint_address, {
        ...item, observed_from_block: item.evidence_block,
        observed_through_block: item.evidence_block,
      });
      continue;
    }
    current.observed_from_block = BigInt(current.observed_from_block) < BigInt(item.evidence_block)
      ? current.observed_from_block : item.evidence_block;
    current.observed_through_block = BigInt(current.observed_through_block) > BigInt(item.evidence_block)
      ? current.observed_through_block : item.evidence_block;
    if (current.endpoint_role === 'wallet' && item.endpoint_role === 'contract') {
      Object.assign(current, item);
    }
  }
  return [...compacted.values()];
}

function normalizeRow(row) {
  if (!row) return null;
  return Object.freeze({
    endpointAddress: row.endpoint_address,
    endpointRole: row.endpoint_role,
    evidenceSource: row.evidence_source,
    evidenceBlock: String(row.evidence_block),
    evidenceBlockHash: row.evidence_block_hash,
    resolverVersion: row.resolver_version,
    observedFromBlock: String(row.observed_from_block),
    observedThroughBlock: String(row.observed_through_block),
  });
}

function createRobinhoodWalletEndpointRoleRepository(options = {}) {
  const database = options.database || db;

  async function listUnresolvedCandidates(limitInput = 100) {
    const limit = Number(limitInput);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('unresolved endpoint limit must be between 1 and 1000');
    }
    const { rows } = await database.query(
      `WITH endpoint_events AS (
         SELECT from_wallet AS endpoint_address, block_number, block_hash,
                transaction_hash, log_index
           FROM robinhood_token_transfer_events WHERE chain = '${CHAIN}'
         UNION ALL
         SELECT to_wallet AS endpoint_address, block_number, block_hash,
                transaction_hash, log_index
           FROM robinhood_token_transfer_events WHERE chain = '${CHAIN}'
       ), candidates AS (
         SELECT DISTINCT ON (event.endpoint_address)
                event.endpoint_address, event.block_number, event.block_hash
           FROM endpoint_events event
           LEFT JOIN robinhood_wallet_endpoint_roles role
             ON role.chain = '${CHAIN}' AND role.endpoint_address = event.endpoint_address
          WHERE (role.endpoint_address IS NULL OR (
              role.endpoint_role = 'wallet'
              AND event.block_number > role.observed_through_block
            ))
            AND event.endpoint_address NOT IN (
              '0x0000000000000000000000000000000000000000',
              '0x000000000000000000000000000000000000dead'
            )
            AND event.endpoint_address !~ '^0x0{39}[1-9a]$'
          ORDER BY event.endpoint_address, event.block_number DESC,
                   event.transaction_hash DESC, event.log_index DESC
       )
       SELECT endpoint_address, block_number, block_hash FROM candidates
       ORDER BY block_number, endpoint_address LIMIT $1::int`,
      [limit]
    );
    return Object.freeze(rows.map((row) => Object.freeze({
      endpointAddress: row.endpoint_address,
      blockNumber: String(row.block_number),
      blockHash: row.block_hash,
    })));
  }

  async function upsertEvidence(inputs = []) {
    const payload = compactEvidence(inputs);
    if (!payload.length) return Object.freeze([]);
    const { rows } = await database.query(
      `INSERT INTO robinhood_wallet_endpoint_roles (
         chain, endpoint_address, endpoint_role, evidence_source, evidence_block,
         evidence_block_hash, resolver_version, observed_from_block, observed_through_block
       ) SELECT '${CHAIN}', item.endpoint_address, item.endpoint_role, item.evidence_source,
                item.evidence_block::bigint, item.evidence_block_hash, item.resolver_version,
                item.observed_from_block::bigint, item.observed_through_block::bigint
         FROM jsonb_to_recordset($1::jsonb) AS item(
           endpoint_address text, endpoint_role text, evidence_source text,
           evidence_block text, evidence_block_hash text, resolver_version text,
           observed_from_block text, observed_through_block text
         )
       ON CONFLICT (chain, endpoint_address) DO UPDATE SET
         endpoint_role = CASE
           WHEN robinhood_wallet_endpoint_roles.endpoint_role = 'contract' THEN 'contract'
           ELSE EXCLUDED.endpoint_role
         END,
         evidence_source = CASE
           WHEN robinhood_wallet_endpoint_roles.endpoint_role = 'wallet'
            AND EXCLUDED.endpoint_role = 'contract' THEN EXCLUDED.evidence_source
           ELSE robinhood_wallet_endpoint_roles.evidence_source
         END,
         evidence_block = CASE
           WHEN robinhood_wallet_endpoint_roles.endpoint_role = 'wallet'
            AND EXCLUDED.endpoint_role = 'contract' THEN EXCLUDED.evidence_block
           ELSE robinhood_wallet_endpoint_roles.evidence_block
         END,
         evidence_block_hash = CASE
           WHEN robinhood_wallet_endpoint_roles.endpoint_role = 'wallet'
            AND EXCLUDED.endpoint_role = 'contract' THEN EXCLUDED.evidence_block_hash
           ELSE robinhood_wallet_endpoint_roles.evidence_block_hash
         END,
         resolver_version = CASE
           WHEN robinhood_wallet_endpoint_roles.endpoint_role = 'wallet'
            AND EXCLUDED.endpoint_role = 'contract' THEN EXCLUDED.resolver_version
           ELSE robinhood_wallet_endpoint_roles.resolver_version
         END,
         observed_from_block = LEAST(
           robinhood_wallet_endpoint_roles.observed_from_block, EXCLUDED.observed_from_block
         ),
         observed_through_block = GREATEST(
           robinhood_wallet_endpoint_roles.observed_through_block, EXCLUDED.observed_through_block
         ),
         updated_at = NOW()
       RETURNING *`,
      [JSON.stringify(payload)]
    );
    return Object.freeze(rows.map(normalizeRow));
  }

  async function loadRoles(addresses = []) {
    if (!Array.isArray(addresses)) throw new TypeError('endpoint addresses must be a list');
    const normalized = [...new Set(addresses.map((value) => (
      fixedHex(value, 'endpointAddress', 20)
    )))];
    if (normalized.length > MAX_ADDRESSES) throw new RangeError(`endpoint addresses exceed ${MAX_ADDRESSES}`);
    if (!normalized.length) return Object.freeze([]);
    const { rows } = await database.query(
      `SELECT * FROM robinhood_wallet_endpoint_roles
       WHERE chain = '${CHAIN}' AND endpoint_address = ANY($1::varchar[])
       ORDER BY endpoint_address`,
      [normalized]
    );
    return Object.freeze(rows.map(normalizeRow));
  }

  return Object.freeze({ listUnresolvedCandidates, loadRoles, upsertEvidence });
}

module.exports = {
  MAX_ADDRESSES,
  createRobinhoodWalletEndpointRoleRepository,
  __private: { compactEvidence, normalizeEvidence, normalizeRow },
};

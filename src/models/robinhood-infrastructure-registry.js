const db = require('./db');

const CHAIN = 'robinhood';
const INFRASTRUCTURE_KINDS = Object.freeze(['cex', 'router', 'bridge', 'locker', 'burn']);
const KIND_SET = new Set(INFRASTRUCTURE_KINDS);
const MAX_LOOKUP_ADDRESSES = 10_000;

function address(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error('infrastructure address must be a 20-byte address');
  }
  return normalized;
}

function blockNumber(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error('blockNumber must be a non-negative integer');
  return BigInt(normalized).toString();
}

function kinds(values) {
  const supplied = values == null ? INFRASTRUCTURE_KINDS : values;
  if (!Array.isArray(supplied) || !supplied.length) {
    throw new Error('kinds must be a non-empty list');
  }
  const normalized = [...new Set(supplied.map((value) => String(value ?? '').trim().toLowerCase()))]
    .sort();
  const unsupported = normalized.find((value) => !KIND_SET.has(value));
  if (unsupported) throw new Error(`Unsupported infrastructure kind: ${unsupported}`);
  return normalized;
}

function addresses(values) {
  if (!Array.isArray(values)) throw new TypeError('addresses must be a list');
  if (values.length > MAX_LOOKUP_ADDRESSES) {
    throw new RangeError(`addresses exceed ${MAX_LOOKUP_ADDRESSES}`);
  }
  return [...new Set(values.map(address))].sort();
}

function normalizeLookup(input = {}) {
  if (input.chain != null && String(input.chain).trim().toLowerCase() !== CHAIN) {
    throw new Error(`Unsupported infrastructure chain: ${input.chain}`);
  }
  return Object.freeze({
    chain: CHAIN,
    addresses: Object.freeze(addresses(input.addresses)),
    kinds: Object.freeze(kinds(input.kinds)),
    blockNumber: blockNumber(input.blockNumber ?? input.block_number),
  });
}

function normalizeRow(row) {
  return Object.freeze({
    chain: row.chain,
    address: row.address,
    kind: row.kind,
    label: row.label,
    source: row.source,
    evidence: Object.freeze(row.evidence_json),
    validFromBlock: String(row.valid_from_block),
    validThroughBlock: row.valid_through_block == null
      ? null : String(row.valid_through_block),
    verifiedAt: new Date(row.verified_at).toISOString(),
  });
}

function normalizeRows(rows) {
  const normalized = rows.map(normalizeRow);
  const seen = new Set();
  for (const entry of normalized) {
    const key = `${entry.address}:${entry.kind}`;
    if (seen.has(key)) {
      throw new Error(`Ambiguous infrastructure registry entries for ${key}`);
    }
    seen.add(key);
  }
  return Object.freeze(normalized);
}

function createRobinhoodInfrastructureRegistryRepository(options = {}) {
  const database = options.database || db;

  async function listActiveAtBlock(input = {}) {
    const lookup = normalizeLookup(input);
    if (!lookup.addresses.length) return Object.freeze([]);
    const { rows } = await database.query(
      `SELECT chain, address, kind, label, source, evidence_json,
              valid_from_block::text, valid_through_block::text, verified_at
         FROM robinhood_infrastructure_registry
        WHERE chain = $1
          AND address = ANY($2::varchar[])
          AND kind = ANY($3::varchar[])
          AND valid_from_block <= $4::bigint
          AND (valid_through_block IS NULL OR valid_through_block >= $4::bigint)
        ORDER BY address, kind, valid_from_block DESC`,
      [lookup.chain, lookup.addresses, lookup.kinds, lookup.blockNumber]
    );
    return normalizeRows(rows);
  }

  return Object.freeze({ listActiveAtBlock });
}

module.exports = {
  INFRASTRUCTURE_KINDS,
  MAX_LOOKUP_ADDRESSES,
  createRobinhoodInfrastructureRegistryRepository,
  __private: { normalizeLookup, normalizeRow, normalizeRows },
};

const db = require('../models/db');
const { INFRASTRUCTURE_KINDS } = require('../models/robinhood-infrastructure-registry');

const MAX_IMPORT_ENTRIES = 250;
const MAX_BLOCK_NUMBER = 9_223_372_036_854_775_807n;
const KIND_SET = new Set(INFRASTRUCTURE_KINDS);

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  throw new Error('evidence must be JSON-compatible');
}

function block(value, label, optional = false) {
  if (optional && value == null) return null;
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = BigInt(normalized);
  if (parsed > MAX_BLOCK_NUMBER) throw new Error(`${label} exceeds PostgreSQL BIGINT`);
  return parsed.toString();
}

function normalizeIdentity(input) {
  const chain = String(input.chain ?? 'robinhood').trim().toLowerCase();
  const address = String(input.address ?? '').trim().toLowerCase();
  const kind = String(input.kind ?? '').trim().toLowerCase();
  const label = String(input.label ?? '').trim();
  const source = String(input.source ?? '').trim().toLowerCase();
  if (chain !== 'robinhood') throw new Error(`Unsupported infrastructure chain: ${chain}`);
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('address must be a 20-byte address');
  if (address === `0x${'0'.repeat(40)}` && kind !== 'burn') {
    throw new Error('zero address is allowed only for burn entries');
  }
  if (!KIND_SET.has(kind)) throw new Error(`Unsupported infrastructure kind: ${kind}`);
  if (!label || label.length > 120) throw new Error('label must contain at most 120 characters');
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(source)) throw new Error('source is invalid');
  return { chain, address, kind, label, source };
}

function normalizeEvidence(input) {
  const evidence = canonicalJson(input.evidence);
  if (!evidence || Array.isArray(evidence) || !Object.keys(evidence).length) {
    throw new Error('evidence must be a non-empty object');
  }
  return evidence;
}

function normalizeValidity(input) {
  const validFromBlock = block(input.validFromBlock ?? input.valid_from_block, 'validFromBlock');
  const validThroughBlock = block(
    input.validThroughBlock ?? input.valid_through_block, 'validThroughBlock', true
  );
  if (validThroughBlock != null && BigInt(validThroughBlock) < BigInt(validFromBlock)) {
    throw new Error('validThroughBlock must be greater than or equal to validFromBlock');
  }
  return { validFromBlock, validThroughBlock };
}

function normalizeClosure(input, validity, options = {}) {
  const supplied = input.closure ?? (input.closed_source == null ? null : {
    source: input.closed_source,
    evidence: input.closed_evidence_json,
    verifiedAt: input.closed_verified_at,
  });
  if (validity.validThroughBlock == null && supplied != null) {
    throw new Error('open entries must not contain closure evidence');
  }
  if (validity.validThroughBlock != null && supplied == null) {
    if (options.allowLegacyClosed === true) return null;
    throw new Error('closed entries require closure evidence');
  }
  if (supplied == null) return null;
  const source = String(supplied.source ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(source)) throw new Error('closure source is invalid');
  const evidence = normalizeEvidence(supplied);
  const verifiedAt = new Date(String(supplied.verifiedAt ?? '')).toISOString();
  return Object.freeze({ source, evidence, verifiedAt });
}

function normalizeEntry(input = {}, options = {}) {
  const identity = normalizeIdentity(input);
  const evidence = normalizeEvidence(input);
  const validity = normalizeValidity(input);
  const closure = normalizeClosure(input, validity, options);
  const verifiedAt = new Date(String(input.verifiedAt ?? input.verified_at ?? '')).toISOString();
  return Object.freeze({
    ...identity, evidence, ...validity, verifiedAt, closure,
  });
}

function signature(entry) {
  return JSON.stringify(entry);
}

function overlaps(left, right) {
  const leftEnd = left.validThroughBlock == null ? null : BigInt(left.validThroughBlock);
  const rightEnd = right.validThroughBlock == null ? null : BigInt(right.validThroughBlock);
  return (leftEnd == null || leftEnd >= BigInt(right.validFromBlock))
    && (rightEnd == null || rightEnd >= BigInt(left.validFromBlock));
}

function assertNoManifestOverlap(entries) {
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (entries[left].address === entries[right].address
          && entries[left].kind === entries[right].kind
          && overlaps(entries[left], entries[right])) {
        throw new Error(`Manifest intervals overlap for ${entries[left].address}:${entries[left].kind}`);
      }
    }
  }
}

function normalizeManifest(input) {
  const supplied = Array.isArray(input) ? input : input?.entries;
  if (!Array.isArray(supplied) || !supplied.length) throw new Error('manifest entries are required');
  if (supplied.length > MAX_IMPORT_ENTRIES) {
    throw new RangeError(`manifest entries exceed ${MAX_IMPORT_ENTRIES}`);
  }
  const unique = new Map();
  for (const item of supplied.map(normalizeEntry)) {
    const key = `${item.address}:${item.kind}:${item.validFromBlock}`;
    const current = unique.get(key);
    if (current && signature(current) !== signature(item)) {
      throw new Error(`Manifest contains conflicting entry ${key}`);
    }
    unique.set(key, item);
  }
  const entries = [...unique.values()].sort((left, right) => {
    const scopeOrder = left.address.localeCompare(right.address)
      || left.kind.localeCompare(right.kind);
    if (scopeOrder) return scopeOrder;
    const leftBlock = BigInt(left.validFromBlock);
    const rightBlock = BigInt(right.validFromBlock);
    if (leftBlock < rightBlock) return -1;
    if (leftBlock > rightBlock) return 1;
    return 0;
  });
  assertNoManifestOverlap(entries);
  return Object.freeze(entries);
}

function rowEntry(row) {
  return normalizeEntry({
    ...row, evidence: row.evidence_json, validFromBlock: row.valid_from_block,
    validThroughBlock: row.valid_through_block, verifiedAt: row.verified_at,
  }, { allowLegacyClosed: true });
}

async function buildPlan(database, entries) {
  const addresses = [...new Set(entries.map(({ address }) => address))];
  const { rows } = await database.query(
    `SELECT chain, address, kind, label, source, evidence_json,
            valid_from_block::text, valid_through_block::text, verified_at,
            closed_source, closed_evidence_json, closed_verified_at
       FROM robinhood_infrastructure_registry
      WHERE chain = 'robinhood' AND address = ANY($1::varchar[])
      ORDER BY address, kind, valid_from_block`,
    [addresses]
  );
  const existing = rows.map(rowEntry);
  const inserts = [];
  let unchanged = 0;
  for (const candidate of entries) {
    const collisions = existing.filter((entry) => entry.address === candidate.address
      && entry.kind === candidate.kind && overlaps(entry, candidate));
    if (!collisions.length) inserts.push(candidate);
    else if (collisions.length === 1 && signature(collisions[0]) === signature(candidate)) {
      unchanged += 1;
    } else {
      throw new Error(`Registry interval conflicts for ${candidate.address}:${candidate.kind}`);
    }
  }
  return Object.freeze({ entries: entries.length, inserts: Object.freeze(inserts), unchanged });
}

async function insertEntries(client, entries) {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO robinhood_infrastructure_registry (
         chain, address, kind, label, source, evidence_json, valid_from_block,
         valid_through_block, verified_at, closed_source, closed_evidence_json,
         closed_verified_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bigint, $8::bigint,
         $9::timestamptz, $10, $11::jsonb, $12::timestamptz)`,
      [entry.chain, entry.address, entry.kind, entry.label, entry.source,
        JSON.stringify(entry.evidence), entry.validFromBlock, entry.validThroughBlock,
        entry.verifiedAt, entry.closure?.source ?? null,
        entry.closure ? JSON.stringify(entry.closure.evidence) : null,
        entry.closure?.verifiedAt ?? null]
    );
  }
}

async function runRegistryImport(input = {}, options = {}) {
  const database = options.database || db;
  const entries = normalizeManifest(input.manifest);
  if (input.apply !== true) {
    const plan = await buildPlan(database, entries);
    return Object.freeze({
      mode: 'dry-run', entries: plan.entries, insert: plan.inserts.length,
      unchanged: plan.unchanged,
    });
  }
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('robinhood-infrastructure-import', 0))"
    );
    const plan = await buildPlan(client, entries);
    await insertEntries(client, plan.inserts);
    await client.query('COMMIT');
    return Object.freeze({
      mode: 'applied', entries: plan.entries, inserted: plan.inserts.length,
      unchanged: plan.unchanged,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  MAX_IMPORT_ENTRIES,
  runRegistryImport,
  __private: { buildPlan, normalizeEntry, normalizeManifest, overlaps },
};

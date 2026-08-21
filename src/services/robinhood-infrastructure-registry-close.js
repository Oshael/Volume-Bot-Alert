const db = require('../models/db');
const { INFRASTRUCTURE_KINDS } = require('../models/robinhood-infrastructure-registry');

const KIND_SET = new Set(INFRASTRUCTURE_KINDS);
const MAX_BLOCK_NUMBER = 9_223_372_036_854_775_807n;

function block(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = BigInt(normalized);
  if (parsed > MAX_BLOCK_NUMBER) throw new Error(`${label} exceeds PostgreSQL BIGINT`);
  return parsed.toString();
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  throw new Error('closure evidence must be JSON-compatible');
}

function evidence(value) {
  const normalized = canonicalJson(value);
  if (!normalized || Array.isArray(normalized) || !Object.keys(normalized).length) {
    throw new Error('closure evidence must be a non-empty object');
  }
  return normalized;
}

function normalizeRequest(input = {}) {
  const address = String(input.address ?? '').trim().toLowerCase();
  const kind = String(input.kind ?? '').trim().toLowerCase();
  const validFromBlock = block(input.validFromBlock, 'validFromBlock');
  const validThroughBlock = block(input.validThroughBlock, 'validThroughBlock');
  const source = String(input.closure?.source ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('address must be a 20-byte address');
  if (!KIND_SET.has(kind)) throw new Error(`Unsupported infrastructure kind: ${kind}`);
  if (address === `0x${'0'.repeat(40)}` && kind !== 'burn') {
    throw new Error('zero address is allowed only for burn entries');
  }
  if (BigInt(validThroughBlock) < BigInt(validFromBlock)) {
    throw new Error('validThroughBlock must be greater than or equal to validFromBlock');
  }
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(source)) throw new Error('closure source is invalid');
  return Object.freeze({
    address, kind, validFromBlock, validThroughBlock,
    closure: Object.freeze({
      source, evidence: evidence(input.closure?.evidence),
      verifiedAt: new Date(String(input.closure?.verifiedAt ?? '')).toISOString(),
    }),
  });
}

function overlaps(leftFrom, leftThrough, rightFrom, rightThrough) {
  const leftEnd = leftThrough == null ? null : BigInt(leftThrough);
  const rightEnd = rightThrough == null ? null : BigInt(rightThrough);
  return (leftEnd == null || leftEnd >= BigInt(rightFrom))
    && (rightEnd == null || rightEnd >= BigInt(leftFrom));
}

function sameClosure(row, request) {
  return String(row.valid_through_block) === request.validThroughBlock
    && row.closed_source === request.closure.source
    && JSON.stringify(canonicalJson(row.closed_evidence_json))
      === JSON.stringify(request.closure.evidence)
    && new Date(row.closed_verified_at).toISOString() === request.closure.verifiedAt;
}

function planRows(rows, request) {
  const target = rows.find((row) => String(row.valid_from_block) === request.validFromBlock);
  if (!target) throw new Error('Infrastructure interval was not found');
  if (target.valid_through_block != null) {
    if (sameClosure(target, request)) return 'unchanged';
    throw new Error('Infrastructure interval is already closed with different evidence');
  }
  const conflict = rows.some((row) => row !== target && overlaps(
    request.validFromBlock, request.validThroughBlock,
    String(row.valid_from_block), row.valid_through_block == null
      ? null : String(row.valid_through_block)
  ));
  if (conflict) throw new Error('Closure would overlap another infrastructure interval');
  return 'close';
}

async function loadPlan(database, request, lock = false) {
  const { rows } = await database.query(
    `SELECT valid_from_block::text, valid_through_block::text,
            closed_source, closed_evidence_json, closed_verified_at
       FROM robinhood_infrastructure_registry
      WHERE chain = 'robinhood' AND address = $1 AND kind = $2
      ORDER BY valid_from_block${lock ? ' FOR UPDATE' : ''}`,
    [request.address, request.kind]
  );
  return planRows(rows, request);
}

async function runRegistryClosure(input = {}, options = {}) {
  const database = options.database || db;
  const request = normalizeRequest(input.request);
  if (input.apply !== true) {
    return Object.freeze({ mode: 'dry-run', action: await loadPlan(database, request) });
  }
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('robinhood-infrastructure-import', 0))"
    );
    const action = await loadPlan(client, request, true);
    if (action === 'close') {
      const result = await client.query(
        `UPDATE robinhood_infrastructure_registry
            SET valid_through_block = $4::bigint, closed_source = $5,
                closed_evidence_json = $6::jsonb, closed_verified_at = $7::timestamptz,
                updated_at = NOW()
          WHERE chain = 'robinhood' AND address = $1 AND kind = $2
            AND valid_from_block = $3::bigint AND valid_through_block IS NULL`,
        [request.address, request.kind, request.validFromBlock, request.validThroughBlock,
          request.closure.source, JSON.stringify(request.closure.evidence),
          request.closure.verifiedAt]
      );
      if (result.rowCount !== 1) throw new Error('Infrastructure closure lost its interval lock');
    }
    await client.query('COMMIT');
    return Object.freeze({ mode: 'applied', action: action === 'close' ? 'closed' : action });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  runRegistryClosure,
  __private: { normalizeRequest, planRows },
};

const db = require('../models/db');

function parseBooleanFlag(value) {
  return value === true || value === 'true' || value === '1';
}

function parseOptionalInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;

    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  const hours = parseOptionalInteger(args.hours, 'hours', { min: 1, max: 24 * 365 });
  const days = parseOptionalInteger(args.days, 'days', { min: 1, max: 365 });
  const limitAddresses = parseOptionalInteger(args.limitAddresses, 'limitAddresses', { min: 1, max: 1000000 });
  const dryRun = parseBooleanFlag(args.dryRun);
  const resetRange = parseBooleanFlag(args.resetRange);

  let lookbackHours = hours;
  if (lookbackHours == null && days != null) {
    lookbackHours = days * 24;
  }

  if (lookbackHours == null && !parseBooleanFlag(args.all)) {
    lookbackHours = 48;
  }

  return {
    lookbackHours,
    limitAddresses,
    dryRun,
    resetRange,
    all: parseBooleanFlag(args.all),
  };
}

function buildWhereClause(options) {
  const params = [];
  const clauses = [];

  if (!options.all && Number.isInteger(options.lookbackHours)) {
    params.push(options.lookbackHours);
    clauses.push(`ts >= NOW() - ($${params.length}::int * INTERVAL '1 hour')`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function buildAddressLimitSql(limitAddresses, startParamIndex) {
  if (!Number.isInteger(limitAddresses)) {
    return { sql: '', params: [] };
  }

  return {
    sql: `LIMIT $${startParamIndex}::int`,
    params: [limitAddresses],
  };
}

async function countCandidateBuckets(options) {
  const { whereSql, params } = buildWhereClause(options);
  const { sql: limitSql, params: limitParams } = buildAddressLimitSql(options.limitAddresses, params.length + 1);

  const query = `
    WITH candidate_addresses AS (
      SELECT DISTINCT token_address
      FROM token_market_snapshots
      ${whereSql}
      ORDER BY token_address ASC
      ${limitSql}
    )
    SELECT COUNT(*)::int AS bucket_count
    FROM (
      SELECT
        snapshots.token_address,
        date_trunc('minute', snapshots.ts) AS bucket_ts
      FROM token_market_snapshots snapshots
      INNER JOIN candidate_addresses ca
        ON ca.token_address = snapshots.token_address
      ${whereSql ? whereSql.replace(/\bts\b/g, 'snapshots.ts') : ''}
      GROUP BY snapshots.token_address, date_trunc('minute', snapshots.ts)
    ) aggregated
  `;

  const result = await db.query(query, [...params, ...limitParams]);
  return Number(result.rows[0]?.bucket_count) || 0;
}

async function resetExistingBuckets(options) {
  const { whereSql, params } = buildWhereClause(options);
  const { sql: limitSql, params: limitParams } = buildAddressLimitSql(options.limitAddresses, params.length + 1);

  const query = `
    WITH candidate_addresses AS (
      SELECT DISTINCT token_address
      FROM token_market_snapshots
      ${whereSql}
      ORDER BY token_address ASC
      ${limitSql}
    ),
    candidate_buckets AS (
      SELECT
        snapshots.token_address,
        date_trunc('minute', snapshots.ts) AS bucket_ts
      FROM token_market_snapshots snapshots
      INNER JOIN candidate_addresses ca
        ON ca.token_address = snapshots.token_address
      ${whereSql ? whereSql.replace(/\bts\b/g, 'snapshots.ts') : ''}
      GROUP BY snapshots.token_address, date_trunc('minute', snapshots.ts)
    )
    DELETE FROM token_market_volume_buckets_1m buckets
    USING candidate_buckets cb
    WHERE buckets.token_address = cb.token_address
      AND buckets.bucket_ts = cb.bucket_ts
  `;

  const result = await db.query(query, [...params, ...limitParams]);
  return result.rowCount || 0;
}

async function backfillBuckets(options) {
  const { whereSql, params } = buildWhereClause(options);
  const { sql: limitSql, params: limitParams } = buildAddressLimitSql(options.limitAddresses, params.length + 1);

  const query = `
    WITH candidate_addresses AS (
      SELECT DISTINCT token_address
      FROM token_market_snapshots
      ${whereSql}
      ORDER BY token_address ASC
      ${limitSql}
    ),
    ordered AS (
      SELECT
        snapshots.id,
        snapshots.token_address,
        snapshots.ts,
        date_trunc('minute', snapshots.ts) AS bucket_ts,
        snapshots.vol_5m,
        snapshots.vol_1h,
        snapshots.vol_6h,
        snapshots.vol_24h,
        ROW_NUMBER() OVER (
          PARTITION BY snapshots.token_address, date_trunc('minute', snapshots.ts)
          ORDER BY snapshots.ts DESC, snapshots.id DESC
        ) AS rn_close
      FROM token_market_snapshots snapshots
      INNER JOIN candidate_addresses ca
        ON ca.token_address = snapshots.token_address
      ${whereSql ? whereSql.replace(/\bts\b/g, 'snapshots.ts') : ''}
    ),
    aggregated AS (
      SELECT
        token_address,
        bucket_ts,
        MAX(CASE WHEN rn_close = 1 THEN vol_5m END) AS close_vol_5m,
        MAX(CASE WHEN rn_close = 1 THEN vol_1h END) AS close_vol_1h,
        MAX(CASE WHEN rn_close = 1 THEN vol_6h END) AS close_vol_6h,
        MAX(CASE WHEN rn_close = 1 THEN vol_24h END) AS close_vol_24h,
        COUNT(*)::int AS sample_count
      FROM ordered
      GROUP BY token_address, bucket_ts
    )
    INSERT INTO token_market_volume_buckets_1m (
      token_address,
      bucket_ts,
      close_vol_5m,
      close_vol_1h,
      close_vol_6h,
      close_vol_24h,
      sample_count,
      source
    )
    SELECT
      token_address,
      bucket_ts,
      close_vol_5m,
      close_vol_1h,
      close_vol_6h,
      close_vol_24h,
      sample_count,
      'snapshot_backfill'
    FROM aggregated
    ON CONFLICT (token_address, bucket_ts) DO UPDATE SET
      close_vol_5m = EXCLUDED.close_vol_5m,
      close_vol_1h = EXCLUDED.close_vol_1h,
      close_vol_6h = EXCLUDED.close_vol_6h,
      close_vol_24h = EXCLUDED.close_vol_24h,
      sample_count = EXCLUDED.sample_count,
      source = EXCLUDED.source
  `;

  await db.query(query, [...params, ...limitParams]);
}

async function run() {
  try {
    const options = parseCliArgs();
    const scopeLabel = options.all
      ? 'all available snapshot history'
      : `last ${options.lookbackHours}h of snapshot history`;

    console.log(`[BackfillVolumeBuckets1m] Scope: ${scopeLabel}`);
    if (options.limitAddresses) {
      console.log(`[BackfillVolumeBuckets1m] Address limit: ${options.limitAddresses}`);
    }

    const candidateBucketCount = await countCandidateBuckets(options);
    console.log(`[BackfillVolumeBuckets1m] Candidate 1m buckets: ${candidateBucketCount}`);

    if (options.dryRun) {
      console.log('[BackfillVolumeBuckets1m] Dry run only. No writes executed.');
      return;
    }

    if (options.resetRange) {
      const deleted = await resetExistingBuckets(options);
      console.log(`[BackfillVolumeBuckets1m] Reset existing buckets in scope: ${deleted}`);
    }

    await backfillBuckets(options);
    console.log('[BackfillVolumeBuckets1m] Backfill complete.');
  } catch (err) {
    console.error('[BackfillVolumeBuckets1m] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

if (require.main === module) {
  void run();
}

module.exports = {
  run,
  __private: {
    parseCliArgs,
    buildWhereClause,
    buildAddressLimitSql,
  },
};

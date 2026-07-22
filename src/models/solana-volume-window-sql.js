const VOLUME_WINDOWS = Object.freeze(['5m', '1h', '6h', '24h']);
const RECENT_COMPLETE_TOLERANCE = '15 minutes';

function coverageStateSql(alias, window) {
  return `CASE jsonb_typeof(${alias}.window_coverage -> '${window}')
    WHEN 'object' THEN ${alias}.window_coverage -> '${window}' ->> 'state'
    WHEN 'string' THEN ${alias}.window_coverage ->> '${window}'
    ELSE NULL END`;
}

function coverageSourceSql(alias, window) {
  return `CASE jsonb_typeof(${alias}.window_coverage -> '${window}')
    WHEN 'object' THEN ${alias}.window_coverage -> '${window}' ->> 'source'
    ELSE NULL END`;
}

function recentFieldSql(window, expression, suffix) {
  const column = `close_vol_${window}`;
  const order = `CASE WHEN (${coverageStateSql('bucket', window)}) = 'complete'
        THEN 0 ELSE 1 END, bucket.bucket_ts DESC`;
  return `(array_agg(${expression} ORDER BY ${order})
      FILTER (WHERE bucket.${column} IS NOT NULL))[1] AS ${suffix}_${window}`;
}

function recentProjectionSql(window) {
  const column = `close_vol_${window}`;
  return [
    recentFieldSql(window, `bucket.${column}`, 'close_vol'),
    recentFieldSql(window, 'bucket.bucket_ts', 'bucket_ts'),
    recentFieldSql(window, coverageStateSql('bucket', window), 'coverage_state'),
    recentFieldSql(window, coverageSourceSql('bucket', window), 'coverage_source'),
  ].join(',\n      ');
}

function fallbackJoinSql(window, chainSql, tokenAddressSql, asOfSql) {
  const column = `close_vol_${window}`;
  return `LEFT JOIN LATERAL (
    SELECT bucket.bucket_ts, bucket.${column} AS volume_usd,
      ${coverageStateSql('bucket', window)} AS coverage_state,
      ${coverageSourceSql('bucket', window)} AS coverage_source
    FROM token_market_volume_buckets_1m bucket
    WHERE bucket.chain = ${chainSql}
      AND bucket.token_address = ${tokenAddressSql}
      AND bucket.bucket_ts < ${asOfSql} - INTERVAL '${RECENT_COMPLETE_TOLERANCE}'
      AND bucket.${column} IS NOT NULL
      AND recent.close_vol_${window} IS NULL
    ORDER BY bucket.bucket_ts DESC
    LIMIT 1
  ) fallback_${window} ON TRUE`;
}

function finalProjectionSql(window) {
  return [
    `COALESCE(recent.close_vol_${window}, fallback_${window}.volume_usd) AS close_vol_${window}`,
    `COALESCE(recent.bucket_ts_${window}, fallback_${window}.bucket_ts) AS bucket_ts_${window}`,
    `COALESCE(recent.coverage_state_${window}, fallback_${window}.coverage_state) AS coverage_state_${window}`,
    `COALESCE(recent.coverage_source_${window}, fallback_${window}.coverage_source) AS coverage_source_${window}`,
  ].join(',\n    ');
}

function buildCanonicalVolumeJoinSql(options = {}) {
  const chainSql = options.chainSql || "'solana'";
  const tokenAddressSql = options.tokenAddressSql;
  const asOfSql = options.asOfSql;
  const alias = options.alias || 'volume';
  const windows = options.windows || VOLUME_WINDOWS;
  if (!tokenAddressSql || !asOfSql) {
    throw new Error('Canonical Solana volume SQL requires tokenAddressSql and asOfSql');
  }
  if (!Array.isArray(windows) || !windows.length
    || windows.some((window) => !VOLUME_WINDOWS.includes(window))) {
    throw new Error('Canonical Solana volume SQL requires supported windows');
  }

  return `LEFT JOIN LATERAL (
  SELECT
    ${windows.map(finalProjectionSql).join(',\n    ')}
  FROM LATERAL (
    SELECT
      ${windows.map(recentProjectionSql).join(',\n      ')}
    FROM token_market_volume_buckets_1m bucket
    WHERE bucket.chain = ${chainSql}
      AND bucket.token_address = ${tokenAddressSql}
      AND bucket.bucket_ts >= ${asOfSql} - INTERVAL '${RECENT_COMPLETE_TOLERANCE}'
      AND bucket.bucket_ts < ${asOfSql}
  ) recent
  ${windows.map((window) => (
    fallbackJoinSql(window, chainSql, tokenAddressSql, asOfSql)
  )).join('\n  ')}
) ${alias} ON TRUE`;
}

module.exports = {
  RECENT_COMPLETE_TOLERANCE,
  VOLUME_WINDOWS,
  buildCanonicalVolumeJoinSql,
};

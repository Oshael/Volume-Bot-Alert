# PumpFun Fast 5x Analysis Query

This is the reproducible exploratory dataset for the PumpFun Fast 5x alert.

Ponto importante:
- this query is for offline analysis
- do not put this full scan in a hot runtime path
- start with a small lookback if the VPS is under load

```sql
SET statement_timeout = '60s';

DROP TABLE IF EXISTS early_5h_features;

CREATE TEMP TABLE early_5h_features AS
WITH base AS (
  SELECT
    address,
    MAX(symbol) AS symbol,
    MAX(source) AS source,
    MIN(
      CASE
        WHEN source = 'pumpfun-migrated' AND migration_grace_until IS NOT NULL
          THEN migration_grace_until - INTERVAL '10 minutes'
        ELSE first_seen_at
      END
    ) AS start_ts
  FROM token_catalog
  WHERE source = 'pumpfun-migrated'
    AND first_seen_at >= NOW() - INTERVAL '3 days'
  GROUP BY address
),
mcap_window AS (
  SELECT
    b.address,
    b.symbol,
    b.source,
    b.start_ts,
    mb.bucket_ts,
    mb.close_mcap,
    FIRST_VALUE(mb.close_mcap) OVER (
      PARTITION BY b.address
      ORDER BY mb.bucket_ts ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS first_mcap
  FROM base b
  JOIN token_market_buckets_1m mb
    ON mb.token_address = b.address
   AND mb.bucket_ts >= b.start_ts
   AND mb.bucket_ts < b.start_ts + INTERVAL '5 hours'
   AND mb.close_mcap > 0
  WHERE b.start_ts <= NOW() - INTERVAL '5 hours'
),
mcap_features AS (
  SELECT
    address,
    MAX(symbol) AS symbol,
    MIN(start_ts) AS start_ts,
    MAX(first_mcap) AS first_mcap,
    MAX(close_mcap) AS max_mcap,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY close_mcap::double precision) AS p95_mcap,
    MAX(close_mcap) / NULLIF(MAX(first_mcap), 0) AS max_mcap_multiple,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY close_mcap::double precision)
      / NULLIF(MAX(first_mcap)::double precision, 0) AS p95_mcap_multiple,
    MIN(bucket_ts) FILTER (WHERE close_mcap >= first_mcap * 2) AS time_to_2x,
    MIN(bucket_ts) FILTER (WHERE close_mcap >= first_mcap * 3) AS time_to_3x,
    MIN(bucket_ts) FILTER (WHERE close_mcap >= first_mcap * 5) AS time_to_5x,
    COUNT(*) AS mcap_buckets
  FROM mcap_window
  GROUP BY address
),
volume_features AS (
  SELECT
    b.address,
    MAX(vb.close_vol_5m) AS max_vol_5m_seen,
    AVG(vb.close_vol_5m) FILTER (
      WHERE vb.bucket_ts < b.start_ts + INTERVAL '30 minutes'
    ) AS avg_vol_5m_first_30m,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY vb.close_vol_5m::double precision) AS p95_vol_5m,
    MAX(vb.close_vol_1h) AS max_vol_1h_seen,
    MAX(vb.close_vol_6h) AS max_vol_6h_seen,
    COUNT(*) AS vol_buckets
  FROM base b
  JOIN token_market_volume_buckets_1m vb
    ON vb.token_address = b.address
   AND vb.bucket_ts >= b.start_ts
   AND vb.bucket_ts < b.start_ts + INTERVAL '5 hours'
   AND vb.close_vol_5m IS NOT NULL
  WHERE b.start_ts <= NOW() - INTERVAL '5 hours'
  GROUP BY b.address
)
SELECT
  mf.*,
  vf.max_vol_5m_seen,
  vf.avg_vol_5m_first_30m,
  vf.p95_vol_5m,
  vf.max_vol_1h_seen,
  vf.max_vol_6h_seen,
  vf.vol_buckets,
  CASE
    WHEN mf.time_to_5x IS NOT NULL AND mf.time_to_5x <= mf.start_ts + INTERVAL '30 minutes'
      THEN 'fast_5x'
    WHEN mf.time_to_5x IS NOT NULL
      THEN 'slow_5x'
    WHEN mf.p95_mcap_multiple >= 3
      THEN 'near_miss_3x'
    ELSE 'failed'
  END AS outcome
FROM mcap_features mf
LEFT JOIN volume_features vf ON vf.address = mf.address
WHERE mf.mcap_buckets >= 20
  AND mf.first_mcap BETWEEN 15000 AND 80000;

SELECT
  outcome,
  COUNT(*) AS tokens,
  ROUND(AVG(first_mcap)::numeric, 2) AS avg_first_mcap,
  ROUND(AVG(p95_mcap_multiple)::numeric, 2) AS avg_p95_multiple,
  ROUND(AVG(p95_vol_5m)::numeric, 2) AS avg_p95_vol_5m,
  ROUND(AVG(avg_vol_5m_first_30m)::numeric, 2) AS avg_vol_first_30m,
  ROUND(AVG(max_vol_1h_seen)::numeric, 2) AS avg_max_vol_1h
FROM early_5h_features
GROUP BY outcome
ORDER BY tokens DESC;

SELECT *
FROM early_5h_features
WHERE outcome = 'failed'
ORDER BY p95_vol_5m DESC NULLS LAST
LIMIT 50;
```

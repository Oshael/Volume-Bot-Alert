const db = require('./db');

const CHAIN = 'robinhood';
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);

function boundedText(value, label, maxLength, { optional = false } = {}) {
  const normalized = String(value ?? '').trim();
  if (!normalized && optional) return null;
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must contain between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return BigInt(raw).toString();
}

function fixedHex(value, label, bytes) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function hexData(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(normalized)) {
    throw new Error(`${label} must be even-length hex data`);
  }
  return normalized;
}

function timestamp(value, label, fallback) {
  const parsed = new Date(value == null ? fallback : value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}

function normalizeLog(log, range) {
  const protocol = boundedText(log?.protocol, 'log.protocol', 16, { optional: true });
  if (protocol && !PROTOCOLS.has(protocol)) throw new Error('log.protocol is unsupported');
  const blockNumber = quantity(log?.blockNumber, 'log.blockNumber');
  if (BigInt(blockNumber) < BigInt(range.fromBlock) || BigInt(blockNumber) > BigInt(range.toBlock)) {
    throw new Error('log.blockNumber must be inside the captured range');
  }
  if (!Array.isArray(log?.topics) || log.topics.length === 0) {
    throw new Error('log.topics must be a non-empty array');
  }
  return {
    transaction_hash: fixedHex(log.transactionHash, 'log.transactionHash', 32),
    log_index: quantity(log.logIndex, 'log.logIndex'),
    block_number: blockNumber,
    block_hash: fixedHex(log.blockHash, 'log.blockHash', 32),
    transaction_index: quantity(log.transactionIndex, 'log.transactionIndex'),
    address: fixedHex(log.address, 'log.address', 20),
    topics: log.topics.map((topic, index) => fixedHex(topic, `log.topics[${index}]`, 32)),
    data: hexData(log.data, 'log.data'),
    protocol,
    market_key: boundedText(log.marketKey, 'log.marketKey', 160, { optional: true }),
  };
}

function normalizeCapture(input = {}, now = Date.now) {
  const fromBlock = quantity(input.fromBlock, 'fromBlock');
  const toBlock = quantity(input.toBlock, 'toBlock');
  if (BigInt(toBlock) < BigInt(fromBlock)) throw new Error('toBlock must be at least fromBlock');
  const checkpointTimestamp = timestamp(
    input.checkpoint?.timestamp,
    'checkpoint.timestamp'
  );
  const fetchStartedAt = timestamp(input.fetchStartedAt, 'fetchStartedAt', checkpointTimestamp);
  const fetchFinishedAt = timestamp(input.fetchFinishedAt, 'fetchFinishedAt', now());
  if (fetchFinishedAt < fetchStartedAt) {
    throw new Error('fetchFinishedAt must not precede fetchStartedAt');
  }
  const range = { fromBlock, toBlock };
  const logs = (Array.isArray(input.logs) ? input.logs : []).map((log) => normalizeLog(log, range));
  const rawLogCount = Number(input.rawLogCount ?? logs.length);
  if (!Number.isSafeInteger(rawLogCount) || rawLogCount < logs.length) {
    throw new Error('rawLogCount must be a safe integer at least as large as logs.length');
  }
  return {
    ...range,
    provider: boundedText(input.provider, 'provider', 64),
    decoderVersion: boundedText(input.decoderVersion, 'decoderVersion', 64),
    rawLogCount,
    logs,
    checkpointHash: fixedHex(input.checkpoint?.hash, 'checkpoint.hash', 32),
    checkpointTimestamp,
    fetchStartedAt,
    fetchFinishedAt,
  };
}

function normalizeWatermark(row) {
  if (!row) return null;
  return {
    frontier: row.frontier,
    nextBlock: String(row.next_block),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash,
    checkpointTimestamp: row.checkpoint_timestamp?.toISOString?.() || row.checkpoint_timestamp,
    lastRangeId: row.last_range_id == null ? null : String(row.last_range_id),
    version: String(row.version),
  };
}

function boundedInteger(value, label, fallback, min, max) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return resolved;
}

function normalizeClaimReferences(input) {
  if (!Array.isArray(input)) throw new Error('claims must be an array');
  const unique = new Map();
  for (const claim of input) {
    const transactionHash = fixedHex(claim?.transactionHash, 'claim.transactionHash', 32);
    const logIndex = quantity(claim?.logIndex, 'claim.logIndex');
    unique.set(`${transactionHash}:${logIndex}`, {
      transaction_hash: transactionHash,
      log_index: logIndex,
    });
  }
  return [...unique.values()];
}

function normalizeClaimRow(row) {
  return {
    transactionHash: row.transaction_hash,
    logIndex: String(row.log_index),
    rangeId: String(row.range_id),
    blockNumber: String(row.block_number),
    blockHash: row.block_hash,
    transactionIndex: String(row.transaction_index),
    address: row.address,
    topics: row.topics,
    data: row.data,
    protocol: row.protocol,
    marketKey: row.market_key,
    status: row.enrichment_status,
    attemptCount: Number(row.attempt_count),
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until?.toISOString?.() || row.lease_until,
  };
}

function createRobinhoodBackfillCaptureRepository(options = {}) {
  const database = options.database || db;
  const now = options.now || Date.now;

  async function captureMarketRange(input = {}) {
    const capture = normalizeCapture(input, now);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const manifest = await client.query(
        `INSERT INTO robinhood_backfill_ranges (
           chain, stream, from_block, to_block, provider, status, decoder_version,
           attempt_count, fetch_started_at, fetch_finished_at
         )
         VALUES ($1, 'market', $2, $3, $4, 'fetching', $5, 1, $6, $7)
         ON CONFLICT (chain, stream, from_block, to_block) DO UPDATE SET
           provider = EXCLUDED.provider,
           status = 'fetching',
           decoder_version = EXCLUDED.decoder_version,
           attempt_count = robinhood_backfill_ranges.attempt_count + 1,
           next_attempt_at = NOW(),
           last_error = NULL,
           fetch_started_at = EXCLUDED.fetch_started_at,
           fetch_finished_at = EXCLUDED.fetch_finished_at,
           updated_at = NOW()
         WHERE robinhood_backfill_ranges.status IN ('pending', 'fetching', 'failed')
         RETURNING id`,
        [
          CHAIN,
          capture.fromBlock,
          capture.toBlock,
          capture.provider,
          capture.decoderVersion,
          capture.fetchStartedAt,
          capture.fetchFinishedAt,
        ]
      );
      if (!manifest.rowCount) {
        const existing = await client.query(
          `SELECT id, status FROM robinhood_backfill_ranges
           WHERE chain = $1 AND stream = 'market' AND from_block = $2 AND to_block = $3`,
          [CHAIN, capture.fromBlock, capture.toBlock]
        );
        if (existing.rows[0]?.status !== 'captured') {
          throw new Error(`Robinhood backfill range is ${existing.rows[0]?.status || 'unavailable'}`);
        }
        await client.query('COMMIT');
        return {
          rangeId: String(existing.rows[0].id),
          insertedLogs: 0,
          duplicate: true,
          watermarkAdvanced: false,
        };
      }

      const rangeId = manifest.rows[0].id;
      const inserted = capture.logs.length
        ? await client.query(
          `INSERT INTO robinhood_market_log_staging (
             chain, transaction_hash, log_index, range_id, block_number, block_hash,
             transaction_index, address, topics, data, protocol, market_key
           )
           SELECT $1, item.transaction_hash, item.log_index::bigint, $2,
                  item.block_number::bigint, item.block_hash,
                  item.transaction_index::bigint, item.address, item.topics,
                  item.data, item.protocol, item.market_key
           FROM jsonb_to_recordset($3::jsonb) AS item(
             transaction_hash text, log_index text, block_number text, block_hash text,
             transaction_index text, address text, topics jsonb, data text,
             protocol text, market_key text
           )
           ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING
           RETURNING 1`,
          [CHAIN, rangeId, JSON.stringify(capture.logs)]
        )
        : { rowCount: 0 };

      await client.query(
        `INSERT INTO robinhood_backfill_watermarks (chain, frontier, next_block)
         VALUES ($1, 'market_scan', $2)
         ON CONFLICT (chain, frontier) DO NOTHING`,
        [CHAIN, capture.fromBlock]
      );
      const advanced = await client.query(
        `UPDATE robinhood_backfill_watermarks
         SET next_block = $3::bigint + 1,
             checkpoint_block = $3,
             checkpoint_hash = $4,
             checkpoint_timestamp = $5,
             last_range_id = $6,
             version = version + 1,
             updated_at = NOW()
         WHERE chain = $1 AND frontier = 'market_scan' AND next_block = $2
         RETURNING *`,
        [
          CHAIN,
          capture.fromBlock,
          capture.toBlock,
          capture.checkpointHash,
          capture.checkpointTimestamp,
          rangeId,
        ]
      );
      if (!advanced.rowCount) throw new Error('Robinhood market scan range is not contiguous');

      await client.query(
        `UPDATE robinhood_backfill_ranges
         SET status = 'captured',
             raw_log_count = $2,
             tracked_log_count = $3,
             checkpoint_block = to_block,
             checkpoint_hash = $4,
             checkpoint_timestamp = $5,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [
          rangeId,
          capture.rawLogCount,
          capture.logs.length,
          capture.checkpointHash,
          capture.checkpointTimestamp,
        ]
      );
      await client.query('COMMIT');
      return {
        rangeId: String(rangeId),
        insertedLogs: inserted.rowCount,
        duplicate: false,
        watermarkAdvanced: true,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadScanWatermark(frontier) {
    const result = await database.query(
      `SELECT * FROM robinhood_backfill_watermarks
       WHERE chain = $1 AND frontier = $2`,
      [CHAIN, frontier]
    );
    return normalizeWatermark(result.rows[0]);
  }

  async function getBacklogSummary() {
    const result = await database.query(
      `SELECT
         COUNT(*) FILTER (WHERE enrichment_status = 'pending') AS pending,
         COUNT(*) FILTER (
           WHERE enrichment_status = 'pending' AND next_attempt_at <= NOW()
         ) AS ready,
         COUNT(*) FILTER (
           WHERE enrichment_status = 'pending' AND next_attempt_at > NOW()
         ) AS cooling_down,
         COUNT(*) FILTER (WHERE enrichment_status = 'leased') AS leased,
         COUNT(*) FILTER (
           WHERE enrichment_status = 'leased' AND lease_until > NOW()
         ) AS active_leases,
         COUNT(*) FILTER (
           WHERE enrichment_status = 'leased' AND lease_until <= NOW()
         ) AS expired_leases,
         COUNT(*) FILTER (WHERE enrichment_status = 'blocked') AS blocked,
         COUNT(*) FILTER (
           WHERE enrichment_status IN ('completed', 'rejected')
         ) AS terminal,
         MIN(block_number) FILTER (
           WHERE enrichment_status IN ('pending', 'leased', 'blocked')
         ) AS oldest_open_block,
         MIN(block_number) FILTER (
           WHERE (
             enrichment_status = 'pending' AND next_attempt_at <= NOW()
           ) OR (
             enrichment_status = 'leased' AND lease_until <= NOW()
           )
         ) AS oldest_ready_block,
         MAX(attempt_count) AS max_attempt_count
       FROM robinhood_market_log_staging
       WHERE chain = $1`,
      [CHAIN]
    );
    const row = result.rows[0];
    return {
      pending: Number(row.pending),
      ready: Number(row.ready),
      coolingDown: Number(row.cooling_down),
      leased: Number(row.leased),
      activeLeases: Number(row.active_leases),
      expiredLeases: Number(row.expired_leases),
      blocked: Number(row.blocked),
      terminal: Number(row.terminal),
      oldestOpenBlock: row.oldest_open_block == null ? null : String(row.oldest_open_block),
      oldestReadyBlock: row.oldest_ready_block == null ? null : String(row.oldest_ready_block),
      maxAttemptCount: Number(row.max_attempt_count || 0),
    };
  }

  async function claimEnrichmentBatch(input = {}) {
    const owner = boundedText(input.owner, 'owner', 128);
    const limit = boundedInteger(input.limit, 'limit', 100, 1, 1000);
    const leaseMs = boundedInteger(input.leaseMs, 'leaseMs', 60_000, 1000, 86_400_000);
    const result = await database.query(
      `WITH claimable AS MATERIALIZED (
         SELECT chain, transaction_hash, log_index
         FROM robinhood_market_log_staging
         WHERE chain = $1
           AND (
             (enrichment_status = 'pending' AND next_attempt_at <= NOW())
             OR (enrichment_status = 'leased' AND lease_until <= NOW())
           )
         ORDER BY block_number, transaction_index, log_index
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE robinhood_market_log_staging AS staging
       SET enrichment_status = 'leased',
           lease_owner = $3,
           lease_until = NOW() + ($4::int * INTERVAL '1 millisecond'),
           attempt_count = staging.attempt_count + 1,
           updated_at = NOW()
       FROM claimable
       WHERE staging.chain = claimable.chain
         AND staging.transaction_hash = claimable.transaction_hash
         AND staging.log_index = claimable.log_index
       RETURNING staging.*`,
      [CHAIN, limit, owner, leaseMs]
    );
    return result.rows.map(normalizeClaimRow).sort((left, right) => {
      const blockDifference = BigInt(left.blockNumber) - BigInt(right.blockNumber);
      if (blockDifference !== 0n) return blockDifference < 0n ? -1 : 1;
      const transactionDifference = BigInt(left.transactionIndex) - BigInt(right.transactionIndex);
      if (transactionDifference !== 0n) return transactionDifference < 0n ? -1 : 1;
      const indexDifference = BigInt(left.logIndex) - BigInt(right.logIndex);
      return indexDifference < 0n ? -1 : indexDifference > 0n ? 1 : 0;
    });
  }

  async function renewEnrichmentClaims(input = {}) {
    const owner = boundedText(input.owner, 'owner', 128);
    const claims = normalizeClaimReferences(input.claims);
    if (!claims.length) return [];
    const leaseMs = boundedInteger(input.leaseMs, 'leaseMs', 60_000, 1000, 86_400_000);
    const result = await database.query(
      `UPDATE robinhood_market_log_staging AS staging
       SET lease_until = NOW() + ($3::int * INTERVAL '1 millisecond'),
           updated_at = NOW()
       FROM jsonb_to_recordset($2::jsonb) AS claim(transaction_hash text, log_index bigint)
       WHERE staging.chain = $1
         AND staging.transaction_hash = claim.transaction_hash
         AND staging.log_index = claim.log_index
         AND staging.enrichment_status = 'leased'
         AND staging.lease_owner = $4
         AND staging.lease_until > NOW()
       RETURNING staging.*`,
      [CHAIN, JSON.stringify(claims), leaseMs, owner]
    );
    return result.rows.map(normalizeClaimRow);
  }

  async function failEnrichmentClaims(input = {}) {
    const owner = boundedText(input.owner, 'owner', 128);
    const claims = normalizeClaimReferences(input.claims);
    if (!claims.length) return [];
    const retryDelayMs = boundedInteger(
      input.retryDelayMs, 'retryDelayMs', 5000, 0, 604_800_000
    );
    const maxAttempts = boundedInteger(input.maxAttempts, 'maxAttempts', 5, 1, 100);
    const error = boundedText(input.error, 'error', 4000);
    const result = await database.query(
      `UPDATE robinhood_market_log_staging AS staging
       SET enrichment_status = CASE
             WHEN staging.attempt_count >= $5 THEN 'blocked'
             ELSE 'pending'
           END,
           lease_owner = NULL,
           lease_until = NULL,
           next_attempt_at = CASE
             WHEN staging.attempt_count >= $5 THEN NOW()
             ELSE NOW() + ($3::int * INTERVAL '1 millisecond')
           END,
           last_error = $6,
           updated_at = NOW()
       FROM jsonb_to_recordset($2::jsonb) AS claim(transaction_hash text, log_index bigint)
       WHERE staging.chain = $1
         AND staging.transaction_hash = claim.transaction_hash
         AND staging.log_index = claim.log_index
         AND staging.enrichment_status = 'leased'
         AND staging.lease_owner = $4
         AND staging.lease_until > NOW()
       RETURNING staging.*`,
      [CHAIN, JSON.stringify(claims), retryDelayMs, owner, maxAttempts, error]
    );
    return result.rows.map(normalizeClaimRow);
  }

  async function settleEnrichmentClaims(input = {}) {
    const owner = boundedText(input.owner, 'owner', 128);
    const claims = normalizeClaimReferences(input.claims);
    if (!claims.length) return [];
    const outcome = String(input.outcome || '').trim();
    if (!['completed', 'rejected'].includes(outcome)) {
      throw new Error('outcome must be completed or rejected');
    }
    const retentionMs = boundedInteger(
      input.retentionMs, 'retentionMs', 604_800_000, 1, 31_536_000_000
    );
    const result = await database.query(
      `UPDATE robinhood_market_log_staging AS staging
       SET enrichment_status = $3,
           lease_owner = NULL,
           lease_until = NULL,
           terminal_at = NOW(),
           retention_eligible_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
           last_error = NULL,
           updated_at = NOW()
       FROM jsonb_to_recordset($2::jsonb) AS claim(transaction_hash text, log_index bigint)
       WHERE staging.chain = $1
         AND staging.transaction_hash = claim.transaction_hash
         AND staging.log_index = claim.log_index
         AND staging.enrichment_status = 'leased'
         AND staging.lease_owner = $5
         AND staging.lease_until > NOW()
       RETURNING staging.*`,
      [CHAIN, JSON.stringify(claims), outcome, retentionMs, owner]
    );
    return result.rows.map(normalizeClaimRow);
  }

  async function releaseEnrichmentClaims(input = {}) {
    const owner = boundedText(input.owner, 'owner', 128);
    const retryDelayMs = boundedInteger(
      input.retryDelayMs, 'retryDelayMs', 0, 0, 604_800_000
    );
    const result = await database.query(
      `UPDATE robinhood_market_log_staging
       SET enrichment_status = 'pending',
           lease_owner = NULL,
           lease_until = NULL,
           next_attempt_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE chain = $1
         AND enrichment_status = 'leased'
         AND lease_owner = $2
       RETURNING *`,
      [CHAIN, owner, retryDelayMs]
    );
    return result.rows.map(normalizeClaimRow);
  }

  return Object.freeze({
    captureMarketRange,
    claimEnrichmentBatch,
    failEnrichmentClaims,
    getBacklogSummary,
    loadDiscoveryScanWatermark: () => loadScanWatermark('discovery_scan'),
    loadMarketScanWatermark: () => loadScanWatermark('market_scan'),
    releaseEnrichmentClaims,
    renewEnrichmentClaims,
    settleEnrichmentClaims,
  });
}

module.exports = {
  createRobinhoodBackfillCaptureRepository,
  __private: { normalizeCapture },
};

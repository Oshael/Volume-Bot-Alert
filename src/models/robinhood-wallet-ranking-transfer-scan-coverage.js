const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  createRobinhoodWalletRankingTransferAvailabilityRepository,
} = require('./robinhood-wallet-ranking-transfer-availability');

const CHAIN = 'robinhood';
const DEFAULT_VERSION = 'rh_transfer_v1';
const MAX_TOKENS = 20;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BLOCK = 9223372036854775806n;
const TIMEOUT_MS = 5000;

const SCOPES_SQL = `WITH requested AS (
    SELECT unnest($1::text[]) AS token_address
  ), scanned AS (
    SELECT requested.token_address, scope.scan_scope_id, scope.stream,
      scope.from_block, scope.through_block, scope.checkpoint_hash
    FROM requested
    JOIN robinhood_wallet_transfer_scan_scopes scope
      ON scope.chain = '${CHAIN}' AND scope.projection_version = $2
     AND scope.from_block <= $4::bigint AND scope.through_block >= $3::bigint
     AND scope.token_scope_hash IS NULL
     AND scope.scope_id IS NULL
     AND scope.token_addresses @> ARRAY[requested.token_address]
    UNION ALL
    SELECT requested.token_address, scope.scan_scope_id, scope.stream,
      scope.from_block, scope.through_block, scope.checkpoint_hash
    FROM requested
    JOIN robinhood_wallet_transfer_token_scopes tokens
      ON tokens.chain = '${CHAIN}'
     AND tokens.token_addresses @> ARRAY[requested.token_address]
    JOIN robinhood_wallet_transfer_scan_scopes scope
      ON scope.chain = tokens.chain AND scope.token_scope_hash = tokens.scope_hash
     AND scope.projection_version = $2
     AND scope.from_block <= $4::bigint AND scope.through_block >= $3::bigint
     AND scope.scope_id IS NULL
    UNION ALL
    SELECT requested.token_address, scope.scan_scope_id, scope.stream,
      scope.from_block, scope.through_block, scope.checkpoint_hash
    FROM requested
    JOIN robinhood_wallet_transfer_scan_scopes scope
      ON scope.chain = '${CHAIN}' AND scope.projection_version = $2
     AND scope.from_block <= $4::bigint AND scope.through_block >= $3::bigint
     AND scope.token_addresses IS NULL AND scope.token_scope_hash IS NULL
    JOIN robinhood_wallet_transfer_scope_heads head
      ON head.scope_id = scope.scope_id AND head.chain = scope.chain
     AND head.projection_version = scope.projection_version AND head.stream = scope.stream
     AND head.state = 'ready' AND scope.from_block >= head.baseline_next_block
     AND scope.scope_version <= head.current_version
    JOIN robinhood_wallet_transfer_scope_versions version
      ON version.scope_id = scope.scope_id AND version.scope_version = scope.scope_version
    WHERE EXISTS (
      SELECT 1 FROM robinhood_wallet_transfer_scope_members member
      WHERE member.scope_id = scope.scope_id AND member.token_address = requested.token_address
        AND member.valid_from_version <= scope.scope_version
        AND (member.valid_to_version IS NULL OR scope.scope_version < member.valid_to_version)
    )
    UNION ALL
    SELECT requested.token_address, scope.global_scan_id AS scan_scope_id, scope.stream,
      scope.from_block, scope.through_block, scope.checkpoint_hash
    FROM requested
    JOIN robinhood_wallet_transfer_global_scans scope
      ON scope.chain = '${CHAIN}' AND scope.projection_version = $2
     AND scope.from_block <= $4::bigint AND scope.through_block >= $3::bigint
     AND scope.reader_version = 'canonical-global-v1'
     AND NOT (scope.excluded_token_addresses @> ARRAY[requested.token_address])
    JOIN robinhood_wallet_transfer_cursors cursor
      ON cursor.chain = scope.chain AND cursor.projection_version = scope.projection_version
     AND cursor.stream = scope.stream AND cursor.version >= scope.cursor_version
     AND cursor.next_block > scope.through_block
  ), matching AS (
    SELECT requested.token_address, scope.scan_scope_id, scope.stream,
      scope.from_block, scope.through_block,
      (block.canonical IS TRUE) AS checkpoint_canonical
    FROM requested
    LEFT JOIN scanned scope ON scope.token_address = requested.token_address
    LEFT JOIN robinhood_chain_blocks block
      ON block.chain = '${CHAIN}' AND block.block_number = scope.through_block
     AND block.block_hash = scope.checkpoint_hash
  )
  SELECT token_address,
    COUNT(scan_scope_id) FILTER (WHERE stream = 'seed')::integer AS seed_scans,
    COUNT(scan_scope_id) FILTER (WHERE stream = 'live')::integer AS live_scans,
    COUNT(scan_scope_id) FILTER (
      WHERE stream = 'live' AND checkpoint_canonical
    )::integer AS canonical_live_scans,
    COALESCE(range_agg(int8range(
      GREATEST(from_block, $3::bigint), LEAST(through_block, $4::bigint) + 1, '[)'
    )) FILTER (WHERE stream = 'live' AND checkpoint_canonical),
      '{}'::int8multirange) @> int8range($3::bigint, $4::bigint + 1, '[)')
      AS block_range_covered
  FROM matching GROUP BY token_address ORDER BY token_address`;

function block(value, label) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a block number`);
  const parsed = BigInt(text);
  if (parsed > MAX_BLOCK) throw new Error(`${label} exceeds supported block range`);
  return parsed;
}

function normalizeInput(input) {
  if (!Array.isArray(input.tokenAddresses) || input.tokenAddresses.length > MAX_TOKENS) {
    throw new Error(`tokenAddresses must contain at most ${MAX_TOKENS} entries`);
  }
  const tokenAddresses = [...new Set(input.tokenAddresses.map((token) => (
    normalizeTokenAddress(CHAIN, token)
  )))].sort();
  const fromBlock = block(input.fromBlock, 'fromBlock');
  const throughBlock = block(input.throughBlock, 'throughBlock');
  if (throughBlock < fromBlock) throw new Error('block range is inverted');
  const windowStart = new Date(input.windowStart);
  const asOf = new Date(input.asOf);
  if (!Number.isFinite(windowStart.getTime()) || !Number.isFinite(asOf.getTime())
    || asOf <= windowStart || asOf - windowStart > MAX_WINDOW_MS) {
    throw new Error('windowStart/asOf must define a window of at most 30 days');
  }
  const classificationVersion = String(input.classificationVersion ?? DEFAULT_VERSION)
    .trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(classificationVersion)) {
    throw new Error('classificationVersion is invalid');
  }
  return { tokenAddresses, fromBlock: fromBlock.toString(),
    throughBlock: throughBlock.toString(), windowStart: windowStart.toISOString(),
    asOf: asOf.toISOString(), classificationVersion };
}

function scopeReason(row) {
  if (row.block_range_covered === true) return [];
  if (row.live_scans === 0) {
    return [row.seed_scans ? 'transfer_scan_seed_raw_unproven' : 'transfer_scan_scope_missing'];
  }
  return [row.canonical_live_scans === 0
    ? 'transfer_scan_checkpoint_unproven' : 'transfer_scan_scope_gap'];
}

function rawReasons(availability) {
  if (availability?.rawTransferAvailable === true) return [];
  const reasons = availability?.partitions?.flatMap((day) => day.reasons || []) || [];
  return reasons.length ? reasons : ['raw_transfer_availability_unverified'];
}

function createRobinhoodWalletRankingTransferScanCoverageRepository(options = {}) {
  const database = options.database || db;
  const availabilityRepository = options.availabilityRepository
    || createRobinhoodWalletRankingTransferAvailabilityRepository({ database });
  return {
    async inspectBlockRange(input = {}) {
      const normalized = normalizeInput(input);
      if (!normalized.tokenAddresses.length) return [];
      const result = await database.queryWithStatementTimeout(SCOPES_SQL, [
        normalized.tokenAddresses, normalized.classificationVersion,
        normalized.fromBlock, normalized.throughBlock,
      ], TIMEOUT_MS);
      const availability = await availabilityRepository.inspectWindow(normalized);
      const byToken = new Map(result.rows.map((row) => [row.token_address, row]));
      const partitionReasons = rawReasons(availability);
      return normalized.tokenAddresses.map((tokenAddress) => {
        const row = byToken.get(tokenAddress) || {
          seed_scans: 0, live_scans: 0, canonical_live_scans: 0,
          block_range_covered: false,
        };
        const reasons = [...new Set([...scopeReason(row), ...partitionReasons])].sort();
        return {
          tokenAddress, fromBlock: normalized.fromBlock,
          throughBlock: normalized.throughBlock,
          blockRangeCovered: row.block_range_covered === true,
          rawTransferAvailable: availability?.rawTransferAvailable === true,
          scanProofReady: reasons.length === 0,
          windowBoundsVerified: false,
          sourceCoverageVerified: false,
          coverageReasons: reasons,
        };
      });
    },
  };
}

module.exports = { createRobinhoodWalletRankingTransferScanCoverageRepository };

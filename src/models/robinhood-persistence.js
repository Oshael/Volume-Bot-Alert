const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const PROTOCOL_BY_DISCOVERY_KIND = Object.freeze({
  'pair-created': 'uniswap-v2',
  'pool-created': 'uniswap-v3',
  initialize: 'uniswap-v4',
});
const STREAMS = new Set(['discovery', 'market']);
const PENDING_ENRICHMENT_REASONS = new Set([
  'eligibility_not_checked',
  'quote_usd_unavailable',
  'quote_metadata_unusable',
  'token_metadata_unusable',
]);
const LIQUIDITY_STATUSES = new Set([
  'spot_estimate_from_double_quote_reserve',
  'missing_v2_reserve_or_quote',
  'requires_tick_liquidity_distribution',
]);
const MINUTE_MS = 60 * 1000;
const MAX_SIGNAL_WINDOW_MS = 14 * 24 * 60 * MINUTE_MS;
const SIGNAL_PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);

function normalizeSignalProtocols(value) {
  const entries = Array.isArray(value) ? value : [];
  const protocols = [...new Set(
    entries.map((protocol) => String(protocol).trim().toLowerCase()).filter(Boolean)
  )];
  if (!protocols.length || protocols.some((protocol) => !SIGNAL_PROTOCOLS.has(protocol))) {
    throw new Error('signal protocols must contain supported Robinhood protocols');
  }
  return protocols;
}

function decimalQuantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw).toString();
}

function hexWord(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be 32 bytes`);
  return normalized;
}

function timestampDate(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error(`${label} is invalid`);
  return new Date(numeric);
}

function normalizeStream(value) {
  const stream = String(value || '').trim().toLowerCase();
  if (!STREAMS.has(stream)) throw new Error('stream must be discovery or market');
  return stream;
}

function normalizeSignalCandidateQuery(options = {}) {
  const protocols = normalizeSignalProtocols(options.protocols);
  const windowMs = Number(options.windowMs);
  if (
    !Number.isSafeInteger(windowMs)
    || windowMs <= 0
    || windowMs % MINUTE_MS !== 0
    || windowMs > MAX_SIGNAL_WINDOW_MS
  ) {
    throw new Error('signal windowMs must be a whole minute between 1 minute and 14 days');
  }
  const rawLimit = options.limit == null ? 500 : Number(options.limit);
  if (!Number.isSafeInteger(rawLimit) || rawLimit <= 0) {
    throw new Error('signal candidate limit must be a positive safe integer');
  }
  const asOf = options.asOf == null ? null : new Date(options.asOf);
  if (asOf && !Number.isFinite(asOf.getTime())) throw new Error('signal asOf must be a valid timestamp');
  const statementTimeoutMs = Number(options.statementTimeoutMs ?? 10_000);
  if (
    !Number.isSafeInteger(statementTimeoutMs)
    || statementTimeoutMs < 1000
    || statementTimeoutMs > 60_000
  ) {
    throw new Error('signal statementTimeoutMs must be between 1000 and 60000');
  }
  return { protocols, windowMs, limit: Math.min(rawLimit, 5000), asOf, statementTimeoutMs };
}

function countValue(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is outside safe integer range`);
  return parsed;
}

function timestampIso(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function normalizeSignalCandidateRow(row, windowMs) {
  return {
    chain: CHAIN,
    protocol: String(row.protocol),
    marketKey: String(row.market_key),
    tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
    quoteAddress: normalizeTokenAddress(CHAIN, row.quote_address),
    discoveredAt: timestampIso(row.discovered_at, 'candidate discovered_at'),
    windowMs,
    windowStart: timestampIso(row.window_start, 'candidate window_start'),
    windowEnd: timestampIso(row.window_end, 'candidate window_end'),
    liquidityUsd: row.last_liquidity_usd == null ? null : String(row.last_liquidity_usd),
    liquidityRaw: row.last_liquidity_raw == null ? null : String(row.last_liquidity_raw),
    liquidityStatus: row.last_liquidity_status == null
      ? 'not_observed'
      : String(row.last_liquidity_status),
    liquidityConfidence: row.last_liquidity_confidence == null
      ? null
      : String(row.last_liquidity_confidence),
    liquidityWarning: row.last_liquidity_warning == null
      ? null
      : String(row.last_liquidity_warning),
    volumeUsd: String(row.volume_usd),
    swaps: countValue(row.swaps, 'candidate swaps'),
    buys: countValue(row.buys, 'candidate buys'),
    sells: countValue(row.sells, 'candidate sells'),
    transactions: countValue(row.transactions, 'candidate transactions'),
    lastPriceUsd: String(row.last_price_usd),
    lastFdvUsd: String(row.last_fdv_usd),
    lastObservedAt: timestampIso(row.last_observed_at, 'candidate last_observed_at'),
    adminBlocked: row.admin_blocked === true,
  };
}

function normalizeCursor(streamValue, cursor = {}) {
  const stream = normalizeStream(streamValue);
  const checkpoint = cursor.checkpoint || null;
  return {
    stream,
    nextBlock: decimalQuantity(cursor.nextBlock, 'cursor.nextBlock'),
    safeHead: cursor.safeHead == null ? null : decimalQuantity(cursor.safeHead, 'cursor.safeHead'),
    checkpointBlock: checkpoint?.number == null
      ? null
      : decimalQuantity(checkpoint.number, 'cursor.checkpoint.number'),
    checkpointHash: checkpoint?.hash == null
      ? null
      : hexWord(checkpoint.hash, 'cursor.checkpoint.hash'),
    checkpointTimestamp: checkpoint?.timestampMs == null
      ? null
      : timestampDate(checkpoint.timestampMs, 'cursor.checkpoint.timestampMs'),
  };
}

function normalizeLogEntry(entry, stream) {
  const log = entry?.log;
  if (!log || !Array.isArray(log.topics) || !log.topics.length) {
    throw new Error('entry.log with topic0 is required');
  }
  const event = entry.event || {};
  const protocol = String(event.protocol || '').trim() || null;
  return {
    stream,
    transactionHash: hexWord(log.transactionHash, 'log.transactionHash'),
    logIndex: decimalQuantity(log.logIndex, 'log.logIndex'),
    blockNumber: decimalQuantity(log.blockNumber, 'log.blockNumber'),
    blockHash: hexWord(log.blockHash, 'log.blockHash'),
    topic0: hexWord(log.topics[0], 'log.topic0'),
    eventKind: String(event.kind || '').trim() || null,
    protocol,
    marketKey: String(event.marketKey || '').trim().toLowerCase() || null,
  };
}

function optionalNumber(value) {
  return value == null ? null : Number(value);
}

function normalizePoolIdentity(event, protocol) {
  if (protocol === 'uniswap-v4') {
    return { poolAddress: null, poolId: hexWord(event.poolId, 'event.poolId') };
  }
  return {
    poolAddress: normalizeTokenAddress(CHAIN, event.poolAddress || event.pairAddress),
    poolId: null,
  };
}

function buildPoolMetadata(event) {
  return JSON.stringify({
    quoteIndex: event.quoteIndex ?? null,
    quoteKind: event.quoteKind ?? null,
    dynamicFee: event.dynamicFee ?? null,
    pairIndex: event.pairIndex ?? null,
  });
}

function normalizePool(event) {
  if (!event?.tracked) return null;
  const protocol = PROTOCOL_BY_DISCOVERY_KIND[event.kind];
  if (!protocol || event.protocol !== protocol) throw new Error('Unsupported discovery event protocol');
  const marketKey = String(event.marketKey || '').trim().toLowerCase();
  if (!marketKey.startsWith(`${CHAIN}:${protocol}:`) || marketKey.length > 160) {
    throw new Error('Invalid Robinhood market key');
  }
  const identity = normalizePoolIdentity(event, protocol);
  const token0 = event.token0 || event.currency0;
  const token1 = event.token1 || event.currency1;
  return {
    protocol,
    marketKey,
    ...identity,
    originAddress: normalizeTokenAddress(
      CHAIN,
      event.factoryAddress || event.poolManagerAddress
    ),
    tokenAddress: normalizeTokenAddress(CHAIN, event.tokenAddress),
    quoteAddress: normalizeTokenAddress(CHAIN, event.quoteAddress),
    currency0: normalizeTokenAddress(CHAIN, token0),
    currency1: normalizeTokenAddress(CHAIN, token1),
    fee: optionalNumber(event.fee),
    tickSpacing: optionalNumber(event.tickSpacing),
    hooksAddress: event.hooksAddress == null
      ? null
      : normalizeTokenAddress(CHAIN, event.hooksAddress),
    discoveryBlock: decimalQuantity(event.blockNumber, 'event.blockNumber'),
    discoveryBlockHash: hexWord(event.blockHash, 'event.blockHash'),
    discoveryTxHash: hexWord(event.transactionHash, 'event.transactionHash'),
    discoveryLogIndex: decimalQuantity(event.logIndex, 'event.logIndex'),
    discoveredAt: timestampDate(event.timestampMs, 'event.timestampMs'),
    metadata: buildPoolMetadata(event),
  };
}

function normalizeNoxaLaunch(event) {
  if (event?.kind !== 'token-launched' || event.accepted !== true) return null;
  if (
    event.protocol !== 'uniswap-v3'
    || event.deduplicatedWith !== 'uniswap-v3'
    || event.isNewMarket !== false
    || event.launchSource !== 'noxa-fun'
    || !Array.isArray(event.validationErrors)
    || event.validationErrors.length !== 0
  ) {
    throw new Error('Accepted NOXA launch is missing validated v3 deduplication');
  }
  const poolAddress = normalizeTokenAddress(CHAIN, event.poolAddress);
  const marketKey = String(event.marketKey || '').trim().toLowerCase();
  if (marketKey !== `${CHAIN}:uniswap-v3:${poolAddress}`) {
    throw new Error('Accepted NOXA launch does not match its v3 market');
  }
  const record = event.factoryRecord;
  if (!record?.exists) throw new Error('Accepted NOXA launch requires its factory record');
  return {
    marketKey,
    poolAddress,
    metadata: JSON.stringify({
      noxa: {
        launchSource: 'noxa-fun',
        factoryAddress: normalizeTokenAddress(CHAIN, event.factoryAddress),
        deployerAddress: normalizeTokenAddress(CHAIN, event.deployerAddress),
        dexFactoryAddress: normalizeTokenAddress(CHAIN, event.dexFactoryAddress),
        pairTokenAddress: normalizeTokenAddress(CHAIN, event.pairTokenAddress),
        positionManagerAddress: normalizeTokenAddress(CHAIN, record.positionManagerAddress),
        dexId: decimalQuantity(event.dexId, 'event.dexId'),
        launchConfigId: decimalQuantity(event.launchConfigId, 'event.launchConfigId'),
        positionId: decimalQuantity(event.positionId, 'event.positionId'),
        restrictionsEndBlockL1: decimalQuantity(
          event.restrictionsEndBlockL1,
          'event.restrictionsEndBlockL1'
        ),
        initialBuyAmountRaw: decimalQuantity(event.initialBuyAmountRaw, 'event.initialBuyAmountRaw'),
        supplyRaw: decimalQuantity(record.supplyRaw, 'factoryRecord.supplyRaw'),
        validatedAtBlock: decimalQuantity(event.blockNumber, 'event.blockNumber'),
      },
    }),
  };
}

function decimalValue(value, label, options = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error(`${label} must be a positive decimal`);
  if (options.allowZero !== true && /^0+(?:\.0+)?$/.test(raw)) throw new Error(`${label} must be greater than zero`);
  return raw;
}

function uint8(value, label) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) throw new Error(`${label} must be uint8`);
  return numeric;
}

function normalizeSwapContext(entry, logRow) {
  const event = entry?.event;
  if (event?.kind !== 'swap' || event.accepted !== true) return null;
  const protocol = String(event.protocol || '');
  if (!Object.values(PROTOCOL_BY_DISCOVERY_KIND).includes(protocol)) {
    throw new Error('Unsupported swap protocol');
  }
  const transactionHash = hexWord(event.transactionHash, 'event.transactionHash');
  const logIndex = decimalQuantity(event.logIndex, 'event.logIndex');
  const blockNumber = decimalQuantity(event.blockNumber, 'event.blockNumber');
  if (transactionHash !== logRow.transactionHash || logIndex !== logRow.logIndex) {
    throw new Error('Swap identity does not match its log');
  }
  if (blockNumber !== logRow.blockNumber) throw new Error('Swap block does not match its log');
  const marketKey = String(event.marketKey || '').trim().toLowerCase();
  if (!marketKey.startsWith(`${CHAIN}:${protocol}:`)) throw new Error('Invalid swap market key');
  if (protocol !== logRow.protocol || marketKey !== logRow.marketKey) {
    throw new Error('Swap market does not match its processed log');
  }
  const side = String(event.side || '');
  if (!['buy', 'sell'].includes(side)) throw new Error('Swap side must be buy or sell');
  return {
    transactionHash,
    logIndex,
    blockNumber,
    protocol,
    marketKey,
    ...normalizeObservationPoolIdentity(event, protocol),
    tokenAddress: normalizeTokenAddress(CHAIN, event.tokenAddress),
    quoteAddress: normalizeTokenAddress(CHAIN, event.quoteAddress),
    side,
    observedAt: timestampDate(event.timestampMs, 'event.timestampMs').toISOString(),
    tokenAmountRaw: decimalValue(event.tokenAmountRaw, 'event.tokenAmountRaw'),
    quoteAmountRaw: decimalValue(event.quoteAmountRaw, 'event.quoteAmountRaw'),
  };
}

function normalizeObservationPoolIdentity(event, protocol) {
  if (protocol === 'uniswap-v4') {
    return { poolAddress: null, poolId: hexWord(event.poolId, 'event.poolId') };
  }
  return {
    poolAddress: normalizeTokenAddress(CHAIN, event.poolAddress),
    poolId: null,
  };
}

function emptyObservationMetrics() {
  return {
    tokenDecimals: null,
    quoteDecimals: null,
    tokenTotalSupplyRaw: null,
    tokenAmount: null,
    quoteAmount: null,
    priceQuote: null,
    quoteUsdPrice: null,
    priceUsd: null,
    volumeUsd: null,
    fdvUsd: null,
    marketCapUsd: null,
    valuationType: null,
    quoteUsdSource: null,
    quoteUsdStatus: null,
    liquidityUsd: null,
    liquidityRaw: null,
    liquidityStatus: null,
    liquidityConfidence: null,
    liquidityWarning: null,
  };
}

function normalizeLiquidityMetrics(observation, protocol) {
  const status = String(observation.liquidityStatus || '');
  const confidence = String(observation.liquidityConfidence || '');
  const warning = observation.liquidityWarning == null
    ? null
    : String(observation.liquidityWarning).slice(0, 64);
  const liquidityUsd = observation.liquidityUsd == null
    ? null
    : decimalValue(observation.liquidityUsd, 'observation.liquidityUsd', { allowZero: true });
  const liquidityRaw = observation.liquidityRaw == null
    ? null
    : decimalValue(observation.liquidityRaw, 'observation.liquidityRaw', { allowZero: true });
  if (!LIQUIDITY_STATUSES.has(status) || !['none', 'medium'].includes(confidence)) {
    throw new Error('Observation liquidity status or confidence is invalid');
  }
  if (protocol === 'uniswap-v2') {
    const available = status === 'spot_estimate_from_double_quote_reserve';
    if (
      liquidityRaw != null
      || available !== (liquidityUsd != null)
      || confidence !== (available ? 'medium' : 'none')
    ) {
      throw new Error('V2 observation liquidity evidence is inconsistent');
    }
  } else if (
    status !== 'requires_tick_liquidity_distribution'
    || liquidityUsd != null
    || liquidityRaw == null
    || confidence !== 'none'
  ) {
    throw new Error('Concentrated-liquidity observation evidence is inconsistent');
  }
  return {
    liquidityUsd,
    liquidityRaw,
    liquidityStatus: status,
    liquidityConfidence: confidence,
    liquidityWarning: warning,
  };
}

function assertObservationMatchesSwap(observation, context) {
  const matches = (
    String(observation.protocol || '') === context.protocol
    && decimalQuantity(observation.blockNumber, 'observation.blockNumber') === context.blockNumber
    && String(observation.marketKey || '').toLowerCase() === context.marketKey
    && normalizeTokenAddress(CHAIN, observation.tokenAddress) === context.tokenAddress
    && normalizeTokenAddress(CHAIN, observation.quoteAddress) === context.quoteAddress
    && decimalQuantity(observation.tokenAmountRaw, 'observation.tokenAmountRaw') === context.tokenAmountRaw
    && decimalQuantity(observation.quoteAmountRaw, 'observation.quoteAmountRaw') === context.quoteAmountRaw
  );
  if (!matches) throw new Error('Observation metrics do not match their decoded swap');
}

function normalizeAcceptedObservation(observation, context) {
  const transactionHash = hexWord(observation.transactionHash, 'observation.transactionHash');
  const logIndex = decimalQuantity(observation.logIndex, 'observation.logIndex');
  if (transactionHash !== context.transactionHash || logIndex !== context.logIndex) {
    throw new Error('Observation identity does not match its decoded swap');
  }
  assertObservationMatchesSwap(observation, context);
  return {
    tokenDecimals: uint8(observation.tokenDecimals, 'observation.tokenDecimals'),
    quoteDecimals: uint8(observation.quoteDecimals, 'observation.quoteDecimals'),
    tokenTotalSupplyRaw: decimalValue(
      observation.tokenTotalSupplyRaw,
      'observation.tokenTotalSupplyRaw',
      { allowZero: true }
    ),
    tokenAmountRaw: decimalValue(observation.tokenAmountRaw, 'observation.tokenAmountRaw'),
    quoteAmountRaw: decimalValue(observation.quoteAmountRaw, 'observation.quoteAmountRaw'),
    tokenAmount: decimalValue(observation.tokenAmount, 'observation.tokenAmount', { allowZero: true }),
    quoteAmount: decimalValue(observation.quoteAmount, 'observation.quoteAmount', { allowZero: true }),
    priceQuote: decimalValue(observation.priceQuote, 'observation.priceQuote'),
    quoteUsdPrice: decimalValue(observation.quoteUsdPrice, 'observation.quoteUsdPrice'),
    priceUsd: decimalValue(observation.priceUsd, 'observation.priceUsd'),
    volumeUsd: decimalValue(observation.volumeUsd, 'observation.volumeUsd', { allowZero: true }),
    fdvUsd: decimalValue(observation.fdvUsd, 'observation.fdvUsd', { allowZero: true }),
    marketCapUsd: observation.marketCapUsd == null
      ? null
      : decimalValue(observation.marketCapUsd, 'observation.marketCapUsd', { allowZero: true }),
    valuationType: String(observation.valuationType || 'fdv'),
    quoteUsdSource: String(observation.quoteUsdSource || '').slice(0, 64),
    quoteUsdStatus: String(observation.quoteUsdStatus || '').slice(0, 16),
    ...normalizeLiquidityMetrics(observation, context.protocol),
  };
}

function normalizeObservation(entry, logRow) {
  const context = normalizeSwapContext(entry, logRow);
  if (!context) return null;
  const observation = entry.observation;
  const accepted = observation?.accepted === true;
  const reason = accepted ? null : String(observation?.reason || 'enrichment_missing').slice(0, 64);
  const status = accepted
    ? 'accepted'
    : (PENDING_ENRICHMENT_REASONS.has(reason) ? 'pending' : 'rejected');
  return {
    ...context,
    status,
    rejectionReason: reason,
    ...(accepted ? normalizeAcceptedObservation(observation, context) : emptyObservationMetrics()),
  };
}

async function insertProcessedLog(client, row) {
  return client.query(
    `INSERT INTO robinhood_processed_logs (
       chain, transaction_hash, log_index, stream, block_number, block_hash,
       topic0, event_kind, protocol, market_key
     ) VALUES ('robinhood', $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING
     RETURNING transaction_hash`,
    [
      row.transactionHash, row.logIndex, row.stream, row.blockNumber, row.blockHash,
      row.topic0, row.eventKind, row.protocol, row.marketKey,
    ]
  );
}

async function upsertPool(client, pool) {
  await client.query(
    `INSERT INTO robinhood_pool_registry (
       chain, protocol, market_key, pool_address, pool_id, origin_address,
       token_address, quote_address, currency0, currency1, fee, tick_spacing,
       hooks_address, discovery_block, discovery_block_hash, discovery_tx_hash,
       discovery_log_index, discovered_at, metadata
     ) VALUES (
       'robinhood', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18::jsonb
     )
     ON CONFLICT (chain, protocol, market_key) DO UPDATE SET
       pool_address = EXCLUDED.pool_address,
       pool_id = EXCLUDED.pool_id,
       origin_address = EXCLUDED.origin_address,
       token_address = EXCLUDED.token_address,
       quote_address = EXCLUDED.quote_address,
       currency0 = EXCLUDED.currency0,
       currency1 = EXCLUDED.currency1,
       fee = EXCLUDED.fee,
       tick_spacing = EXCLUDED.tick_spacing,
       hooks_address = EXCLUDED.hooks_address,
       active = true,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      pool.protocol, pool.marketKey, pool.poolAddress, pool.poolId, pool.originAddress,
      pool.tokenAddress, pool.quoteAddress, pool.currency0, pool.currency1,
      pool.fee, pool.tickSpacing, pool.hooksAddress, pool.discoveryBlock,
      pool.discoveryBlockHash, pool.discoveryTxHash, pool.discoveryLogIndex,
      pool.discoveredAt, pool.metadata,
    ]
  );
}

async function updatePoolNoxaLaunch(client, launch) {
  const result = await client.query(
    `UPDATE robinhood_pool_registry
     SET metadata = metadata || $3::jsonb,
         updated_at = NOW()
     WHERE chain = 'robinhood'
       AND protocol = 'uniswap-v3'
       AND market_key = $1
       AND pool_address = $2
       AND active = true
     RETURNING market_key`,
    [launch.marketKey, launch.poolAddress, launch.metadata]
  );
  if (result.rowCount !== 1) {
    throw new Error('Validated NOXA launch could not attach to its active v3 pool');
  }
}

async function upsertCursor(client, cursor) {
  await client.query(
    `INSERT INTO robinhood_ingestion_cursors (
       chain, stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
       checkpoint_timestamp, coverage_start_block, coverage_start_timestamp
     ) VALUES ('robinhood', $1, $2, $3, $4, $5, $6, $4, $6)
     ON CONFLICT (chain, stream) DO UPDATE SET
       next_block = EXCLUDED.next_block,
       safe_head = EXCLUDED.safe_head,
       checkpoint_block = EXCLUDED.checkpoint_block,
       checkpoint_hash = EXCLUDED.checkpoint_hash,
       checkpoint_timestamp = EXCLUDED.checkpoint_timestamp,
       coverage_start_block = COALESCE(
         robinhood_ingestion_cursors.coverage_start_block,
         EXCLUDED.coverage_start_block
       ),
       coverage_start_timestamp = COALESCE(
         robinhood_ingestion_cursors.coverage_start_timestamp,
         EXCLUDED.coverage_start_timestamp
       ),
       version = robinhood_ingestion_cursors.version + 1,
       updated_at = NOW()
     WHERE robinhood_ingestion_cursors.next_block <= EXCLUDED.next_block`,
    [
      cursor.stream, cursor.nextBlock, cursor.safeHead, cursor.checkpointBlock,
      cursor.checkpointHash, cursor.checkpointTimestamp,
    ]
  );
}

function rowIdentity(row) {
  return `${row.transactionHash}:${row.logIndex}`;
}

async function insertProcessedLogs(client, rows) {
  if (!rows.length) return [];
  const result = await client.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
         "transactionHash" text, "logIndex" text, stream text,
         "blockNumber" text, "blockHash" text, "topic0" text,
         "eventKind" text, protocol text, "marketKey" text
       )
     )
     INSERT INTO robinhood_processed_logs (
       chain, transaction_hash, log_index, stream, block_number, block_hash,
       topic0, event_kind, protocol, market_key
     )
     SELECT
       'robinhood', "transactionHash", "logIndex"::bigint, stream,
       "blockNumber"::bigint, "blockHash", "topic0", "eventKind", protocol, "marketKey"
     FROM input
     ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING
     RETURNING transaction_hash, log_index::text`,
    [JSON.stringify(rows)]
  );
  return result.rows.map((row) => `${row.transaction_hash}:${row.log_index}`);
}

async function insertMarketObservations(client, rows, cursor) {
  if (!rows.length) {
    return { insertedObservations: 0, touchedBuckets: 0, liveBuckets: [] };
  }
  const result = await client.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
         "transactionHash" text, "logIndex" text, "blockNumber" text,
         protocol text, "marketKey" text, "poolAddress" text, "poolId" text,
         "tokenAddress" text, "quoteAddress" text, side text, status text,
         "rejectionReason" text, "observedAt" timestamptz,
         "tokenDecimals" int, "quoteDecimals" int, "tokenTotalSupplyRaw" text,
         "tokenAmountRaw" text, "quoteAmountRaw" text, "tokenAmount" text,
         "quoteAmount" text, "priceQuote" text, "quoteUsdPrice" text,
         "priceUsd" text, "volumeUsd" text, "fdvUsd" text, "marketCapUsd" text,
         "valuationType" text, "quoteUsdSource" text, "quoteUsdStatus" text,
         "liquidityUsd" text, "liquidityRaw" text, "liquidityStatus" text,
         "liquidityConfidence" text, "liquidityWarning" text
       )
     ),
     inserted_observations AS (
       INSERT INTO robinhood_market_observations (
         chain, transaction_hash, log_index, block_number, protocol, market_key,
         pool_address, pool_id, token_address, quote_address, side, status,
         rejection_reason, observed_at,
         token_decimals, quote_decimals, token_total_supply_raw, token_amount_raw,
         quote_amount_raw, token_amount, quote_amount, price_quote, quote_usd_price,
         price_usd, volume_usd, fdv_usd, market_cap_usd, valuation_type,
         quote_usd_source, quote_usd_status, liquidity_usd, liquidity_raw,
         liquidity_status, liquidity_confidence, liquidity_warning
       )
       SELECT
         'robinhood', "transactionHash", "logIndex"::bigint, "blockNumber"::bigint,
         protocol, "marketKey", "poolAddress", "poolId", "tokenAddress", "quoteAddress",
         side, status, "rejectionReason", "observedAt", "tokenDecimals", "quoteDecimals",
         "tokenTotalSupplyRaw"::numeric, "tokenAmountRaw"::numeric,
         "quoteAmountRaw"::numeric, "tokenAmount"::numeric, "quoteAmount"::numeric,
         "priceQuote"::numeric, "quoteUsdPrice"::numeric, "priceUsd"::numeric,
         "volumeUsd"::numeric, "fdvUsd"::numeric, "marketCapUsd"::numeric,
         "valuationType", "quoteUsdSource", "quoteUsdStatus",
         "liquidityUsd"::numeric, "liquidityRaw"::numeric, "liquidityStatus",
         "liquidityConfidence", "liquidityWarning"
       FROM input
       ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING
       RETURNING *
     ),
     aggregated AS (
       SELECT
         chain, protocol, market_key, token_address, quote_address,
         date_trunc('minute', observed_at) AS bucket_ts,
         (array_agg(price_usd ORDER BY block_number, log_index))[1] AS open_price_usd,
         MAX(price_usd) AS high_price_usd,
         MIN(price_usd) AS low_price_usd,
         (array_agg(price_usd ORDER BY block_number DESC, log_index DESC))[1] AS close_price_usd,
         (array_agg(fdv_usd ORDER BY block_number, log_index))[1] AS open_fdv_usd,
         MAX(fdv_usd) AS high_fdv_usd,
         MIN(fdv_usd) AS low_fdv_usd,
         (array_agg(fdv_usd ORDER BY block_number DESC, log_index DESC))[1] AS close_fdv_usd,
         (array_agg(liquidity_usd ORDER BY
           block_number DESC, log_index DESC))[1] AS close_liquidity_usd,
         (array_agg(liquidity_raw ORDER BY
           block_number DESC, log_index DESC))[1] AS close_liquidity_raw,
         (array_agg(liquidity_status ORDER BY
           block_number DESC, log_index DESC))[1] AS close_liquidity_status,
         (array_agg(liquidity_confidence ORDER BY
           block_number DESC, log_index DESC))[1] AS close_liquidity_confidence,
         (array_agg(liquidity_warning ORDER BY
           block_number DESC, log_index DESC))[1] AS close_liquidity_warning,
         SUM(volume_usd) AS volume_usd,
         COUNT(*)::bigint AS swaps,
         COUNT(*) FILTER (WHERE side = 'buy') AS buys,
         COUNT(*) FILTER (WHERE side = 'sell') AS sells,
         COUNT(DISTINCT transaction_hash)::bigint AS transactions,
         (array_agg(observed_at ORDER BY block_number, log_index))[1] AS first_observed_at,
         MIN(block_number) AS first_block_number,
         (array_agg(log_index ORDER BY block_number, log_index))[1] AS first_log_index,
         (array_agg(observed_at ORDER BY block_number DESC, log_index DESC))[1] AS last_observed_at,
         MAX(block_number) AS last_block_number,
         (array_agg(log_index ORDER BY block_number DESC, log_index DESC))[1] AS last_log_index
       FROM inserted_observations
       WHERE status = 'accepted'
       GROUP BY chain, protocol, market_key, token_address, quote_address,
         date_trunc('minute', observed_at)
     ),
     upserted_buckets AS (
       INSERT INTO robinhood_market_buckets_1m (
         chain, protocol, market_key, token_address, quote_address, bucket_ts,
         open_price_usd, high_price_usd, low_price_usd, close_price_usd,
         open_fdv_usd, high_fdv_usd, low_fdv_usd, close_fdv_usd,
         close_liquidity_usd, close_liquidity_raw, close_liquidity_status,
         close_liquidity_confidence, close_liquidity_warning,
         volume_usd, swaps, buys, sells, transactions, first_observed_at, first_block_number,
         first_log_index, last_observed_at, last_block_number, last_log_index, expires_at
       )
       SELECT
         aggregated.*, bucket_ts + INTERVAL '14 days'
       FROM aggregated
       ON CONFLICT (chain, protocol, market_key, bucket_ts) DO UPDATE SET
         open_price_usd = CASE
           WHEN (EXCLUDED.first_block_number, EXCLUDED.first_log_index)
             < (robinhood_market_buckets_1m.first_block_number,
                robinhood_market_buckets_1m.first_log_index)
           THEN EXCLUDED.open_price_usd ELSE robinhood_market_buckets_1m.open_price_usd END,
         high_price_usd = GREATEST(robinhood_market_buckets_1m.high_price_usd, EXCLUDED.high_price_usd),
         low_price_usd = LEAST(robinhood_market_buckets_1m.low_price_usd, EXCLUDED.low_price_usd),
         close_price_usd = CASE
           WHEN (EXCLUDED.last_block_number, EXCLUDED.last_log_index)
             > (robinhood_market_buckets_1m.last_block_number,
                robinhood_market_buckets_1m.last_log_index)
           THEN EXCLUDED.close_price_usd ELSE robinhood_market_buckets_1m.close_price_usd END,
         open_fdv_usd = CASE
           WHEN (EXCLUDED.first_block_number, EXCLUDED.first_log_index)
             < (robinhood_market_buckets_1m.first_block_number,
                robinhood_market_buckets_1m.first_log_index)
           THEN EXCLUDED.open_fdv_usd ELSE robinhood_market_buckets_1m.open_fdv_usd END,
         high_fdv_usd = GREATEST(robinhood_market_buckets_1m.high_fdv_usd, EXCLUDED.high_fdv_usd),
         low_fdv_usd = LEAST(robinhood_market_buckets_1m.low_fdv_usd, EXCLUDED.low_fdv_usd),
         close_fdv_usd = CASE
           WHEN (EXCLUDED.last_block_number, EXCLUDED.last_log_index)
             > (robinhood_market_buckets_1m.last_block_number,
                robinhood_market_buckets_1m.last_log_index)
           THEN EXCLUDED.close_fdv_usd ELSE robinhood_market_buckets_1m.close_fdv_usd END,
         close_liquidity_usd = CASE
           WHEN (EXCLUDED.last_block_number, EXCLUDED.last_log_index)
             > (robinhood_market_buckets_1m.last_block_number,
                robinhood_market_buckets_1m.last_log_index)
           THEN EXCLUDED.close_liquidity_usd
           ELSE robinhood_market_buckets_1m.close_liquidity_usd END,
         close_liquidity_raw = CASE
           WHEN (EXCLUDED.last_block_number, EXCLUDED.last_log_index)
             > (robinhood_market_buckets_1m.last_block_number,
                robinhood_market_buckets_1m.last_log_index)
           THEN EXCLUDED.close_liquidity_raw
           ELSE robinhood_market_buckets_1m.close_liquidity_raw END,
         close_liquidity_status = CASE
           WHEN (EXCLUDED.last_block_number, EXCLUDED.last_log_index)
             > (robinhood_market_buckets_1m.last_block_number,
                robinhood_market_buckets_1m.last_log_index)
           THEN EXCLUDED.close_liquidity_status
           ELSE robinhood_market_buckets_1m.close_liquidity_status END,
         close_liquidity_confidence = CASE
           WHEN (EXCLUDED.last_block_number, EXCLUDED.last_log_index)
             > (robinhood_market_buckets_1m.last_block_number,
                robinhood_market_buckets_1m.last_log_index)
           THEN EXCLUDED.close_liquidity_confidence
           ELSE robinhood_market_buckets_1m.close_liquidity_confidence END,
         close_liquidity_warning = CASE
           WHEN (EXCLUDED.last_block_number, EXCLUDED.last_log_index)
             > (robinhood_market_buckets_1m.last_block_number,
                robinhood_market_buckets_1m.last_log_index)
           THEN EXCLUDED.close_liquidity_warning
           ELSE robinhood_market_buckets_1m.close_liquidity_warning END,
         volume_usd = robinhood_market_buckets_1m.volume_usd + EXCLUDED.volume_usd,
         swaps = robinhood_market_buckets_1m.swaps + EXCLUDED.swaps,
         buys = robinhood_market_buckets_1m.buys + EXCLUDED.buys,
         sells = robinhood_market_buckets_1m.sells + EXCLUDED.sells,
         transactions = robinhood_market_buckets_1m.transactions + EXCLUDED.transactions,
         first_observed_at = LEAST(
           robinhood_market_buckets_1m.first_observed_at, EXCLUDED.first_observed_at
         ),
         first_block_number = LEAST(
           robinhood_market_buckets_1m.first_block_number, EXCLUDED.first_block_number
         ),
         first_log_index = CASE
           WHEN EXCLUDED.first_block_number < robinhood_market_buckets_1m.first_block_number
           THEN EXCLUDED.first_log_index
           WHEN EXCLUDED.first_block_number = robinhood_market_buckets_1m.first_block_number
           THEN LEAST(robinhood_market_buckets_1m.first_log_index, EXCLUDED.first_log_index)
           ELSE robinhood_market_buckets_1m.first_log_index END,
         last_observed_at = GREATEST(
           robinhood_market_buckets_1m.last_observed_at, EXCLUDED.last_observed_at
         ),
         last_block_number = GREATEST(
           robinhood_market_buckets_1m.last_block_number, EXCLUDED.last_block_number
         ),
         last_log_index = CASE
           WHEN EXCLUDED.last_block_number > robinhood_market_buckets_1m.last_block_number
           THEN EXCLUDED.last_log_index
           WHEN EXCLUDED.last_block_number = robinhood_market_buckets_1m.last_block_number
           THEN GREATEST(robinhood_market_buckets_1m.last_log_index, EXCLUDED.last_log_index)
           ELSE robinhood_market_buckets_1m.last_log_index END,
         expires_at = GREATEST(robinhood_market_buckets_1m.expires_at, EXCLUDED.expires_at),
         updated_at = NOW()
       WHERE robinhood_market_buckets_1m.token_address = EXCLUDED.token_address
         AND robinhood_market_buckets_1m.quote_address = EXCLUDED.quote_address
       RETURNING *
     ),
     touched_token_buckets AS (
       SELECT DISTINCT chain, token_address, bucket_ts FROM upserted_buckets
     ),
     market_coverage AS (
       SELECT COALESCE((
         SELECT coverage_start_timestamp
         FROM robinhood_ingestion_cursors
         WHERE chain = 'robinhood' AND stream = 'market'
       ), $2::timestamptz) AS coverage_start_at
     ),
     canonical_volume_5m AS (
       SELECT target.chain, target.token_address,
         $2::timestamptz AS volume_5m_window_end,
         $2::timestamptz - INTERVAL '5 minutes' AS volume_5m_baseline_at,
         CASE
           WHEN $2::timestamptz IS NULL THEN 'unavailable'
           WHEN market_coverage.coverage_start_at <= $2::timestamptz - INTERVAL '10 minutes'
             THEN 'complete'
           ELSE 'partial'
         END AS volume_5m_delta_coverage,
         COALESCE(SUM(observation.volume_usd) FILTER (
           WHERE observation.observed_at > $2::timestamptz - INTERVAL '5 minutes'
         ), 0) AS current_volume_5m_usd,
         COALESCE(SUM(observation.volume_usd) FILTER (
           WHERE observation.observed_at <= $2::timestamptz - INTERVAL '5 minutes'
         ), 0) AS previous_volume_5m_usd
       FROM (
         SELECT DISTINCT chain, token_address FROM touched_token_buckets
       ) target
       CROSS JOIN market_coverage
       LEFT JOIN LATERAL (
         SELECT stored.volume_usd, stored.observed_at
         FROM robinhood_market_observations stored
         WHERE stored.chain = target.chain
           AND stored.token_address = target.token_address
           AND stored.protocol IN ('uniswap-v2', 'uniswap-v3', 'uniswap-v4')
           AND stored.status = 'accepted'
           AND stored.observed_at > $2::timestamptz - INTERVAL '10 minutes'
           AND stored.observed_at <= $2::timestamptz
         UNION ALL
         SELECT inserted.volume_usd, inserted.observed_at
         FROM inserted_observations inserted
         WHERE inserted.chain = target.chain
           AND inserted.token_address = target.token_address
           AND inserted.status = 'accepted'
           AND inserted.observed_at > $2::timestamptz - INTERVAL '10 minutes'
           AND inserted.observed_at <= $2::timestamptz
       ) observation ON TRUE
       GROUP BY target.chain, target.token_address, market_coverage.coverage_start_at
     ),
     all_token_buckets AS (
       SELECT existing.*
       FROM robinhood_market_buckets_1m existing
       INNER JOIN touched_token_buckets target
         ON target.chain = existing.chain
        AND target.token_address = existing.token_address
        AND target.bucket_ts = existing.bucket_ts
       WHERE NOT EXISTS (
         SELECT 1 FROM upserted_buckets updated
         WHERE updated.chain = existing.chain
           AND updated.protocol = existing.protocol
           AND updated.market_key = existing.market_key
           AND updated.bucket_ts = existing.bucket_ts
       )
       UNION ALL
       SELECT updated.* FROM upserted_buckets updated
     ),
     protocol_activity AS (
       SELECT chain, token_address, bucket_ts, protocol,
         SUM(volume_usd) AS volume_usd,
         SUM(swaps)::bigint AS swaps,
         SUM(buys)::bigint AS buys,
         SUM(sells)::bigint AS sells,
         SUM(transactions)::bigint AS transactions
       FROM all_token_buckets
       GROUP BY chain, token_address, bucket_ts, protocol
     ),
     protocol_diagnostics AS (
       SELECT chain, token_address, bucket_ts,
         jsonb_object_agg(protocol, jsonb_build_object(
           'volumeUsd', volume_usd::text,
           'swaps', swaps,
           'buys', buys,
           'sells', sells,
           'transactions', transactions
         )) AS protocols
       FROM protocol_activity
       GROUP BY chain, token_address, bucket_ts
     ),
     live_buckets AS (
       SELECT bucket.chain, bucket.token_address, bucket.bucket_ts,
         (array_agg(bucket.open_price_usd ORDER BY bucket.first_block_number,
           bucket.first_log_index, bucket.protocol, bucket.market_key))[1] AS open_price_usd,
         MAX(bucket.high_price_usd) AS high_price_usd,
         MIN(bucket.low_price_usd) AS low_price_usd,
         (array_agg(bucket.close_price_usd ORDER BY bucket.last_block_number DESC,
           bucket.last_log_index DESC, bucket.protocol, bucket.market_key))[1] AS close_price_usd,
         (array_agg(bucket.open_fdv_usd ORDER BY bucket.first_block_number,
           bucket.first_log_index, bucket.protocol, bucket.market_key))[1] AS open_fdv_usd,
         MAX(bucket.high_fdv_usd) AS high_fdv_usd,
         MIN(bucket.low_fdv_usd) AS low_fdv_usd,
         (array_agg(bucket.close_fdv_usd ORDER BY bucket.last_block_number DESC,
           bucket.last_log_index DESC, bucket.protocol, bucket.market_key))[1] AS close_fdv_usd,
         (array_agg(bucket.protocol ORDER BY bucket.last_block_number DESC,
           bucket.last_log_index DESC, bucket.protocol, bucket.market_key))[1]
           AS valuation_protocol,
         (array_agg(bucket.market_key ORDER BY bucket.last_block_number DESC,
           bucket.last_log_index DESC, bucket.protocol, bucket.market_key))[1]
           AS valuation_market_key,
         SUM(bucket.volume_usd) AS volume_usd,
         SUM(bucket.swaps)::bigint AS swaps,
         SUM(bucket.buys)::bigint AS buys,
         SUM(bucket.sells)::bigint AS sells,
         SUM(bucket.transactions)::bigint AS transactions,
         MAX(bucket.last_observed_at) AS last_observed_at,
         MAX(bucket.last_block_number) AS last_block_number,
         (array_agg(bucket.last_log_index ORDER BY bucket.last_block_number DESC,
           bucket.last_log_index DESC, bucket.protocol, bucket.market_key))[1] AS last_log_index,
         diagnostics.protocols
       FROM all_token_buckets bucket
       INNER JOIN protocol_diagnostics diagnostics
         ON diagnostics.chain = bucket.chain
        AND diagnostics.token_address = bucket.token_address
        AND diagnostics.bucket_ts = bucket.bucket_ts
       GROUP BY bucket.chain, bucket.token_address, bucket.bucket_ts, diagnostics.protocols
     ),
     live_bucket_payloads AS (
       SELECT bucket.*, canonical.current_volume_5m_usd,
         canonical.previous_volume_5m_usd, canonical.volume_5m_baseline_at,
         canonical.volume_5m_window_end, canonical.volume_5m_delta_coverage
       FROM live_buckets bucket
       INNER JOIN canonical_volume_5m canonical
         USING (chain, token_address)
     )
     SELECT
       (SELECT COUNT(*)::int FROM inserted_observations) AS inserted_observations,
       (SELECT COUNT(*)::int FROM aggregated) AS expected_buckets,
       (SELECT COUNT(*)::int FROM upserted_buckets) AS touched_buckets,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'chain', chain,
         'tokenAddress', token_address,
         'bucketTs', bucket_ts,
         'openPriceUsd', open_price_usd::text,
         'highPriceUsd', high_price_usd::text,
         'lowPriceUsd', low_price_usd::text,
         'closePriceUsd', close_price_usd::text,
         'openFdvUsd', open_fdv_usd::text,
         'highFdvUsd', high_fdv_usd::text,
         'lowFdvUsd', low_fdv_usd::text,
         'closeFdvUsd', close_fdv_usd::text,
         'valuationProtocol', valuation_protocol,
         'valuationMarketKey', valuation_market_key,
         'volumeUsd', volume_usd::text,
         'currentVolume5mUsd', current_volume_5m_usd::text,
         'prevVolume5mCanonical', previous_volume_5m_usd::text,
         'volume5mBaselineAt', volume_5m_baseline_at,
         'volume5mWindowEnd', volume_5m_window_end,
         'volume5mDeltaCoverage', volume_5m_delta_coverage,
         'swaps', swaps,
         'buys', buys,
         'sells', sells,
         'transactions', transactions,
         'lastObservedAt', last_observed_at,
         'lastBlockNumber', last_block_number::text,
         'lastLogIndex', last_log_index::text,
         'protocols', protocols
       ) ORDER BY token_address, bucket_ts) FROM live_bucket_payloads), '[]'::jsonb) AS live_buckets`,
    [JSON.stringify(rows), cursor.checkpointTimestamp]
  );
  const counts = result.rows[0] || {};
  const expectedBuckets = Number(counts.expected_buckets || 0);
  const touchedBuckets = Number(counts.touched_buckets || 0);
  if (expectedBuckets !== touchedBuckets) {
    throw new Error('Robinhood market bucket identity conflicts with token/quote dimensions');
  }
  return {
    insertedObservations: Number(counts.inserted_observations || 0),
    touchedBuckets,
    liveBuckets: Array.isArray(counts.live_buckets) ? counts.live_buckets : [],
  };
}

function finiteMetric(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRobinhoodMarketBucketUpdate(row, cursor) {
  const bucketTs = timestampIso(row.bucketTs, 'live bucket timestamp');
  const lastObservedAt = timestampIso(row.lastObservedAt, 'live bucket observation timestamp');
  const lastBlockNumber = decimalQuantity(row.lastBlockNumber, 'live bucket block number');
  const lastLogIndex = decimalQuantity(row.lastLogIndex, 'live bucket log index');
  const completeThrough = cursor.checkpointTimestamp?.getTime() || 0;
  return {
    type: 'market:bucket',
    chain: CHAIN,
    address: normalizeTokenAddress(CHAIN, row.tokenAddress),
    bucketTs,
    sequence: [CHAIN, cursor.nextBlock, lastBlockNumber, lastLogIndex]
      .map((part, index) => index === 0 ? part : String(part).padStart(24, '0'))
      .join(':'),
    ordering: { cursorNextBlock: cursor.nextBlock, lastBlockNumber, lastLogIndex },
    granularityMinutes: 1,
    generatedAt: new Date().toISOString(),
    activity: {
      volumeUsd: String(row.volumeUsd),
      currentVolume5mUsd: row.currentVolume5mUsd == null
        ? null : String(row.currentVolume5mUsd),
      prevVolume5mCanonical: row.prevVolume5mCanonical == null
        ? null : String(row.prevVolume5mCanonical),
      volume5mBaselineAt: row.volume5mBaselineAt || null,
      volume5mWindowEnd: row.volume5mWindowEnd || null,
      volume5mDeltaCoverage: row.volume5mDeltaCoverage || 'unavailable',
      swaps: countValue(row.swaps, 'live bucket swaps'),
      buys: countValue(row.buys, 'live bucket buys'),
      sells: countValue(row.sells, 'live bucket sells'),
      transactions: countValue(row.transactions, 'live bucket transactions'),
      protocols: row.protocols && typeof row.protocols === 'object' ? row.protocols : {},
    },
    valuation: {
      type: 'fdv',
      fdvUsd: finiteMetric(row.closeFdvUsd),
      priceUsd: finiteMetric(row.closePriceUsd),
      observedAt: lastObservedAt,
    },
    candle: {
      bucketTs,
      granularityMinutes: 1,
      openFdvUsd: finiteMetric(row.openFdvUsd),
      highFdvUsd: finiteMetric(row.highFdvUsd),
      lowFdvUsd: finiteMetric(row.lowFdvUsd),
      closeFdvUsd: finiteMetric(row.closeFdvUsd),
      openPrice: finiteMetric(row.openPriceUsd),
      highPrice: finiteMetric(row.highPriceUsd),
      lowPrice: finiteMetric(row.lowPriceUsd),
      closePrice: finiteMetric(row.closePriceUsd),
      sampleCount: countValue(row.swaps, 'live bucket samples'),
    },
    coverage: {
      state: completeThrough >= new Date(bucketTs).getTime() + MINUTE_MS ? 'complete' : 'partial',
      source: 'robinhood-accepted-swaps',
    },
  };
}

function emitRobinhoodMarketBucketUpdates(rows, cursor, emit) {
  for (const row of rows) {
    try {
      emit(buildRobinhoodMarketBucketUpdate(row, cursor));
    } catch (error) {
      console.warn('[RobinhoodPersistence] Failed to emit live bucket update:', error.message);
    }
  }
}

async function emitRobinhoodStandardAlertSignals(rows, cursor, source, consume) {
  if (!source || !consume || !rows.length) return;
  try {
    const commitCompletedAt = new Date();
    const signals = await source.buildFromCommittedBuckets({ buckets: rows, cursor });
    if (signals.length) await consume(signals, { commitCompletedAt });
  } catch (error) {
    console.warn('[RobinhoodPersistence] Failed to build standard alert signals:', error.message);
  }
}

async function refreshHourlyBuckets(client, rows) {
  const targets = rows
    .filter((row) => row.status === 'accepted')
    .map((row) => ({
      protocol: row.protocol,
      marketKey: row.marketKey,
      observedAt: row.observedAt,
    }));
  if (!targets.length) return 0;

  const result = await client.query(
    `WITH targets AS (
       SELECT DISTINCT
         'robinhood'::text AS chain,
         protocol,
         "marketKey" AS market_key,
         date_trunc('hour', "observedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_ts
       FROM jsonb_to_recordset($1::jsonb) AS row(
         protocol text, "marketKey" text, "observedAt" timestamptz
       )
     ),
     aggregated AS (
       SELECT
         minute.chain, minute.protocol, minute.market_key,
         minute.token_address, minute.quote_address, targets.bucket_ts,
         (array_agg(minute.open_price_usd ORDER BY
           minute.first_block_number, minute.first_log_index))[1] AS open_price_usd,
         MAX(minute.high_price_usd) AS high_price_usd,
         MIN(minute.low_price_usd) AS low_price_usd,
         (array_agg(minute.close_price_usd ORDER BY
           minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_price_usd,
         (array_agg(minute.open_fdv_usd ORDER BY
           minute.first_block_number, minute.first_log_index))[1] AS open_fdv_usd,
         MAX(minute.high_fdv_usd) AS high_fdv_usd,
         MIN(minute.low_fdv_usd) AS low_fdv_usd,
         (array_agg(minute.close_fdv_usd ORDER BY
           minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_fdv_usd,
         (array_agg(minute.close_liquidity_usd ORDER BY
           minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_liquidity_usd,
         (array_agg(minute.close_liquidity_raw ORDER BY
           minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_liquidity_raw,
         (array_agg(minute.close_liquidity_status ORDER BY
           minute.last_block_number DESC, minute.last_log_index DESC))[1] AS close_liquidity_status,
         (array_agg(minute.close_liquidity_confidence ORDER BY
           minute.last_block_number DESC, minute.last_log_index DESC))[1]
           AS close_liquidity_confidence,
         (array_agg(minute.close_liquidity_warning ORDER BY
           minute.last_block_number DESC, minute.last_log_index DESC))[1]
           AS close_liquidity_warning,
         SUM(minute.volume_usd) AS volume_usd,
         SUM(minute.swaps)::bigint AS swaps,
         SUM(minute.buys)::bigint AS buys,
         SUM(minute.sells)::bigint AS sells,
         SUM(minute.transactions)::bigint AS transactions,
         COUNT(*)::smallint AS source_minute_buckets,
         (array_agg(minute.first_observed_at ORDER BY
           minute.first_block_number, minute.first_log_index))[1] AS first_observed_at,
         MIN(minute.first_block_number) AS first_block_number,
         (array_agg(minute.first_log_index ORDER BY
           minute.first_block_number, minute.first_log_index))[1] AS first_log_index,
         (array_agg(minute.last_observed_at ORDER BY
           minute.last_block_number DESC, minute.last_log_index DESC))[1] AS last_observed_at,
         MAX(minute.last_block_number) AS last_block_number,
         (array_agg(minute.last_log_index ORDER BY
           minute.last_block_number DESC, minute.last_log_index DESC))[1] AS last_log_index
       FROM targets
       INNER JOIN robinhood_market_buckets_1m minute
         ON minute.chain = targets.chain
        AND minute.protocol = targets.protocol
        AND minute.market_key = targets.market_key
        AND minute.bucket_ts >= targets.bucket_ts
        AND minute.bucket_ts < targets.bucket_ts + INTERVAL '1 hour'
       GROUP BY minute.chain, minute.protocol, minute.market_key,
         minute.token_address, minute.quote_address, targets.bucket_ts
     ),
     upserted AS (
       INSERT INTO robinhood_market_buckets_1h (
         chain, protocol, market_key, token_address, quote_address, bucket_ts,
         open_price_usd, high_price_usd, low_price_usd, close_price_usd,
         open_fdv_usd, high_fdv_usd, low_fdv_usd, close_fdv_usd,
         close_liquidity_usd, close_liquidity_raw, close_liquidity_status,
         close_liquidity_confidence, close_liquidity_warning,
         volume_usd, swaps, buys, sells, transactions, source_minute_buckets,
         first_observed_at, first_block_number, first_log_index,
         last_observed_at, last_block_number, last_log_index
       )
       SELECT * FROM aggregated
       ON CONFLICT (chain, protocol, market_key, bucket_ts) DO UPDATE SET
         open_price_usd = EXCLUDED.open_price_usd,
         high_price_usd = EXCLUDED.high_price_usd,
         low_price_usd = EXCLUDED.low_price_usd,
         close_price_usd = EXCLUDED.close_price_usd,
         open_fdv_usd = EXCLUDED.open_fdv_usd,
         high_fdv_usd = EXCLUDED.high_fdv_usd,
         low_fdv_usd = EXCLUDED.low_fdv_usd,
         close_fdv_usd = EXCLUDED.close_fdv_usd,
         close_liquidity_usd = EXCLUDED.close_liquidity_usd,
         close_liquidity_raw = EXCLUDED.close_liquidity_raw,
         close_liquidity_status = EXCLUDED.close_liquidity_status,
         close_liquidity_confidence = EXCLUDED.close_liquidity_confidence,
         close_liquidity_warning = EXCLUDED.close_liquidity_warning,
         volume_usd = EXCLUDED.volume_usd,
         swaps = EXCLUDED.swaps,
         buys = EXCLUDED.buys,
         sells = EXCLUDED.sells,
         transactions = EXCLUDED.transactions,
         source_minute_buckets = EXCLUDED.source_minute_buckets,
         first_observed_at = EXCLUDED.first_observed_at,
         first_block_number = EXCLUDED.first_block_number,
         first_log_index = EXCLUDED.first_log_index,
         last_observed_at = EXCLUDED.last_observed_at,
         last_block_number = EXCLUDED.last_block_number,
         last_log_index = EXCLUDED.last_log_index,
         updated_at = NOW()
       WHERE robinhood_market_buckets_1h.token_address = EXCLUDED.token_address
         AND robinhood_market_buckets_1h.quote_address = EXCLUDED.quote_address
       RETURNING 1
     )
     SELECT
       (SELECT COUNT(*)::int FROM targets) AS target_buckets,
       (SELECT COUNT(*)::int FROM aggregated) AS expected_buckets,
       (SELECT COUNT(*)::int FROM upserted) AS touched_buckets`,
    [JSON.stringify(targets)]
  );
  const counts = result.rows[0] || {};
  const targetBuckets = Number(counts.target_buckets || 0);
  const expectedBuckets = Number(counts.expected_buckets || 0);
  const touchedBuckets = Number(counts.touched_buckets || 0);
  if (targetBuckets !== expectedBuckets || expectedBuckets !== touchedBuckets) {
    throw new Error('Robinhood hourly bucket refresh is incomplete or has conflicting dimensions');
  }
  return touchedBuckets;
}

function createRobinhoodPersistenceRepository(options = {}) {
  const database = options.database || db;
  const emitMarketBucketUpdate = options.emitMarketBucketUpdate || ((payload) => {
    const socketHub = require('../services/socket-hub');
    return socketHub.emitMarketBucketUpdate(payload);
  });
  const standardAlertSignalConsumer = typeof options.standardAlertSignalConsumer === 'function'
    ? options.standardAlertSignalConsumer
    : null;
  const standardAlertSignalSource = options.standardAlertSignalSource
    || (standardAlertSignalConsumer
      ? require('../services/robinhood-standard-alert-signal-source')
        .createRobinhoodStandardAlertSignalSource({ database })
      : null);

  async function commitDiscoveryRange(input = {}) {
    const cursor = normalizeCursor('discovery', input.cursor);
    const entries = (Array.isArray(input.entries) ? input.entries : [])
      .map((entry) => ({
        row: normalizeLogEntry(entry, 'discovery'),
        pool: normalizePool(entry.event),
        noxaLaunch: normalizeNoxaLaunch(entry.event),
      }));
    const client = await database.getClient();
    let insertedLogs = 0;
    let upsertedPools = 0;
    let updatedNoxaLaunches = 0;
    try {
      await client.query('BEGIN');
      const insertedEntries = [];
      for (const entry of entries) {
        const inserted = await insertProcessedLog(client, entry.row);
        if (!inserted.rowCount) continue;
        insertedLogs += 1;
        insertedEntries.push(entry);
      }
      for (const entry of insertedEntries) {
        if (!entry.pool) continue;
        await upsertPool(client, entry.pool);
        upsertedPools += 1;
      }
      for (const entry of insertedEntries) {
        if (!entry.noxaLaunch) continue;
        await updatePoolNoxaLaunch(client, entry.noxaLaunch);
        updatedNoxaLaunches += 1;
      }
      await upsertCursor(client, cursor);
      await client.query('COMMIT');
      return {
        insertedLogs,
        duplicateLogs: entries.length - insertedLogs,
        upsertedPools,
        updatedNoxaLaunches,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function commitMarketRange(input = {}) {
    const cursor = normalizeCursor('market', input.cursor);
    const entries = (Array.isArray(input.entries) ? input.entries : []).map((entry) => {
      const row = normalizeLogEntry(entry, 'market');
      return { row, observation: normalizeObservation(entry, row) };
    });
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const insertedIdentities = new Set(await insertProcessedLogs(
        client,
        entries.map((entry) => entry.row)
      ));
      const observations = entries
        .filter((entry) => entry.observation && insertedIdentities.has(rowIdentity(entry.row)))
        .map((entry) => entry.observation);
      const marketWrite = await insertMarketObservations(client, observations, cursor);
      const touchedHourlyBuckets = await refreshHourlyBuckets(client, observations);
      await upsertCursor(client, cursor);
      await client.query('COMMIT');
      emitRobinhoodMarketBucketUpdates(marketWrite.liveBuckets, cursor, emitMarketBucketUpdate);
      await emitRobinhoodStandardAlertSignals(
        marketWrite.liveBuckets, cursor, standardAlertSignalSource, standardAlertSignalConsumer
      );
      const { liveBuckets: _, ...marketCounts } = marketWrite;
      return {
        insertedLogs: insertedIdentities.size,
        duplicateLogs: entries.length - insertedIdentities.size,
        ...marketCounts,
        touchedHourlyBuckets,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function loadCursor(streamValue) {
    const stream = normalizeStream(streamValue);
    const result = await database.query(
      `SELECT * FROM robinhood_ingestion_cursors WHERE chain = 'robinhood' AND stream = $1`,
      [stream]
    );
    return result.rows[0] || null;
  }

  async function listActivePools() {
    const result = await database.query(
      `SELECT protocol, market_key, pool_address, pool_id, origin_address,
              token_address, quote_address, currency0, currency1,
              fee, tick_spacing, metadata
       FROM robinhood_pool_registry
       WHERE chain = 'robinhood' AND active = true
       ORDER BY protocol ASC, market_key ASC`
    );
    return result.rows;
  }

  async function listSignalDryRunCandidates(input = {}) {
    const query = normalizeSignalCandidateQuery(input);
    const execute = typeof database.queryWithStatementTimeout === 'function'
      ? (sql, params) => database.queryWithStatementTimeout(sql, params, query.statementTimeoutMs)
      : (sql, params) => database.query(sql, params);
    const result = await execute(
      `WITH bounds AS (
         SELECT date_trunc('minute', COALESCE($3::timestamptz, NOW())) AS window_end
       ),
       activity AS (
         SELECT
           bucket.chain, bucket.protocol, bucket.market_key,
           bucket.token_address, bucket.quote_address,
           bounds.window_end - ($1::bigint * INTERVAL '1 millisecond') AS window_start,
           bounds.window_end,
           SUM(bucket.volume_usd) AS volume_usd,
           SUM(bucket.swaps)::bigint AS swaps,
           SUM(bucket.buys)::bigint AS buys,
           SUM(bucket.sells)::bigint AS sells,
           SUM(bucket.transactions)::bigint AS transactions,
           (array_agg(bucket.close_price_usd ORDER BY
             bucket.last_block_number DESC, bucket.last_log_index DESC))[1] AS last_price_usd,
           (array_agg(bucket.close_fdv_usd ORDER BY
             bucket.last_block_number DESC, bucket.last_log_index DESC))[1] AS last_fdv_usd,
           (array_agg(bucket.close_liquidity_usd ORDER BY
             bucket.last_block_number DESC, bucket.last_log_index DESC))[1]
             AS last_liquidity_usd,
           (array_agg(bucket.close_liquidity_raw ORDER BY
             bucket.last_block_number DESC, bucket.last_log_index DESC))[1]
             AS last_liquidity_raw,
           (array_agg(bucket.close_liquidity_status ORDER BY
             bucket.last_block_number DESC, bucket.last_log_index DESC))[1]
             AS last_liquidity_status,
           (array_agg(bucket.close_liquidity_confidence ORDER BY
             bucket.last_block_number DESC, bucket.last_log_index DESC))[1]
             AS last_liquidity_confidence,
           (array_agg(bucket.close_liquidity_warning ORDER BY
             bucket.last_block_number DESC, bucket.last_log_index DESC))[1]
             AS last_liquidity_warning,
           MAX(bucket.last_observed_at) AS last_observed_at
         FROM robinhood_market_buckets_1m bucket
         CROSS JOIN bounds
         WHERE bucket.chain = 'robinhood'
           AND bucket.protocol = ANY($4::text[])
           AND bucket.bucket_ts >= bounds.window_end
             - ($1::bigint * INTERVAL '1 millisecond')
           AND bucket.bucket_ts < bounds.window_end
         GROUP BY bucket.chain, bucket.protocol, bucket.market_key,
           bucket.token_address, bucket.quote_address, bounds.window_end
       )
       SELECT
         activity.*, registry.discovered_at,
         EXISTS (
           SELECT 1
           FROM admin_blocked_tokens blocked
           WHERE blocked.chain = 'robinhood'
             AND blocked.address = activity.token_address
         ) AS admin_blocked
       FROM activity
       INNER JOIN robinhood_pool_registry registry
         ON registry.chain = activity.chain
        AND registry.protocol = activity.protocol
        AND registry.market_key = activity.market_key
        AND registry.token_address = activity.token_address
        AND registry.quote_address = activity.quote_address
        AND registry.active = true
       ORDER BY activity.last_observed_at DESC, activity.protocol ASC, activity.market_key ASC
       LIMIT $2::int`,
      [query.windowMs, query.limit, query.asOf, query.protocols]
    );
    return result.rows.map((row) => normalizeSignalCandidateRow(row, query.windowMs));
  }

  return Object.freeze({
    commitDiscoveryRange,
    commitMarketRange,
    listActivePools,
    listSignalDryRunCandidates,
    loadCursor,
  });
}

module.exports = {
  createRobinhoodPersistenceRepository,
  __private: {
    normalizeCursor,
    normalizeLogEntry,
    normalizeNoxaLaunch,
    normalizeObservation,
    normalizePool,
    buildRobinhoodMarketBucketUpdate,
    emitRobinhoodStandardAlertSignals,
    normalizeSignalCandidateQuery,
    normalizeSignalCandidateRow,
  },
};

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodPersistenceRepository,
  __private,
} = require('../src/models/robinhood-persistence');

const ADDRESS = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const QUOTE = '0x3333333333333333333333333333333333333333';
const POOL = '0x4444444444444444444444444444444444444444';
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const TOPIC = `0x${'c'.repeat(64)}`;
const POOL_ID = `0x${'d'.repeat(64)}`;

function discoveryEntry(overrides = {}) {
  return {
    log: {
      blockNumber: '8069000',
      blockHash: HASH_A,
      transactionHash: HASH_B,
      logIndex: '7',
      topics: [TOPIC],
      data: `0x${'f'.repeat(256)}`,
    },
    event: {
      tracked: true,
      kind: 'pair-created',
      chain: 'robinhood',
      protocol: 'uniswap-v2',
      blockNumber: '8069000',
      blockHash: HASH_A,
      transactionHash: HASH_B,
      logIndex: '7',
      timestampMs: '1783900800000',
      factoryAddress: ADDRESS,
      pairAddress: POOL,
      marketKey: `robinhood:uniswap-v2:${POOL}`,
      token0: TOKEN,
      token1: QUOTE,
      tokenAddress: TOKEN,
      quoteAddress: QUOTE,
      quoteIndex: 1,
      pairIndex: '10',
      ...overrides,
    },
  };
}

function noxaEntry(overrides = {}) {
  return {
    log: {
      blockNumber: '8069000',
      blockHash: HASH_A,
      transactionHash: HASH_B,
      logIndex: '8',
      topics: [TOPIC],
      data: `0x${'d'.repeat(256)}`,
    },
    event: {
      kind: 'token-launched',
      accepted: true,
      validationErrors: [],
      chain: 'robinhood',
      protocol: 'uniswap-v3',
      blockNumber: '8069000',
      blockHash: HASH_A,
      transactionHash: HASH_B,
      logIndex: '8',
      timestampMs: '1783900800000',
      factoryAddress: ADDRESS,
      tokenAddress: TOKEN,
      deployerAddress: '0x5555555555555555555555555555555555555555',
      dexFactoryAddress: ADDRESS,
      pairTokenAddress: QUOTE,
      poolAddress: POOL,
      marketKey: `robinhood:uniswap-v3:${POOL}`,
      dexId: '0',
      launchConfigId: '1',
      positionId: '2',
      restrictionsEndBlockL1: '3',
      initialBuyAmountRaw: '4',
      launchSource: 'noxa-fun',
      marketDiscoveryKey: `robinhood:uniswap-v3:${POOL}`,
      isNewMarket: false,
      deduplicatedWith: 'uniswap-v3',
      factoryRecord: {
        exists: true,
        positionManagerAddress: '0x6666666666666666666666666666666666666666',
        supplyRaw: '1000000000000000000000000000',
      },
      ...overrides,
    },
  };
}

function cursor() {
  return {
    nextBlock: '8069001',
    safeHead: '8069010',
    checkpoint: {
      number: '8069000',
      hash: HASH_A,
      timestampMs: 1783900800000,
    },
  };
}

function marketEntry(overrides = {}, eventOverrides = {}) {
  const marketKey = `robinhood:uniswap-v3:${POOL}`;
  return {
    log: {
      blockNumber: '8069000',
      blockHash: HASH_A,
      transactionHash: HASH_B,
      logIndex: '7',
      topics: [TOPIC],
      data: `0x${'e'.repeat(320)}`,
    },
    event: {
      kind: 'swap',
      accepted: true,
      protocol: 'uniswap-v3',
      blockNumber: '8069000',
      transactionHash: HASH_B,
      logIndex: '7',
      timestampMs: 1783900800000,
      marketKey,
      poolAddress: POOL,
      poolId: null,
      tokenAddress: TOKEN,
      quoteAddress: QUOTE,
      side: 'buy',
      tokenAmountRaw: '123456789012345678901234567890',
      quoteAmountRaw: '98765432109876543210',
      ...eventOverrides,
    },
    observation: {
      accepted: true,
      chain: 'robinhood',
      protocol: 'uniswap-v3',
      blockNumber: '8069000',
      transactionHash: HASH_B,
      logIndex: '7',
      timestampMs: 1783900800000,
      marketKey,
      poolAddress: POOL,
      poolId: null,
      tokenAddress: TOKEN,
      quoteAddress: QUOTE,
      side: 'buy',
      tokenDecimals: 18,
      quoteDecimals: 6,
      tokenTotalSupplyRaw: '1000000000000000000000000000',
      tokenSupplyStatus: 'exact_block_call',
      tokenSupplyBlockTag: '8069000',
      tokenAmountRaw: '123456789012345678901234567890',
      quoteAmountRaw: '98765432109876543210',
      tokenAmount: '123456789012.34567890123456789',
      quoteAmount: '98765432109876.54321',
      priceQuote: '0.000000000000000000123456789012',
      quoteUsdPrice: '1',
      priceUsd: '0.000000000000000000123456789012',
      volumeUsd: '98765432109876.54321',
      fdvUsd: '123456.789012',
      marketCapUsd: null,
      valuationType: 'fdv',
      quoteUsdSource: 'usdg-peg-assumption',
      quoteUsdStatus: 'assumed',
      liquidityUsd: null,
      liquidityRaw: '12345678901234567890',
      liquidityStatus: 'requires_tick_liquidity_distribution',
      liquidityConfidence: 'none',
      liquidityWarning: null,
      ...overrides,
    },
  };
}

function liquidityDeltaEntry(overrides = {}) {
  const marketKey = `robinhood:uniswap-v4:${POOL_ID}`;
  return {
    log: {
      blockNumber: '8069000', blockHash: HASH_A, transactionHash: HASH_B,
      logIndex: '7', topics: [TOPIC], data: `0x${'e'.repeat(256)}`,
    },
    event: {
      kind: 'modify-liquidity', chain: 'robinhood', protocol: 'uniswap-v4',
      blockNumber: '8069000', blockHash: HASH_A, transactionHash: HASH_B,
      logIndex: '7', timestampMs: 1783900800000, marketKey, poolId: POOL_ID,
      tokenAddress: TOKEN, quoteAddress: QUOTE, sender: ADDRESS,
      tickLower: -120, tickUpper: 120, liquidityDelta: '-250', salt: HASH_A,
      ...overrides,
    },
  };
}

function liveBucketRow(overrides = {}) {
  return {
    chain: 'robinhood',
    tokenAddress: TOKEN,
    bucketTs: '2026-07-13T00:00:00.000Z',
    openPriceUsd: '0.10',
    highPriceUsd: '0.14',
    lowPriceUsd: '0.09',
    closePriceUsd: '0.12',
    openFdvUsd: '100000',
    highFdvUsd: '140000',
    lowFdvUsd: '90000',
    closeFdvUsd: '120000',
    valuationProtocol: 'uniswap-v3',
    valuationMarketKey: `robinhood:uniswap-v3:${POOL}`,
    volumeUsd: '450.25',
    currentVolume5mUsd: '1450.25',
    prevVolume5mCanonical: '900',
    volume5mBaselineAt: '2026-07-12T23:55:00.000Z',
    volume5mWindowEnd: '2026-07-13T00:00:00.000Z',
    volume5mDeltaCoverage: 'complete',
    swaps: 3,
    buys: 2,
    sells: 1,
    transactions: 3,
    lastObservedAt: '2026-07-13T00:00:20.000Z',
    lastBlockNumber: '8069000',
    lastLogIndex: '7',
    protocols: {
      'uniswap-v2': { volumeUsd: '150.25', swaps: 1, buys: 1, sells: 0, transactions: 1 },
      'uniswap-v3': { volumeUsd: '300', swaps: 2, buys: 1, sells: 1, transactions: 2 },
    },
    ...overrides,
  };
}

function fakeBackfillEnrichmentResult(sql, params, options) {
  if (/FOR UPDATE OF staging/.test(sql)) {
    const claims = JSON.parse(params[0]);
    return options.leaseLost
      ? { rows: [], rowCount: 0 }
      : { rows: claims.map(() => ({ transaction_hash: HASH_B })), rowCount: claims.length };
  }
  if (/INSERT INTO robinhood_backfill_aggregation_outbox/.test(sql)) {
    const targets = JSON.parse(params[0]);
    if (options.targetDuplicate) return { rows: [], rowCount: 0 };
    return { rows: targets.map(() => ({ transaction_hash: HASH_B })), rowCount: targets.length };
  }
  if (/UPDATE robinhood_market_log_staging staging/.test(sql)) {
    if (options.failBackfillTerminal) throw new Error('terminal write failed');
    const terminal = JSON.parse(params[0]);
    return { rows: terminal.map(() => ({ transaction_hash: HASH_B })), rowCount: terminal.length };
  }
  return null;
}

function fakePoolWriteResult(sql, options) {
  if (/INSERT INTO robinhood_pool_registry/.test(sql) && options.failPool) {
    throw new Error('pool write failed');
  }
  if (/UPDATE robinhood_pool_registry/.test(sql) && /metadata = metadata/.test(sql)) {
    return options.missingNoxaPool ? { rows: [], rowCount: 0 } : { rows: [{}], rowCount: 1 };
  }
  return null;
}

function createFakeDatabase(options = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      const backfillEnrichmentResult = fakeBackfillEnrichmentResult(sql, params, options);
      if (backfillEnrichmentResult) return backfillEnrichmentResult;
      if (/INSERT INTO robinhood_processed_logs/.test(sql)) {
        if (/jsonb_to_recordset/.test(sql)) {
          const rows = JSON.parse(params[0]);
          return options.duplicate
            ? { rows: [], rowCount: 0 }
            : {
              rows: rows.map((row) => ({
                transaction_hash: row.transactionHash,
                log_index: row.logIndex,
              })),
              rowCount: rows.length,
            };
        }
        return options.duplicate
          ? { rows: [], rowCount: 0 }
          : { rows: [{ transaction_hash: HASH_B }], rowCount: 1 };
      }
      if (/SELECT 1 FROM robinhood_v4_liquidity_materialization_state/.test(sql)) {
        return options.v4Materialized ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO robinhood_v4_liquidity_ranges/.test(sql)) {
        return options.failV4Range ? { rows: [], rowCount: 0 } : { rows: [{}], rowCount: 1 };
      }
      const poolResult = fakePoolWriteResult(sql, options);
      if (poolResult) return poolResult;
      if (/INSERT INTO robinhood_market_observations/.test(sql)) {
        if (options.failObservation) throw new Error('observation write failed');
        const rows = JSON.parse(params[0]);
        const insertedObservations = options.duplicate ? 0 : rows.length;
        const expectedBuckets = options.duplicate
          ? 0 : rows.filter((row) => row.status === 'accepted').length;
        return {
          rows: [{
            inserted_observations: insertedObservations,
            expected_buckets: expectedBuckets,
            touched_buckets: options.bucketIdentityConflict ? 0 : expectedBuckets,
            live_buckets: options.duplicate && params[2] !== true ? [] : (options.liveBuckets || []),
          }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO robinhood_market_buckets_1h/.test(sql)) {
        if (options.failHourlyBucket) throw new Error('hourly bucket write failed');
        const rows = JSON.parse(params[0]);
        const expectedBuckets = rows.length;
        return {
          rows: [{
            target_buckets: expectedBuckets,
            expected_buckets: expectedBuckets,
            touched_buckets: options.hourlyBucketConflict ? 0 : expectedBuckets,
          }],
          rowCount: 1,
        };
      }
      const backfillResult = fakeBackfillResult(sql);
      if (backfillResult) return backfillResult;
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; },
  };
  return {
    database: {
      async getClient() { return client; },
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: options.readRows || [], rowCount: options.readRows?.length || 0 };
      },
    },
    calls,
    isReleased: () => released,
  };
}

function fakeBackfillResult(sql) {
  if (/INSERT INTO robinhood_backfill_ranges/.test(sql)) {
    return { rows: [{ id: 91 }], rowCount: 1 };
  }
  return /UPDATE robinhood_backfill_watermarks/.test(sql)
    ? { rows: [{ next_block: '8069001' }], rowCount: 1 }
    : null;
}

describe('Robinhood persistence repository', () => {
  it('commits log identity, pool registry, and cursor in one transaction', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const result = await repository.commitDiscoveryRange({
      entries: [discoveryEntry()],
      cursor: cursor(),
    });

    assert.deepEqual(result, {
      insertedLogs: 1,
      duplicateLogs: 0,
      upsertedPools: 1,
      updatedNoxaLaunches: 0,
    });
    assert.equal(fake.calls[0].sql, 'BEGIN');
    assert.match(fake.calls[1].sql, /INSERT INTO robinhood_processed_logs/);
    assert.match(fake.calls[2].sql, /INSERT INTO robinhood_pool_registry/);
    assert.match(fake.calls[3].sql, /INSERT INTO robinhood_ingestion_cursors/);
    assert.match(fake.calls[3].sql,
      /coverage_start_block, coverage_start_timestamp/);
    assert.match(fake.calls[3].sql,
      /coverage_start_block = COALESCE\(\s*robinhood_ingestion_cursors\.coverage_start_block,\s*EXCLUDED\.coverage_start_block/);
    assert.match(fake.calls[3].sql,
      /coverage_start_timestamp = COALESCE\(\s*robinhood_ingestion_cursors\.coverage_start_timestamp,\s*EXCLUDED\.coverage_start_timestamp/);
    assert.match(fake.calls[3].sql,
      /WHERE robinhood_ingestion_cursors\.next_block <= EXCLUDED\.next_block/);
    assert.equal(fake.calls[4].sql, 'COMMIT');
    assert.equal(fake.isReleased(), true);

    assert.equal(fake.calls[1].params.includes(discoveryEntry().log.data), false);
    assert.deepEqual(fake.calls[2].params.slice(0, 5), [
      'uniswap-v2', `robinhood:uniswap-v2:${POOL}`, POOL, null, ADDRESS,
    ]);
  });

  it('treats a replayed log as duplicate without rewriting its pool', async () => {
    const fake = createFakeDatabase({ duplicate: true });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const result = await repository.commitDiscoveryRange({
      entries: [discoveryEntry()],
      cursor: cursor(),
    });

    assert.deepEqual(result, {
      insertedLogs: 0,
      duplicateLogs: 1,
      upsertedPools: 0,
      updatedNoxaLaunches: 0,
    });
    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_pool_registry/.test(call.sql)), false);
    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_ingestion_cursors/.test(call.sql)), true);
    assert.equal(fake.calls.at(-1).sql, 'COMMIT');
  });

  it('publishes discovery_scan atomically after its catalog range', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });
    const rangeCursor = {
      ...cursor(),
      fromBlock: '8069000',
      toBlock: '8069000',
      logs: [discoveryEntry().log],
    };
    const result = await repository.commitDiscoveryRange({
      entries: [discoveryEntry()],
      cursor: rangeCursor,
      backfillCapture: {
        provider: 'drpc', decoderVersion: 'discovery-log-v1', rawLogCount: 1,
      },
    });

    assert.deepEqual(result.backfill, { rangeId: '91', duplicate: false });
    const sql = fake.calls.map((call) => call.sql);
    assert.ok(sql.findIndex((value) => /pool_registry/.test(value))
      < sql.findIndex((value) => /backfill_ranges/.test(value)));
    assert.ok(sql.findIndex((value) => /backfill_watermarks/.test(value))
      < sql.indexOf('COMMIT'));
  });

  it('rolls back and does not advance the cursor when a pool write fails', async () => {
    const fake = createFakeDatabase({ failPool: true });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await assert.rejects(
      () => repository.commitDiscoveryRange({ entries: [discoveryEntry()], cursor: cursor() }),
      /pool write failed/
    );

    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_ingestion_cursors/.test(call.sql)), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(fake.isReleased(), true);
  });

  it('attaches a validated NOXA launch to its v3 pool in the same transaction', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });
    const v3PoolEntry = discoveryEntry({
      kind: 'pool-created',
      protocol: 'uniswap-v3',
      pairAddress: undefined,
      poolAddress: POOL,
      marketKey: `robinhood:uniswap-v3:${POOL}`,
      fee: 10000,
      tickSpacing: 200,
    });

    const result = await repository.commitDiscoveryRange({
      entries: [noxaEntry(), v3PoolEntry],
      cursor: cursor(),
    });

    assert.deepEqual(result, {
      insertedLogs: 2,
      duplicateLogs: 0,
      upsertedPools: 1,
      updatedNoxaLaunches: 1,
    });
    const poolWriteIndex = fake.calls.findIndex((call) => /INSERT INTO robinhood_pool_registry/.test(call.sql));
    const noxaWriteIndex = fake.calls.findIndex((call) => /UPDATE robinhood_pool_registry/.test(call.sql));
    assert.equal(poolWriteIndex < noxaWriteIndex, true);
    const noxaMetadata = JSON.parse(fake.calls[noxaWriteIndex].params[2]);
    assert.equal(noxaMetadata.noxa.launchSource, 'noxa-fun');
    assert.equal(noxaMetadata.noxa.restrictionsEndBlockL1, '3');
    assert.equal(noxaMetadata.noxa.supplyRaw, '1000000000000000000000000000');
  });

  it('rolls back the cursor when a validated NOXA launch has no active v3 pool', async () => {
    const fake = createFakeDatabase({ missingNoxaPool: true });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await assert.rejects(
      repository.commitDiscoveryRange({ entries: [noxaEntry()], cursor: cursor() }),
      /could not attach to its active v3 pool/
    );

    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_ingestion_cursors/.test(call.sql)), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
  });

  it('preserves v4 pool identity without inventing a pool address', () => {
    const event = discoveryEntry({
      kind: 'initialize',
      protocol: 'uniswap-v4',
      marketKey: `robinhood:uniswap-v4:${POOL_ID}`,
      poolAddress: null,
      poolId: POOL_ID,
      factoryAddress: undefined,
      poolManagerAddress: ADDRESS,
      token0: undefined,
      token1: undefined,
      currency0: TOKEN,
      currency1: QUOTE,
      fee: 3000,
      tickSpacing: 60,
      hooksAddress: '0x0000000000000000000000000000000000000000',
    }).event;

    const pool = __private.normalizePool(event);

    assert.equal(pool.protocol, 'uniswap-v4');
    assert.equal(pool.poolAddress, null);
    assert.equal(pool.poolId, POOL_ID);
    assert.equal(pool.originAddress, ADDRESS);
  });

  it('loads persistent cursors and active pools with explicit Robinhood scope', async () => {
    const fake = createFakeDatabase({ readRows: [{ stream: 'discovery' }] });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    assert.deepEqual(await repository.loadCursor('discovery'), { stream: 'discovery' });
    assert.deepEqual(await repository.listActivePools(), [{ stream: 'discovery' }]);
    assert.ok(fake.calls.every((call) => /chain = 'robinhood'/.test(call.sql)));
    const poolRead = fake.calls.find((call) => /FROM robinhood_pool_registry/.test(call.sql));
    assert.doesNotMatch(poolRead.sql, /SELECT \*/);
    assert.match(poolRead.sql, /protocol, market_key, pool_address/);
  });

  it('reads V4 ranges at the exact swap boundary', async () => {
    const row = { tick_lower: -60, tick_upper: 60, liquidity_gross: '100' };
    const fake = createFakeDatabase({ readRows: [row] });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    assert.deepEqual(await repository.listHistoricalV4LiquidityRanges(POOL_ID, '10', '7'), [row]);
    const call = fake.calls[0];
    assert.deepEqual(call.params, [POOL_ID, '10', '7']);
    assert.match(call.sql, /block_number < \$2/);
    assert.match(call.sql, /block_number = \$2 AND log_index < \$3/);
  });

  it('reads signal candidates per active market from closed minute buckets only', async () => {
    const fake = createFakeDatabase({
      readRows: [{
        protocol: 'uniswap-v2',
        market_key: `robinhood:uniswap-v2:${POOL}`,
        token_address: TOKEN.toUpperCase(),
        quote_address: QUOTE,
        discovered_at: new Date('2026-07-13T08:00:00.000Z'),
        window_start: new Date('2026-07-13T11:00:00.000Z'),
        window_end: new Date('2026-07-13T12:00:00.000Z'),
        volume_usd: '12345.67',
        swaps: '14',
        buys: '8',
        sells: '6',
        transactions: '12',
        last_price_usd: '0.25',
        last_fdv_usd: '250000',
        last_liquidity_usd: '75000',
        last_liquidity_raw: null,
        last_liquidity_status: 'spot_estimate_from_double_quote_reserve',
        last_liquidity_confidence: 'medium',
        last_liquidity_warning: 'spot_price_and_reserves_are_manipulable',
        last_observed_at: new Date('2026-07-13T11:59:30.000Z'),
        admin_blocked: false,
      }],
    });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const rows = await repository.listSignalDryRunCandidates({
      protocols: ['uniswap-v2'],
      windowMs: 60 * 60 * 1000,
      limit: 25,
      asOf: '2026-07-13T12:00:45.000Z',
    });

    assert.equal(rows[0].marketKey, `robinhood:uniswap-v2:${POOL}`);
    assert.equal(rows[0].tokenAddress, TOKEN);
    assert.equal(rows[0].volumeUsd, '12345.67');
    assert.equal(rows[0].transactions, 12);
    assert.equal(rows[0].liquidityUsd, '75000');
    assert.equal(rows[0].liquidityRaw, null);
    assert.equal(rows[0].liquidityStatus, 'spot_estimate_from_double_quote_reserve');
    assert.equal(rows[0].liquidityConfidence, 'medium');
    assert.equal(rows[0].liquidityWarning, 'spot_price_and_reserves_are_manipulable');
    assert.equal(rows[0].adminBlocked, false);
    const call = fake.calls[0];
    assert.deepEqual(call.params, [60 * 60 * 1000, 25, new Date('2026-07-13T12:00:45.000Z'), [
      'uniswap-v2',
    ]]);
    assert.match(call.sql, /date_trunc\('minute', COALESCE\(\$3::timestamptz, NOW\(\)\)\)/);
    assert.match(call.sql, /bucket\.bucket_ts < bounds\.window_end/);
    assert.match(call.sql, /bucket\.protocol = ANY\(\$4::text\[\]\)/);
    assert.match(call.sql, /registry\.market_key = activity\.market_key/);
    assert.match(call.sql, /registry\.active = true/);
    assert.match(call.sql, /bucket\.close_liquidity_usd/);
    assert.match(call.sql, /AS last_liquidity_status/);
    assert.match(call.sql, /blocked\.chain = 'robinhood'/);
    assert.match(call.sql, /blocked\.address = activity\.token_address/);
    assert.doesNotMatch(call.sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('rejects signal windows that exceed bucket precision or retention', () => {
    assert.throws(
      () => __private.normalizeSignalCandidateQuery({ protocols: ['uniswap-v2'], windowMs: 90_000 }),
      /whole minute/
    );
    assert.throws(
      () => __private.normalizeSignalCandidateQuery({
        protocols: ['uniswap-v2'],
        windowMs: 15 * 24 * 60 * 60 * 1000,
      }),
      /between 1 minute and 14 days/
    );
    assert.throws(
      () => __private.normalizeSignalCandidateQuery({
        protocols: ['uniswap-v2'],
        windowMs: 60_000,
        statementTimeoutMs: 999,
      }),
      /statementTimeoutMs must be between 1000 and 60000/
    );
    assert.throws(
      () => __private.normalizeSignalCandidateQuery({ protocols: [], windowMs: 60_000 }),
      /signal protocols must contain supported Robinhood protocols/
    );
  });

  it('bulk commits market dedupe, exact observations, and cursor atomically', async () => {
    const fake = createFakeDatabase({ liveBuckets: [liveBucketRow()] });
    const emitted = [];
    const repository = createRobinhoodPersistenceRepository({
      database: fake.database,
      emitMarketBucketUpdate(payload) {
        emitted.push({ payload, lastDatabaseCall: fake.calls.at(-1).sql });
      },
    });

    const result = await repository.commitMarketRange({
      entries: [marketEntry()],
      cursor: cursor(),
    });

    assert.deepEqual(result, {
      insertedLogs: 1,
      duplicateLogs: 0,
      insertedObservations: 1,
      touchedBuckets: 1,
      insertedLiquidityDeltas: 0,
      touchedHourlyBuckets: 1,
    });
    assert.equal(fake.calls[0].sql, 'BEGIN');
    assert.match(fake.calls[1].sql, /jsonb_to_recordset/);
    assert.match(fake.calls[2].sql, /INSERT INTO robinhood_market_observations/);
    assert.match(fake.calls[2].sql, /liquidity_usd, liquidity_raw/);
    assert.match(fake.calls[2].sql, /"liquidityUsd"::numeric, "liquidityRaw"::numeric/);
    assert.match(fake.calls[2].sql, /INSERT INTO robinhood_market_buckets_1m/);
    assert.match(fake.calls[2].sql, /COUNT\(DISTINCT transaction_hash\)/);
    assert.match(fake.calls[2].sql, /bucket_ts \+ INTERVAL '14 days'/);
    assert.match(fake.calls[2].sql, /AS close_liquidity_usd/);
    assert.match(fake.calls[2].sql, /close_liquidity_status = CASE/);
    assert.match(fake.calls[2].sql, /all_token_buckets AS/);
    assert.match(fake.calls[2].sql, /jsonb_object_agg\(protocol/);
    assert.match(fake.calls[2].sql, /canonical_volume_5m AS/);
    assert.match(fake.calls[2].sql, /AS valuation_protocol/);
    assert.match(fake.calls[2].sql, /'valuationMarketKey', valuation_market_key/);
    assert.match(fake.calls[2].sql, /FROM inserted_observations inserted/);
    assert.match(fake.calls[2].sql, /observed_at > \$2::timestamptz - INTERVAL '10 minutes'/);
    assert.match(fake.calls[2].sql, /SUM\(bucket\.swaps\)/);
    assert.match(fake.calls[2].sql,
      /ORDER BY block_number DESC, log_index DESC/);
    assert.match(fake.calls[3].sql, /INSERT INTO robinhood_market_buckets_1h/);
    assert.match(fake.calls[3].sql, /FROM targets[\s\S]*robinhood_market_buckets_1m/);
    assert.match(fake.calls[3].sql, /SUM\(minute\.transactions\)/);
    assert.match(fake.calls[3].sql, /minute\.close_liquidity_usd/);
    assert.match(fake.calls[3].sql, /close_liquidity_status = EXCLUDED\.close_liquidity_status/);
    assert.match(fake.calls[4].sql, /INSERT INTO robinhood_ingestion_cursors/);
    assert.equal(fake.calls[5].sql, 'COMMIT');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].lastDatabaseCall, 'COMMIT');
    assert.equal(emitted[0].payload.chain, 'robinhood');
    assert.equal(emitted[0].payload.address, TOKEN);
    assert.equal(emitted[0].payload.activity.volumeUsd, '450.25');
    assert.equal(emitted[0].payload.activity.currentVolume5mUsd, '1450.25');
    assert.equal(emitted[0].payload.activity.prevVolume5mCanonical, '900');
    assert.equal(emitted[0].payload.activity.volume5mDeltaCoverage, 'complete');
    assert.equal(emitted[0].payload.activity.swaps, 3);
    assert.deepEqual(Object.keys(emitted[0].payload.activity.protocols), [
      'uniswap-v2', 'uniswap-v3',
    ]);
    assert.equal(emitted[0].payload.valuation.type, 'fdv');
    assert.equal(emitted[0].payload.candle.closeFdvUsd, 120000);
    assert.equal('closeMcap' in emitted[0].payload.candle, false);
    assert.equal(emitted[0].payload.coverage.state, 'partial');
    assert.match(emitted[0].payload.sequence, /^robinhood:\d{24}:\d{24}:\d{24}$/);

    const logPayload = JSON.parse(fake.calls[1].params[0]);
    const observationPayload = JSON.parse(fake.calls[2].params[0]);
    assert.equal(fake.calls[2].params[1].toISOString(), '2026-07-13T00:00:00.000Z');
    assert.equal('data' in logPayload[0], false);
    assert.equal(observationPayload[0].status, 'accepted');
    assert.equal(observationPayload[0].tokenAmountRaw, '123456789012345678901234567890');
    assert.equal(observationPayload[0].tokenSupplyStatus, 'exact_block_call');
    assert.equal(observationPayload[0].tokenSupplyAnchorBlockNumber, '8069000');
    assert.equal(observationPayload[0].priceUsd, '0.000000000000000000123456789012');
    assert.equal(observationPayload[0].liquidityRaw, '12345678901234567890');
    assert.equal(observationPayload[0].liquidityStatus, 'requires_tick_liquidity_distribution');
  });

  it('commits historical enrichment and its aggregation target without live effects', async () => {
    const fake = createFakeDatabase({ liveBuckets: [liveBucketRow()] });
    const emitted = [];
    const repository = createRobinhoodPersistenceRepository({
      database: fake.database,
      emitMarketBucketUpdate: (payload) => emitted.push(payload),
      standardAlertSignalSource: {
        buildFromCommittedBuckets: async () => [{ id: 'must-not-run' }],
      },
      standardAlertSignalConsumer: async (signals) => emitted.push(...signals),
    });

    const result = await repository.commitBackfillEnrichmentBatch({
      owner: 'backfill-worker-a',
      claims: [{ transactionHash: HASH_B, logIndex: '7' }],
      entries: [marketEntry()],
    });

    assert.deepEqual(result, {
      insertedLogs: 1,
      duplicateLogs: 0,
      insertedObservations: 1,
      insertedLiquidityDeltas: 0,
      touchedBuckets: 1,
      aggregationTargets: 1,
      terminalClaims: 1,
    });
    assert.deepEqual(emitted, []);
    assert.equal(fake.calls[0].sql, 'BEGIN');
    assert.match(fake.calls[1].sql, /FOR UPDATE OF staging/);
    assert.match(fake.calls[4].sql, /INSERT INTO robinhood_backfill_aggregation_outbox/);
    assert.match(fake.calls[5].sql, /UPDATE robinhood_market_log_staging staging/);
    assert.equal(fake.calls[6].sql, 'COMMIT');
    assert.equal(fake.calls.some((call) => (
      /INSERT INTO robinhood_ingestion_cursors/.test(call.sql)
    )), false);
    assert.equal(fake.calls.some((call) => /robinhood_market_buckets_1h/.test(call.sql)), false);
    assert.equal(JSON.parse(fake.calls[5].params[0])[0].status, 'completed');
  });

  it('persists a business rejection without publishing an aggregation target', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const result = await repository.commitBackfillEnrichmentBatch({
      owner: 'backfill-worker-a',
      claims: [{ transactionHash: HASH_B, logIndex: '7' }],
      entries: [marketEntry({ accepted: false, reason: 'token_ineligible' })],
    });

    assert.equal(result.insertedObservations, 1);
    assert.equal(result.touchedBuckets, 0);
    assert.equal(result.aggregationTargets, 0);
    const terminal = fake.calls.find((call) => (
      /UPDATE robinhood_market_log_staging staging/.test(call.sql)
    ));
    assert.equal(JSON.parse(terminal.params[0])[0].status, 'rejected');
  });

  it('persists a V4 liquidity delta atomically and ignores its replay', async () => {
    const first = createFakeDatabase();
    const inserted = await createRobinhoodPersistenceRepository({ database: first.database })
      .commitMarketRange({ entries: [liquidityDeltaEntry()], cursor: cursor() });
    const write = first.calls.find((call) => /INSERT INTO robinhood_v4_liquidity_deltas/.test(call.sql));

    assert.equal(inserted.insertedLiquidityDeltas, 1);
    assert.equal(inserted.insertedObservations, 0);
    assert.equal(JSON.parse(write.params[0])[0].liquidityDelta, '-250');
    assert.equal(first.calls.at(-1).sql, 'COMMIT');

    const replay = createFakeDatabase({ duplicate: true });
    const duplicate = await createRobinhoodPersistenceRepository({ database: replay.database })
      .commitMarketRange({ entries: [liquidityDeltaEntry()], cursor: cursor() });
    assert.equal(duplicate.insertedLiquidityDeltas, 0);
    assert.equal(replay.calls.some((call) => /v4_liquidity_deltas/.test(call.sql)), false);
  });

  it('updates materialized V4 ranges without inserting a negative constrained row', async () => {
    const fake = createFakeDatabase({ v4Materialized: true });
    const result = await createRobinhoodPersistenceRepository({ database: fake.database })
      .commitMarketRange({ entries: [liquidityDeltaEntry()], cursor: cursor() });
    const range = fake.calls.find((call) => /INSERT INTO robinhood_v4_liquidity_ranges/.test(call.sql));

    assert.equal(result.insertedLiquidityDeltas, 1);
    assert.match(range.sql, /UPDATE robinhood_v4_liquidity_ranges existing/);
    assert.match(range.sql, /existing\.liquidity_gross \+ grouped\.liquidity_delta >= 0/);
    assert.match(range.sql, /WHERE liquidity_delta > 0/);
    assert.equal(fake.calls.at(-1).sql, 'COMMIT');
  });

  it('rolls back a live V4 delta when its materialized range would conflict', async () => {
    const fake = createFakeDatabase({ v4Materialized: true, failV4Range: true });
    await assert.rejects(
      createRobinhoodPersistenceRepository({ database: fake.database })
        .commitMarketRange({ entries: [liquidityDeltaEntry()], cursor: cursor() }),
      /range update conflicted or became negative/
    );
    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_ingestion_cursors/.test(call.sql)), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
  });

  it('persists a historical V4 delta before settling its backfill claim', async () => {
    const fake = createFakeDatabase();
    const result = await createRobinhoodPersistenceRepository({ database: fake.database })
      .commitBackfillEnrichmentBatch({
        owner: 'backfill-worker-a',
        claims: [{ transactionHash: HASH_B, logIndex: '7' }],
        entries: [liquidityDeltaEntry()],
      });
    const deltaIndex = fake.calls.findIndex((call) => /v4_liquidity_deltas/.test(call.sql));
    const settleIndex = fake.calls.findIndex((call) => /UPDATE robinhood_market_log_staging/.test(call.sql));

    assert.equal(result.insertedLiquidityDeltas, 1);
    assert.equal(result.insertedObservations, 0);
    assert.equal(deltaIndex < settleIndex, true);
    assert.equal(fake.calls.at(-1).sql, 'COMMIT');
  });

  it('rolls back terminal-write crashes and accepts an idempotent retry', async () => {
    const input = {
      owner: 'backfill-worker-a',
      claims: [{ transactionHash: HASH_B, logIndex: '7' }],
      entries: [marketEntry()],
    };
    const failing = createFakeDatabase({ failBackfillTerminal: true });
    await assert.rejects(
      createRobinhoodPersistenceRepository({ database: failing.database })
        .commitBackfillEnrichmentBatch(input),
      /terminal write failed/
    );
    assert.equal(failing.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(failing.calls.some((call) => call.sql === 'COMMIT'), false);

    const replay = createFakeDatabase({ duplicate: true, targetDuplicate: true });
    const result = await createRobinhoodPersistenceRepository({ database: replay.database })
      .commitBackfillEnrichmentBatch(input);
    assert.equal(result.duplicateLogs, 1);
    assert.equal(result.insertedObservations, 0);
    assert.equal(result.aggregationTargets, 0);
    assert.equal(result.terminalClaims, 1);
    assert.equal(replay.calls.at(-1).sql, 'COMMIT');
  });

  it('rejects recoverable enrichment before opening a transaction', async () => {
    const fake = createFakeDatabase();
    await assert.rejects(
      createRobinhoodPersistenceRepository({ database: fake.database })
        .commitBackfillEnrichmentBatch({
          owner: 'backfill-worker-a',
          claims: [{ transactionHash: HASH_B, logIndex: '7' }],
          entries: [marketEntry({ accepted: false, reason: 'quote_usd_unavailable' })],
        }),
      { code: 'backfill_enrichment_incomplete' }
    );
    assert.equal(fake.calls.length, 0);
  });

  it('defers hourly rebuild for a safely closed historical range', async () => {
    const fake = createFakeDatabase({ liveBuckets: [liveBucketRow()] });
    const emitted = [];
    const repository = createRobinhoodPersistenceRepository({
      database: fake.database,
      now: () => Date.parse('2026-07-13T02:15:00.000Z'),
      emitMarketBucketUpdate(payload) { emitted.push(payload); },
    });

    const result = await repository.commitMarketRange({
      entries: [marketEntry()],
      cursor: { ...cursor(), backfill: true },
    });

    assert.equal(result.insertedLogs, 1);
    assert.equal(result.insertedObservations, 1);
    assert.equal(result.touchedBuckets, 1);
    assert.equal(result.touchedHourlyBuckets, 0);
    assert.equal(fake.calls.some((call) => (
      /INSERT INTO robinhood_market_buckets_1h/.test(call.sql)
    )), false);
    assert.match(fake.calls.at(-2).sql, /INSERT INTO robinhood_ingestion_cursors/);
    assert.equal(fake.calls.at(-1).sql, 'COMMIT');
    assert.equal(emitted.length, 1);
  });

  it('keeps hourly rebuild in the hot path for backfill inside the current UTC hour', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({
      database: fake.database,
      now: () => Date.parse('2026-07-13T00:45:00.000Z'),
    });

    const result = await repository.commitMarketRange({
      entries: [marketEntry()],
      cursor: { ...cursor(), backfill: true },
    });

    assert.equal(result.touchedHourlyBuckets, 1);
    assert.equal(fake.calls.some((call) => (
      /INSERT INTO robinhood_market_buckets_1h/.test(call.sql)
    )), true);
  });

  it('keeps a committed market range successful when socket emission fails', async () => {
    const fake = createFakeDatabase({ liveBuckets: [liveBucketRow()] });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const repository = createRobinhoodPersistenceRepository({
        database: fake.database,
        emitMarketBucketUpdate() { throw new Error('socket unavailable'); },
      });
      const result = await repository.commitMarketRange({
        entries: [marketEntry()],
        cursor: cursor(),
      });

      assert.equal(result.touchedBuckets, 1);
      assert.equal(fake.calls.at(-1).sql, 'COMMIT');
      assert.equal(fake.calls.some((call) => call.sql === 'ROLLBACK'), false);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('builds targeted standard signals only after the market commit', async () => {
    const fake = createFakeDatabase({ liveBuckets: [liveBucketRow()] });
    const consumed = [];
    let consumerContext = null;
    const sourceCalls = [];
    const repository = createRobinhoodPersistenceRepository({
      database: fake.database,
      emitMarketBucketUpdate() {},
      standardAlertSignalSource: {
        async buildFromCommittedBuckets(input) {
          sourceCalls.push({ input, lastDatabaseCall: fake.calls.at(-1).sql });
          return [{ id: 'signal-1' }];
        },
      },
      async standardAlertSignalConsumer(signals, context) {
        consumed.push(...signals);
        consumerContext = context;
      },
    });

    await repository.commitMarketRange({ entries: [marketEntry()], cursor: cursor() });

    assert.equal(sourceCalls.length, 1);
    assert.equal(sourceCalls[0].lastDatabaseCall, 'COMMIT');
    assert.equal(sourceCalls[0].input.buckets[0].tokenAddress, TOKEN);
    assert.equal(sourceCalls[0].input.cursor.nextBlock, '8069001');
    assert.deepEqual(consumed, [{ id: 'signal-1' }]);
    assert.ok(consumerContext.commitCompletedAt instanceof Date);
  });

  it('does not rewrite an observation when its market log is replayed', async () => {
    const fake = createFakeDatabase({ duplicate: true });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const result = await repository.commitMarketRange({
      entries: [marketEntry()],
      cursor: cursor(),
    });

    assert.deepEqual(result, {
      insertedLogs: 0,
      duplicateLogs: 1,
      insertedObservations: 0,
      touchedBuckets: 0,
      insertedLiquidityDeltas: 0,
      touchedHourlyBuckets: 0,
    });
    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_market_observations/.test(call.sql)), false);
    assert.equal(fake.calls.at(-1).sql, 'COMMIT');
  });

  it('preserves exact decoded swap facts when USD enrichment is temporarily unavailable', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const result = await repository.commitMarketRange({
      entries: [marketEntry({ accepted: false, reason: 'quote_usd_unavailable' })],
      cursor: cursor(),
    });

    assert.equal(result.insertedObservations, 1);
    assert.equal(result.touchedBuckets, 0);
    assert.equal(result.touchedHourlyBuckets, 0);
    const insert = fake.calls.find((call) => /INSERT INTO robinhood_market_observations/.test(call.sql));
    const payload = JSON.parse(insert.params[0])[0];
    assert.equal(payload.status, 'pending');
    assert.equal(payload.rejectionReason, 'quote_usd_unavailable');
    assert.equal(payload.tokenAmountRaw, '123456789012345678901234567890');
    assert.equal(payload.quoteAmountRaw, '98765432109876543210');
    assert.equal(payload.priceUsd, null);
    assert.equal(payload.liquidityUsd, null);
    assert.equal(payload.liquidityRaw, null);
    assert.equal(payload.liquidityStatus, null);
  });

  it('rejects a concentrated-liquidity observation mislabeled as USD', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await assert.rejects(
      repository.commitMarketRange({
        entries: [marketEntry({
          liquidityUsd: '100',
          liquidityRaw: null,
          liquidityStatus: 'spot_estimate_from_double_quote_reserve',
          liquidityConfidence: 'medium',
        })],
        cursor: cursor(),
      }),
      /V3 observation liquidity evidence is inconsistent/
    );
    assert.equal(fake.calls.length, 0);
  });

  it('accepts V3 pool-balance TVL with its concentrated-liquidity scalar', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await repository.commitMarketRange({
      entries: [marketEntry({
        liquidityUsd: '30020',
        liquidityStatus: 'spot_tvl_from_pool_balances',
        liquidityConfidence: 'medium',
        liquidityWarning: 'spot_price_and_pool_balances_are_manipulable',
      })],
      cursor: cursor(),
    });
    const insert = fake.calls.find((call) => /INSERT INTO robinhood_market_observations/.test(call.sql));
    assert.equal(JSON.parse(insert.params[0])[0].liquidityUsd, '30020');
  });

  it('accepts V4 point-in-time tick-range TVL with its active-liquidity scalar', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });
    const identity = {
      protocol: 'uniswap-v4', marketKey: `robinhood:uniswap-v4:${POOL_ID}`,
      poolAddress: null, poolId: POOL_ID,
    };

    await repository.commitMarketRange({
      entries: [marketEntry({
        ...identity,
        liquidityUsd: '123.45',
        liquidityStatus: 'spot_tvl_from_v4_tick_ranges',
        liquidityConfidence: 'medium',
        liquidityWarning: 'spot_price_and_tick_liquidity_are_manipulable',
      }, identity)],
      cursor: cursor(),
    });
    const insert = fake.calls.find((call) => /INSERT INTO robinhood_market_observations/.test(call.sql));
    assert.equal(JSON.parse(insert.params[0])[0].liquidityUsd, '123.45');
  });

  it('rejects an enrichment result paired with different decoded swap amounts', async () => {
    const fake = createFakeDatabase();
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await assert.rejects(
      () => repository.commitMarketRange({
        entries: [marketEntry({ tokenAmountRaw: '1' })],
        cursor: cursor(),
      }),
      /metrics do not match their decoded swap/
    );

    assert.equal(fake.calls.length, 0);
  });

  it('rolls back the market cursor when an observation batch fails', async () => {
    const fake = createFakeDatabase({ failObservation: true });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await assert.rejects(
      () => repository.commitMarketRange({ entries: [marketEntry()], cursor: cursor() }),
      /observation write failed/
    );

    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_ingestion_cursors/.test(call.sql)), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(fake.isReleased(), true);
  });

  it('rolls back when an existing market bucket has different token dimensions', async () => {
    const fake = createFakeDatabase({ bucketIdentityConflict: true });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await assert.rejects(
      () => repository.commitMarketRange({ entries: [marketEntry()], cursor: cursor() }),
      /bucket identity conflicts/
    );

    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_ingestion_cursors/.test(call.sql)), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
  });

  it('rolls back observations and cursor when hourly rollup fails', async () => {
    const fake = createFakeDatabase({ failHourlyBucket: true });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await assert.rejects(
      () => repository.commitMarketRange({ entries: [marketEntry()], cursor: cursor() }),
      /hourly bucket write failed/
    );

    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_ingestion_cursors/.test(call.sql)), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
  });

  it('rolls back when an hourly bucket has conflicting token dimensions', async () => {
    const fake = createFakeDatabase({ hourlyBucketConflict: true });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await assert.rejects(
      () => repository.commitMarketRange({ entries: [marketEntry()], cursor: cursor() }),
      /hourly bucket refresh is incomplete/
    );

    assert.equal(fake.calls.some((call) => /INSERT INTO robinhood_ingestion_cursors/.test(call.sql)), false);
    assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
  });
});

describe('Robinhood supply provenance normalization', () => {
  const swapLogRow = {
    transactionHash: HASH_B,
    logIndex: '7',
    blockNumber: '8069000',
    protocol: 'uniswap-v3',
    marketKey: `robinhood:uniswap-v3:${POOL}`,
  };

  it('accepts a live latest_call supply anchored at the swap block', () => {
    const normalized = __private.normalizeObservation(
      marketEntry({ tokenSupplyStatus: 'latest_call', tokenSupplyBlockTag: '8069000' }),
      swapLogRow
    );

    assert.equal(normalized.status, 'accepted');
    assert.equal(normalized.tokenSupplyStatus, 'latest_call');
    assert.equal(normalized.tokenSupplyAnchorBlockNumber, '8069000');
  });

  it('rejects a supply anchor newer than the swap regardless of status', () => {
    assert.throws(
      () => __private.normalizeObservation(
        marketEntry({ tokenSupplyStatus: 'latest_call', tokenSupplyBlockTag: '8069001' }),
        swapLogRow
      ),
      /supply anchor cannot be newer than its swap/
    );
  });

  it('rejects an unknown supply status', () => {
    assert.throws(
      () => __private.normalizeObservation(
        marketEntry({ tokenSupplyStatus: 'guessed', tokenSupplyBlockTag: '8069000' }),
        swapLogRow
      ),
      /supply status is invalid/
    );
  });
});

describe('commitHeadProcessingBatch derived outbox', () => {
  const WINDOW_END = new Date('2026-07-13T00:00:00.000Z');
  const findCall = (calls, re) => calls.find((entry) => re.test(String(entry.sql)));

  it('appends a built market:bucket payload per live bucket in the same transaction', async () => {
    const fake = createFakeDatabase({ liveBuckets: [liveBucketRow()] });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const result = await repository.commitHeadProcessingBatch({
      entries: [marketEntry()],
      emit: { nextBlock: '8069001', checkpointTimestamp: WINDOW_END },
    });

    const outboxCall = findCall(fake.calls, /INSERT INTO robinhood_derived_outbox/);
    assert.ok(outboxCall, 'derived outbox insert must run');
    const rows = JSON.parse(outboxCall.params[0]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].protocol, 'uniswap-v3');
    assert.equal(rows[0].marketKey, `robinhood:uniswap-v3:${POOL}`);
    assert.equal(rows[0].tokenAddress, TOKEN);
    // The stored payload is the fan-out event itself — the consumer never re-values.
    assert.equal(rows[0].payload.type, 'market:bucket');
    assert.equal(rows[0].payload.address, TOKEN);
    assert.deepEqual(rows[0].payload.market, {
      protocol: 'uniswap-v3', key: `robinhood:uniswap-v3:${POOL}`,
    });
    assert.equal(rows[0].payload.ordering.frontierTimestamp, WINDOW_END.toISOString());
    assert.equal(rows[0].payload.derived.standardAlertEligible, true);
    assert.equal(result.insertedOutboxRows, 1);
  });

  it('marks only the newest bucket per token/commit as eligible for standard alerts', async () => {
    const fake = createFakeDatabase({ liveBuckets: [
      liveBucketRow({ lastBlockNumber: '8068999', lastLogIndex: '9' }),
      liveBucketRow({ bucketTs: '2026-07-13T00:01:00.000Z' }),
    ] });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await repository.commitHeadProcessingBatch({
      entries: [marketEntry()],
      emit: { nextBlock: '8069001', checkpointTimestamp: WINDOW_END },
    });

    const outboxCall = findCall(fake.calls, /INSERT INTO robinhood_derived_outbox/);
    const rows = JSON.parse(outboxCall.params[0]);
    assert.deepEqual(rows.map((row) => row.payload.derived.standardAlertEligible), [false, true]);
  });

  it('threads the coverage window end into the observation write', async () => {
    const fake = createFakeDatabase({ liveBuckets: [liveBucketRow()] });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await repository.commitHeadProcessingBatch({
      entries: [marketEntry()],
      emit: { nextBlock: '8069001', checkpointTimestamp: WINDOW_END },
    });

    const obsCall = findCall(fake.calls, /INSERT INTO robinhood_market_observations/);
    // Without a real window end the 5m volume/coverage would be 'unavailable';
    // the derived path must value it against the processing frontier.
    assert.equal(obsCall.params[1] instanceof Date, true);
    assert.equal(obsCall.params[1].toISOString(), WINDOW_END.toISOString());
    assert.equal(obsCall.params[2], true);
  });

  it('builds outbox from the canonical bucket when the monolith won the log identity race', async () => {
    const fake = createFakeDatabase({ duplicate: true, liveBuckets: [liveBucketRow()] });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const result = await repository.commitHeadProcessingBatch({
      entries: [marketEntry()],
      emit: { nextBlock: '8069001', checkpointTimestamp: WINDOW_END },
    });

    const obsCall = findCall(fake.calls, /INSERT INTO robinhood_market_observations/);
    assert.equal(JSON.parse(obsCall.params[0]).length, 1);
    assert.equal(obsCall.params[2], true); // target existing bucket without re-counting it
    assert.equal(result.insertedLogs, 0);
    assert.equal(result.insertedObservations, 0);
    assert.equal(result.touchedBuckets, 0);
    assert.equal(result.insertedOutboxRows, 1);
  });

  it('preserves legacy behaviour (no outbox, null window) when no emit context is given', async () => {
    const fake = createFakeDatabase({ liveBuckets: [liveBucketRow()] });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const result = await repository.commitHeadProcessingBatch({ entries: [marketEntry()] });

    assert.equal(findCall(fake.calls, /INSERT INTO robinhood_derived_outbox/), undefined);
    const obsCall = findCall(fake.calls, /INSERT INTO robinhood_market_observations/);
    assert.equal(obsCall.params[1], null);
    assert.equal(obsCall.params[2], false);
    assert.equal(result.insertedOutboxRows, 0);
  });

  it('notifies the derived worker in the same transaction after appending rows', async () => {
    const fake = createFakeDatabase({ liveBuckets: [liveBucketRow()] });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    await repository.commitHeadProcessingBatch({
      entries: [marketEntry()],
      emit: { nextBlock: '8069001', checkpointTimestamp: WINDOW_END },
    });

    const notify = findCall(fake.calls, /pg_notify/);
    assert.ok(notify, 'a NOTIFY must be issued');
    assert.equal(notify.params[0], 'robinhood_derived_outbox');
  });
});

describe('resolveMarketFrontier', () => {
  const findCall = (calls, re) => calls.find((entry) => re.test(String(entry.sql)));

  it('anchors coverage on the newest accepted observation below the pending block', async () => {
    const fake = createFakeDatabase({
      readRows: [{ block_number: '99', observed_at: new Date('2026-07-13T00:00:00.000Z') }],
    });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const frontier = await repository.resolveMarketFrontier('100');

    assert.equal(frontier.nextBlock, '100');
    assert.equal(frontier.checkpointTimestamp.toISOString(), '2026-07-13T00:00:00.000Z');
    const call = findCall(fake.calls, /block_number < \$1/);
    assert.equal(call.params[0], '100'); // bounded strictly below the pending block
  });

  it('returns no frontier when nothing is processed below the pending block', async () => {
    const fake = createFakeDatabase({ readRows: [] });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    assert.equal(await repository.resolveMarketFrontier('100'), null);
  });

  it('spans the whole history when the queue is drained (null pending block)', async () => {
    const fake = createFakeDatabase({
      readRows: [{ block_number: '250', observed_at: new Date('2026-07-13T01:00:00.000Z') }],
    });
    const repository = createRobinhoodPersistenceRepository({ database: fake.database });

    const frontier = await repository.resolveMarketFrontier(null);

    assert.equal(frontier.nextBlock, '251'); // block + 1
    const call = findCall(fake.calls, /block_number < \$1/);
    assert.equal(call.params[0], '9223372036854775807'); // unbounded sentinel
  });
});

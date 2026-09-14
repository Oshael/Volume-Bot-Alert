'use strict';

const db = require('../models/db');
const {
  createRobinhoodBackfillCaptureRepository,
} = require('../models/robinhood-backfill-capture');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { parseQuantity, toQuantity } = require('../services/evm-log-poller');
const {
  __private: { selectTrackedLogs },
} = require('../services/robinhood-backfill-market-scanner');
const v2 = require('../services/uniswap-v2-decoder');
const v3 = require('../services/uniswap-v3-decoder');
const v4 = require('../services/uniswap-v4-decoder');

const CHAIN_ID = 4663n;
const MARKET_TOPICS = Object.freeze([
  v2.TOPICS.swap, v2.TOPICS.sync, v3.TOPICS.initialize,
  v3.TOPICS.swap, v4.TOPICS.modifyLiquidity, v4.TOPICS.swap,
]);
const TOPIC_PROTOCOL = new Map([
  [v2.TOPICS.swap, 'uniswap-v2'], [v2.TOPICS.sync, 'uniswap-v2'],
  [v3.TOPICS.initialize, 'uniswap-v3'], [v3.TOPICS.swap, 'uniswap-v3'],
]);

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const values = Object.fromEntries(argv.map((argument) => {
    const match = String(argument).match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    return [match[1], match[2] ?? 'true'];
  }));
  const unknown = Object.keys(values).filter((key) => !['apply', 'rpc-url', 'max-ranges'].includes(key));
  if (unknown.length) throw new Error(`Unknown argument: --${unknown[0]}`);
  if (values.apply != null && values.apply !== 'true') throw new Error('--apply does not accept a value');
  const maxRanges = Number(values['max-ranges'] || 100);
  if (!Number.isSafeInteger(maxRanges) || maxRanges < 1 || maxRanges > 100) {
    throw new Error('max-ranges must be between 1 and 100');
  }
  return {
    apply: values.apply === 'true',
    rpcUrl: String(values['rpc-url'] || env.ROBINHOOD_ARCHIVE_RPC_URL || '').trim(),
    maxRanges,
  };
}

function createRepairRepository(database = db) {
  async function listBrokenRanges(limit) {
    const result = await database.query(
      `WITH frontiers AS MATERIALIZED (
         SELECT MAX(next_block) FILTER (WHERE frontier = 'market_enriched') AS enriched_next,
                MAX(next_block) FILTER (WHERE frontier = 'market_scan') AS scan_next
         FROM robinhood_backfill_watermarks WHERE chain = 'robinhood'
       ), broken AS MATERIALIZED (
         SELECT ranges.id::text, ranges.from_block::text, ranges.to_block::text,
                ranges.raw_log_count, ranges.tracked_log_count,
                ranges.checkpoint_hash, ranges.checkpoint_timestamp,
                COUNT(staging.transaction_hash)::int AS staging_count
         FROM robinhood_backfill_ranges ranges
         CROSS JOIN frontiers
         LEFT JOIN robinhood_market_log_staging staging
           ON staging.chain = ranges.chain AND staging.range_id = ranges.id
         WHERE ranges.chain = 'robinhood' AND ranges.stream = 'market'
           AND ranges.status = 'captured'
           AND ranges.to_block >= frontiers.enriched_next
           AND ranges.from_block < frontiers.scan_next
         GROUP BY ranges.id
         HAVING COUNT(staging.transaction_hash) <> ranges.tracked_log_count
       )
       SELECT broken.*, COUNT(*) OVER ()::int AS total_broken
       FROM broken ORDER BY from_block::bigint LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async function listPoolsForLogs(logs) {
    const requested = new Map();
    for (const log of logs) {
      const address = String(log.address || '').toLowerCase();
      const topic0 = String(log.topics?.[0] || '').toLowerCase();
      const identity = address === v4.ROBINHOOD_V4_POOL_MANAGER
        ? { protocol: 'uniswap-v4', pool_address: null, pool_id: String(log.topics?.[1] || '').toLowerCase() }
        : { protocol: TOPIC_PROTOCOL.get(topic0), pool_address: address, pool_id: null };
      if (!identity.protocol || (!identity.pool_address && !identity.pool_id)) continue;
      requested.set(`${identity.protocol}:${identity.pool_address || identity.pool_id}`, identity);
    }
    if (!requested.size) return [];
    const result = await database.query(
      `WITH requested AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
           protocol text, pool_address text, pool_id text
         )
       )
       SELECT registry.protocol, registry.market_key, registry.pool_address,
              registry.pool_id, registry.origin_address, registry.token_address,
              registry.quote_address, registry.currency0, registry.currency1,
              registry.fee, registry.tick_spacing, registry.metadata
       FROM requested JOIN robinhood_pool_registry registry
         ON registry.chain = 'robinhood' AND registry.protocol = requested.protocol
        AND registry.pool_address = requested.pool_address
       WHERE requested.pool_address IS NOT NULL
       UNION
       SELECT registry.protocol, registry.market_key, registry.pool_address,
              registry.pool_id, registry.origin_address, registry.token_address,
              registry.quote_address, registry.currency0, registry.currency1,
              registry.fee, registry.tick_spacing, registry.metadata
       FROM requested JOIN robinhood_pool_registry registry
         ON registry.chain = 'robinhood' AND registry.protocol = requested.protocol
        AND registry.pool_id = requested.pool_id
       WHERE requested.pool_id IS NOT NULL`,
      [JSON.stringify([...requested.values()])]
    );
    return result.rows;
  }

  return Object.freeze({ listBrokenRanges, listPoolsForLogs });
}

function createArchiveClient(url) {
  if (!url) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required');
  return createEvmJsonRpcClient({
    providers: [{ name: 'archive', url }], timeoutMs: 60_000, maxRetries: 2,
  });
}

async function recaptureRange(client, range) {
  const [rawLogs, checkpoint] = await Promise.all([
    client.requestProvider('archive', 'eth_getLogs', [{
      topics: [MARKET_TOPICS],
      fromBlock: toQuantity(range.from_block),
      toBlock: toQuantity(range.to_block),
    }]),
    client.requestProvider(
      'archive', 'eth_getBlockByNumber', [toQuantity(range.to_block), false]
    ),
  ]);
  if (!Array.isArray(rawLogs)) throw new Error(`Range ${range.id} returned invalid logs`);
  const expectedRaw = Number(range.raw_log_count);
  const legacyLogs = rawLogs.filter(
    (log) => String(log.topics?.[0] || '').toLowerCase() !== v4.TOPICS.modifyLiquidity
  );
  const topicProfile = rawLogs.length === expectedRaw
    ? 'current'
    : legacyLogs.length === expectedRaw ? 'legacy-without-v4-liquidity' : null;
  if (!topicProfile) {
    throw new Error(
      `Range ${range.id} raw log count mismatch: expected=${expectedRaw} `
      + `current=${rawLogs.length} legacy=${legacyLogs.length}`
    );
  }
  if (
    parseQuantity(checkpoint?.number, 'checkpoint.number') !== BigInt(range.to_block)
    || String(checkpoint?.hash || '').toLowerCase() !== String(range.checkpoint_hash).toLowerCase()
    || Number(parseQuantity(checkpoint?.timestamp, 'checkpoint.timestamp'))
      !== Math.floor(new Date(range.checkpoint_timestamp).getTime() / 1000)
  ) {
    throw new Error(`Range ${range.id} checkpoint does not match its manifest`);
  }
  return {
    logs: topicProfile === 'current' ? rawLogs : legacyLogs,
    topicProfile,
  };
}

async function runRepair(options, deps = {}) {
  const repository = deps.repository || createRepairRepository(deps.database || db);
  const ranges = await repository.listBrokenRanges(options.maxRanges);
  if (!ranges.length) return { mode: options.apply ? 'apply' : 'dry-run', ranges: 0, logs: 0 };
  if (Number(ranges[0].total_broken) > options.maxRanges) {
    throw new Error(`Broken range count exceeds max-ranges=${options.maxRanges}`);
  }
  const rpc = deps.rpc || createArchiveClient(options.rpcUrl);
  if (parseQuantity(await rpc.requestProvider('archive', 'eth_chainId'), 'chainId') !== CHAIN_ID) {
    throw new Error('Archive RPC is not on Robinhood Chain');
  }
  const captures = [];
  for (const range of ranges) captures.push(await recaptureRange(rpc, range));
  const pools = await repository.listPoolsForLogs(captures.flatMap(({ logs }) => logs));
  const repairs = ranges.map((range, index) => {
    const logs = selectTrackedLogs(captures[index].logs, pools);
    if (logs.length !== Number(range.tracked_log_count)) {
      throw new Error(`Range ${range.id} tracked log count does not match its manifest`);
    }
    return {
      rangeId: range.id, fromBlock: range.from_block, toBlock: range.to_block,
      rawLogCount: Number(range.raw_log_count), checkpointHash: range.checkpoint_hash, logs,
    };
  });
  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    ranges: repairs.length,
    logs: repairs.reduce((total, repair) => total + repair.logs.length, 0),
    firstBlock: ranges[0].from_block,
    lastBlock: ranges.at(-1).to_block,
    topicProfiles: [...new Set(captures.map(({ topicProfile }) => topicProfile))],
  };
  if (!options.apply) return summary;
  const capture = deps.capture || createRobinhoodBackfillCaptureRepository({
    database: deps.database || db,
  });
  return { ...summary, ...(await capture.restoreCapturedMarketRanges(repairs)) };
}

async function run() {
  try {
    console.log(JSON.stringify(await runRepair(parseArgs()), null, 2));
  } catch (error) {
    console.error('[RobinhoodBackfillStagingRepair]', error.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) void run();

module.exports = {
  runRepair,
  __private: { createRepairRepository, parseArgs, recaptureRange },
};

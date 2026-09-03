const { setTimeout: delay } = require('node:timers/promises');
const db = require('../models/db');
const {
  createRobinhoodPersistenceRepository,
} = require('../models/robinhood-persistence');
const {
  createRobinhoodBackfillEnrichmentAdapter,
} = require('../services/robinhood-backfill-enrichment-adapter');
const {
  executeRobinhoodBackfillEnrichmentPlan,
  planRobinhoodBackfillEnrichment,
} = require('../services/robinhood-backfill-enrichment-planner');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');

const CHAIN_ID = 4663n;
const REJECTION = 'v3_pool_balance_unavailable';
const LOCK_KEY = 'robinhood:v3-pruned-capture-repair';

function integer(value, fallback, min, max, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const resolved = Number.isInteger(parsed) ? parsed : fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return resolved;
}

function block(value, fallback, label) {
  const resolved = String(value ?? fallback).trim();
  if (!/^\d+$/.test(resolved)) throw new Error(`${label} must be a non-negative block`);
  return resolved;
}

function parseNamedArgs(argv) {
  return Object.fromEntries(argv.map((argument) => {
    const match = String(argument).match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    return [match[1], match[2] ?? 'true'];
  }));
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = parseNamedArgs(argv);
  const mode = String(args.mode || 'dry-run').toLowerCase();
  if (!['dry-run', 'write'].includes(mode)) throw new Error('mode must be dry-run or write');
  return {
    mode,
    rpcUrl: String(args['rpc-url'] || env.ROBINHOOD_V3_REPAIR_RPC_URL || '').trim(),
    fromBlock: block(args['from-block'], '0', 'from-block'),
    toBlock: block(args['to-block'], '9223372036854775807', 'to-block'),
    batchSize: integer(args['batch-size'], 100, 1, 500, 'batch-size'),
    rpcConcurrency: integer(args['rpc-concurrency'], 2, 1, 8, 'rpc-concurrency'),
    maxBatches: integer(args['max-batches'], mode === 'dry-run' ? 1 : 0, 0, 1_000_000, 'max-batches'),
    sleepMs: integer(args['sleep-ms'], 100, 0, 60_000, 'sleep-ms'),
  };
}

function createCandidateRepository(database = db) {
  const filter = `capture.chain = 'robinhood'
    AND capture.stream = 'market'
    AND capture.protocol = 'uniswap-v3'
    AND capture.processing_status = 'rejected'
    AND capture.evidence->>'rejected' = '${REJECTION}'
    AND COALESCE(capture.evidence #>> '{archiveRepair,status}', '') <> 'blocked'
    AND capture.block_number BETWEEN $1::bigint AND $2::bigint`;

  async function summarize(fromBlock, toBlock) {
    const result = await database.query(
      `SELECT COUNT(*)::bigint AS candidates,
              MIN(capture.block_number)::text AS first_block,
              MAX(capture.block_number)::text AS last_block
         FROM robinhood_head_captures capture
        WHERE ${filter}`,
      [fromBlock, toBlock]
    );
    return result.rows[0];
  }

  async function list(fromBlock, toBlock, limit) {
    const result = await database.query(
      `SELECT capture.transaction_hash, capture.log_index::text,
              capture.block_number::text, capture.block_hash,
              capture.transaction_index::text, capture.address,
              capture.topics, capture.data, capture.protocol, capture.market_key,
              registry.market_key AS registry_market_key,
              registry.pool_address, registry.pool_id, registry.origin_address,
              registry.token_address, registry.quote_address,
              registry.currency0, registry.currency1, registry.fee,
              registry.tick_spacing, registry.metadata
         FROM robinhood_head_captures capture
         LEFT JOIN robinhood_pool_registry registry
           ON registry.chain = capture.chain
          AND registry.protocol = capture.protocol
          AND registry.market_key = capture.market_key
        WHERE ${filter}
        ORDER BY capture.block_number, capture.transaction_index,
                 capture.log_index, capture.transaction_hash
        LIMIT $3`,
      [fromBlock, toBlock, limit]
    );
    return result.rows;
  }

  async function markRepaired(rows) {
    const identities = rows.map((row) => ({
      transactionHash: row.transaction_hash,
      logIndex: row.log_index,
    }));
    const result = await database.query(
      `UPDATE robinhood_head_captures capture
          SET processing_status = 'processed',
              evidence = capture.evidence || jsonb_build_object(
                'archiveRepair', jsonb_build_object(
                  'status', 'completed',
                  'originalReason', $2::text,
                  'repairedAt', NOW()
                )
              ),
              last_error = NULL,
              terminal_at = NOW(),
              retention_eligible_at = NOW() + INTERVAL '7 days',
              updated_at = NOW()
         FROM jsonb_to_recordset($1::jsonb) AS repaired(
           "transactionHash" text, "logIndex" bigint
         )
        WHERE capture.chain = 'robinhood'
          AND capture.transaction_hash = repaired."transactionHash"
          AND capture.log_index = repaired."logIndex"
          AND capture.processing_status = 'rejected'
          AND capture.evidence->>'rejected' = $2
        RETURNING capture.transaction_hash`,
      [JSON.stringify(identities), REJECTION]
    );
    if (result.rowCount !== rows.length) {
      throw new Error(`Archive repair finalized ${result.rowCount}/${rows.length} captures`);
    }
    return result.rowCount;
  }

  async function markBlocked(failures) {
    if (!failures.length) return 0;
    const identities = failures.map(({ row, error }) => ({
      transactionHash: row.transaction_hash,
      logIndex: row.log_index,
      error: String(error?.message || error || 'archive repair failed').slice(0, 1000),
    }));
    const result = await database.query(
      `UPDATE robinhood_head_captures capture
          SET evidence = capture.evidence || jsonb_build_object(
                'archiveRepair', jsonb_build_object(
                  'status', 'blocked',
                  'originalReason', $2::text,
                  'failedAt', NOW(),
                  'error', failed.error
                )
              ),
              last_error = LEFT('V3 archive repair blocked: ' || failed.error, 4000),
              terminal_at = NOW(),
              retention_eligible_at = NOW() + INTERVAL '7 days',
              updated_at = NOW()
         FROM jsonb_to_recordset($1::jsonb) AS failed(
           "transactionHash" text, "logIndex" bigint, error text
         )
        WHERE capture.chain = 'robinhood'
          AND capture.transaction_hash = failed."transactionHash"
          AND capture.log_index = failed."logIndex"
          AND capture.processing_status = 'rejected'
          AND capture.evidence->>'rejected' = $2
        RETURNING capture.transaction_hash`,
      [JSON.stringify(identities), REJECTION]
    );
    if (result.rowCount !== failures.length) {
      throw new Error(`Archive repair blocked ${result.rowCount}/${failures.length} captures`);
    }
    return result.rowCount;
  }

  async function withLock(callback) {
    const client = await database.getClient();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
      return await callback();
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]); } catch (_) {}
      client.release();
    }
  }

  return Object.freeze({ summarize, list, markRepaired, markBlocked, withLock });
}

function claim(row) {
  return {
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    transactionIndex: row.transaction_index,
    address: row.address,
    topics: row.topics,
    data: row.data,
    protocol: row.protocol,
    marketKey: row.market_key,
  };
}

function poolSeeds(rows) {
  const unique = new Map();
  for (const row of rows) {
    if (!row.registry_market_key) {
      throw new Error(`Pool registry missing for ${row.market_key}`);
    }
    unique.set(row.market_key, {
      protocol: row.protocol,
      market_key: row.market_key,
      pool_address: row.pool_address,
      pool_id: row.pool_id,
      origin_address: row.origin_address,
      token_address: row.token_address,
      quote_address: row.quote_address,
      currency0: row.currency0,
      currency1: row.currency1,
      fee: row.fee,
      tick_spacing: row.tick_spacing,
      metadata: row.metadata,
    });
  }
  return [...unique.values()];
}

async function mapConcurrent(items, concurrency, mapper) {
  let index = 0;
  const output = Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      output[current] = await mapper(items[current], current);
    }
  }));
  return output;
}

async function buildPreparedEntries(prepared, results, adapter, concurrency) {
  const outcomes = await mapConcurrent(prepared, concurrency, async (item) => {
    try {
      const entry = await adapter.buildEntry({
        context: item.context,
        results: results.get(item.id),
      });
      return { entry, row: item.row };
    } catch (error) {
      if (error?.retryable === true) throw error;
      return { error, row: item.row };
    }
  });
  const completed = outcomes.filter(({ entry }) => entry);
  return {
    entries: completed.map(({ entry }) => entry),
    repairedRows: completed.map(({ row }) => row),
    failures: outcomes.filter(({ error }) => error),
  };
}

function createArchiveClient(rpcUrl) {
  if (!rpcUrl) throw new Error('ROBINHOOD_V3_REPAIR_RPC_URL is required in write mode');
  return createEvmJsonRpcClient({
    providers: [{ name: 'archive', url: rpcUrl }],
    timeoutMs: 60_000,
    maxRetries: 2,
    minRequestIntervalMs: 0,
  });
}

async function enrich(rows, rpcClient, options) {
  const adapter = createRobinhoodBackfillEnrichmentAdapter({
    seedPools: poolSeeds(rows),
    rpcClient,
    rpcProvider: 'archive',
    timestampProvider: 'archive',
  });
  const prepared = rows.map((row) => {
    const item = adapter.prepareClaim(claim(row));
    return { row, ...item, id: `${row.transaction_hash}:${row.log_index}` };
  });
  const plan = planRobinhoodBackfillEnrichment(prepared.map((item) => ({
    id: item.id,
    tokenAddress: item.tokenAddress,
    blockNumber: item.row.block_number,
    logIndex: item.row.log_index,
    requests: item.requests,
  })), { providerBatchSizes: { archive: 100 } });
  const executed = await executeRobinhoodBackfillEnrichmentPlan(plan, rpcClient, {
    concurrency: options.rpcConcurrency,
  });
  const results = new Map(executed.items.map((item) => [item.id, item.results]));
  const built = await buildPreparedEntries(
    prepared, results, adapter, options.rpcConcurrency
  );
  return {
    ...built,
    rpc: executed.metrics,
  };
}

async function runRepair(options, deps = {}) {
  const candidates = deps.candidates || createCandidateRepository(deps.database || db);
  const initial = await candidates.summarize(options.fromBlock, options.toBlock);
  const summary = {
    mode: options.mode,
    candidates: Number(initial.candidates || 0),
    remaining: Number(initial.candidates || 0),
    progressPct: Number(initial.candidates || 0) === 0 ? 100 : 0,
    firstBlock: initial.first_block,
    lastBlock: initial.last_block,
    batches: 0,
    repaired: 0,
    accepted: 0,
    rejected: 0,
    blocked: 0,
  };
  if (options.mode === 'dry-run' || summary.candidates === 0) return summary;
  const rpcClient = deps.rpcClient || createArchiveClient(options.rpcUrl);
  const persistence = deps.persistence || createRobinhoodPersistenceRepository();
  const enrichBatch = deps.enrichBatch || ((rows) => enrich(rows, rpcClient, options));

  return candidates.withLock(async () => {
    const chainId = await rpcClient.request('eth_chainId');
    if (BigInt(chainId) !== CHAIN_ID) throw new Error('Archive RPC is not on Robinhood Chain');
    let scanFromBlock = options.fromBlock;
    while (options.maxBatches === 0 || summary.batches < options.maxBatches) {
      const rows = await candidates.list(scanFromBlock, options.toBlock, options.batchSize);
      if (!rows.length) break;
      const built = await enrichBatch(rows);
      const repairedRows = built.repairedRows || rows;
      const failures = built.failures || [];
      const committed = built.entries.length
        ? await persistence.commitHeadProcessingBatch({ entries: built.entries })
        : null;
      if (repairedRows.length) await candidates.markRepaired(repairedRows);
      if (failures.length) await candidates.markBlocked(failures);
      summary.batches += 1;
      summary.repaired += repairedRows.length;
      summary.accepted += built.entries.filter((entry) => entry.observation?.accepted).length;
      summary.rejected += built.entries.filter((entry) => entry.observation?.accepted === false).length;
      summary.blocked += failures.length;
      summary.remaining = Math.max(0, summary.candidates - summary.repaired - summary.blocked);
      summary.progressPct = Number((
        ((summary.repaired + summary.blocked) / summary.candidates) * 100
      ).toFixed(2));
      summary.lastBlock = rows.at(-1).block_number;
      summary.lastCommit = committed;
      summary.lastRpc = built.rpc;
      summary.lastFailures = failures.slice(0, 10).map(({ row, error }) => ({
        transactionHash: row.transaction_hash,
        logIndex: row.log_index,
        blockNumber: row.block_number,
        marketKey: row.market_key,
        error: String(error?.message || error).slice(0, 500),
      }));
      scanFromBlock = summary.lastBlock;
      console.log(JSON.stringify({ event: 'v3_archive_repair_progress', ...summary }));
      if (options.sleepMs) await delay(options.sleepMs);
    }
    return summary;
  });
}

async function run() {
  try {
    const summary = await runRepair(parseArgs());
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('[RobinhoodV3ArchiveRepair]', error.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) void run();

module.exports = {
  runRepair,
  __private: {
    buildPreparedEntries, claim, createArchiveClient, createCandidateRepository,
    enrich, parseArgs, poolSeeds,
  },
};

require('dotenv').config();

const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { TRANSFER_TOPIC, ZERO_TOPIC } = require('../services/evm-erc20-supply-delta');

const EXPECTED_CHAIN_ID = 4663n;
const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const PROVIDER_NAME = 'holder-transfer-probe';
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function resolveProvider(env = process.env) {
  const url = String(env.ROBINHOOD_HOLDER_TRANSFER_PROBE_RPC_URL
    || env.ROBINHOOD_RPC_URL || env.ROBINHOOD_DRPC_RPC_URL || PUBLIC_RPC_URL).trim();
  const source = env.ROBINHOOD_HOLDER_TRANSFER_PROBE_RPC_URL ? 'probe'
    : env.ROBINHOOD_RPC_URL ? 'robinhood-config'
      : env.ROBINHOOD_DRPC_RPC_URL ? 'drpc' : 'robinhood-public';
  return { name: PROVIDER_NAME, source, url };
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    confirmations: boundedInteger(input.confirmations, 2, 0, 1000),
    blockCount: boundedInteger(input.blockCount, 2000, 1, 50_000),
    chunkBlocks: boundedInteger(input.chunkBlocks, 250, 1, 5000),
    timeoutMs: boundedInteger(input.timeoutMs, 15_000, 1000, 60_000),
    ledgerRowBytes: boundedInteger(input.ledgerRowBytes, 160, 64, 1024),
    tailEventBytes: boundedInteger(input.tailEventBytes, 220, 96, 2048),
    addressBatchSize: boundedInteger(input.addressBatchSize, 100, 1, 500),
    catalogLimit: boundedInteger(input.catalogLimit, 1000, 1, 50_000),
    fromBlock: input.fromBlock == null || input.fromBlock === ''
      ? null : quantity(input.fromBlock, 'fromBlock'),
  });
}

function normalizeAddresses(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new TypeError('addresses must be an array');
  return [...new Set(value.map((address) => String(address || '').trim().toLowerCase()))]
    .map((address) => {
      if (!ADDRESS_PATTERN.test(address)) throw new Error(`invalid catalog address: ${address}`);
      return address;
    });
}

async function loadCatalogScope(database, limit = 1000) {
  if (typeof database?.query !== 'function') throw new TypeError('database.query is required');
  const safeLimit = boundedInteger(limit, 1000, 1, 50_000);
  const [countResult, addressResult] = await Promise.all([
    database.query("SELECT COUNT(*)::text AS total FROM token_catalog WHERE chain = 'robinhood'"),
    database.query(
      `SELECT address FROM token_catalog
       WHERE chain = 'robinhood'
       ORDER BY last_seen_at DESC NULLS LAST, address ASC
       LIMIT $1::int`,
      [safeLimit]
    ),
  ]);
  const total = Number(countResult.rows?.[0]?.total);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('catalog total is invalid');
  const addresses = normalizeAddresses(addressResult.rows.map((row) => row.address));
  return Object.freeze({ total, addresses });
}

function isAdaptiveRangeError(error) {
  return ['log_range_error', 'timeout', 'rate_limited'].includes(error?.code)
    || (error?.code === 'http_error' && [400, 408, 413, 429].includes(error.httpStatus));
}

function decodeTransfer(log) {
  const token = String(log?.address || '').toLowerCase();
  const topics = Array.isArray(log?.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : [];
  const data = String(log?.data || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token) || topics.length < 3
    || topics[0] !== TRANSFER_TOPIC || !topics.slice(1, 3).every((topic) => /^0x[0-9a-f]{64}$/.test(topic))
    || !/^0x[0-9a-f]{64}$/.test(data)) return null;
  return {
    token,
    from: `0x${topics[1].slice(-40)}`,
    to: `0x${topics[2].slice(-40)}`,
  };
}

async function readLogsAdaptive(client, fromBlock, toBlock, telemetry, addresses = null) {
  telemetry.requests += 1;
  try {
    const filter = {
      fromBlock: blockTag(fromBlock), toBlock: blockTag(toBlock), topics: [TRANSFER_TOPIC],
    };
    if (addresses) filter.address = addresses;
    const logs = await client.requestProvider(PROVIDER_NAME, 'eth_getLogs', [filter]);
    if (!Array.isArray(logs)) throw new Error('eth_getLogs result is invalid');
    telemetry.largestSuccessfulRange = Math.max(
      telemetry.largestSuccessfulRange, Number(toBlock - fromBlock + 1n)
    );
    return logs;
  } catch (error) {
    const code = String(error?.code || error?.name || 'error');
    telemetry.errors[code] = (telemetry.errors[code] || 0) + 1;
    if (!isAdaptiveRangeError(error) || fromBlock >= toBlock) throw error;
    telemetry.splits += 1;
    const middle = (fromBlock + toBlock) / 2n;
    const left = await readLogsAdaptive(client, fromBlock, middle, telemetry, addresses);
    const right = await readLogsAdaptive(client, middle + 1n, toBlock, telemetry, addresses);
    return [...left, ...right];
  }
}

function batches(values, size) {
  if (values == null) return [null];
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function resolveWindow(head, options) {
  const safeHead = head >= BigInt(options.confirmations) ? head - BigInt(options.confirmations) : 0n;
  const defaultFrom = safeHead >= BigInt(options.blockCount - 1)
    ? safeHead - BigInt(options.blockCount - 1) : 0n;
  const fromBlock = options.fromBlock ?? defaultFrom;
  if (fromBlock > safeHead) throw new Error('fromBlock cannot exceed safe head');
  return { fromBlock, safeHead };
}

async function collectLogs(client, fromBlock, safeHead, options, addressBatches, telemetry) {
  const logs = [];
  for (let start = fromBlock; start <= safeHead; start += BigInt(options.chunkBlocks)) {
    const candidateEnd = start + BigInt(options.chunkBlocks - 1);
    const end = candidateEnd > safeHead ? safeHead : candidateEnd;
    for (const addressBatch of addressBatches) {
      logs.push(...await readLogsAdaptive(client, start, end, telemetry, addressBatch));
    }
  }
  return logs;
}

function describeScope(addresses, inputTotal, options, addressBatchCount) {
  if (addresses == null) return { kind: 'chain-wide' };
  const catalogTotal = Number(inputTotal ?? addresses.length);
  if (!Number.isSafeInteger(catalogTotal) || catalogTotal < addresses.length) {
    throw new Error('catalogTotal cannot be smaller than selected addresses');
  }
  return {
    kind: 'catalog', selectedTokens: addresses.length, catalogTotal,
    coveragePct: catalogTotal ? Number(((addresses.length / catalogTotal) * 100).toFixed(2)) : null,
    addressBatchSize: options.addressBatchSize, addressBatches: addressBatchCount,
  };
}

function projection(value, sampleSeconds) {
  return sampleSeconds > 0 ? Math.round((value * 86_400) / sampleSeconds) : null;
}

function summarize(logs, sampleSeconds, options) {
  const tokens = new Set();
  const wallets = new Set();
  const pairs = new Set();
  const mintTokens = new Set();
  let events = 0;
  let malformed = 0;
  let mints = 0;
  let burns = 0;
  let selfTransfers = 0;
  for (const log of logs) {
    const transfer = decodeTransfer(log);
    if (!transfer) { malformed += 1; continue; }
    events += 1;
    tokens.add(transfer.token);
    if (transfer.from === transfer.to) selfTransfers += 1;
    if (transfer.from === `0x${ZERO_TOPIC.slice(-40)}`) { mints += 1; mintTokens.add(transfer.token); }
    else { wallets.add(transfer.from); pairs.add(`${transfer.token}:${transfer.from}`); }
    if (transfer.to === `0x${ZERO_TOPIC.slice(-40)}`) burns += 1;
    else { wallets.add(transfer.to); pairs.add(`${transfer.token}:${transfer.to}`); }
  }
  const pairUpperBoundPerDay = projection(pairs.size, sampleSeconds);
  const eventsPerDay = projection(events, sampleSeconds);
  return {
    events, malformed, tokens: tokens.size, wallets: wallets.size,
    tokenWalletPairsTouched: pairs.size, mints, burns, selfTransfers,
    projected: {
      eventsPerDay,
      touchedPairUpperBoundPerDay: pairUpperBoundPerDay,
      ledgerGrowthUpperBoundBytesPerDay: pairUpperBoundPerDay == null
        ? null : pairUpperBoundPerDay * options.ledgerRowBytes,
      liveTailBytesPerDay: eventsPerDay == null ? null : eventsPerDay * options.tailEventBytes,
    },
    deploymentEvidence: {
      exactDeploymentBlockAvailable: false,
      tokensWithMintInSample: mintTokens.size,
      coveragePct: tokens.size ? Number(((mintTokens.size / tokens.size) * 100).toFixed(2)) : null,
    },
  };
}

async function runHolderTransferProbe(input = {}) {
  const options = normalizeOptions(input);
  const addresses = normalizeAddresses(input.addresses);
  const addressBatches = batches(addresses, options.addressBatchSize);
  const provider = input.provider || resolveProvider(input.env);
  const client = input.client || createEvmJsonRpcClient({
    providers: [provider], timeoutMs: options.timeoutMs, maxRetries: 0, minRequestIntervalMs: 0,
  });
  const chainId = quantity(
    await client.requestProvider(PROVIDER_NAME, 'eth_chainId'), 'eth_chainId'
  );
  if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`unexpected chain ID ${chainId}`);
  const head = quantity(await client.requestProvider(PROVIDER_NAME, 'eth_blockNumber'), 'head block');
  const { fromBlock, safeHead } = resolveWindow(head, options);
  const [firstBlock, lastBlock] = await Promise.all([
    client.requestProvider(PROVIDER_NAME, 'eth_getBlockByNumber', [blockTag(fromBlock), false]),
    client.requestProvider(PROVIDER_NAME, 'eth_getBlockByNumber', [blockTag(safeHead), false]),
  ]);
  const sampleSeconds = Number(quantity(lastBlock?.timestamp, 'last timestamp')
    - quantity(firstBlock?.timestamp, 'first timestamp'));
  const telemetry = { requests: 0, splits: 0, largestSuccessfulRange: 0, errors: {} };
  const logs = await collectLogs(
    client, fromBlock, safeHead, options, addressBatches, telemetry
  );
  return {
    readOnly: true, provider: provider.source, chainId: chainId.toString(),
    fromBlock: fromBlock.toString(), toBlock: safeHead.toString(),
    blocks: Number(safeHead - fromBlock + 1n), sampleSeconds,
    ...summarize(logs, sampleSeconds, options), telemetry,
    scope: describeScope(addresses, input.catalogTotal, options, addressBatches.length),
    rpc: client.getMetrics?.()?.[PROVIDER_NAME] || {},
    warning: 'Storage growth is an upper bound from touched pairs, not net new positive balances.',
  };
}

function printReport(report, logger = console) {
  logger.log(`[RobinhoodHolderTransferProbe] provider=${report.provider} scope=${report.scope.kind} blocks=${report.fromBlock}-${report.toBlock} seconds=${report.sampleSeconds} events=${report.events} malformed=${report.malformed}`);
  if (report.scope.kind === 'catalog') logger.log(`  selectedTokens=${report.scope.selectedTokens}/${report.scope.catalogTotal} catalogCoveragePct=${report.scope.coveragePct} addressBatches=${report.scope.addressBatches}`);
  logger.log(`  tokens=${report.tokens} wallets=${report.wallets} touchedPairs=${report.tokenWalletPairsTouched} mints=${report.mints} burns=${report.burns}`);
  logger.log(`  projectedEventsPerDay=${report.projected.eventsPerDay} ledgerUpperBytesPerDay=${report.projected.ledgerGrowthUpperBoundBytesPerDay} tailBytesPerDay=${report.projected.liveTailBytesPerDay}`);
  logger.log(`  rpcRequests=${report.telemetry.requests} splits=${report.telemetry.splits} largestRange=${report.telemetry.largestSuccessfulRange} deploymentMintCoveragePct=${report.deploymentEvidence.coveragePct}`);
  logger.log(`  warning="${report.warning}"`);
}

async function main() {
  const catalogMode = process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_SCOPE === 'catalog';
  const database = catalogMode ? require('../models/db') : null;
  try {
    const catalog = catalogMode ? await loadCatalogScope(
      database, process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_CATALOG_LIMIT
    ) : null;
    const report = await runHolderTransferProbe({
      confirmations: process.env.ROBINHOOD_CONFIRMATIONS,
      blockCount: process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_BLOCKS,
      chunkBlocks: process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_CHUNK_BLOCKS,
      timeoutMs: process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_TIMEOUT_MS,
      fromBlock: process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_FROM_BLOCK,
      addressBatchSize: process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_ADDRESS_BATCH_SIZE,
      addresses: catalog?.addresses,
      catalogTotal: catalog?.total,
    });
    printReport(report);
  } finally {
    if (database) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`[RobinhoodHolderTransferProbe] fatal: ${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  decodeTransfer, loadCatalogScope, normalizeOptions, resolveProvider,
  runHolderTransferProbe, summarize,
};

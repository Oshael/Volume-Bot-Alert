require('dotenv').config();

const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { TRANSFER_TOPIC, ZERO_TOPIC } = require('../services/evm-erc20-supply-delta');

const EXPECTED_CHAIN_ID = 4663n;
const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const PROVIDER_NAME = 'holder-transfer-probe';

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
    || env.ROBINHOOD_DRPC_RPC_URL || env.ROBINHOOD_RPC_URL || PUBLIC_RPC_URL).trim();
  const source = env.ROBINHOOD_HOLDER_TRANSFER_PROBE_RPC_URL ? 'probe'
    : env.ROBINHOOD_DRPC_RPC_URL ? 'drpc'
      : env.ROBINHOOD_RPC_URL ? 'robinhood-config' : 'robinhood-public';
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
    fromBlock: input.fromBlock == null || input.fromBlock === ''
      ? null : quantity(input.fromBlock, 'fromBlock'),
  });
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

async function readLogsAdaptive(client, fromBlock, toBlock, telemetry) {
  telemetry.requests += 1;
  try {
    const logs = await client.requestProvider(PROVIDER_NAME, 'eth_getLogs', [{
      fromBlock: blockTag(fromBlock), toBlock: blockTag(toBlock), topics: [TRANSFER_TOPIC],
    }]);
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
    const left = await readLogsAdaptive(client, fromBlock, middle, telemetry);
    const right = await readLogsAdaptive(client, middle + 1n, toBlock, telemetry);
    return [...left, ...right];
  }
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
  const provider = input.provider || resolveProvider(input.env);
  const client = input.client || createEvmJsonRpcClient({
    providers: [provider], timeoutMs: options.timeoutMs, maxRetries: 0, minRequestIntervalMs: 0,
  });
  const chainId = quantity(
    await client.requestProvider(PROVIDER_NAME, 'eth_chainId'), 'eth_chainId'
  );
  if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`unexpected chain ID ${chainId}`);
  const head = quantity(await client.requestProvider(PROVIDER_NAME, 'eth_blockNumber'), 'head block');
  const safeHead = head >= BigInt(options.confirmations) ? head - BigInt(options.confirmations) : 0n;
  const defaultFrom = safeHead >= BigInt(options.blockCount - 1)
    ? safeHead - BigInt(options.blockCount - 1) : 0n;
  const fromBlock = options.fromBlock ?? defaultFrom;
  if (fromBlock > safeHead) throw new Error('fromBlock cannot exceed safe head');
  const [firstBlock, lastBlock] = await Promise.all([
    client.requestProvider(PROVIDER_NAME, 'eth_getBlockByNumber', [blockTag(fromBlock), false]),
    client.requestProvider(PROVIDER_NAME, 'eth_getBlockByNumber', [blockTag(safeHead), false]),
  ]);
  const sampleSeconds = Number(quantity(lastBlock?.timestamp, 'last timestamp')
    - quantity(firstBlock?.timestamp, 'first timestamp'));
  const telemetry = { requests: 0, splits: 0, largestSuccessfulRange: 0, errors: {} };
  const logs = [];
  for (let start = fromBlock; start <= safeHead; start += BigInt(options.chunkBlocks)) {
    const end = start + BigInt(options.chunkBlocks - 1) > safeHead
      ? safeHead : start + BigInt(options.chunkBlocks - 1);
    logs.push(...await readLogsAdaptive(client, start, end, telemetry));
  }
  return {
    readOnly: true, provider: provider.source, chainId: chainId.toString(),
    fromBlock: fromBlock.toString(), toBlock: safeHead.toString(),
    blocks: Number(safeHead - fromBlock + 1n), sampleSeconds,
    ...summarize(logs, sampleSeconds, options), telemetry,
    rpc: client.getMetrics?.()?.[PROVIDER_NAME] || {},
    warning: 'Storage growth is an upper bound from touched pairs, not net new positive balances.',
  };
}

function printReport(report, logger = console) {
  logger.log(`[RobinhoodHolderTransferProbe] blocks=${report.fromBlock}-${report.toBlock} seconds=${report.sampleSeconds} events=${report.events} malformed=${report.malformed}`);
  logger.log(`  tokens=${report.tokens} wallets=${report.wallets} touchedPairs=${report.tokenWalletPairsTouched} mints=${report.mints} burns=${report.burns}`);
  logger.log(`  projectedEventsPerDay=${report.projected.eventsPerDay} ledgerUpperBytesPerDay=${report.projected.ledgerGrowthUpperBoundBytesPerDay} tailBytesPerDay=${report.projected.liveTailBytesPerDay}`);
  logger.log(`  rpcRequests=${report.telemetry.requests} splits=${report.telemetry.splits} largestRange=${report.telemetry.largestSuccessfulRange} deploymentMintCoveragePct=${report.deploymentEvidence.coveragePct}`);
  logger.log(`  warning="${report.warning}"`);
}

async function main() {
  const report = await runHolderTransferProbe({
    confirmations: process.env.ROBINHOOD_CONFIRMATIONS,
    blockCount: process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_BLOCKS,
    chunkBlocks: process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_CHUNK_BLOCKS,
    timeoutMs: process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_TIMEOUT_MS,
    fromBlock: process.env.ROBINHOOD_HOLDER_TRANSFER_PROBE_FROM_BLOCK,
  });
  printReport(report);
}

if (require.main === module) main().catch((error) => {
  console.error(`[RobinhoodHolderTransferProbe] fatal: ${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  decodeTransfer, normalizeOptions, resolveProvider, runHolderTransferProbe, summarize,
};

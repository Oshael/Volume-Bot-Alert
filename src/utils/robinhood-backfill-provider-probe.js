require('dotenv').config();

const { createHash } = require('node:crypto');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { DISCOVERY_FILTER, MARKET_FILTER, rangeBounds } = require('./robinhood-public-backfill-probe');

const EXPECTED_CHAIN_ID = 4663n;
const DEFAULT_PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const DEFAULT_RANGE_SIZES = Object.freeze([1000, 5000, 10000]);
const DEFAULT_IN_FLIGHT = Object.freeze([1, 2, 4]);
const PROVIDER_SPECS = Object.freeze([
  { name: 'robinhood-public', env: 'ROBINHOOD_RPC_URL', fallback: DEFAULT_PUBLIC_RPC_URL },
  { name: 'drpc', env: 'ROBINHOOD_DRPC_RPC_URL' },
  { name: 'alchemy-free', env: 'ROBINHOOD_ALCHEMY_RPC_URL' },
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function parseIntegerList(value, fallback, maximum, label) {
  const source = String(value ?? '').trim();
  if (!source) return [...fallback];
  const values = [...new Set(source.split(',').map((item) => {
    const parsed = Number.parseInt(item.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
  }).filter(Boolean))];
  if (!values.length) throw new Error(`${label} has no valid values`);
  return values;
}

function parseQuantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error(`${label} must be a decimal or hex quantity`);
  }
  return BigInt(raw);
}

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function configuredProviders(env = process.env) {
  return PROVIDER_SPECS.map((spec) => ({
    name: spec.name,
    url: String(env[spec.env] || spec.fallback || '').trim(),
  })).filter(({ url }) => url);
}

function createProbeClient(providers, options = {}) {
  return createEvmJsonRpcClient({
    providers,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxRetries: 0,
    minRequestIntervalMs: 0,
  });
}

function compactError(error) {
  return {
    code: error?.code || error?.name || 'error',
    httpStatus: error?.httpStatus ?? null,
    rpcCode: error?.rpcCode ?? null,
    message: String(error?.message || error).slice(0, 200),
  };
}

async function measure(operation) {
  const startedAt = Date.now();
  try {
    const value = await operation();
    return { ok: true, elapsedMs: Date.now() - startedAt, value };
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - startedAt, error: compactError(error) };
  }
}

function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((percentage / 100) * sorted.length) - 1];
}

function logFingerprint(logs) {
  const identities = logs.map((log) => [
    String(log?.transactionHash || '').toLowerCase(),
    String(log?.logIndex || '').toLowerCase(),
    String(log?.blockHash || '').toLowerCase(),
  ].join(':')).sort();
  return createHash('sha256').update(identities.join('|')).digest('hex');
}

function metricDelta(before = {}, after = {}) {
  const fields = ['requests', 'successes', 'errors', 'requestBytes', 'responseBytes'];
  return Object.fromEntries(fields.map((field) => [
    field, (after[field] || 0) - (before[field] || 0),
  ]));
}

async function probeLogScenario(client, provider, definition, safeHead, options) {
  const before = client.getMetrics()?.[provider]?.eth_getLogs;
  const results = [];
  const startedAt = Date.now();
  for (let sample = 0; sample < options.samples; sample += 1) {
    const offset = sample * options.inFlight;
    const tasks = Array.from({ length: options.inFlight }, async (_, lane) => {
      const bounds = rangeBounds(definition.cursor, options.rangeSize, offset + lane, safeHead);
      if (!bounds) return null;
      const filter = {
        ...definition.filter,
        fromBlock: toQuantity(bounds.fromBlock),
        toBlock: toQuantity(bounds.toBlock),
      };
      const result = await measure(() => client.requestProvider(provider, 'eth_getLogs', [filter]));
      const logs = result.ok && Array.isArray(result.value) ? result.value : [];
      return {
        fromBlock: bounds.fromBlock.toString(),
        toBlock: bounds.toBlock.toString(),
        blocks: Number(bounds.toBlock - bounds.fromBlock + 1n),
        ok: result.ok,
        elapsedMs: result.elapsedMs,
        logs: result.ok ? logs.length : null,
        fingerprint: result.ok ? logFingerprint(logs) : null,
        error: result.error || null,
      };
    });
    results.push(...(await Promise.all(tasks)).filter(Boolean));
  }
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  const successful = results.filter(({ ok }) => ok);
  const blocks = successful.reduce((total, result) => total + result.blocks, 0);
  const after = client.getMetrics()?.[provider]?.eth_getLogs;
  return {
    key: `${definition.name}:${options.rangeSize}:${options.inFlight}`,
    stream: definition.name,
    rangeSize: options.rangeSize,
    inFlight: options.inFlight,
    samples: results.length,
    complete: results.length > 0 && successful.length === results.length,
    elapsedMs,
    blocksPerMinute: Math.round((blocks * 60_000) / elapsedMs),
    logs: successful.reduce((total, result) => total + result.logs, 0),
    latencyMs: {
      p50: percentile(results.map(({ elapsedMs: latency }) => latency), 50),
      p95: percentile(results.map(({ elapsedMs: latency }) => latency), 95),
    },
    traffic: metricDelta(before, after),
    ranges: results,
  };
}

async function inspectProvider(client, provider, definitions, safeHead, options) {
  const chainId = parseQuantity(
    await client.requestProvider(provider, 'eth_chainId'), `${provider}.eth_chainId`
  );
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`${provider} returned chain ID ${chainId}; expected ${EXPECTED_CHAIN_ID}`);
  }
  const timestampBlocks = Array.from({ length: 10 }, (_, index) => safeHead - BigInt(index))
    .filter((block) => block >= 0n);
  const timestamps = await measure(() => client.requestBatchProvider(provider, timestampBlocks.map(
    (block) => ({ method: 'eth_getBlockByNumber', params: [toQuantity(block), false] })
  )));
  const scenarios = [];
  for (const definition of definitions) {
    for (const rangeSize of options.rangeSizes) {
      for (const inFlight of options.inFlight) {
        scenarios.push(await probeLogScenario(
          client, provider, definition, safeHead,
          { rangeSize, inFlight, samples: options.samples }
        ));
      }
    }
  }
  return {
    provider,
    chainId: chainId.toString(),
    timestamps: {
      ok: timestamps.ok,
      elapsedMs: timestamps.elapsedMs,
      count: timestamps.ok && Array.isArray(timestamps.value) ? timestamps.value.length : 0,
      error: timestamps.error || null,
    },
    scenarios,
    rpc: client.getMetrics()?.[provider] || {},
    complete: timestamps.ok && scenarios.every(({ complete }) => complete),
  };
}

function findDivergences(providers) {
  const comparisons = new Map();
  for (const provider of providers) {
    for (const scenario of provider.scenarios) {
      for (const range of scenario.ranges.filter(({ ok }) => ok)) {
        const key = `${scenario.stream}:${range.fromBlock}:${range.toBlock}`;
        const previous = comparisons.get(key);
        if (!previous) comparisons.set(key, { provider: provider.provider, range });
        else if (previous.range.fingerprint !== range.fingerprint) {
          comparisons.set(key, { ...previous, divergentWith: provider.provider });
        }
      }
    }
  }
  return [...comparisons.entries()].filter(([, value]) => value.divergentWith).map(
    ([range, value]) => ({ range, provider: value.provider, divergentWith: value.divergentWith })
  );
}

async function runBackfillProviderProbe(options = {}) {
  const providers = options.providers || configuredProviders(options.env);
  if (!providers.some(({ name }) => name === 'drpc')) {
    throw new Error('ROBINHOOD_DRPC_RPC_URL is required for the comparative probe');
  }
  const client = options.client || createProbeClient(providers, options);
  const heads = await Promise.all(providers.map(async ({ name }) => {
    const result = await measure(() => client.requestProvider(name, 'eth_blockNumber'));
    return {
      name,
      ok: result.ok,
      head: result.ok ? parseQuantity(result.value, `${name}.eth_blockNumber`) : null,
      error: result.error || null,
    };
  }));
  const availableHeads = heads.filter(({ ok }) => ok);
  if (!availableHeads.length) throw new Error('No provider returned eth_blockNumber');
  const confirmations = BigInt(options.confirmations);
  const lowestHead = availableHeads.reduce(
    (minimum, { head }) => head < minimum ? head : minimum, availableHeads[0].head
  );
  const safeHead = lowestHead >= confirmations ? lowestHead - confirmations : 0n;
  const coverage = BigInt(Math.max(...options.rangeSizes)
    * Math.max(...options.inFlight) * options.samples);
  const defaultStart = safeHead >= coverage ? safeHead - coverage + 1n : 0n;
  const startBlock = options.startBlock == null
    ? defaultStart
    : parseQuantity(options.startBlock, 'startBlock');
  if (startBlock > safeHead) throw new Error('Probe start block cannot exceed the safe head');
  const definitions = [
    { name: 'discovery', cursor: startBlock, filter: DISCOVERY_FILTER },
    { name: 'market', cursor: startBlock, filter: MARKET_FILTER },
  ];
  const reports = [];
  for (const { name } of providers) {
    const head = heads.find((entry) => entry.name === name);
    reports.push(head.ok
      ? await inspectProvider(client, name, definitions, safeHead, options)
      : {
        provider: name,
        chainId: null,
        timestamps: { ok: false, elapsedMs: null, count: 0, error: head.error },
        scenarios: [],
        rpc: client.getMetrics()?.[name] || {},
        complete: false,
      });
  }
  const divergences = findDivergences(reports);
  return {
    safeHead: safeHead.toString(),
    heads: Object.fromEntries(heads.map(
      ({ name, head }) => [name, head == null ? null : head.toString()]
    )),
    rangeSizes: options.rangeSizes,
    inFlight: options.inFlight,
    samples: options.samples,
    startBlock: startBlock.toString(),
    costUnits: { available: false, reason: 'JSON-RPC responses do not expose billed CUs' },
    providers: reports,
    divergences,
    complete: reports.every(({ complete }) => complete) && divergences.length === 0,
  };
}

function printReport(report, logger = console) {
  logger.log(`[RobinhoodBackfillProviderProbe] safeHead=${report.safeHead} complete=${report.complete} divergences=${report.divergences.length}`);
  for (const provider of report.providers) {
    logger.log(`  provider=${provider.provider} complete=${provider.complete} timestampsOk=${provider.timestamps.ok} timestampsMs=${provider.timestamps.elapsedMs}`);
    for (const scenario of provider.scenarios) {
      const errorCodes = [...new Set(scenario.ranges.map(({ error }) => error?.code).filter(Boolean))];
      logger.log(`    ${scenario.key} complete=${scenario.complete} blocksPerMinute=${scenario.blocksPerMinute} logs=${scenario.logs} p50=${scenario.latencyMs.p50} p95=${scenario.latencyMs.p95} responseBytes=${scenario.traffic.responseBytes} errors=${scenario.traffic.errors} errorCodes=${errorCodes.join(',') || 'none'}`);
    }
  }
  for (const divergence of report.divergences) {
    logger.error(`  divergence range=${divergence.range} providers=${divergence.provider},${divergence.divergentWith}`);
  }
  logger.log(`  costUnits=unavailable reason="${report.costUnits.reason}"`);
}

async function main() {
  const report = await runBackfillProviderProbe({
    timeoutMs: boundedInteger(process.env.ROBINHOOD_BACKFILL_PROBE_TIMEOUT_MS, 15_000, 1000, 60_000),
    confirmations: boundedInteger(process.env.ROBINHOOD_CONFIRMATIONS, 2, 0, 1000),
    rangeSizes: parseIntegerList(
      process.env.ROBINHOOD_BACKFILL_PROBE_RANGE_SIZES,
      DEFAULT_RANGE_SIZES, 10_000, 'ROBINHOOD_BACKFILL_PROBE_RANGE_SIZES'
    ),
    inFlight: parseIntegerList(
      process.env.ROBINHOOD_BACKFILL_PROBE_IN_FLIGHT,
      DEFAULT_IN_FLIGHT, 8, 'ROBINHOOD_BACKFILL_PROBE_IN_FLIGHT'
    ),
    samples: boundedInteger(process.env.ROBINHOOD_BACKFILL_PROBE_SAMPLES, 1, 1, 5),
    startBlock: process.env.ROBINHOOD_BACKFILL_PROBE_START_BLOCK || null,
  });
  printReport(report);
  if (!report.complete) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[RobinhoodBackfillProviderProbe] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  configuredProviders,
  findDivergences,
  logFingerprint,
  parseIntegerList,
  probeLogScenario,
  runBackfillProviderProbe,
};

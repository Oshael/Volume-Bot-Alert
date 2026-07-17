require('dotenv').config();

const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const EXPECTED_CHAIN_ID = 4663n;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_LOG_BLOCK_RANGE = 250;

const CONTRACTS = Object.freeze([
  { key: 'weth', address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' },
  { key: 'usdg', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' },
  { key: 'uniswap-v2-factory', address: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f', logs: true },
  { key: 'uniswap-v3-factory', address: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', logs: true },
  { key: 'uniswap-v4-pool-manager', address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', logs: true },
  { key: 'noxa-launch-factory', address: '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb', logs: true },
  { key: 'noxa-multicall3', address: '0xca11bde05977b3631167028862be2a173976ca11' },
]);

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function normalizeHttpUrl(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const url = new URL(normalized);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} must be an HTTP(S) URL`);
  }
  return url.toString();
}

function maskEndpoint(value) {
  try {
    const url = new URL(String(value || ''));
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length > 0) parts[parts.length - 1] = '***';
    url.pathname = parts.length ? `/${parts.join('/')}` : '/';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return '(invalid endpoint)';
  }
}

function parseQuantity(value, label) {
  const raw = String(value || '');
  if (!/^0x[0-9a-f]+$/i.test(raw)) {
    throw new Error(`${label} returned an invalid hex quantity`);
  }
  return BigInt(raw);
}

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function buildLogRange(headBlock, blockRange) {
  const safeHead = BigInt(headBlock);
  const width = BigInt(Math.max(1, Number(blockRange) || 1));
  const fromBlock = safeHead >= width - 1n ? safeHead - width + 1n : 0n;
  return { fromBlock: toQuantity(fromBlock), toBlock: toQuantity(safeHead) };
}

function parseBlockSelector(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^0x[0-9a-f]+$/i.test(raw)) return BigInt(raw);
  if (/^\d+$/.test(raw)) return BigInt(raw);
  throw new Error('ROBINHOOD_PROBE_LOG_BLOCK must be a decimal or hex block number');
}

function resolveLogRange(headBlock, options = {}) {
  const selectedBlock = parseBlockSelector(options.logBlock);
  if (selectedBlock == null) {
    return buildLogRange(headBlock, options.logBlockRange || DEFAULT_LOG_BLOCK_RANGE);
  }
  if (selectedBlock > BigInt(headBlock)) {
    throw new Error('ROBINHOOD_PROBE_LOG_BLOCK cannot be above the current head');
  }
  const quantity = toQuantity(selectedBlock);
  return { fromBlock: quantity, toBlock: quantity };
}

function attachMetrics(error, metrics) {
  const safeError = error instanceof Error ? error : new Error(String(error));
  safeError.probeMetrics = metrics;
  return safeError;
}

async function rpcRequest(rpcUrl, method, params = [], options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = parsePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60000);
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: options.id || 1,
    method,
    params,
  });
  const startedAt = Date.now();
  let response;

  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: payload,
    });
  } catch (error) {
    const errorKind = error instanceof Error && error.name ? error.name : 'Error';
    throw attachMetrics(new Error(`${method} transport failed (${errorKind})`), {
      method,
      elapsedMs: Date.now() - startedAt,
      requestBytes: Buffer.byteLength(payload),
      responseBytes: 0,
      httpStatus: null,
    });
  }

  const rawBody = await response.text();
  const metrics = {
    method,
    elapsedMs: Date.now() - startedAt,
    requestBytes: Buffer.byteLength(payload),
    responseBytes: Buffer.byteLength(rawBody),
    httpStatus: response.status,
  };

  if (!response.ok) {
    throw attachMetrics(new Error(`${method} failed with HTTP ${response.status}`), metrics);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (_) {
    throw attachMetrics(new Error(`${method} returned invalid JSON`), metrics);
  }
  if (body?.error) {
    throw attachMetrics(new Error(`${method} RPC error ${body.error.code}: ${body.error.message}`), metrics);
  }
  return { result: body?.result ?? null, metrics };
}

function emptyTotals() {
  return { requests: 0, requestBytes: 0, responseBytes: 0, elapsedMs: 0, errors: 0 };
}

function addMetrics(totals, metrics, failed = false) {
  totals.requests += 1;
  totals.requestBytes += Number(metrics?.requestBytes) || 0;
  totals.responseBytes += Number(metrics?.responseBytes) || 0;
  totals.elapsedMs += Number(metrics?.elapsedMs) || 0;
  if (failed) totals.errors += 1;
}

async function runProviderProbe(provider, options = {}) {
  const totals = emptyTotals();
  const errors = [];
  let requestId = 0;
  const request = async (method, params = []) => {
    try {
      const output = await rpcRequest(provider.url, method, params, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        id: ++requestId,
      });
      addMetrics(totals, output.metrics);
      return output.result;
    } catch (error) {
      addMetrics(totals, error.probeMetrics || { method }, true);
      throw error;
    }
  };

  const report = {
    label: provider.label,
    endpoint: maskEndpoint(provider.url),
    ok: false,
    complete: false,
    chainId: null,
    headBlock: null,
    blockTimestamp: null,
    contracts: [],
    logs: [],
    errors,
    totals,
  };

  try {
    const chainId = parseQuantity(await request('eth_chainId'), 'eth_chainId');
    report.chainId = Number(chainId);
    if (chainId !== EXPECTED_CHAIN_ID) {
      throw new Error(`Unexpected chain ID ${chainId}; expected ${EXPECTED_CHAIN_ID}`);
    }

    const headBlock = parseQuantity(await request('eth_blockNumber'), 'eth_blockNumber');
    report.headBlock = headBlock.toString();
    const block = await request('eth_getBlockByNumber', [toQuantity(headBlock), false]);
    report.blockTimestamp = parseQuantity(block?.timestamp, 'eth_getBlockByNumber.timestamp').toString();

    for (const contract of CONTRACTS) {
      try {
        const code = String(await request('eth_getCode', [contract.address, 'latest']) || '0x');
        report.contracts.push({ key: contract.key, address: contract.address, codeBytes: Math.max(0, (code.length - 2) / 2) });
      } catch (error) {
        errors.push({ check: `code:${contract.key}`, message: error.message });
      }
    }

    const range = resolveLogRange(headBlock, options);
    for (const contract of CONTRACTS.filter((item) => item.logs)) {
      try {
        const logs = await request('eth_getLogs', [{ address: contract.address, ...range }]);
        const safeLogs = Array.isArray(logs) ? logs : [];
        const topic0s = [...new Set(safeLogs.map((log) => log?.topics?.[0]).filter(Boolean))].slice(0, 8);
        report.logs.push({
          key: contract.key,
          ...range,
          count: safeLogs.length,
          firstBlock: safeLogs[0]?.blockNumber || null,
          topic0s,
        });
      } catch (error) {
        errors.push({ check: `logs:${contract.key}`, message: error.message });
      }
    }

    report.ok = true;
    report.complete = errors.length === 0;
  } catch (error) {
    errors.push({ check: 'provider', message: error.message });
  }

  return report;
}

function getProviders(env = process.env) {
  const providers = [{ label: 'robinhood-public', url: normalizeHttpUrl(env.ROBINHOOD_RPC_URL || PUBLIC_RPC_URL, 'ROBINHOOD_RPC_URL') }];
  const alchemyUrl = normalizeHttpUrl(env.ROBINHOOD_ALCHEMY_RPC_URL, 'ROBINHOOD_ALCHEMY_RPC_URL');
  if (alchemyUrl) providers.push({ label: 'alchemy-free', url: alchemyUrl });
  return providers;
}

async function runProbe(options = {}) {
  const providers = options.providers || getProviders(options.env);
  const reports = [];
  for (const provider of providers) {
    reports.push(await runProviderProbe(provider, options));
  }
  return reports;
}

function printReports(reports, logger = console) {
  for (const report of reports) {
    logger.log(`[RobinhoodProbe] provider=${report.label} endpoint=${report.endpoint} ok=${report.ok} complete=${report.complete}`);
    logger.log(`  chainId=${report.chainId ?? 'unknown'} head=${report.headBlock ?? 'unknown'} timestamp=${report.blockTimestamp ?? 'unknown'}`);
    for (const contract of report.contracts) logger.log(`  code ${contract.key} bytes=${contract.codeBytes}`);
    for (const logs of report.logs) logger.log(`  logs ${logs.key} range=${logs.fromBlock}-${logs.toBlock} count=${logs.count} topics=${logs.topic0s.join(',') || 'none'}`);
    logger.log(`  traffic requests=${report.totals.requests} errors=${report.totals.errors} requestBytes=${report.totals.requestBytes} responseBytes=${report.totals.responseBytes} elapsedMs=${report.totals.elapsedMs}`);
    for (const error of report.errors) logger.error(`  error ${error.check}: ${error.message}`);
  }
}

async function main() {
  const reports = await runProbe({
    timeoutMs: parsePositiveInteger(process.env.ROBINHOOD_PROBE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 60000),
    logBlockRange: parsePositiveInteger(process.env.ROBINHOOD_PROBE_LOG_BLOCK_RANGE, DEFAULT_LOG_BLOCK_RANGE, 10000),
    logBlock: process.env.ROBINHOOD_PROBE_LOG_BLOCK,
  });
  printReports(reports);
  if (!reports.some((report) => report.ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[RobinhoodProbe] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTRACTS,
  EXPECTED_CHAIN_ID,
  buildLogRange,
  getProviders,
  maskEndpoint,
  parseBlockSelector,
  parseQuantity,
  printReports,
  resolveLogRange,
  rpcRequest,
  runProbe,
  runProviderProbe,
};

'use strict';

require('dotenv').config();
const {
  EXPECTED_CHAIN_ID, maskEndpoint, parseQuantity, rpcRequest,
} = require('./robinhood-rpc-probe');
const {
  __private: { readReceiptBlock },
} = require('../services/robinhood-chain-capture-worker');

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
function nonNegativeInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function resolveEndpoint(env = process.env) {
  const key = String(env.ROBINHOOD_CHAIN_CAPTURE_LIVE_RPC_URL || '').trim()
    ? 'ROBINHOOD_CHAIN_CAPTURE_LIVE_RPC_URL' : 'ROBINHOOD_RPC_URL';
  const raw = String(env[key] || '').trim();
  if (!raw) throw new Error('ROBINHOOD_CHAIN_CAPTURE_LIVE_RPC_URL or ROBINHOOD_RPC_URL is required');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${key} must be HTTP(S)`);
  return { key, url: url.toString() };
}

function sampleBlocks(head, confirmations, historyDepth) {
  const recent = head > BigInt(confirmations) ? head - BigInt(confirmations) : 0n;
  const historical = head > BigInt(historyDepth) ? head - BigInt(historyDepth) : 0n;
  return [...new Set([recent.toString(), historical.toString()])].map(BigInt);
}

async function runProbe(options = {}) {
  const endpoint = options.endpoint || resolveEndpoint(options.env);
  const timeoutMs = positiveInteger(options.timeoutMs, 10_000, 60_000);
  const confirmations = nonNegativeInteger(options.confirmations, 2, 1000);
  const historyDepth = positiveInteger(options.historyDepth, 64, 10_000);
  let requestId = 0; let requests = 0;
  const request = async (method, params = []) => {
    requests += 1;
    return (await rpcRequest(endpoint.url, method, params, {
      fetchImpl: options.fetchImpl, timeoutMs, id: ++requestId,
    })).result;
  };
  const report = {
    approved: false, endpointSource: endpoint.key, endpoint: maskEndpoint(endpoint.url),
    chainId: null, headBlock: null, confirmations, historyDepth,
    samples: [], blockers: [], requests: 0,
  };
  try {
    const chainId = parseQuantity(await request('eth_chainId'), 'eth_chainId');
    report.chainId = chainId.toString();
    if (chainId !== EXPECTED_CHAIN_ID) {
      report.blockers.push({
        code: 'chain_id_mismatch', actual: chainId.toString(), expected: EXPECTED_CHAIN_ID.toString(),
      });
      return report;
    }
    const head = parseQuantity(await request('eth_blockNumber'), 'eth_blockNumber');
    report.headBlock = head.toString();
    for (const blockNumber of sampleBlocks(head, confirmations, historyDepth)) {
      try {
        const capture = await readReceiptBlock({ request }, blockNumber);
        report.samples.push({
          blockNumber: blockNumber.toString(), blockHash: capture.block.hash,
          transactions: capture.transactions.length, domainEvents: capture.events.length,
        });
      } catch (error) {
        report.blockers.push({
          code: 'receipt_capture_unsupported', blockNumber: blockNumber.toString(),
          detail: error.code || error.message,
        });
      }
    }
    report.approved = report.blockers.length === 0;
    return report;
  } catch (error) {
    report.blockers.push({ code: 'rpc_unavailable', detail: error.code || error.message });
    return report;
  } finally {
    report.requests = requests;
  }
}

async function main() {
  const report = await runProbe({
    timeoutMs: process.env.ROBINHOOD_CHAIN_CAPTURE_LIVE_PROBE_TIMEOUT_MS,
    confirmations: process.env.ROBINHOOD_CHAIN_CAPTURE_CONFIRMATIONS,
    historyDepth: process.env.ROBINHOOD_CHAIN_CAPTURE_LIVE_PROBE_HISTORY_DEPTH,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.approved) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  console.error(`Robinhood chain capture live RPC probe failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { nonNegativeInteger, positiveInteger, resolveEndpoint, runProbe, sampleBlocks };

require('dotenv').config();

const fixture = require('../../data/fixtures/robinhood-uniswap-v4.json');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createErc20MetadataReader } = require('../services/evm-erc20-metadata');
const { buildMarketObservation } = require('../services/evm-market-metrics');
const { buildLiquidityAssessment, classifyTokenEligibility } = require('../services/robinhood-market-policy');
const { createRobinhoodWethUsdQuoteReader } = require('../services/robinhood-weth-usd-quote');
const { createUniswapV4Tracker } = require('../services/uniswap-v4-decoder');

const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

function createDefaultClient(env = process.env) {
  const providers = [{ name: 'robinhood-public', url: env.ROBINHOOD_RPC_URL || PUBLIC_RPC_URL }];
  if (env.ROBINHOOD_ALCHEMY_RPC_URL) {
    providers.push({ name: 'alchemy-free', url: env.ROBINHOOD_ALCHEMY_RPC_URL });
  }
  return createEvmJsonRpcClient({ providers, timeoutMs: 15000, maxRetries: 0 });
}

async function runDryRun(options = {}) {
  const rpcClient = options.rpcClient || createDefaultClient(options.env);
  const metadataReader = createErc20MetadataReader({ rpcClient });
  const quoteReader = createRobinhoodWethUsdQuoteReader({ rpcClient });
  const tracker = createUniswapV4Tracker();
  tracker.processLog(fixture.initialize);
  const swap = tracker.processLog(fixture.swap);
  const [tokenMetadata, quoteMetadata, wethUsd] = await Promise.all([
    metadataReader.getMetadata(swap.tokenAddress),
    metadataReader.getMetadata(swap.quoteAddress),
    quoteReader.getSnapshot(),
  ]);
  const eligibility = classifyTokenEligibility(swap.tokenAddress);
  const observation = buildMarketObservation({ swap, tokenMetadata, quoteMetadata, eligibility });
  const liquidity = buildLiquidityAssessment({ protocol: swap.protocol, liquidityRaw: swap.liquidityRaw });
  return {
    mode: 'live-read-only',
    fixture: fixture.source,
    tokenMetadata,
    quoteMetadata,
    wethUsd,
    eligibility,
    observation,
    liquidity,
    rpcMetrics: rpcClient.getMetrics(),
    summary: {
      metadataUsable: tokenMetadata.usable && quoteMetadata.usable,
      eligibilityAccepted: eligibility.eligible,
      observationAccepted: observation.accepted,
      wethUsdObserved: wethUsd.status === 'observed',
      liquidityStatus: liquidity.status,
    },
  };
}

if (require.main === module) {
  runDryRun().then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => {
    console.error(`[RobinhoodMarketMetricsDryRun] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createDefaultClient, runDryRun };

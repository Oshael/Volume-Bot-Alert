const config = require('../../config');
const db = require('../models/db');
const {
  createRobinhoodPoolLiquidityEventCursorRepository,
} = require('../models/robinhood-pool-liquidity-event-cursor');
const {
  createRobinhoodPoolLiquiditySeedRepository,
} = require('../models/robinhood-pool-liquidity-seed');
const {
  createRobinhoodRpcClient, validateRobinhoodProviderChainIds,
} = require('../services/robinhood-ingestion-worker');
const {
  runRobinhoodPoolLiquiditySeed,
} = require('../services/robinhood-pool-liquidity-seed');

function parseArgs(argv = process.argv.slice(2)) {
  const unknown = argv.filter((value) => value !== '--write');
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  return Object.freeze({ write: argv.includes('--write') });
}

async function main(deps = {}) {
  const options = deps.options || parseArgs(deps.argv);
  const database = deps.database || db;
  const repository = deps.repository
    || createRobinhoodPoolLiquiditySeedRepository({ database });
  const cursorRepository = deps.cursorRepository
    || createRobinhoodPoolLiquidityEventCursorRepository({ database });
  let rpcClient = deps.rpcClient;
  if (options.write && !rpcClient) {
    rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)(
      deps.rpcOptions || config.robinhoodIngestionWorker
    );
    await (deps.validateChainIds || validateRobinhoodProviderChainIds)(rpcClient);
  }
  const result = await runRobinhoodPoolLiquiditySeed({
    repository, cursorRepository, rpcClient,
  }, { write: options.write, concurrency: config.robinhoodPoolLiquidityWorker.concurrency });
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('[RobinhoodPoolLiquiditySeed] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end());

module.exports = { main, parseArgs };

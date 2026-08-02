require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodV4LiquidityReplayRepository,
} = require('../models/robinhood-v4-liquidity-replay');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  createRobinhoodV4LiquidityReplay,
} = require('../services/robinhood-v4-liquidity-replay');

async function main(env = process.env) {
  const rpcUrl = String(env.ROBINHOOD_V4_REPLAY_RPC_URL || 'http://127.0.0.1:8547').trim();
  const rpcClient = createEvmJsonRpcClient({
    providers: [{ name: 'robinhood-local', url: rpcUrl }],
    timeoutMs: 60_000,
    maxRetries: 1,
  });
  const replay = createRobinhoodV4LiquidityReplay({
    rpcClient,
    repository: createRobinhoodV4LiquidityReplayRepository(),
  });
  const result = await replay.run({
    rangeSize: Number(env.ROBINHOOD_V4_REPLAY_RANGE_SIZE || 1000),
    confirmations: Number(env.ROBINHOOD_V4_REPLAY_CONFIRMATIONS || 2),
    maxRanges: Number(env.ROBINHOOD_V4_REPLAY_MAX_RANGES || 100_000),
    onProgress: ({ ranges, persisted, state }) => {
      if (ranges % 100 === 0 || state.status === 'completed') {
        console.log(`[RobinhoodV4Replay] ranges=${ranges} deltas=${persisted} next=${state.nextBlock} status=${state.status}`);
      }
    },
  });
  console.log(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[RobinhoodV4Replay] ${error.message}`);
    process.exitCode = 1;
  }).finally(() => db.pool.end());
}

module.exports = { main };

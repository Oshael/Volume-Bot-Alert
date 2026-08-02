const db = require('../models/db');
const {
  createRobinhoodV4LiquidityMaterialization,
} = require('../models/robinhood-v4-liquidity-materialization');

async function main() {
  const result = await createRobinhoodV4LiquidityMaterialization().materialize();
  console.log(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[RobinhoodV4Materialization] ${error.message}`);
    process.exitCode = 1;
  }).finally(() => db.pool.end());
}

module.exports = { main };

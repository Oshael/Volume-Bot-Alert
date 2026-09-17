'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodHolderShadowParity,
} = require('../services/robinhood-holder-shadow-parity');

async function main(deps = {}) {
  const audit = deps.audit || createRobinhoodHolderShadowParity({ database: deps.database || db });
  const result = await audit.inspect();
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().then((result) => {
  if (!result.ready) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood holder shadow parity audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main };

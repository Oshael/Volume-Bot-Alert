'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodHolderRollbackPreflight,
} = require('../services/robinhood-holder-rollback-preflight');

async function main(deps = {}) {
  const audit = deps.audit || createRobinhoodHolderRollbackPreflight({
    database: deps.database || db,
  });
  const result = await audit.inspect();
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().then((result) => {
  if (!result.readyForReconstruction) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood holder rollback preflight failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main };

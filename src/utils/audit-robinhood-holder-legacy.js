'use strict';

require('dotenv').config();
const db = require('../models/db');
const { createRobinhoodHolderLegacyAudit } = require('../services/robinhood-holder-legacy-audit');

async function main(deps = {}) {
  const audit = deps.audit || createRobinhoodHolderLegacyAudit({ database: deps.database || db });
  const result = await audit.inspect();
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood holder legacy audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main };

'use strict';

require('dotenv').config();
const { run } = require('../services/robinhood-chain-transaction-partition-retention');

async function main(args = process.argv.slice(2), deps = {}) {
  if (args.some((arg) => arg !== '--apply') || args.length > 1) {
    throw new Error('only --apply is supported');
  }
  const report = await run({ apply: args.includes('--apply') }, deps);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood transaction partition retention failed:', error.message);
  process.exitCode = 1;
});

module.exports = { main };

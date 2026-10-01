'use strict';
const { auditBatchSelection } = require('../models/robinhood-wallet-transfer-selection-audit');
function parseArgs(argv) {
  const keys = { 'from-block': 'fromBlock', 'to-block': 'toBlock', 'maximum-rows': 'maximumRows' };
  const input = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(\d+)$/.exec(arg);
    if (!match || !keys[match[1]] || Object.hasOwn(input, keys[match[1]])) throw new Error('invalid audit argument');
    input[keys[match[1]]] = match[2];
  }
  return input;
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const report = await auditBatchSelection(deps.database || require('../models/db'), parseArgs(argv));
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  if (!report.parity) throw new Error('batch selection parity failed');
  return report;
}
if (require.main === module) {
  require('dotenv').config();
  main().catch((error) => {
    console.error('Transfer selection audit failed:', error.message);
    process.exitCode = 1;
  }).finally(() => require('../models/db').pool.end());
}
module.exports = { main, parseArgs };

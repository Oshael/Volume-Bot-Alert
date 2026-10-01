'use strict';

const { readFile } = require('node:fs/promises');
const { auditScopeHistory } = require('../models/robinhood-wallet-transfer-scope-history-audit');

function parseArgs(argv) {
  const flags = { 'projection-version': 'projectionVersion', stream: 'stream', 'max-ranges': 'maxRanges',
    'max-tokens': 'maxTokens', 'budget-ms': 'budgetMs', resume: 'resumePath' };
  const options = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || !flags[match[1]]) throw new Error('unknown or empty audit argument');
    const key = flags[match[1]];
    if (Object.hasOwn(options, key)) throw new Error(`repeated argument: ${match[1]}`);
    options[key] = match[2];
  }
  return options;
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.resumePath) options.resume = JSON.parse(await readFile(options.resumePath, 'utf8')).resume;
  if (options.resumePath && !options.resume) throw new Error('report has no resume cursor');
  const report = await auditScopeHistory(deps.database || require('../models/db'), options);
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}
if (require.main === module) {
  require('dotenv').config();
  main().catch((error) => {
    console.error('Transfer scope history audit failed:', error.message);
    process.exitCode = 1;
  }).finally(() => require('../models/db').pool.end());
}
module.exports = { main, parseArgs };

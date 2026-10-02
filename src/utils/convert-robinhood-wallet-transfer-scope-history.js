'use strict';
const { convertScopeHistory } = require('../models/robinhood-wallet-transfer-scope-converter');
function parseArgs(argv) {
  const flags = { 'projection-version': 'projectionVersion', stream: 'stream', 'max-ranges': 'maxRanges',
    'max-tokens': 'maxTokens', 'budget-ms': 'budgetMs', 'after-id': 'afterId', 'through-id': 'highWaterId' };
  const options = {};
  for (const arg of argv) {
    if (arg === '--commit' && !Object.hasOwn(options, 'commit')) { options.commit = true; continue; }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || !flags[match[1]]) throw new Error('unknown or empty conversion argument');
    const key = flags[match[1]];
    if (Object.hasOwn(options, key)) throw new Error(`repeated argument: ${match[1]}`);
    options[key] = match[2];
  }
  return options;
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv); const logger = deps.logger || console;
  try {
    const report = await convertScopeHistory(deps.database || require('../models/db'), options,
      (progress) => logger.log(JSON.stringify({ event: 'progress', ...progress })));
    logger.log(JSON.stringify({ event: 'complete', ...report }));
    return report;
  } catch (error) {
    if (error.conversionReport) logger.log(JSON.stringify({ event: 'failed', ...error.conversionReport }));
    throw error;
  }
}
if (require.main === module) {
  require('dotenv').config();
  main().catch((error) => {
    console.error('Transfer scope staging failed:', error.message); process.exitCode = 1;
  }).finally(() => require('../models/db').pool.end());
}
module.exports = { main, parseArgs };

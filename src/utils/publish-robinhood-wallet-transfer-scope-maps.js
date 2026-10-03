'use strict';
const fs = require('node:fs');
const { publishScopeMaps } = require('../models/robinhood-wallet-transfer-scope-publisher');
function parseArgs(argv) {
  const flags = { checkpoint: 'checkpoint', 'max-maps': 'maxMaps', 'budget-ms': 'budgetMs', 'after-hash': 'afterHash' };
  const options = {};
  for (const arg of argv) {
    if (arg === '--commit' && !Object.hasOwn(options, 'commit')) { options.commit = true; continue; }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || !flags[match[1]] || Object.hasOwn(options, flags[match[1]])) throw new Error('invalid publication argument');
    options[flags[match[1]]] = match[2];
  }
  if (!options.checkpoint) throw new Error('--checkpoint is required');
  return options;
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv), logger = deps.logger || console;
  if (fs.statSync(options.checkpoint).size > 4 * 1024 * 1024) throw new Error('oversized audit checkpoint');
  options.audit = JSON.parse(fs.readFileSync(options.checkpoint, 'utf8'));
  try {
    const report = await publishScopeMaps(deps.database || require('../models/db'), options,
      progress => logger.log(JSON.stringify({ event: 'progress', ...progress })));
    logger.log(JSON.stringify({ event: 'complete', ...report })); return report;
  } catch (error) {
    if (error.publicationReport) logger.log(JSON.stringify({ event: 'failed', ...error.publicationReport }));
    throw error;
  }
}
if (require.main === module) {
  require('dotenv').config();
  main().catch(error => { console.error('Scope map publication failed:', error.message); process.exitCode = 1; })
    .finally(() => require('../models/db').pool.end());
}
module.exports = { main, parseArgs };

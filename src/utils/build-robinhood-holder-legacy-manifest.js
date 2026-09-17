'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodHolderLegacyManifestBuilder,
} = require('../services/robinhood-holder-legacy-manifest-builder');

function parseArgs(argv = []) {
  const values = {};
  for (const argument of argv) {
    const match = String(argument).match(/^--(apply|restart|limit)(?:=(.*))?$/);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    values[match[1]] = match[2] ?? 'true';
  }
  for (const flag of ['apply', 'restart']) {
    if (values[flag] != null && values[flag] !== 'true') throw new Error(`--${flag} does not accept a value`);
  }
  const limit = Number(values.limit ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('--limit must be between 1 and 1000');
  }
  return Object.freeze({ apply: values.apply === 'true', restart: values.restart === 'true', limit });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const builder = deps.builder || createRobinhoodHolderLegacyManifestBuilder({
    database: deps.database || db,
  });
  try {
    const result = await builder.batch(options);
    (deps.logger || console).log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (!deps.builder && !deps.database) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ mode: 'error', message: error.message }));
  process.exitCode = 1;
});

module.exports = { main, parseArgs };

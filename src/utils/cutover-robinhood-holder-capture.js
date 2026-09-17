'use strict';

require('dotenv').config();
const db = require('../models/db');
const { createRobinhoodHolderCutoverGate } = require('../services/robinhood-holder-cutover-gate');

function parseArgs(argv = process.argv.slice(2)) {
  const options = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--expect-next=')) {
      options.expectedNextBlock = arg.slice('--expect-next='.length);
    } else if (arg.startsWith('--expect-hash=')) {
      options.expectedCheckpointHash = arg.slice('--expect-hash='.length);
    } else if (arg.startsWith('--statement-timeout-ms=')) {
      const value = arg.slice('--statement-timeout-ms='.length);
      if (!/^[0-9]+$/.test(value)) throw new Error('statement timeout must be an integer');
      options.statementTimeoutMs = Number(value);
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (options.apply && (!/^[0-9]+$/.test(options.expectedNextBlock || '')
      || !/^0x[0-9a-f]{64}$/.test(options.expectedCheckpointHash || ''))) {
    throw new Error('--apply requires --expect-next=N and --expect-hash=0x...');
  }
  if (!options.apply && (options.expectedNextBlock || options.expectedCheckpointHash)) {
    throw new Error('expected anchor options require --apply');
  }
  return options;
}

async function main(deps = {}) {
  const options = parseArgs(deps.argv);
  const gate = deps.gate || createRobinhoodHolderCutoverGate({ database: deps.database || db });
  const result = await gate.inspect(options);
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  if (!result.readyForGate) process.exitCode = 2;
  return result;
}

if (require.main === module) main().catch((error) => {
  const phase = error.cutoverPhase ? ` (${error.cutoverPhase})` : '';
  console.error(`Robinhood holder cutover failed${phase}:`, error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };

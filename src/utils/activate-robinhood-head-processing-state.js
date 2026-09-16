'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  activateHeadProcessingState, previewHeadProcessingActivation,
} = require('../models/robinhood-head-processing-activation');

function bounded(value, fallback, max, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${label} must be between 1 and ${max}`);
  }
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = Object.fromEntries(argv.map((argument) => {
    const match = argument.match(/^--([^=]+)(?:=(.+))?$/);
    if (!match || !['write', 'lock-timeout-ms', 'statement-timeout-ms'].includes(match[1])) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (match[1] === 'write' && match[2] != null) {
      throw new Error('--write does not accept a value');
    }
    return [match[1], match[2] ?? true];
  }));
  return {
    write: values.write === true,
    lockTimeoutMs: bounded(values['lock-timeout-ms'], 5000, 30000, 'lock timeout'),
    statementTimeoutMs: bounded(
      values['statement-timeout-ms'], 300000, 900000, 'statement timeout'
    ),
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const result = options.write
    ? await activateHeadProcessingState({ database: db, ...options })
    : await previewHeadProcessingActivation({ database: db });
  console.log(JSON.stringify({ mode: options.write ? 'write' : 'dry-run', ...result }, null, 2));
  if (!options.write && !result.safe) process.exitCode = 2;
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ phase: 'error', message: error.message, report: error.report || null }));
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };

'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  DEFAULT_RETENTION_BLOCKS, createRobinhoodRetentionSafetyAudit,
} = require('../services/robinhood-retention-safety-audit');

const PREFIXES = ['--chain-retention-blocks=', '--holder-retention-blocks='];
const CHAIN_ONLY = '--chain-only';
function value(argv, prefix) {
  const item = argv.find((argument) => argument.startsWith(prefix));
  return item == null ? DEFAULT_RETENTION_BLOCKS : Number(item.slice(prefix.length));
}
function parseArgs(argv = []) {
  const unknown = argv.find((argument) => argument !== CHAIN_ONLY
    && !PREFIXES.some((prefix) => argument.startsWith(prefix)));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  if (argv.filter((argument) => argument === CHAIN_ONLY).length > 1) {
    throw new Error('--chain-only cannot be repeated');
  }
  return Object.freeze({
    chainRetentionBlocks: value(argv, PREFIXES[0]),
    holderRetentionBlocks: value(argv, PREFIXES[1]),
    ...(argv.includes(CHAIN_ONLY) ? { includeHolderProof: false } : {}),
  });
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const audit = deps.audit || (deps.auditFactory || createRobinhoodRetentionSafetyAudit)({
    database: deps.database || db, ...options,
  });
  const report = await audit.inspect();
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}
if (require.main === module) main().then((report) => {
  const ready = process.argv.includes(CHAIN_ONLY)
    ? report.chain_events?.ready_for_pilot : report.ready_for_pilot;
  if (!ready) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood retention safety audit failed:',
    error.auditPhase ? `${error.auditPhase}: ${error.message}` : error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };

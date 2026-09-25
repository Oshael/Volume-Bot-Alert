'use strict';

require('dotenv').config();
const db = require('../models/db');
const { normalizeOptions, runPilot } = require('../services/robinhood-chain-event-pruner');
const FLAGS = new Set(['--write', '--until-drained', '--partition-drop', '--partition-preview']);

function parseArgs(args = []) {
  const values = {};
  const flags = new Set();
  for (const arg of args) {
    if (FLAGS.has(arg)) {
      if (flags.has(arg)) throw new Error(`unknown or repeated argument: ${arg}`);
      flags.add(arg); continue;
    }
    const match = /^--(batch-limit|max-batches|pause-ms|retention-ms)=(.+)$/.exec(arg);
    if (!match) throw new Error(`unknown or repeated argument: ${arg}`);
    const key = { 'batch-limit': 'batchLimit', 'max-batches': 'maxBatches',
      'pause-ms': 'pauseMs', 'retention-ms': 'retentionMs' }[match[1]];
    if (values[key] != null) throw new Error(`unknown or repeated argument: ${arg}`);
    values[key] = Number(match[2]);
  }
  const write = flags.has('--write');
  const partitionPreview = flags.has('--partition-preview');
  if (!write && !partitionPreview) throw new Error('--write is required');
  if (partitionPreview && (write || flags.has('--partition-drop'))) {
    throw new Error('--partition-preview cannot be combined with write options');
  }
  if (flags.has('--until-drained') && values.maxBatches != null) {
    throw new Error('--until-drained cannot be combined with --max-batches');
  }
  return normalizeOptions({ ...values, untilDrained: flags.has('--until-drained'),
    partitionDropEnabled: flags.has('--partition-drop'), partitionPreview });
}

async function main(args = process.argv.slice(2), deps = {}) {
  const options = parseArgs(args);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const report = await runPilot(options, {
      database: deps.database || db,
      audit: deps.audit,
      shouldStop: () => stopping,
      progress: (entry) => (deps.logger || console).log(JSON.stringify(entry)),
    });
    (deps.logger || console).log(JSON.stringify({ phase: 'summary', ...report }));
    if (report.stopReason === 'blocked' || report.status === 'blocked') process.exitCode = 2;
    return report;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (!deps.database) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({
    status: 'error', code: error.code || 'chain_event_prune_error', message: error.message,
  }));
  process.exitCode = 1;
});

module.exports = { main, parseArgs };

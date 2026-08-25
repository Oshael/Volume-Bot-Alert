require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodDirectionalTransferReplayRepository,
} = require('../models/robinhood-directional-transfer-replay');

const CONFIRM_FLAG = '--confirm-reconcile-robinhood-directional-deployment-gaps';

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const values = {};
  for (const argument of argv) {
    if (argument === CONFIRM_FLAG) {
      if (values.confirm) throw new Error(`${CONFIRM_FLAG} cannot be repeated`);
      values.confirm = true;
      continue;
    }
    const match = argument.match(/^--(run-id|batch-size|max-batches)=(.+)$/);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    if (values[match[1]] !== undefined) throw new Error(`--${match[1]} cannot be repeated`);
    values[match[1]] = match[2];
  }
  if (!values['run-id']) throw new Error('--run-id is required');
  if (!/^\d+$/.test(values['run-id'])) throw new Error('--run-id must be a non-negative integer');
  return Object.freeze({
    confirm: values.confirm === true, runId: values['run-id'],
    batchSize: bounded(values['batch-size'], 500, 1, 500, '--batch-size'),
    maxBatches: bounded(values['max-batches'], 100, 1, 100, '--max-batches'),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const repository = deps.repository || createRobinhoodDirectionalTransferReplayRepository({
    database: deps.database || db,
  });
  const before = await repository.planDeploymentGapReconciliation(options.runId);
  if (!options.confirm) {
    const report = { mode: 'read-only', runId: options.runId, plan: before };
    (deps.logger || console).log(JSON.stringify(report, null, 2));
    return report;
  }
  const batches = [];
  for (let index = 0; index < options.maxBatches; index += 1) {
    const result = await repository.reconcileDeploymentGaps({
      runId: options.runId, limit: options.batchSize,
    });
    batches.push(result);
    if (result.resolved === 0 || result.selected < options.batchSize) break;
  }
  const report = {
    mode: 'apply', runId: options.runId, before, batches,
    after: await repository.planDeploymentGapReconciliation(options.runId),
  };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood directional deployment gap reconciliation failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, main, parseArgs };

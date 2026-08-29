'use strict';

const config = require('../../config');
const db = require('../models/db');
const { createWorkerHealthMonitor } = require('../services/worker-health-monitor');
const { assertRuntimeSchema } = require('./runtime-schema');

async function main(deps = {}) {
  const options = deps.options || config.workerHealthMonitor;
  if (!options.enabled) throw new Error('WORKER_HEALTH_MONITOR_ENABLED must be true');
  if (!options.runsHere) {
    throw new Error('BACKGROUND_WORKER_GROUPS must be worker-health');
  }
  await (deps.assertSchema || assertRuntimeSchema)({ profile: 'runtime' });
  const monitor = (deps.createMonitor || createWorkerHealthMonitor)(options);
  const schedule = deps.setInterval || setInterval;
  const cancel = deps.clearInterval || clearInterval;
  const close = deps.close || (() => db.pool.end());
  const logger = deps.logger || console;
  const runtimeProcess = deps.process || process;
  const keepAlive = schedule(() => {}, 60_000);
  let stopping = false;

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    cancel(keepAlive);
    await monitor.stop();
    await close();
  }

  monitor.start();
  logger.log(
    `[WorkerHealthProcess] Started; expected=${options.expectedComponents?.length || 0}`
  );
  runtimeProcess.once('SIGINT', () => { void shutdown(); });
  runtimeProcess.once('SIGTERM', () => { void shutdown(); });
  return Object.freeze({ monitor, shutdown });
}

if (require.main === module) main().catch((error) => {
  console.error('[WorkerHealthProcess] Fatal:', error.message);
  process.exitCode = 1;
  void db.pool.end();
});

module.exports = { main };

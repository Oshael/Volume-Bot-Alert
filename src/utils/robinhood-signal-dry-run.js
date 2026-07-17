const config = require('../../config');
const db = require('../models/db');
const { createRobinhoodSignalDryRunReporter } = require(
  '../services/robinhood-signal-dry-run'
);

async function run(options = {}) {
  const signalConfig = options.config || config.robinhoodSignalDryRun;
  const reporter = (options.reporterFactory || createRobinhoodSignalDryRunReporter)({
    config: signalConfig,
    candidateLimit: signalConfig.candidateLimit,
    sampleLimit: signalConfig.sampleLimit,
    statementTimeoutMs: signalConfig.statementTimeoutMs,
  });
  const report = await reporter.runOnce(options.asOf ? { asOf: options.asOf } : {});
  (options.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`[RobinhoodSignalDryRun] ${error.message}`);
    process.exitCode = 1;
  }).finally(async () => {
    try { await db.pool.end(); } catch (_) {}
  });
}

module.exports = { run };

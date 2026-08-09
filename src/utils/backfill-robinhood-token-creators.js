/** Resolve token creators through Blockscout. Dry-run unless confirmation is explicit. */
const db = require('../models/db');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const { createRobinhoodBlockscoutMetadataClient } = require('../services/robinhood-blockscout-metadata');

const CONFIRM = '--confirm-backfill-robinhood-token-creators';

function parseArgs(argv = process.argv.slice(2)) {
  const read = (name, fallback) => {
    const index = argv.indexOf(name);
    return index < 0 ? fallback : argv[index + 1];
  };
  const limit = Number(read('--limit', 100));
  const sleepMs = Number(read('--sleep-ms', 100));
  const retryHours = Number(read('--retry-hours', 24));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be 1..1000');
  if (!Number.isSafeInteger(sleepMs) || sleepMs < 0 || sleepMs > 60000) throw new Error('--sleep-ms must be 0..60000');
  if (!Number.isFinite(retryHours) || retryHours < 0) throw new Error('--retry-hours must be >= 0');
  return { apply: argv.includes(CONFIRM), limit, sleepMs, retryHours };
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function run(deps = {}) {
  const options = deps.options || parseArgs();
  const repository = deps.repository || createRobinhoodTokenAttributionRepository();
  const retryBefore = new Date(Date.now() - options.retryHours * 3600000);
  const candidates = await repository.listCreatorCandidates({ limit: options.limit, retryBefore });
  const summary = { apply: options.apply, candidates: candidates.length, resolved: 0, unresolved: 0, failed: 0 };
  if (!options.apply) return summary;
  const client = deps.client || createRobinhoodBlockscoutMetadataClient();
  for (const candidate of candidates) {
    let creatorAddress;
    try {
      creatorAddress = await client.getContractCreator(candidate.tokenAddress);
    } catch (error) {
      await repository.recordAttempt({ ...candidate, error: error.message });
      summary.failed += 1;
      if (options.sleepMs) await (deps.delay || delay)(options.sleepMs);
      continue;
    }
    await repository.recordAttempt({ ...candidate, creatorAddress });
    if (creatorAddress) summary.resolved += 1;
    else summary.unresolved += 1;
    if (options.sleepMs) await (deps.delay || delay)(options.sleepMs);
  }
  return summary;
}

async function main() {
  try { console.log(JSON.stringify(await run(), null, 2)); }
  catch (error) { console.error('creator backfill failed:', error.message); process.exitCode = 1; }
  finally { await db.pool.end().catch(() => {}); }
}

if (require.main === module) void main();

module.exports = { CONFIRM, parseArgs, run };

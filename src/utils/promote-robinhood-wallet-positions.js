require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletPositionTokenRepairRepository,
} = require('../models/robinhood-wallet-position-token-repair');

const CONFIRM_FLAG = '--confirm-promote-robinhood-wallet-positions';

function parseArgs(argv = []) {
  const prefix = '--max-tokens=';
  const unknown = argv.filter((arg) => arg !== CONFIRM_FLAG && !arg.startsWith(prefix));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const matches = argv.filter((arg) => arg.startsWith(prefix));
  if (matches.length > 1) throw new Error('--max-tokens cannot be repeated');
  const maxTokens = matches.length ? Number(matches[0].slice(prefix.length)) : 500;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 500) {
    throw new Error('--max-tokens must be between 1 and 500');
  }
  return Object.freeze({ confirm: argv.includes(CONFIRM_FLAG), maxTokens });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const repository = (deps.repositoryFactory
    || createRobinhoodWalletPositionTokenRepairRepository)({ database: deps.database || db });
  const before = await repository.promotionPlan();
  if (!args.confirm) {
    const report = Object.freeze({ mode: 'read-only', plan: before });
    (deps.logger || console).log(JSON.stringify(report, null, 2));
    return report;
  }
  const prepared = await repository.preparePromotion();
  if (prepared.extended > 0) {
    const report = Object.freeze({
      mode: 'prepare', status: 'shadow-catchup-required', prepared,
      plan: await repository.promotionPlan(),
    });
    (deps.logger || console).log(JSON.stringify(report, null, 2));
    return report;
  }
  let tokens = 0;
  let removed = 0;
  let promoted = 0;
  for (; tokens < args.maxTokens; tokens += 1) {
    const result = await repository.promoteNext({ frontier: prepared.frontier });
    if (!result) break;
    removed += result.removed;
    promoted += result.promoted;
    if ((tokens + 1) % 25 === 0) {
      (deps.logger || console).log(JSON.stringify({
        progress: { tokens: tokens + 1, removed, promoted },
      }));
    }
  }
  const plan = await repository.promotionPlan();
  const report = Object.freeze({
    mode: 'promote',
    status: plan.published === plan.candidates ? 'completed' : 'partial',
    frontier: prepared.frontier, tokens, removed, promoted, plan,
  });
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood token-scoped position promotion failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, main, parseArgs };

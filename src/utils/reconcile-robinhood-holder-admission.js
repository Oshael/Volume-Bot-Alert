'use strict';
const config = require('../../config');
const db = require('../models/db');
const { createRobinhoodHolderAdmissionQueue } = require('../models/robinhood-holder-admission-queue');
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')));
  const admittedAfter = config.robinhoodHolderBackfillWorker.admittedAfter;
  if (!admittedAfter) throw new Error('ROBINHOOD_HOLDER_BACKFILL_ADMITTED_AFTER is required');
  let cursor = args.after || '';
  const queue = createRobinhoodHolderAdmissionQueue();
  const pages = Number(args.pages || 1);
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 100) throw new Error('pages must be 1..100');
  for (let page = 0; page < pages; page += 1) {
    const result = await queue.reconcile({ after: cursor, admittedAfter, limit: 500 });
    console.log(JSON.stringify(result));
    if (result.cursor === null) break;
    cursor = result.cursor;
  }
}
if (require.main === module) main().catch((error) => {
  console.error(error.message); process.exitCode = 1;
}).finally(() => db.pool.end());

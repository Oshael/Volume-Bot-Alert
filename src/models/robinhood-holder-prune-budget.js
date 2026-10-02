'use strict';

const BATCH_BUDGET_MS = 8000;
const STATEMENT_BUDGET_MS = 2000;

// The caller owns BEGIN, rollback and release. Limits expire with the transaction.
async function createAutomaticPruneBudget(client, now = Date.now) {
  const deadline = now() + BATCH_BUDGET_MS;
  await client.query("SET LOCAL statement_timeout = '2s'");
  await client.query("SET LOCAL lock_timeout = '250ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
  await client.query("SET LOCAL work_mem = '4MB'");
  return {
    async query(sql, params) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw Object.assign(new Error('automatic holder prune batch time budget exhausted'), {
          code: 'holder_journal_prune_budget',
        });
      }
      await client.query("SELECT set_config('statement_timeout', $1, true)",
        [`${Math.min(STATEMENT_BUDGET_MS, remaining)}ms`]);
      return client.query(sql, params);
    },
  };
}

module.exports = { createAutomaticPruneBudget };

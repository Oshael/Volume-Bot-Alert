const db = require('./db');

const STATEMENT_TIMEOUT_MS = 5000;

function createRobinhoodWalletRankingReadSnapshot(options = {}) {
  const database = options.database || db;
  return {
    async run(read) {
      const client = await database.getClient();
      try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
        const scopedDatabase = {
          queryWithStatementTimeout(sql, params, timeoutMs) {
            if (!Number.isInteger(timeoutMs) || timeoutMs < 1
              || timeoutMs > STATEMENT_TIMEOUT_MS) {
              throw new Error('ranking snapshot query timeout is invalid');
            }
            return client.query(sql, params);
          },
        };
        const result = await read(scopedDatabase);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

module.exports = { createRobinhoodWalletRankingReadSnapshot };

const config = require('../../config');

function looksLikeTestDatabaseName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'test'
    || normalized.includes('_test')
    || normalized.includes('-test')
    || normalized.startsWith('test_')
    || normalized.startsWith('test-')
    || normalized.includes('testing');
}

async function assertUsingTestDatabase(db) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('Test DB safety check requires a db/pool query interface.');
  }

  const { rows } = await db.query('SELECT current_database() AS database');
  const actualDatabase = rows[0]?.database || config.db.database || '';
  const env = String(process.env.NODE_ENV || '').trim();

  if (env !== 'test' || config.nodeEnv !== 'test' || !looksLikeTestDatabaseName(actualDatabase)) {
    throw new Error(
      `Refusing destructive test cleanup outside test DB. NODE_ENV=${env || '(empty)'}, config.nodeEnv=${config.nodeEnv}, database=${actualDatabase || '(empty)'}`
    );
  }
}

module.exports = { assertUsingTestDatabase };

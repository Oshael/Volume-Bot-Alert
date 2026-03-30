const { pool } = require('../models/db');
const { assertRuntimeSchema } = require('./runtime-schema');

async function main() {
  const profile = process.argv.includes('--test-profile') ? 'test' : 'runtime';
  try {
    await assertRuntimeSchema({ profile });
    console.log(`Runtime DB schema check passed for profile "${profile}".`);
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

void main();

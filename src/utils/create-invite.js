/**
 * Bootstrap invite creator.
 * Creates an invite code for the first user registration.
 * Run with: npm run invite:create
 *
 * Since there are no users yet, this inserts directly into the DB
 * with created_by = NULL (special bootstrap case).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === 'true' || value === '1';
}

const poolConfig = {};

if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  poolConfig.connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
} else {
  poolConfig.host = process.env.DB_HOST;
  poolConfig.port = parseInt(process.env.DB_PORT, 10) || 5432;
  poolConfig.database = process.env.DB_NAME;
  poolConfig.user = process.env.DB_USER;
  poolConfig.password = process.env.DB_PASSWORD;
}

if (parseBoolean(process.env.DB_SSL, false) || process.env.PGSSLMODE === 'require') {
  poolConfig.ssl = {
    rejectUnauthorized: parseBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED, false),
  };
}

const pool = new Pool(poolConfig);

async function createBootstrapInvite() {
  const code = uuidv4().replace(/-/g, '').slice(0, 16).toUpperCase();
  const expiryHours = 24;

  try {
    // Allow NULL created_by for bootstrap.
    await pool.query(
      `INSERT INTO invites (code, created_by, max_uses, expires_at)
       VALUES ($1, NULL, 1, NOW() + INTERVAL '${expiryHours} hours')`,
      [code]
    );

    console.log('');
    console.log('Bootstrap invite created!');
    console.log('');
    console.log(`Code: ${code}`);
    console.log(`Expires in: ${expiryHours} hours`);
    console.log('Max uses: 1');
    console.log('');
    console.log('Use this code to register the first user, then promote to admin:');
    console.log("UPDATE users SET role = 'admin' WHERE username = 'your_username';");
    console.log('');
  } catch (err) {
    console.error('Failed to create invite:', err.message);

    if (err.code === '23502' || err.code === '23503') {
      console.log('');
      console.log('Invites table requires created_by. Adjusting bootstrap constraint...');

      try {
        await pool.query('ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL');
        await pool.query(
          `INSERT INTO invites (code, created_by, max_uses, expires_at)
           VALUES ($1, NULL, 1, NOW() + INTERVAL '${expiryHours} hours')`,
          [code]
        );

        console.log('');
        console.log('Bootstrap invite created!');
        console.log(`Code: ${code}`);
        console.log(`Expires in: ${expiryHours} hours`);
        console.log('');
      } catch (err2) {
        console.error('Still failed:', err2.message);
      }
    }
  } finally {
    await pool.end();
  }
}

createBootstrapInvite();

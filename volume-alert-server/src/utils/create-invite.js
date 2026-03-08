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

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function createBootstrapInvite() {
  const code = uuidv4().replace(/-/g, '').slice(0, 16).toUpperCase();
  const expiryHours = 24;

  try {
    // Allow NULL created_by for bootstrap — alter constraint temporarily
    await pool.query(`
      INSERT INTO invites (code, created_by, max_uses, expires_at)
      VALUES ($1, NULL, 1, NOW() + INTERVAL '${expiryHours} hours')
    `, [code]);

    console.log('');
    console.log('✅ Bootstrap invite created!');
    console.log('');
    console.log(`   Code: ${code}`);
    console.log(`   Expires in: ${expiryHours} hours`);
    console.log(`   Max uses: 1`);
    console.log('');
    console.log('   Use this code to register the first user, then promote to admin:');
    console.log("   UPDATE users SET role = 'admin' WHERE username = 'your_username';");
    console.log('');
  } catch (err) {
    console.error('❌ Failed to create invite:', err.message);

    // If foreign key constraint fails, we need to handle bootstrap differently
    if (err.code === '23502' || err.code === '23503') {
      console.log('');
      console.log('The invites table requires created_by. Adjusting for bootstrap...');

      try {
        // Make created_by nullable for bootstrap
        await pool.query('ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL');
        await pool.query(`
          INSERT INTO invites (code, created_by, max_uses, expires_at)
          VALUES ($1, NULL, 1, NOW() + INTERVAL '${expiryHours} hours')
        `, [code]);

        console.log('');
        console.log('✅ Bootstrap invite created!');
        console.log(`   Code: ${code}`);
        console.log(`   Expires in: ${expiryHours} hours`);
        console.log('');
      } catch (err2) {
        console.error('❌ Still failed:', err2.message);
      }
    }
  } finally {
    await pool.end();
  }
}

createBootstrapInvite();

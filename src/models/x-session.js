'use strict';

// Read/lifecycle for scraping sessions (Bloco 3). The pool (later slice) asks
// for the sessions it may currently use; a 401/403 quarantines one. Secrets
// (auth_token, ct0) live in the row by design so scaling is inserting rows.

const db = require('../models/db');

// Sessions the pool may use right now: enabled and not currently quarantined.
async function listActive({ now = Date.now } = {}) {
  const nowIso = new Date(now()).toISOString();
  const { rows } = await db.query(
    `SELECT id, label, auth_token, ct0, proxy_url, last_used_at
       FROM x_session
      WHERE enabled = TRUE
        AND (quarantined_until IS NULL OR quarantined_until < $1)
      ORDER BY last_used_at ASC NULLS FIRST, id ASC`,
    [nowIso],
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    authToken: row.auth_token,
    ct0: row.ct0,
    proxyUrl: row.proxy_url,
    lastUsedAt: row.last_used_at,
  }));
}

async function markUsed(id, { now = Date.now } = {}) {
  await db.query('UPDATE x_session SET last_used_at = $2 WHERE id = $1', [id, new Date(now()).toISOString()]);
}

async function quarantine(id, untilMs) {
  await db.query('UPDATE x_session SET quarantined_until = $2 WHERE id = $1', [id, new Date(untilMs).toISOString()]);
}

// ct0 self-heal: X rotates ct0 and returns the new one via Set-Cookie; the pool
// persists it so the session stays valid without manual intervention.
async function updateCt0(id, ct0) {
  await db.query('UPDATE x_session SET ct0 = $2 WHERE id = $1', [id, ct0]);
}

// Re-seed (Bloco 3, slice 3.5): the only way a fresh auth_token enters the
// system, since it can't be self-healed once the account is flagged. Keyed by
// label so re-seeding an existing account overwrites its cookies, re-enables it,
// and clears any quarantine. Select-for-update + insert-or-update keeps it
// idempotent without a unique constraint on label.
async function upsertSession({ label, authToken, ct0, proxyUrl = null }) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM x_session WHERE label = $1 FOR UPDATE', [label]);
    let id;
    let created;
    if (existing.rows.length) {
      id = existing.rows[0].id;
      created = false;
      await client.query(
        `UPDATE x_session
            SET auth_token = $2, ct0 = $3, proxy_url = $4,
                enabled = TRUE, quarantined_until = NULL
          WHERE id = $1`,
        [id, authToken, ct0, proxyUrl],
      );
    } else {
      const inserted = await client.query(
        `INSERT INTO x_session (label, auth_token, ct0, proxy_url)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [label, authToken, ct0, proxyUrl],
      );
      id = inserted.rows[0].id;
      created = true;
    }
    await client.query('COMMIT');
    return { id, created };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { listActive, markUsed, quarantine, updateCt0, upsertSession };

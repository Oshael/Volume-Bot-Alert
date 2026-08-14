'use strict';

// Read/lifecycle for scraping sessions (Bloco 3). The pool asks for the sessions
// it may currently use; a 401/403 disables one until operator re-seed. Secrets
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

// An authentication failure means the auth_token is no longer trustworthy.
// Keep the row for operator re-seed, but never retry it on a timer.
async function disable(id) {
  await db.query(
    'UPDATE x_session SET enabled = FALSE, quarantined_until = NULL WHERE id = $1',
    [id],
  );
}

// ct0 self-heal: X rotates ct0 and returns the new one via Set-Cookie; the pool
// persists it so the session stays valid without manual intervention.
async function updateCt0(id, ct0) {
  await db.query('UPDATE x_session SET ct0 = $2 WHERE id = $1', [id, ct0]);
}

// Re-seed (Bloco 3, slice 3.5): the only way a fresh auth_token enters the
// system, since it can't be self-healed once the account is flagged. Keyed by
// label so re-seeding an existing account overwrites its cookies, re-enables it,
// and clears any quarantine. Stage 125 makes label unique, so ON CONFLICT keeps
// concurrent first-time seeds idempotent too.
async function upsertSession({ label, authToken, ct0, proxyUrl = null }) {
  const { rows } = await db.query(
    `INSERT INTO x_session (label, auth_token, ct0, proxy_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (label) DO UPDATE SET
       auth_token = EXCLUDED.auth_token,
       ct0 = EXCLUDED.ct0,
       proxy_url = EXCLUDED.proxy_url,
       enabled = TRUE,
       quarantined_until = NULL
     RETURNING id, (xmax = 0) AS created`,
    [label, authToken, ct0, proxyUrl],
  );
  return { id: rows[0].id, created: rows[0].created === true };
}

module.exports = { listActive, markUsed, quarantine, disable, updateCt0, upsertSession };

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

module.exports = { listActive, markUsed, quarantine };

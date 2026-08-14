'use strict';

// Read/cursor for the lists we poll (Bloco 3). The ingestion worker asks for the
// lists it should poll this cycle and advances each list's cursor/last-polled
// marker afterwards. The cursor is stored for observability and future gap-fill;
// the worker polls the head each cycle rather than walking it.

const db = require('../models/db');

async function listActive() {
  const { rows } = await db.query(
    `SELECT id, list_id, query_id, label, last_cursor, last_polled_at
       FROM x_list
      WHERE enabled = TRUE
      ORDER BY id ASC`,
  );
  return rows.map((row) => ({
    id: row.id,
    listId: row.list_id,
    queryId: row.query_id,
    label: row.label,
    lastCursor: row.last_cursor,
    lastPolledAt: row.last_polled_at,
  }));
}

// COALESCE keeps a prior cursor when a poll yields none, so a quiet cycle never
// erases the marker.
async function updateCursor(id, { cursor = null, now = Date.now } = {}) {
  await db.query(
    'UPDATE x_list SET last_cursor = COALESCE($2, last_cursor), last_polled_at = $3 WHERE id = $1',
    [id, cursor, new Date(now()).toISOString()],
  );
}

async function updateQueryId(id, queryId) {
  await db.query('UPDATE x_list SET query_id = $2 WHERE id = $1', [id, queryId]);
}

module.exports = { listActive, updateCursor, updateQueryId };

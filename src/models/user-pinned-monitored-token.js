const db = require('./db');
const { isValidAddress } = require('./user-token');

function normalizeAddress(address) {
  return String(address || '').trim();
}

function normalizePinnedItems(items = []) {
  const next = [];
  const seen = new Set();

  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    const address = normalizeAddress(item?.address || item);
    if (!address || seen.has(address) || !isValidAddress(address)) {
      continue;
    }
    seen.add(address);
    const requestedOrder = typeof item === 'object' ? Number(item?.sortOrder) : index;
    next.push({
      address,
      sortOrder: Number.isInteger(requestedOrder) && requestedOrder >= 0
        ? requestedOrder
        : index,
    });
  }

  return next;
}

function mapRow(row) {
  return {
    address: row.address,
    sortOrder: Number(row.sort_order) || 0,
    pinnedAt: row.pinned_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function getAll(userId) {
  const { rows } = await db.query(
    `SELECT address, sort_order, pinned_at, updated_at
     FROM user_pinned_monitored_tokens
     WHERE user_id = $1
     ORDER BY sort_order ASC, updated_at DESC, address ASC`,
    [userId]
  );
  return rows.map(mapRow);
}

async function setAll(userId, items) {
  const pinnedItems = normalizePinnedItems(items);
  const client = await db.getClient();

  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_pinned_monitored_tokens WHERE user_id = $1', [userId]);

    for (const item of pinnedItems) {
      await client.query(
        `INSERT INTO user_pinned_monitored_tokens (user_id, address, sort_order)
         VALUES ($1, $2, $3)`,
        [userId, item.address, item.sortOrder]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getAll(userId);
}

async function remove(userId, address) {
  const normalizedAddress = normalizeAddress(address);
  const { rowCount } = await db.query(
    `DELETE FROM user_pinned_monitored_tokens
     WHERE user_id = $1 AND address = $2`,
    [userId, normalizedAddress]
  );
  return rowCount > 0;
}

async function removeAll(userId) {
  const { rowCount } = await db.query(
    'DELETE FROM user_pinned_monitored_tokens WHERE user_id = $1',
    [userId]
  );
  return rowCount;
}

module.exports = {
  getAll,
  setAll,
  remove,
  removeAll,
  __private: {
    mapRow,
    normalizeAddress,
    normalizePinnedItems,
  },
};

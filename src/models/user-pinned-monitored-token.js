const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

function normalizeAddress(address) {
  return String(address || '').trim();
}

function normalizePinnedItems(items = [], chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const next = [];
  const seen = new Set();

  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    let address;
    try { address = normalizeTokenAddress(chain, item?.address || item); } catch (_) { continue; }
    if (seen.has(address)) continue;
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

function normalizePinnedIdentityItems(items = [], defaultChainValue = 'solana') {
  const defaultChain = normalizeTokenChain(defaultChainValue);
  const next = [];
  const seen = new Set();
  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    let chain;
    let address;
    try {
      chain = normalizeTokenChain(item?.chain || defaultChain);
      address = normalizeTokenAddress(chain, item?.address || item);
    } catch (_) {
      continue;
    }
    const key = `${chain}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const requestedOrder = typeof item === 'object' ? Number(item?.sortOrder) : index;
    next.push({
      chain,
      address,
      sortOrder: Number.isInteger(requestedOrder) && requestedOrder >= 0
        ? requestedOrder : index,
    });
  }
  return next;
}

function mapRow(row) {
  return {
    chain: row.chain,
    address: row.address,
    sortOrder: Number(row.sort_order) || 0,
    pinnedAt: row.pinned_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function getAll(userId, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const { rows } = await db.query(
    `SELECT chain, address, sort_order, pinned_at, updated_at
     FROM user_pinned_monitored_tokens
     WHERE user_id = $1 AND chain = $2
     ORDER BY sort_order ASC, updated_at DESC, address ASC`,
    [userId, chain]
  );
  return rows.map(mapRow);
}

async function getAllForChains(userId, chainValues = ['solana']) {
  const chains = [...new Set((Array.isArray(chainValues) ? chainValues : [chainValues])
    .map((chain) => normalizeTokenChain(chain)))];
  if (!chains.length) return [];
  const { rows } = await db.query(
    `SELECT chain, address, sort_order, pinned_at, updated_at
     FROM user_pinned_monitored_tokens
     WHERE user_id = $1 AND chain = ANY($2::varchar[])
     ORDER BY sort_order ASC, updated_at DESC, chain ASC, address ASC`,
    [userId, chains]
  );
  return rows.map(mapRow);
}

async function setAll(userId, items, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const pinnedItems = normalizePinnedItems(items, chain);
  const client = await db.getClient();

  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_pinned_monitored_tokens WHERE user_id = $1 AND chain = $2', [userId, chain]);

    for (const item of pinnedItems) {
      await client.query(
        `INSERT INTO user_pinned_monitored_tokens (user_id, chain, address, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [userId, chain, item.address, item.sortOrder]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getAll(userId, chain);
}

async function setAllForChains(userId, items, chainValues = ['solana']) {
  const chains = [...new Set((Array.isArray(chainValues) ? chainValues : [chainValues])
    .map((chain) => normalizeTokenChain(chain)))];
  const allowedChains = new Set(chains);
  const pinnedItems = normalizePinnedIdentityItems(items)
    .filter((item) => allowedChains.has(item.chain));
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM user_pinned_monitored_tokens
       WHERE user_id = $1 AND chain = ANY($2::varchar[])`,
      [userId, chains]
    );
    for (const item of pinnedItems) {
      await client.query(
        `INSERT INTO user_pinned_monitored_tokens (user_id, chain, address, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [userId, item.chain, item.address, item.sortOrder]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getAllForChains(userId, chains);
}

async function remove(userId, address, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const normalizedAddress = normalizeTokenAddress(chain, address);
  const { rowCount } = await db.query(
    `DELETE FROM user_pinned_monitored_tokens
     WHERE user_id = $1 AND chain = $2 AND address = $3`,
    [userId, chain, normalizedAddress]
  );
  return rowCount > 0;
}

async function removeAll(userId, chainValue = 'solana') {
  const chain = normalizeTokenChain(chainValue);
  const { rowCount } = await db.query(
    'DELETE FROM user_pinned_monitored_tokens WHERE user_id = $1 AND chain = $2',
    [userId, chain]
  );
  return rowCount;
}

async function removeAllForChains(userId, chainValues = ['solana']) {
  const chains = [...new Set((Array.isArray(chainValues) ? chainValues : [chainValues])
    .map((chain) => normalizeTokenChain(chain)))];
  if (!chains.length) return 0;
  const { rowCount } = await db.query(
    `DELETE FROM user_pinned_monitored_tokens
     WHERE user_id = $1 AND chain = ANY($2::varchar[])`,
    [userId, chains]
  );
  return rowCount;
}

module.exports = {
  getAll,
  getAllForChains,
  setAll,
  setAllForChains,
  remove,
  removeAll,
  removeAllForChains,
  __private: {
    mapRow,
    normalizeAddress,
    normalizePinnedIdentityItems,
    normalizePinnedItems,
  },
};

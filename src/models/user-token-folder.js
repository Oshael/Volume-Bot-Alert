const db = require('./db');
const { isValidAddress } = require('./user-token');

const MAX_FOLDER_NAME_LENGTH = 80;

function modelError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizeId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw modelError(`${label} must be a positive integer`);
  }
  return id;
}

function normalizeFolderName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) {
    throw modelError('Folder name is required');
  }
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw modelError(`Folder name must be ${MAX_FOLDER_NAME_LENGTH} characters or less`);
  }
  return name;
}

function normalizeSortOrder(value) {
  const order = Number(value);
  if (!Number.isFinite(order)) {
    return 0;
  }
  return Math.trunc(order);
}

function normalizeAddress(value) {
  const address = String(value || '').trim();
  if (!isValidAddress(address)) {
    throw modelError('Invalid token address format');
  }
  return address;
}

function mapFolderRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    parentFolderId: null,
    name: row.name,
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function mapItemRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    folderId: row.folder_id,
    address: row.address,
    sortOrder: Number(row.sort_order) || 0,
    addedAt: row.added_at ? new Date(row.added_at).toISOString() : null,
  };
}

async function listForUser(userId, runner = db) {
  const normalizedUserId = normalizeId(userId, 'userId');
  const [folderResult, itemResult] = await Promise.all([
    runner.query(
      `SELECT *
       FROM user_token_folders
       WHERE user_id = $1
         AND parent_folder_id IS NULL
       ORDER BY sort_order ASC, name ASC, id ASC`,
      [normalizedUserId]
    ),
    runner.query(
      `SELECT *
       FROM user_token_folder_items
       WHERE user_id = $1
       ORDER BY folder_id ASC, sort_order ASC, added_at ASC, address ASC`,
      [normalizedUserId]
    ),
  ]);

  return {
    folders: folderResult.rows.map(mapFolderRow),
    items: itemResult.rows.map(mapItemRow),
  };
}

async function folderExists(userId, folderId, runner = db) {
  const normalizedUserId = normalizeId(userId, 'userId');
  const normalizedFolderId = normalizeId(folderId, 'folderId');
  const { rows } = await runner.query(
    `SELECT 1
     FROM user_token_folders
     WHERE user_id = $1
       AND id = $2
       AND parent_folder_id IS NULL
     LIMIT 1`,
    [normalizedUserId, normalizedFolderId]
  );
  return rows.length > 0;
}

async function createFolder(userId, input = {}, runner = db) {
  const normalizedUserId = normalizeId(userId, 'userId');
  if (input.parentFolderId !== null && input.parentFolderId !== undefined && input.parentFolderId !== '') {
    throw modelError('Subfolders are not supported');
  }

  const { rows } = await runner.query(
    `INSERT INTO user_token_folders (user_id, name, sort_order)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [
      normalizedUserId,
      normalizeFolderName(input.name),
      normalizeSortOrder(input.sortOrder),
    ]
  );
  return mapFolderRow(rows[0]);
}

async function updateFolder(userId, folderId, input = {}, runner = db) {
  const normalizedUserId = normalizeId(userId, 'userId');
  const normalizedFolderId = normalizeId(folderId, 'folderId');
  if (input.parentFolderId !== null && input.parentFolderId !== undefined && input.parentFolderId !== '') {
    throw modelError('Subfolders are not supported');
  }

  const hasName = Object.hasOwn(input, 'name');
  const hasSortOrder = Object.hasOwn(input, 'sortOrder');
  if (!hasName && !hasSortOrder) {
    throw modelError('No folder changes provided');
  }

  const { rows } = await runner.query(
    `UPDATE user_token_folders
     SET name = CASE WHEN $3::boolean THEN $4 ELSE name END,
         sort_order = CASE WHEN $5::boolean THEN $6 ELSE sort_order END,
         updated_at = NOW()
     WHERE user_id = $1 AND id = $2
       AND parent_folder_id IS NULL
     RETURNING *`,
    [
      normalizedUserId,
      normalizedFolderId,
      hasName,
      hasName ? normalizeFolderName(input.name) : null,
      hasSortOrder,
      hasSortOrder ? normalizeSortOrder(input.sortOrder) : null,
    ]
  );
  return mapFolderRow(rows[0]);
}

async function addTokenToFolder(userId, folderId, address, input = {}, runner = db) {
  const normalizedUserId = normalizeId(userId, 'userId');
  const normalizedFolderId = normalizeId(folderId, 'folderId');
  const normalizedAddress = normalizeAddress(address);

  const { rows } = await runner.query(
    `INSERT INTO user_token_folder_items (user_id, folder_id, address, sort_order)
     SELECT $1, $2, $3, $4
     FROM user_token_folders folder
     JOIN user_tokens token
       ON token.user_id = folder.user_id
      AND token.address = $3
     WHERE folder.user_id = $1
       AND folder.id = $2
       AND folder.parent_folder_id IS NULL
     ON CONFLICT (user_id, folder_id, address) DO UPDATE SET
       sort_order = EXCLUDED.sort_order
     RETURNING *`,
    [normalizedUserId, normalizedFolderId, normalizedAddress, normalizeSortOrder(input.sortOrder)]
  );
  return mapItemRow(rows[0]);
}

async function deleteFolderAndManualTokens(userId, folderId, options = {}) {
  const normalizedUserId = normalizeId(userId, 'userId');
  const normalizedFolderId = normalizeId(folderId, 'folderId');
  const database = options.database || db;
  const client = await database.getClient();

  try {
    await client.query('BEGIN');

    const folderResult = await client.query(
      `SELECT id
       FROM user_token_folders
       WHERE user_id = $1 AND id = $2
         AND parent_folder_id IS NULL
       LIMIT 1`,
      [normalizedUserId, normalizedFolderId]
    );

    if (folderResult.rows.length === 0) {
      await client.query('COMMIT');
      return { deleted: false, removedAddresses: [] };
    }

    const addressResult = await client.query(
      `SELECT DISTINCT address
       FROM user_token_folder_items
       WHERE user_id = $1
         AND folder_id = $2
       ORDER BY address ASC`,
      [normalizedUserId, normalizedFolderId]
    );
    const addresses = addressResult.rows.map((row) => String(row.address || '').trim()).filter(Boolean);

    let removedAddresses = [];
    if (addresses.length > 0) {
      const deleteTokensResult = await client.query(
        `DELETE FROM user_tokens
         WHERE user_id = $1
           AND address = ANY($2::varchar[])
         RETURNING address`,
        [normalizedUserId, addresses]
      );
      removedAddresses = deleteTokensResult.rows.map((row) => row.address);
    }

    await client.query(
      `DELETE FROM user_token_folders
       WHERE user_id = $1 AND id = $2
         AND parent_folder_id IS NULL`,
      [normalizedUserId, normalizedFolderId]
    );

    await client.query('COMMIT');
    return { deleted: true, removedAddresses };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteFolderTokenAndManualToken(userId, folderId, address, options = {}) {
  const normalizedUserId = normalizeId(userId, 'userId');
  const normalizedFolderId = normalizeId(folderId, 'folderId');
  const normalizedAddress = normalizeAddress(address);
  const database = options.database || db;
  const client = await database.getClient();

  try {
    await client.query('BEGIN');

    const membershipResult = await client.query(
      `SELECT 1
       FROM user_token_folder_items item
       JOIN user_token_folders folder
         ON folder.user_id = item.user_id
        AND folder.id = item.folder_id
        AND folder.parent_folder_id IS NULL
       WHERE item.user_id = $1
         AND item.folder_id = $2
         AND item.address = $3
       LIMIT 1`,
      [normalizedUserId, normalizedFolderId, normalizedAddress]
    );

    if (membershipResult.rows.length === 0) {
      await client.query('COMMIT');
      return { deleted: false, removedAddress: null };
    }

    const deleteResult = await client.query(
      `DELETE FROM user_tokens
       WHERE user_id = $1
         AND address = $2
       RETURNING address`,
      [normalizedUserId, normalizedAddress]
    );

    await client.query('COMMIT');
    return {
      deleted: deleteResult.rowCount > 0,
      removedAddress: deleteResult.rows[0]?.address || null,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  normalizeFolderName,
  listForUser,
  folderExists,
  createFolder,
  updateFolder,
  addTokenToFolder,
  deleteFolderAndManualTokens,
  deleteFolderTokenAndManualToken,
};

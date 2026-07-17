const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userTokenFolder = require('../src/models/user-token-folder');
const stage45 = require('../src/utils/db-init-stage45');

function createRunner(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    },
  };
}

function createTransactionalDatabase(handler) {
  const client = createRunner(handler);
  client.released = false;
  client.release = () => {
    client.released = true;
  };
  return {
    client,
    async getClient() {
      return client;
    },
  };
}

describe('manual token folders model', () => {
  it('declares manual token folder tables in stage 45', () => {
    const joined = stage45.STATEMENTS.join('\n');

    assert.match(joined, /CREATE TABLE IF NOT EXISTS user_token_folders/);
    assert.match(joined, /CREATE TABLE IF NOT EXISTS user_token_folder_items/);
    assert.match(joined, /REFERENCES user_tokens\(user_id, chain, address\)/);
    assert.match(joined, /idx_user_token_folders_parent/);
    assert.match(joined, /idx_user_token_folder_items_address/);
  });

  it('creates a root folder with a normalized name', async () => {
    const runner = createRunner((sql) => {
      if (sql.includes('INSERT INTO user_token_folders')) {
        return {
          rows: [{
            id: 9,
            user_id: 3,
            parent_folder_id: null,
            name: 'Utility Coins',
            sort_order: 2,
            created_at: '2026-06-28T12:00:00.000Z',
            updated_at: '2026-06-28T12:00:00.000Z',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const folder = await userTokenFolder.createFolder(3, {
      name: '  Utility   Coins  ',
      sortOrder: 2,
    }, runner);

    assert.equal(folder.name, 'Utility Coins');
    assert.equal(folder.parentFolderId, null);
    assert.equal(runner.calls[0].params[1], 'Utility Coins');
  });

  it('rejects subfolders', async () => {
    const runner = createRunner(() => {
      throw new Error('insert should not run');
    });

    await assert.rejects(
      () => userTokenFolder.createFolder(3, {
        parentFolderId: 8,
        name: 'Nested',
      }, runner),
      /Subfolders are not supported/
    );
  });

  it('links only existing manual tokens to folders', async () => {
    const runner = createRunner((sql) => {
      assert.match(sql, /JOIN user_tokens token/);
      return {
        rows: [{
          user_id: 3,
          folder_id: 9,
          chain: 'solana',
          address: 'So11111111111111111111111111111111111111112',
          sort_order: 1,
          added_at: '2026-06-28T12:00:00.000Z',
        }],
        rowCount: 1,
      };
    });

    const item = await userTokenFolder.addTokenToFolder(
      3,
      9,
      'So11111111111111111111111111111111111111112',
      { sortOrder: 1 },
      runner
    );

    assert.equal(item.address, 'So11111111111111111111111111111111111111112');
    assert.equal(item.chain, 'solana');
    assert.equal(runner.calls[0].params[0], 3);
    assert.equal(runner.calls[0].params[1], 9);
    assert.deepEqual(runner.calls[0].params.slice(2), [
      'solana',
      'So11111111111111111111111111111111111111112',
      1,
    ]);
  });

  it('deletes a folder transactionally and removes contained user tokens', async () => {
    const database = createTransactionalDatabase((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT id') && sql.includes('FROM user_token_folders') && sql.includes('LIMIT 1')) {
        return { rows: [{ id: 9 }], rowCount: 1 };
      }
      if (sql.includes('SELECT DISTINCT chain, address')) {
        return {
          rows: [
            { chain: 'solana', address: 'So11111111111111111111111111111111111111112' },
            { chain: 'robinhood', address: '0x1111111111111111111111111111111111111111' },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('DELETE FROM user_tokens')) {
        return {
          rows: [
            { chain: 'solana', address: 'So11111111111111111111111111111111111111112' },
            { chain: 'robinhood', address: '0x1111111111111111111111111111111111111111' },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('DELETE FROM user_token_folders')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await userTokenFolder.deleteFolderAndManualTokens(3, 9, { database });

    assert.equal(result.deleted, true);
    assert.deepEqual(result.removedAddresses, [
      'So11111111111111111111111111111111111111112',
      '0x1111111111111111111111111111111111111111',
    ]);
    assert.deepEqual(result.removedIdentities.map((item) => item.chain), ['solana', 'robinhood']);
    assert.equal(database.client.calls[0].sql, 'BEGIN');
    assert.equal(database.client.calls.at(-1).sql.trim(), 'COMMIT');
    assert.equal(database.client.released, true);
    assert.ok(database.client.calls.some((call) => call.sql.includes('DELETE FROM user_tokens')));
  });

  it('removes a folder token destructively only when the folder item exists', async () => {
    const database = createTransactionalDatabase((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM user_token_folder_items')) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM user_tokens')) {
        return {
          rows: [{ chain: 'solana', address: 'So11111111111111111111111111111111111111112' }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await userTokenFolder.deleteFolderTokenAndManualToken(
      3,
      9,
      'So11111111111111111111111111111111111111112',
      { database }
    );

    assert.equal(result.deleted, true);
    assert.equal(result.removedAddress, 'So11111111111111111111111111111111111111112');
    assert.ok(database.client.calls.some((call) => call.sql.includes('FROM user_token_folder_items')));
    assert.ok(database.client.calls.some((call) => call.sql.includes('DELETE FROM user_tokens')));
  });
});

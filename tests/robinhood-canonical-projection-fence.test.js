const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  lockRobinhoodCanonicalProjection,
  __private: { normalizeFrontiers },
} = require('../src/models/robinhood-canonical-projection-fence');

const HASH = `0x${'a'.repeat(64)}`;

function client(state = 'running', matched = 1) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('robinhood_chain_capture_cursor')) {
        return state == null ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ recovery_state: state }] };
      }
      return { rowCount: 1, rows: [{ matched }] };
    },
  };
}

describe('Robinhood canonical projection fence', () => {
  it('deduplicates frontiers and accepts only their retained canonical hashes', async () => {
    assert.deepEqual(normalizeFrontiers([
      { blockNumber: '10', blockHash: HASH },
      { throughBlockNumber: 10, throughBlockHash: HASH },
    ]), [{ block_number: '10', block_hash: HASH }]);
    const database = client();
    await lockRobinhoodCanonicalProjection(database, {
      blockNumber: '10', blockHash: HASH,
    }, 'test projection');
    assert.equal(database.calls.length, 2);
    assert.deepEqual(JSON.parse(database.calls[1].params[0]), [
      { block_number: '10', block_hash: HASH },
    ]);
  });

  it('fails closed during recovery or when the frontier hash is not canonical', async () => {
    await assert.rejects(
      lockRobinhoodCanonicalProjection(client('recovery_required'), null, 'test projection'),
      (error) => error.code === 'canonical_projection_fence_conflict'
    );
    await assert.rejects(
      lockRobinhoodCanonicalProjection(client('running', 0), {
        blockNumber: '10', blockHash: HASH,
      }, 'test projection'),
      (error) => error.code === 'canonical_projection_fence_conflict'
    );
  });
});

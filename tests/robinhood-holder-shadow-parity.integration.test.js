'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const {
  createRobinhoodHolderShadowParity,
} = require('../src/services/robinhood-holder-shadow-parity');

after(() => db.pool.end());

it('executes the bounded sample selection against PostgreSQL in a read-only snapshot', async () => {
  const frontier = {
    capture_checkpoint_block: '1000000000000000',
    holder_checkpoint_block: '1000000000000000',
    next_block: '1000000000000001',
    checkpoint_hash: `0x${'a'.repeat(64)}`,
    raw_floor_block: '1000000000000000',
    journal_floor_block: '1000000000000000',
    missing_tail_states: 0,
  };
  const audit = createRobinhoodHolderShadowParity({
    database: { async getClient() {
      const client = await db.getClient();
      return {
        async query(sql, params) {
          if (sql.includes('AS raw_floor_block')) return { rows: [frontier] };
          return client.query(sql, params);
        },
        release: () => client.release(),
      };
    } },
  });
  const result = await audit.inspect();
  assert.equal(result.ready, false);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.samples, []);
});

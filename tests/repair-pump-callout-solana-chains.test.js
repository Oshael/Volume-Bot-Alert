'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  repairPumpSolanaCalloutChains,
  __private: { CANDIDATE_PREDICATE, parseArgs },
} = require('../src/utils/repair-pump-callout-solana-chains');

function fakeDatabase(counts = [12, 3]) {
  const calls = [];
  let countIndex = 0;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('UPDATE callout_thesis_archive')) return { rowCount: counts[0] };
      if (sql.startsWith('UPDATE callout_events')) return { rowCount: counts[1] };
      return { rowCount: null, rows: [] };
    },
    release() { calls.push('RELEASE'); },
  };
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      return { rows: [{ count: counts[countIndex++] }] };
    },
    async getClient() { calls.push('GET_CLIENT'); return client; },
  };
}

describe('Pump callout Solana chain repair', () => {
  it('is dry-run by default and selects only unambiguous unresolved Pump addresses', async () => {
    assert.deepEqual(parseArgs([]), { mode: 'dry-run' });
    assert.match(CANDIDATE_PREDICATE, /platform = 'pump'/);
    assert.match(CANDIDATE_PREDICATE, /asset_raw_chain_id IS NULL/);
    assert.match(CANDIDATE_PREDICATE, /\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$/);
    const database = fakeDatabase();

    assert.deepEqual(await repairPumpSolanaCalloutChains(database), {
      mode: 'dry-run', candidates: { archive: 12, live: 3 },
      repaired: { archive: 0, live: 0 },
    });
    assert.equal(database.calls.includes('GET_CLIENT'), false);
  });

  it('repairs archive and retained live rows atomically only after explicit write mode', async () => {
    const database = fakeDatabase();
    const result = await repairPumpSolanaCalloutChains(database, { mode: 'write' });

    assert.deepEqual(result, {
      mode: 'write', candidates: { archive: 12, live: 3 },
      repaired: { archive: 12, live: 3 },
    });
    const tail = database.calls.slice(-5);
    assert.equal(tail[0], 'BEGIN');
    assert.match(tail[1], /UPDATE callout_thesis_archive/);
    assert.match(tail[2], /UPDATE callout_events/);
    assert.deepEqual(tail.slice(3), ['COMMIT', 'RELEASE']);
  });

  it('rejects unknown arguments and modes', () => {
    assert.throws(() => parseArgs(['--other']), /Unknown argument/);
    assert.throws(() => parseArgs(['--mode', 'unsafe']), /dry-run or write/);
  });
});

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { fixture } = require('./helpers/v4-blocked-repair-fixture');
const { validateEvents } = require('../src/models/robinhood-v4-blocked-repair');
const { validateCheckpoint } = require('../src/utils/repair-robinhood-v4-blocked');
it('accepts only a complete matching preview and ordered nonnegative archive history', () => {
  const { checkpoint, report, item } = fixture();
  assert.equal(validateCheckpoint(checkpoint, report).pools.length, 1);
  for (const mutate of [
    (p) => { p.nextBlock = '12'; },
    (p) => { p.events.reverse(); },
    (p) => { p.events[0].liquidityDelta = '-1'; },
    (p) => { p.events[0].poolId = 'wrong'; },
    (p) => { p.events[1].transactionHash = p.events[0].transactionHash; },
  ]) { const changed = structuredClone(item); mutate(changed); assert.throws(() => validateEvents(changed)); }
  assert.throws(() => validateCheckpoint({ ...checkpoint, checksum: 'wrong' }, report), /checkpoint/);
  assert.throws(() => validateCheckpoint(checkpoint, { ...report, completed: false }), /checkpoint/);
  report.pools[0].processedWithoutDelta = 1;
  assert.throws(() => validateCheckpoint(checkpoint, report), /Unsafe/);
});

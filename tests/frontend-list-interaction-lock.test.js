const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  shouldLockListInteraction,
} = require('../frontend/src/utils/list-interaction-lock.ts');

describe('frontend list interaction lock', () => {
  it('keeps monitored background hover live while protecting interactive controls', () => {
    assert.equal(shouldLockListInteraction({
      insideBroadList: false,
      insideScopedList: true,
      insideInteractiveZone: false,
    }), false);
    assert.equal(shouldLockListInteraction({
      insideBroadList: false,
      insideScopedList: true,
      insideInteractiveZone: true,
    }), true);
  });

  it('preserves full-list locks for reorder-sensitive legacy lists', () => {
    assert.equal(shouldLockListInteraction({
      insideBroadList: true,
      insideScopedList: false,
      insideInteractiveZone: false,
    }), true);
  });
});

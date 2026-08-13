const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  shouldLockListInteraction,
} = require('../frontend/src/utils/list-interaction-lock.ts');

describe('frontend list interaction lock', () => {
  it('keeps monitored controls live while preserving the real pin drag lock', () => {
    assert.equal(shouldLockListInteraction({
      insideBroadList: false,
      insideScopedList: true,
      insideInteractiveZone: true,
      insideMonitoredList: true,
      monitoredPinDragActive: false,
    }), false);
    assert.equal(shouldLockListInteraction({
      insideBroadList: false,
      insideScopedList: true,
      insideInteractiveZone: true,
      insideMonitoredList: true,
      monitoredPinDragActive: true,
    }), true);
  });

  it('preserves interactive and full-list locks outside monitored', () => {
    assert.equal(shouldLockListInteraction({
      insideBroadList: true,
      insideScopedList: false,
      insideInteractiveZone: false,
      insideMonitoredList: false,
      monitoredPinDragActive: false,
    }), true);
    assert.equal(shouldLockListInteraction({
      insideBroadList: false,
      insideScopedList: true,
      insideInteractiveZone: true,
      insideMonitoredList: false,
      monitoredPinDragActive: false,
    }), true);
  });
});

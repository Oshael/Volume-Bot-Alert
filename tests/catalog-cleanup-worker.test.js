const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const cleanupWorker = require('../src/services/catalog-cleanup-worker');

describe('catalog cleanup worker archive scheduling', () => {
  it('waits a full archive interval when there is no persisted anchor', () => {
    assert.equal(
      cleanupWorker.__private.computeArchiveDelayMs(null, Date.UTC(2026, 2, 25, 12, 0, 0)),
      48 * 60 * 60 * 1000
    );
  });

  it('keeps only the remaining delay after a recent persisted archive run', () => {
    const now = Date.UTC(2026, 2, 25, 12, 0, 0);
    const tenHoursAgo = new Date(now - (10 * 60 * 60 * 1000));

    assert.equal(
      cleanupWorker.__private.computeArchiveDelayMs(tenHoursAgo, now),
      38 * 60 * 60 * 1000
    );
  });

  it('runs immediately when the persisted archive interval is already overdue', () => {
    const now = Date.UTC(2026, 2, 25, 12, 0, 0);
    const threeDaysAgo = new Date(now - (72 * 60 * 60 * 1000));

    assert.equal(cleanupWorker.__private.computeArchiveDelayMs(threeDaysAgo, now), 0);
  });
});

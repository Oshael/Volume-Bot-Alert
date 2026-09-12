const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const userUiPref = require('../src/models/user-ui-pref');
const { MIGRATION_SQL, migrate } = require('../src/utils/migrate-watchlist-token-source');
const { WATCHLIST_SOURCE, isWatchlistSource } = require('../src/utils/watchlist-token-source');
describe('Watchlist backend compatibility', () => {
  it('normalizes legacy preferences and emits only canonical Watchlist keys', () => {
    const legacySorts = [{ mode: 'vol', window: '24h' }];
    const normalized = userUiPref.normalizePrefs({
      collapsed: { manual: true },
      manualSorts: legacySorts,
      manualStarredOnly: true,
      manualFolderDeleteWarningDismissed: true,
    });
    assert.deepEqual([normalized.collapsed.watchlist, normalized.watchlistSorts], [true, legacySorts]);
    assert.equal(['manualSorts', 'manualStarredOnly', 'manualFolderDeleteWarningDismissed']
      .some((key) => key in normalized), false);
    const canonical = userUiPref.normalizePrefs({
      collapsed: { manual: true, watchlist: false },
      manualSorts: legacySorts,
      watchlistSorts: [{ mode: 'mcap', window: 'lowest' }],
    });
    assert.deepEqual([canonical.collapsed.watchlist, canonical.watchlistSorts],
      [false, [{ mode: 'mcap', window: 'lowest' }]]);
  });

  it('runs an idempotent catalog source migration contract', async () => {
    const count = await migrate({ database: { async query(sql) {
      assert.equal(sql, MIGRATION_SQL);
      return { rows: [{ migrated_count: 7 }] };
    } } });
    assert.deepEqual([count, WATCHLIST_SOURCE, isWatchlistSource('user-manual')],
      [7, 'user-watchlist', true]);
    assert.match(MIGRATION_SQL, /THEN 'user-watchlist'/);
    assert.match(MIGRATION_SQL, /robinhood-watchlist-metadata-pending/);
  });
});

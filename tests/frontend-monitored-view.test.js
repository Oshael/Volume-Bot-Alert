const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

let monitoredView;

before(async () => {
  monitoredView = await import('../frontend/src/utils/monitored-view.ts');
});

describe('frontend monitored view contract', () => {
  it('keeps the canonical UI order and separates local Watchlist from system views', () => {
    assert.deepEqual(monitoredView.MONITORED_VIEW_IDS, [
      'trending', 'migrated', 'pre_bonded', 'watchlist',
    ]);
    assert.deepEqual(monitoredView.DASHBOARD_SYSTEM_TOKEN_VIEW_IDS, [
      'trending', 'migrated', 'pre_bonded',
    ]);
    assert.equal(monitoredView.isDashboardSystemTokenViewId('watchlist'), false);
    assert.equal(monitoredView.normalizeMonitoredViewId('invalid'), 'trending');
    assert.deepEqual(monitoredView.DASHBOARD_TOKEN_VIEW_RELEASE_CHAINS, ['robinhood']);
  });

  it('creates isolated system-view readiness and a Trending primary pane', () => {
    const pane = monitoredView.createMonitoredPaneState();
    const views = monitoredView.createMonitoredSystemViewStates();

    assert.deepEqual(pane, {
      view: 'trending',
      searchQuery: '',
      scrollAnchor: null,
    });
    assert.deepEqual(Object.keys(views), ['trending', 'migrated', 'pre_bonded']);
    assert.notEqual(views.trending, views.migrated);
    views.trending.tokenIdentities.push('robinhood:0xabc');
    assert.deepEqual(views.migrated.tokenIdentities, []);
    assert.deepEqual(views.pre_bonded.metadataByIdentity, {});
  });

  it('resolves requests only for active system views', () => {
    assert.deepEqual(monitoredView.resolveDashboardTokenViewRequest('trending'), {
      view: 'trending',
      options: { chains: ['robinhood'], limit: 40 },
    });
    assert.equal(monitoredView.resolveDashboardTokenViewRequest('watchlist'), null);
  });

  it('builds a bounded Robinhood request and keeps a future multi-chain hook', () => {
    assert.equal(
      monitoredView.buildDashboardTokenViewPath('trending'),
      '/api/dashboard/token-views/trending?chains=robinhood&limit=40',
    );
    const path = monitoredView.buildDashboardTokenViewPath('migrated', {
      chains: ['robinhood', 'base', 'robinhood'],
      limit: 12,
      asOf: '2026-09-12T12:00:00.000Z',
    });
    assert.equal(
      path,
      '/api/dashboard/token-views/migrated?chains=robinhood%2Cbase&limit=12&asOf=2026-09-12T12%3A00%3A00.000Z',
    );
  });

  it('rejects unsupported remote views, empty chains and unbounded limits', () => {
    assert.throws(
      () => monitoredView.buildDashboardTokenViewPath('watchlist'),
      /unsupported dashboard system token view/,
    );
    assert.throws(
      () => monitoredView.buildDashboardTokenViewPath('trending', { chains: [] }),
      /requires at least one chain/,
    );
    assert.throws(
      () => monitoredView.buildDashboardTokenViewPath('trending', { limit: 41 }),
      /between 1 and 40/,
    );
  });
});

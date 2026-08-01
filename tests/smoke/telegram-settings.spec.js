const { expect, test } = require('@playwright/test');

const READY = {
  chain: 'solana',
  status: 'ready',
  phase: 'ready',
  publicationReady: true,
  workspaceReady: true,
  checkedAt: '2026-08-01T20:00:00.000Z',
  blockers: [],
  message: 'Solana ready.',
  capabilities: {
    alertFeed: true,
    radar: true,
    monitored: true,
    topPerformers: true,
    manualTokens: true,
    starred: true,
    blocklist: true,
    history: true,
    customAlerts: true,
    charts: true,
    explorerLinks: true,
    tradeLinks: true,
    mockTrading: false,
    solanaNative: true,
  },
};

const FIXTURES = {
  'GET /api/auth/me': {
    user: {
      id: 1,
      username: 'telegram_smoke',
      email: 'telegram@example.test',
      role: 'user',
      isActive: true,
      isEmailVerified: true,
    },
  },
  'GET /api/account/access': {
    accessStatus: 'active',
    hasProductAccess: true,
    isExpired: false,
  },
  'GET /api/config': {
    configs: {},
    uiPrefs: { chainFilters: {
      enabledChains: ['solana'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['solana'],
    } },
    tokens: [],
    blocklist: [],
    starredTokens: [],
    availableChains: ['solana'],
    chainReadiness: { solana: READY },
    runtimeFlags: { mockTradingEnabled: false },
  },
  'GET /api/config/chain-readiness': {
    availableChains: ['solana'],
    chainReadiness: { solana: READY },
  },
  'GET /api/config/token-folders': { folders: [], items: [] },
  'GET /api/account/identities': { providers: [], hasPasswordLogin: true },
  'GET /api/billing/state': { enabled: false, plans: [], orders: [] },
  'GET /api/dashboard/market-ticker': { generatedAt: null, stale: false, items: [] },
  'GET /api/dashboard/monitored': {
    tokens: [], pinnedTokens: [], total: 0, page: 0, perPage: 30, hasMore: false,
  },
  'GET /api/dashboard/top-performers': { tokens: [], count: 0 },
  'GET /api/dashboard/alert-feeds': { feeds: [], count: 0, mode: 'all' },
  'GET /api/dashboard/custom-alert-rules': { rules: [], count: 0 },
  'POST /api/catalog/sparklines': { items: [], count: 0 },
};

function requestKey(request) {
  return `${request.method()} ${new URL(request.url()).pathname}`;
}

test('keeps Telegram inert by default and exposes the controlled account link flow', async ({ page }) => {
  let telegramAvailable = false;
  let linkRequests = 0;
  const unexpectedRequests = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.routeWebSocket('**/socket.io/**', (socket) => void socket.close());
  await page.route('**/api/**', async (route) => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    const key = requestKey(route.request());
    if (key === 'GET /api/telegram/status') {
      await route.fulfill({ status: 200, json: {
        available: telegramAvailable,
        status: 'disconnected',
        identity: null,
        botUrl: 'https://t.me/trend_scope_bot',
        linkedAt: null,
        lastDeliveryAt: null,
        lastError: null,
      } });
      return;
    }
    if (key === 'POST /api/telegram/link') {
      linkRequests += 1;
      await route.fulfill({ status: 201, json: {
        deepLink: 'https://t.me/trend_scope_bot?start=opaque_admin_token',
        expiresAt: '2026-08-01T20:10:00.000Z',
      } });
      return;
    }
    const fixture = FIXTURES[key];
    if (!fixture) {
      unexpectedRequests.push(key);
      await route.fulfill({ status: 404, json: { error: `Missing fixture for ${key}` } });
      return;
    }
    await route.fulfill({ status: 200, json: fixture });
  });

  await page.goto('/alerts');
  await expect(page.getByRole('group', { name: 'Filter workspace by blockchain' })).toBeVisible();
  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Bot Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bot Settings' });
  await dialog.getByRole('tab', { name: 'Telegram' }).click();

  await expect(dialog).toContainText('Telegram integration is not available');
  await expect(dialog.getByRole('button', { name: 'Connect Telegram' })).toHaveCount(0);
  expect(linkRequests).toBe(0);

  telegramAvailable = true;
  await dialog.getByRole('button', { name: 'Refresh' }).click();
  const connect = dialog.getByRole('button', { name: 'Connect Telegram' });
  await expect(connect).toBeVisible();
  await connect.click();

  await expect.poll(() => linkRequests).toBe(1);
  await expect(dialog).toContainText('Link ready. Open Telegram and press Start');
  const openTelegram = dialog.getByRole('link', { name: 'Open Telegram' });
  await expect(openTelegram).toHaveAttribute(
    'href',
    'https://t.me/trend_scope_bot?start=opaque_admin_token',
  );
  await expect(openTelegram).toHaveAttribute('rel', 'noopener noreferrer');
  expect(unexpectedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

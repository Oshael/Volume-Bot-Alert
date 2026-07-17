const { expect, test } = require('@playwright/test');

test.describe.configure({ timeout: 60_000 });

const SOL = 'So11111111111111111111111111111111111111112';
const RH = '0xabcdef0123456789abcdef0123456789abcdef01';

function readiness(chain, customAlerts = true) {
  return {
    chain,
    status: customAlerts ? 'ready' : 'syncing',
    phase: customAlerts ? 'ready' : 'rollout-blocked',
    publicationReady: customAlerts,
    workspaceReady: true,
    checkedAt: '2026-07-16T12:00:00.000Z',
    blockers: customAlerts ? [] : ['rollout_not_publishable'],
    message: customAlerts ? `${chain} ready.` : `${chain} rollout blocked.`,
    capabilities: {
      alertFeed: true, radar: true, monitored: true, topPerformers: true,
      manualTokens: true, starred: true, blocklist: true, history: true,
      customAlerts, charts: true, explorerLinks: true, tradeLinks: true,
      mockTrading: false, solanaNative: chain === 'solana',
    },
  };
}

function capability(chain, ready) {
  return {
    chain,
    supported: true,
    ready,
    metrics: chain === 'robinhood' ? ['price', 'fdv'] : ['price', 'mcap'],
    windows: ['spot'],
    reason: ready ? null : 'rollout_not_publishable',
  };
}

async function openWorkspace(page, options = {}) {
  const rhReady = options.rhReady !== false;
  const mutations = [];
  let rules = [];
  await page.routeWebSocket('**/socket.io/**', (socket) => void socket.close());
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    const key = `${request.method()} ${url.pathname}`;
    let body = {};
    if (key === 'GET /api/auth/me') {
      body = { user: { id: 1, username: 'custom_smoke', email: 'custom@example.test', role: 'user', isActive: true, isEmailVerified: true } };
    } else if (key === 'GET /api/account/access') {
      body = { accessStatus: 'active', hasProductAccess: true, isExpired: false };
    } else if (key === 'GET /api/config') {
      body = {
        configs: {},
        uiPrefs: { chainFilters: {
          enabledChains: ['solana', 'robinhood'],
          radarChains: ['solana', 'robinhood'],
          alertFeedChains: ['solana', 'robinhood'],
          browserNotificationChains: ['solana', 'robinhood'],
        } },
        tokens: [], blocklist: [], starredTokens: [],
        availableChains: ['solana', 'robinhood'],
        chainReadiness: { solana: readiness('solana'), robinhood: readiness('robinhood', rhReady) },
        runtimeFlags: { mockTradingEnabled: false },
      };
    } else if (key === 'GET /api/config/chain-readiness') {
      body = { availableChains: ['solana', 'robinhood'], chainReadiness: {
        solana: readiness('solana'), robinhood: readiness('robinhood', rhReady),
      } };
    } else if (key === 'GET /api/config/token-folders') {
      body = { folders: [], items: [] };
    } else if (key === 'GET /api/account/identities') {
      body = { providers: [], hasPasswordLogin: true };
    } else if (key === 'GET /api/billing/state') {
      body = { enabled: false, plans: [], orders: [] };
    } else if (key === 'GET /api/dashboard/monitored') {
      body = { tokens: [
        { chain: 'solana', address: SOL, symbol: 'SOLCUST', mcap: 500000 },
        { chain: 'robinhood', address: RH, symbol: 'RHCUST', fdv: 2500000, valuationType: 'fdv' },
      ], pinnedTokens: [], total: 2, page: 0, perPage: 30, hasMore: false };
    } else if (key === 'GET /api/dashboard/top-performers') {
      body = { tokens: [], count: 0 };
    } else if (key === 'GET /api/dashboard/alert-feeds') {
      body = { feeds: [], count: 0, mode: 'all' };
    } else if (key === 'GET /api/dashboard/custom-alert-rules') {
      body = { rules, count: rules.length, capabilities: {
        solana: capability('solana', true), robinhood: capability('robinhood', rhReady),
      } };
    } else if (key === 'POST /api/dashboard/custom-alert-rules') {
      const payload = request.postDataJSON();
      mutations.push({ method: 'POST', payload });
      const rule = { id: 91, ...payload, status: 'active', metadata: { baselineFdv: 2500000 } };
      rules = [rule];
      body = { rule };
    } else if (key === 'PATCH /api/dashboard/custom-alert-rules/91') {
      const payload = request.postDataJSON();
      mutations.push({ method: 'PATCH', payload });
      rules = [{ ...rules[0], ...payload }];
      body = { rule: rules[0] };
    } else if (key === 'DELETE /api/dashboard/custom-alert-rules/91') {
      mutations.push({ method: 'DELETE', chain: url.searchParams.get('chain') });
      body = { rule: rules[0], disabled: true };
      rules = [];
    } else if (key === 'POST /api/catalog/sparklines') {
      body = { items: [], count: 0 };
    }
    await route.fulfill({ status: 200, json: body });
  });
  await page.goto('/alerts');
  await expect(page.getByRole('button', { name: 'Custom', exact: true })).toBeVisible();
  return mutations;
}

async function openCustomModal(page) {
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  return page.getByRole('dialog', { name: 'Custom alert prototype' });
}

test('creates, edits and disables a Robinhood FDV rule with chain ownership', async ({ page }) => {
  const mutations = await openWorkspace(page);
  let dialog = await openCustomModal(page);
  await dialog.locator('[data-custom-alert-field="chain"]').selectOption('robinhood');
  const metric = dialog.locator('[data-custom-alert-field="metric"]');
  await expect(metric).toHaveText(/Price USD.*FDV USD/);
  await expect(metric).not.toHaveText(/Market Cap/);
  await expect(dialog.locator('[data-custom-alert-capability-note]')).toContainText('Market Cap USD unsupported');

  await dialog.locator('[data-custom-alert-field="tokenQuery"]').fill(RH);
  await metric.selectOption('fdv');
  await dialog.locator('[data-custom-alert-field="target"]').fill('$3m');
  await dialog.getByRole('button', { name: 'Save Alert' }).click();
  await expect.poll(() => mutations.length).toBe(1);
  expect(mutations[0].payload).toMatchObject({ chain: 'robinhood', tokenAddress: RH, metric: 'fdv', window: 'spot', targetValue: 3000000 });

  dialog = await openCustomModal(page);
  const row = dialog.locator('.custom-alert-rule-row');
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(dialog.locator('[data-custom-alert-field="chain"]')).toBeDisabled();
  await expect(dialog.locator('[data-custom-alert-field="tokenQuery"]')).toBeDisabled();
  await dialog.locator('[data-custom-alert-field="target"]').fill('$4m');
  await dialog.getByRole('button', { name: 'Update Alert' }).click();
  await expect.poll(() => mutations.length).toBe(2);
  expect(mutations[1].payload).toMatchObject({ chain: 'robinhood', tokenAddress: RH, metric: 'fdv', window: 'spot', targetValue: 4000000 });

  dialog = await openCustomModal(page);
  await dialog.locator('.custom-alert-rule-row').getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => mutations.length).toBe(3);
  expect(mutations[2]).toEqual({ method: 'DELETE', chain: 'robinhood' });
});

test('shows Robinhood readiness separately and blocks submission', async ({ page }) => {
  const mutations = await openWorkspace(page, { rhReady: false });
  const dialog = await openCustomModal(page);
  await dialog.locator('[data-custom-alert-field="chain"]').selectOption('robinhood');
  await dialog.locator('[data-custom-alert-field="tokenQuery"]').fill(RH);
  await expect(dialog.locator('[data-custom-alert-capability-note]')).toContainText('Temporarily unavailable: rollout not publishable');
  await expect(dialog.locator('[data-custom-alert-field="metric"]')).toHaveText(/FDV USD/);
  await expect(dialog.getByRole('button', { name: 'Save Alert' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Test Alert' })).toBeDisabled();
  expect(mutations).toEqual([]);
});

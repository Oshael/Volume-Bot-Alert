const { test, expect } = require('@playwright/test');

const publicPlansPayload = {
  enabled: true,
  provider: 'moonpay_commerce',
  providerReady: true,
  providerMocked: false,
  plans: [
    {
      key: 'weekly',
      label: '7 Days',
      description: 'Weekly access',
      accessDays: 7,
      currencyCode: 'USDC',
      amountMinor: 1500,
      priceDisplay: 'USDC 15.00',
      featured: false,
      provider: 'moonpay_commerce',
      available: true,
      availabilityReason: null,
    },
    {
      key: 'monthly',
      label: '30 Days',
      description: 'Monthly access',
      accessDays: 30,
      currencyCode: 'USDC',
      amountMinor: 4900,
      priceDisplay: 'USDC 49.00',
      featured: true,
      provider: 'moonpay_commerce',
      available: true,
      availabilityReason: null,
    },
  ],
};

const preAccessMePayload = {
  user: {
    id: 17,
    username: 'Teste',
    email: 'teste@example.com',
    role: 'user',
    isActive: true,
    isEmailVerified: true,
    emailVerifiedAt: '2026-03-31T12:00:00.000Z',
  },
  access: {
    accessStatus: 'inactive',
    accessGrantedAt: null,
    accessExpiresAt: null,
    accessSource: 'payment',
    accessUpdatedAt: '2026-03-31T12:00:00.000Z',
    isExpired: false,
    isTimed: false,
    hasProductAccess: false,
    denialReason: null,
    denialCode: null,
    daysRemaining: null,
  },
  returnUrl: '/alerts',
};

async function installApiMocks(page, options = {}) {
  const state = {
    publicPlansRequests: 0,
    preAccessOrderRequests: 0,
  };

  const {
    preAccess = false,
    delayCheckoutMs = 0,
  } = options;

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    const key = `${request.method()} ${url.pathname}`;

    if (key === 'GET /api/auth/me') {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Authentication required' }),
      });
      return;
    }

    if (key === 'GET /api/billing/plans') {
      state.publicPlansRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(publicPlansPayload),
      });
      return;
    }

    if (preAccess && key === 'GET /api/pre-access/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(preAccessMePayload),
      });
      return;
    }

    if (!preAccess && key === 'GET /api/pre-access/me') {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Pre-access authentication required' }),
      });
      return;
    }

    if (preAccess && key === 'POST /api/pre-access/billing/orders') {
      state.preAccessOrderRequests += 1;
      if (delayCheckoutMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayCheckoutMs));
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Billing order created',
          order: {
            id: 99,
            planKey: 'weekly',
            planName: '7 Days',
            accessDays: 7,
            provider: 'moonpay_commerce',
            providerChargeId: 'charge_123',
            providerCheckoutUrl: 'https://example.com/checkout',
            providerStatus: 'pending',
            currencyCode: 'USDC',
            currencyAmountMinor: 1500,
            status: 'awaiting_payment',
            paidAt: null,
            lastError: null,
            createdAt: '2026-03-31T12:00:00.000Z',
            updatedAt: '2026-03-31T12:00:00.000Z',
          },
          checkoutUrl: 'https://example.com/checkout',
        }),
      });
      return;
    }

    if (preAccess && key === 'POST /api/pre-access/logout') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Pre-access flow closed' }),
      });
      return;
    }

    throw new Error(`Unhandled API route in smoke test: ${key}`);
  });

  return state;
}

test('public landing renders pricing cards from the dynamic billing payload', async ({ page }) => {
  await installApiMocks(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Pick the plan that fits/i })).toBeVisible();
  await expect(page.locator('.legacy-public-pricing-card').filter({ hasText: '7 Days' }).first()).toBeVisible();
  await expect(page.locator('.legacy-public-pricing-card').filter({ hasText: '30 Days' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'LOGIN TO BUY' }).first()).toBeVisible();
});

test('pre-access plan selection shows the in-card checkout generation banner immediately', async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });

  await installApiMocks(page, { preAccess: true, delayCheckoutMs: 1_500 });
  await page.goto('/access');

  await expect(page.getByText('Choose Your Access')).toBeVisible();
  await page.getByRole('button', { name: 'CONTINUE TO CHECKOUT' }).first().click();

  await expect(page.getByText(/Generating secure checkout link/i)).toBeVisible();
});

test('logging out from pre-access returns to the public landing and reloads plans without refresh', async ({ page }) => {
  const apiState = await installApiMocks(page, { preAccess: true });
  await page.goto('/access');

  await expect(page.getByRole('button', { name: 'LOGOUT' })).toBeVisible();
  await page.getByRole('button', { name: 'LOGOUT' }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible();
  await expect(page.locator('.legacy-public-pricing-card').filter({ hasText: '7 Days' }).first()).toBeVisible();
  expect(apiState.publicPlansRequests).toBeGreaterThan(1);
});

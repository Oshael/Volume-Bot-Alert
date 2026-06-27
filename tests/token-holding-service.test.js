const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenBalanceProvider = require('../src/services/token-balance-provider');
const tokenHoldingService = require('../src/services/token-holding-service');

const gateConfig = {
  enabled: true,
  chain: 'solana',
  mintAddress: 'Mint11111111111111111111111111111111111111111',
  rpcProvider: 'helius',
  balanceCacheSeconds: 60,
  unlimitedThreshold: '2000000',
  discountThreshold: '1000000',
  discountPercent: 50,
  launchPromo: {
    enabled: true,
    startAt: '2026-06-01T00:00:00.000Z',
    endAt: '2026-06-15T00:00:00.000Z',
    threshold: '100000',
  },
};

describe('token holding service', () => {
  it('calculates raw thresholds with BigInt precision', () => {
    assert.equal(tokenHoldingService.thresholdToRaw('2000000', 6, 'unlimited').toString(), '2000000000000');

    const eligible = tokenHoldingService.evaluateTier({
      balanceRaw: '2000000000000',
      decimals: 6,
      now: '2026-06-20T00:00:00.000Z',
    }, gateConfig);
    const oneRawUnitShort = tokenHoldingService.evaluateTier({
      balanceRaw: '1999999999999',
      decimals: 6,
      now: '2026-06-20T00:00:00.000Z',
    }, gateConfig);

    assert.equal(eligible.tier, 'unlimited');
    assert.equal(eligible.hasUnlimitedAccess, true);
    assert.equal(oneRawUnitShort.tier, 'discount_50');
    assert.equal(oneRawUnitShort.hasUnlimitedAccess, false);
  });

  it('keeps launch promo access separate from discount eligibility', () => {
    const result = tokenHoldingService.evaluateTier({
      balanceRaw: '1000000000000',
      decimals: 6,
      now: '2026-06-10T00:00:00.000Z',
    }, gateConfig);

    assert.equal(result.tier, 'launch_free');
    assert.equal(result.hasLaunchPromoAccess, true);
    assert.equal(result.discountPercent, 50);
  });

  it('selects the highest eligible configured discount tier', () => {
    const tieredConfig = {
      ...gateConfig,
      discountTiers: [
        { threshold: '250000', discountPercent: 10, tier: 'discount_10' },
        { threshold: '1000000', discountPercent: 50, tier: 'discount_50' },
        { threshold: '500000', discountPercent: 25, tier: 'discount_25' },
      ],
    };

    const entryTier = tokenHoldingService.evaluateTier({
      balanceRaw: '250000000000',
      decimals: 6,
      now: '2026-06-20T00:00:00.000Z',
    }, tieredConfig);
    const midTier = tokenHoldingService.evaluateTier({
      balanceRaw: '750000000000',
      decimals: 6,
      now: '2026-06-20T00:00:00.000Z',
    }, tieredConfig);
    const topTier = tokenHoldingService.evaluateTier({
      balanceRaw: '1000000000000',
      decimals: 6,
      now: '2026-06-20T00:00:00.000Z',
    }, tieredConfig);

    assert.equal(entryTier.tier, 'discount_10');
    assert.equal(entryTier.discountPercent, 10);
    assert.equal(midTier.tier, 'discount_25');
    assert.equal(midTier.discountPercent, 25);
    assert.equal(topTier.tier, 'discount_50');
    assert.equal(topTier.discountPercent, 50);
  });

  it('does not apply launch promo outside configured timestamps', () => {
    const result = tokenHoldingService.evaluateTier({
      balanceRaw: '100000000000',
      decimals: 6,
      now: '2026-06-20T00:00:00.000Z',
    }, gateConfig);

    assert.equal(result.tier, 'none');
    assert.equal(result.hasLaunchPromoAccess, false);
    assert.equal(result.discountPercent, 0);
  });

  it('extracts a Helius wallet balance without using uiAmount for decisions', async () => {
    const provider = tokenBalanceProvider.createHeliusTokenBalanceProvider({
      heliusApi: {
        getTokenSupply: async () => ({
          context: { slot: 99 },
          value: {
            amount: '1000000000000000',
            decimals: 6,
            uiAmount: 1000000000,
          },
        }),
        getTokenAccounts: async () => ({
          token_accounts: [
            { amount: '1000000000000', token_program: 'Tokenkeg111' },
            { tokenAmount: { amount: '999999999999' } },
          ],
        }),
      },
    });

    const balance = await provider.getWalletTokenBalance({
      walletAddress: 'Wallet1111111111111111111111111111111111111',
      mintAddress: gateConfig.mintAddress,
    });

    assert.equal(balance.decimals, 6);
    assert.equal(balance.balanceRaw, '1999999999999');
    assert.equal(balance.balanceUiString, '1999999.999999');
    assert.equal(balance.tokenProgram, 'Tokenkeg111');
    assert.equal(balance.rpcSlot, 99);
  });

  it('refreshes and persists a token holding snapshot', async () => {
    const savedPayloads = [];
    const now = new Date('2026-06-20T10:00:00.000Z');

    const snapshot = await tokenHoldingService.refreshSnapshotForUser({
      userId: 42,
      walletAddress: 'Wallet2222222222222222222222222222222222222',
      now,
    }, {
      config: gateConfig,
      balanceProvider: {
        providerName: 'helius',
        getWalletTokenBalance: async () => ({
          walletAddress: 'Wallet2222222222222222222222222222222222222',
          mintAddress: gateConfig.mintAddress,
          tokenProgram: 'Tokenkeg111',
          decimals: 6,
          balanceRaw: '2000000000000',
          balanceUiString: '2000000',
          rpcProvider: 'helius',
          rpcSlot: 123,
        }),
      },
      snapshotModel: {
        createSnapshot: async (payload) => {
          savedPayloads.push(payload);
          return payload;
        },
      },
    });

    assert.equal(savedPayloads.length, 1);
    assert.equal(snapshot.userId, 42);
    assert.equal(snapshot.tier, 'unlimited');
    assert.equal(snapshot.hasUnlimitedAccess, true);
    assert.equal(snapshot.expiresAt, '2026-06-20T10:01:00.000Z');
    assert.deepEqual(snapshot.metadata.thresholds, {
      unlimitedRaw: '2000000000000',
      discountRaw: '1000000000000',
      launchPromoRaw: '100000000000',
    });
  });
});

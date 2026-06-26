const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userAccess = require('../src/models/user-access');

const gateConfig = {
  enabled: true,
  mintAddress: 'Mint11111111111111111111111111111111111111111',
  rpcFailureGraceSeconds: 3600,
};

function createUser(overrides = {}) {
  return {
    id: 7,
    role: 'user',
    access_status: 'inactive',
    access_source: 'manual',
    access_granted_at: '2026-06-01T00:00:00.000Z',
    access_expires_at: null,
    access_updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('user access token resolver', () => {
  it('grants product access from an unexpired unlimited token snapshot', async () => {
    const access = await userAccess.buildResolvedAccessSnapshot(
      createUser(),
      new Date('2026-06-23T12:00:00.000Z'),
      {
        config: gateConfig,
        tokenHoldingSnapshotModel: {
          findLatestForUser: async () => ({
            tier: 'unlimited',
            balanceRaw: '2000000000000',
            balanceUiString: '2000000',
            discountPercent: 50,
            hasUnlimitedAccess: true,
            hasLaunchPromoAccess: false,
            checkedAt: '2026-06-23T11:59:00.000Z',
            expiresAt: '2026-06-23T12:01:00.000Z',
          }),
        },
      }
    );

    assert.equal(access.hasProductAccess, true);
    assert.equal(access.accessSource, 'token');
    assert.equal(access.accessReason, 'token_unlimited');
    assert.equal(access.tokenTier, 'unlimited');
    assert.equal(access.tokenBalanceRaw, '2000000000000');
    assert.equal(access.denialCode, null);
  });

  it('sets launch promo token access to expire at the configured promo end', async () => {
    const access = await userAccess.buildResolvedAccessSnapshot(
      createUser(),
      new Date('2026-06-23T12:00:00.000Z'),
      {
        config: {
          ...gateConfig,
          launchPromo: {
            enabled: true,
            startAt: '2026-06-20T00:00:00.000Z',
            endAt: '2026-07-04T00:00:00.000Z',
          },
        },
        tokenHoldingSnapshotModel: {
          findLatestForUser: async () => ({
            tier: 'launch_free',
            balanceRaw: '100000000000',
            balanceUiString: '100000',
            discountPercent: 0,
            hasUnlimitedAccess: false,
            hasLaunchPromoAccess: true,
            checkedAt: '2026-06-23T11:59:00.000Z',
            expiresAt: '2026-06-23T12:01:00.000Z',
          }),
        },
      }
    );

    assert.equal(access.hasProductAccess, true);
    assert.equal(access.accessSource, 'token');
    assert.equal(access.accessReason, 'token_launch_promo');
    assert.equal(access.tokenTier, 'launch_free');
    assert.equal(access.accessExpiresAt, '2026-07-04T00:00:00.000Z');
    assert.equal(access.isTimed, true);
    assert.equal(access.daysRemaining, 11);
  });

  it('does not use an expired token snapshot for access', async () => {
    const access = await userAccess.buildResolvedAccessSnapshot(
      createUser(),
      new Date('2026-06-23T12:00:00.000Z'),
      {
        config: gateConfig,
        tokenHoldingSnapshotModel: {
          findLatestForUser: async () => ({
            tier: 'unlimited',
            hasUnlimitedAccess: true,
            checkedAt: '2026-06-23T11:50:00.000Z',
            expiresAt: '2026-06-23T11:51:00.000Z',
          }),
        },
        userWalletModel: {
          findByUserId: async () => null,
        },
      }
    );

    assert.equal(access.hasProductAccess, false);
    assert.equal(access.denialCode, 'access_inactive');
    assert.equal(access.tokenTier, 'unlimited');
  });

  it('does not grant launch promo access after the promo end', async () => {
    const access = await userAccess.buildResolvedAccessSnapshot(
      createUser(),
      new Date('2026-07-05T12:00:00.000Z'),
      {
        config: {
          ...gateConfig,
          launchPromo: {
            enabled: true,
            startAt: '2026-06-20T00:00:00.000Z',
            endAt: '2026-07-04T00:00:00.000Z',
          },
        },
        tokenHoldingSnapshotModel: {
          findLatestForUser: async () => ({
            tier: 'launch_free',
            balanceRaw: '100000000000',
            balanceUiString: '100000',
            discountPercent: 0,
            hasUnlimitedAccess: false,
            hasLaunchPromoAccess: true,
            checkedAt: '2026-07-05T11:59:00.000Z',
            expiresAt: '2026-07-05T12:01:00.000Z',
          }),
        },
      }
    );

    assert.equal(access.hasProductAccess, false);
    assert.equal(access.denialCode, 'access_inactive');
    assert.equal(access.tokenTier, 'launch_free');
  });

  it('refreshes an expired eligible token snapshot before denying token access', async () => {
    const refreshed = [];
    const access = await userAccess.buildResolvedAccessSnapshot(
      createUser(),
      new Date('2026-06-23T12:00:00.000Z'),
      {
        config: gateConfig,
        tokenHoldingSnapshotModel: {
          findLatestForUser: async () => ({
            tier: 'unlimited',
            hasUnlimitedAccess: true,
            checkedAt: '2026-06-23T11:58:00.000Z',
            expiresAt: '2026-06-23T11:59:00.000Z',
          }),
          createSnapshot: async (payload) => {
            refreshed.push(payload);
            return {
              tier: 'unlimited',
              balanceRaw: '2000000000000',
              balanceUiString: '2000000',
              discountPercent: 50,
              hasUnlimitedAccess: true,
              hasLaunchPromoAccess: false,
              checkedAt: '2026-06-23T12:00:00.000Z',
              expiresAt: '2026-06-23T12:01:00.000Z',
            };
          },
        },
        userWalletModel: {
          findByUserId: async () => ({
            walletAddress: 'Wallet111111111111111111111111111111111111',
          }),
        },
        tokenHoldingService: {
          refreshSnapshotForUser: async (input, deps) => deps.snapshotModel.createSnapshot({
            userId: input.userId,
            walletAddress: input.walletAddress,
          }),
        },
      }
    );

    assert.equal(access.hasProductAccess, true);
    assert.equal(access.accessReason, 'token_unlimited');
    assert.equal(access.tokenBalanceUi, '2000000');
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].walletAddress, 'Wallet111111111111111111111111111111111111');
  });

  it('keeps an expired eligible token snapshot during RPC failure grace', async () => {
    const access = await userAccess.buildResolvedAccessSnapshot(
      createUser(),
      new Date('2026-06-23T12:00:00.000Z'),
      {
        config: gateConfig,
        tokenHoldingSnapshotModel: {
          findLatestForUser: async () => ({
            tier: 'unlimited',
            balanceRaw: '2000000000000',
            balanceUiString: '2000000',
            hasUnlimitedAccess: true,
            hasLaunchPromoAccess: false,
            checkedAt: '2026-06-23T11:58:00.000Z',
            expiresAt: '2026-06-23T11:59:00.000Z',
          }),
        },
        userWalletModel: {
          findByUserId: async () => ({
            walletAddress: 'Wallet111111111111111111111111111111111111',
          }),
        },
        tokenHoldingService: {
          refreshSnapshotForUser: async () => {
            throw new Error('rpc unavailable');
          },
        },
      }
    );

    assert.equal(access.hasProductAccess, true);
    assert.equal(access.accessSource, 'token');
    assert.equal(access.accessReason, 'token_unlimited');
    assert.equal(access.tokenBalanceUi, '2000000');
  });

  it('removes token access when refresh confirms the balance is below threshold', async () => {
    const access = await userAccess.buildResolvedAccessSnapshot(
      createUser(),
      new Date('2026-06-23T12:00:00.000Z'),
      {
        config: gateConfig,
        tokenHoldingSnapshotModel: {
          findLatestForUser: async () => ({
            tier: 'unlimited',
            hasUnlimitedAccess: true,
            checkedAt: '2026-06-23T11:58:00.000Z',
            expiresAt: '2026-06-23T11:59:00.000Z',
          }),
          createSnapshot: async () => ({
            tier: 'none',
            balanceRaw: '0',
            balanceUiString: '0',
            discountPercent: 0,
            hasUnlimitedAccess: false,
            hasLaunchPromoAccess: false,
            checkedAt: '2026-06-23T12:00:00.000Z',
            expiresAt: '2026-06-23T12:01:00.000Z',
          }),
        },
        userWalletModel: {
          findByUserId: async () => ({
            walletAddress: 'Wallet111111111111111111111111111111111111',
          }),
        },
        tokenHoldingService: {
          refreshSnapshotForUser: async (input, deps) => deps.snapshotModel.createSnapshot({
            userId: input.userId,
            walletAddress: input.walletAddress,
          }),
        },
      }
    );

    assert.equal(access.hasProductAccess, false);
    assert.equal(access.denialCode, 'access_inactive');
    assert.equal(access.tokenTier, 'none');
    assert.equal(access.tokenBalanceUi, '0');
  });

  it('keeps revoked access blocked even with an eligible token snapshot', async () => {
    const access = await userAccess.buildResolvedAccessSnapshot(
      createUser({ access_status: 'revoked' }),
      new Date('2026-06-23T12:00:00.000Z'),
      {
        config: gateConfig,
        tokenHoldingSnapshotModel: {
          findLatestForUser: async () => {
            throw new Error('should not query token snapshots for revoked access');
          },
        },
      }
    );

    assert.equal(access.hasProductAccess, false);
    assert.equal(access.denialCode, 'access_revoked');
  });

  it('enriches paid access with token discount metadata without changing the reason', async () => {
    const access = await userAccess.buildResolvedAccessSnapshot(
      createUser({
        access_status: 'active',
        access_source: 'payment',
        access_expires_at: '2026-07-23T12:00:00.000Z',
      }),
      new Date('2026-06-23T12:00:00.000Z'),
      {
        config: gateConfig,
        tokenHoldingSnapshotModel: {
          findLatestForUser: async () => ({
            tier: 'discount_50',
            discountPercent: 50,
            balanceRaw: '1000000000000',
            balanceUiString: '1000000',
            hasUnlimitedAccess: false,
            hasLaunchPromoAccess: false,
            checkedAt: '2026-06-23T11:59:00.000Z',
            expiresAt: '2026-06-23T12:01:00.000Z',
          }),
        },
      }
    );

    assert.equal(access.hasProductAccess, true);
    assert.equal(access.accessReason, 'payment');
    assert.equal(access.tokenTier, 'discount_50');
    assert.equal(access.discountPercent, 50);
  });
});

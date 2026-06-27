const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenGateWebhookService = require('../src/services/token-gate-webhook-service');

const gateConfig = {
  enabled: true,
  chain: 'solana',
  mintAddress: 'Mint11111111111111111111111111111111111111111',
  rpcProvider: 'helius',
};

describe('token gate webhook service', () => {
  it('collects wallet owners touched by the configured mint', () => {
    const addresses = tokenGateWebhookService.__private.collectAffectedWalletAddresses([
      {
        tokenTransfers: [
          {
            mint: gateConfig.mintAddress,
            fromUserAccount: 'Seller11111111111111111111111111111111111',
            toUserAccount: 'Buyer111111111111111111111111111111111111',
          },
          {
            mint: 'OtherMint111111111111111111111111111111111111',
            fromUserAccount: 'Ignored1111111111111111111111111111111111',
          },
        ],
        accountData: [
          {
            account: 'TokenAccount1111111111111111111111111111111',
            tokenBalanceChanges: [
              {
                mint: gateConfig.mintAddress,
                userAccount: 'Owner111111111111111111111111111111111111',
              },
            ],
          },
        ],
      },
    ], gateConfig.mintAddress);

    assert.deepEqual(addresses.sort(), [
      'Buyer111111111111111111111111111111111111',
      'Owner111111111111111111111111111111111111',
      'Seller11111111111111111111111111111111111',
      'TokenAccount1111111111111111111111111111111',
    ].sort());
  });

  it('refreshes linked wallets and revokes sockets when token access is lost', async () => {
    const refreshed = [];
    const revoked = [];
    const result = await tokenGateWebhookService.processHeliusTokenWebhook({
      tokenTransfers: [{
        mint: gateConfig.mintAddress,
        fromUserAccount: 'LinkedWallet1111111111111111111111111111111',
      }],
    }, {
      config: gateConfig,
      userWalletModel: {
        findByWalletAddresses: async (addresses) => {
          assert.deepEqual(addresses, ['LinkedWallet1111111111111111111111111111111']);
          return [{
            id: 7,
            userId: 42,
            walletAddress: 'LinkedWallet1111111111111111111111111111111',
          }];
        },
      },
      tokenHoldingService: {
        refreshSnapshotForUser: async (input) => {
          refreshed.push(input);
          return { tier: 'none' };
        },
      },
      userModel: {
        findById: async (userId) => ({ id: userId, access_status: 'inactive' }),
      },
      userAccessModel: {
        buildResolvedAccessSnapshot: async () => ({
          hasProductAccess: false,
          denialCode: 'access_inactive',
          accessReason: 'none',
        }),
      },
      socketHub: {
        revokeUserSockets: (userId, reason) => revoked.push({ userId, reason }),
      },
    });

    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].userId, 42);
    assert.equal(result.ignored, false);
    assert.equal(result.refreshedWalletCount, 1);
    assert.equal(result.revokedUserCount, 1);
    assert.deepEqual(revoked, [{ userId: 42, reason: 'access_inactive' }]);
  });

  it('ignores webhook payloads that do not touch the configured mint', async () => {
    const result = await tokenGateWebhookService.processHeliusTokenWebhook({
      tokenTransfers: [{
        mint: 'OtherMint111111111111111111111111111111111111',
        fromUserAccount: 'LinkedWallet1111111111111111111111111111111',
      }],
    }, {
      config: gateConfig,
      userWalletModel: {
        findByWalletAddresses: async () => {
          throw new Error('should not query linked wallets');
        },
      },
    });

    assert.equal(result.ignored, true);
    assert.equal(result.reason, 'no_matching_token_transfer');
  });
});

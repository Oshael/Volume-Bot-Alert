const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const walletAuthService = require('../src/services/wallet-auth-service');
const WalletAuthChallenge = require('../src/models/wallet-auth-challenge');

function createSolanaKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = publicDer.subarray(publicDer.length - 32);
  return {
    privateKey,
    walletAddress: walletAuthService.__private.encodeBase58(publicKeyBytes),
  };
}

function createFakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    release() {
      calls.push('release');
    },
  };
}

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
    enabled: false,
    startAt: null,
    endAt: null,
    threshold: '100000',
  },
};

describe('wallet auth service', () => {
  it('verifies Ed25519 signatures from a Solana public key', () => {
    const { privateKey, walletAddress } = createSolanaKeypair();
    const message = 'TrendScope Wallet Login test message';
    const signature = crypto.sign(null, Buffer.from(message), privateKey);

    assert.equal(walletAuthService.__private.normalizeWalletAddress(walletAddress), walletAddress);
    assert.equal(walletAuthService.__private.verifyEd25519Signature({
      walletAddress,
      message,
      signature: Array.from(signature),
    }), true);
    assert.equal(walletAuthService.__private.verifyEd25519Signature({
      walletAddress,
      message: `${message}!`,
      signature: Array.from(signature),
    }), false);
  });

  it('creates a challenge message and stores only hashes', async () => {
    const { walletAddress } = createSolanaKeypair();
    const captured = [];

    const challenge = await walletAuthService.createChallenge({
      walletAddress,
      now: new Date('2026-06-23T12:00:00.000Z'),
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    }, {
      config: gateConfig,
      challengeModel: {
        create: async (payload) => {
          captured.push(payload);
          return { record: { id: 1 } };
        },
      },
    });

    assert.equal(challenge.walletAddress, walletAddress);
    assert.match(challenge.message, /TrendScope Wallet Login/);
    assert.match(challenge.message, new RegExp(walletAddress));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].message, challenge.message);
    assert.equal(captured[0].expiresAt, '2026-06-23T12:05:00.000Z');
  });

  it('creates a wallet-only user only when token balance is eligible', async () => {
    const { privateKey, walletAddress } = createSolanaKeypair();
    const message = 'TrendScope Wallet Login eligible wallet';
    const signature = crypto.sign(null, Buffer.from(message), privateKey);
    const fakeClient = createFakeClient();
    const createdUsers = [];
    const createdWallets = [];
    const snapshots = [];

    const result = await walletAuthService.verifyWalletSignature({
      walletAddress,
      message,
      signature: walletAuthService.__private.encodeBase58(signature),
      walletProvider: 'phantom',
      now: new Date('2026-06-23T12:00:00.000Z'),
    }, {
      config: gateConfig,
      getClient: async () => fakeClient,
      challengeModel: {
        findValidByMessage: async () => ({
          id: 12,
          walletAddress,
          messageHash: WalletAuthChallenge.hashValue(message),
        }),
        consume: async (id) => ({ id, consumedAt: '2026-06-23T12:00:01.000Z' }),
      },
      balanceProvider: {
        providerName: 'helius',
        getWalletTokenBalance: async () => ({
          walletAddress,
          mintAddress: gateConfig.mintAddress,
          tokenProgram: 'Tokenkeg111',
          decimals: 6,
          balanceRaw: '2000000000000',
          balanceUiString: '2000000',
          rpcProvider: 'helius',
          rpcSlot: 123,
        }),
      },
      userModel: {
        createWalletOnly: async (payload) => {
          createdUsers.push(payload);
          return {
            id: 44,
            username: payload.username,
            email: 'wallet_test@wallet.local',
            role: 'user',
            is_active: true,
            is_email_verified: true,
            access_status: 'inactive',
            access_source: 'manual',
            access_expires_at: null,
          };
        },
      },
      walletModel: {
        findByWalletAddress: async () => null,
        createLink: async (payload) => {
          createdWallets.push(payload);
          return { id: 9, userId: payload.userId, walletAddress: payload.walletAddress };
        },
      },
      snapshotModel: {
        createSnapshot: async (payload) => {
          snapshots.push(payload);
          return payload;
        },
      },
    });

    assert.equal(result.mode, 'created_wallet_user');
    assert.equal(result.tokenAccessEligible, true);
    assert.equal(result.requiresAccessResolver, false);
    assert.equal(result.access.hasProductAccess, true);
    assert.equal(result.access.accessReason, 'token_unlimited');
    assert.equal(createdUsers[0].username, `user_${walletAddress.slice(-4)}`);
    assert.equal(createdWallets[0].userId, 44);
    assert.equal(snapshots[0].tier, 'unlimited');
    assert.deepEqual(fakeClient.calls, ['BEGIN', 'COMMIT', 'release']);
  });

  it('does not create an account for an insufficient new wallet', async () => {
    const { privateKey, walletAddress } = createSolanaKeypair();
    const message = 'TrendScope Wallet Login insufficient wallet';
    const signature = crypto.sign(null, Buffer.from(message), privateKey);

    const result = await walletAuthService.verifyWalletSignature({
      walletAddress,
      message,
      signature: Array.from(signature),
      now: new Date('2026-06-23T12:00:00.000Z'),
    }, {
      config: gateConfig,
      challengeModel: {
        findValidByMessage: async () => ({ id: 13 }),
        consume: async () => ({ id: 13 }),
      },
      balanceProvider: {
        getWalletTokenBalance: async () => ({
          walletAddress,
          mintAddress: gateConfig.mintAddress,
          decimals: 6,
          balanceRaw: '99999999999',
          balanceUiString: '99999.999999',
          rpcProvider: 'helius',
        }),
      },
      walletModel: {
        findByWalletAddress: async () => null,
        createLink: async () => {
          throw new Error('should not create wallet link');
        },
      },
      getClient: async () => {
        throw new Error('should not open transaction');
      },
    });

    assert.equal(result.mode, 'insufficient_balance');
    assert.equal(result.user, null);
    assert.equal(result.tokenAccessEligible, false);
  });

  it('creates a pre-access wallet user when a new wallet only qualifies for discount', async () => {
    const { privateKey, walletAddress } = createSolanaKeypair();
    const message = 'TrendScope Wallet Login discount wallet';
    const signature = crypto.sign(null, Buffer.from(message), privateKey);
    const fakeClient = createFakeClient();
    const createdUsers = [];
    const createdWallets = [];
    const snapshots = [];

    const result = await walletAuthService.verifyWalletSignature({
      walletAddress,
      message,
      signature: walletAuthService.__private.encodeBase58(signature),
      walletProvider: 'phantom',
      now: new Date('2026-06-23T12:00:00.000Z'),
    }, {
      config: gateConfig,
      getClient: async () => fakeClient,
      challengeModel: {
        findValidByMessage: async () => ({ id: 16 }),
        consume: async () => ({ id: 16 }),
      },
      balanceProvider: {
        providerName: 'helius',
        getWalletTokenBalance: async () => ({
          walletAddress,
          mintAddress: gateConfig.mintAddress,
          tokenProgram: 'Tokenkeg111',
          decimals: 6,
          balanceRaw: '1000000000000',
          balanceUiString: '1000000',
          rpcProvider: 'helius',
        }),
      },
      userModel: {
        createWalletOnly: async (payload) => {
          createdUsers.push(payload);
          return {
            id: 45,
            username: payload.username,
            email: 'wallet_discount@wallet.local',
            role: 'user',
            is_active: true,
            is_email_verified: true,
            access_status: 'inactive',
            access_source: 'manual',
            access_expires_at: null,
          };
        },
      },
      walletModel: {
        findByWalletAddress: async () => null,
        createLink: async (payload) => {
          createdWallets.push(payload);
          return { id: 10, userId: payload.userId, walletAddress: payload.walletAddress };
        },
      },
      snapshotModel: {
        createSnapshot: async (payload) => {
          snapshots.push(payload);
          return payload;
        },
      },
    });

    assert.equal(result.mode, 'created_wallet_discount_user');
    assert.equal(result.tokenAccessEligible, false);
    assert.equal(result.tokenDiscountEligible, true);
    assert.equal(result.access.hasProductAccess, false);
    assert.equal(result.access.denialCode, 'access_inactive');
    assert.equal(result.access.tokenTier, 'discount_50');
    assert.equal(result.access.discountPercent, 50);
    assert.equal(createdUsers[0].username, `user_${walletAddress.slice(-4)}`);
    assert.equal(createdWallets[0].userId, 45);
    assert.equal(snapshots[0].tier, 'discount_50');
    assert.deepEqual(fakeClient.calls, ['BEGIN', 'COMMIT', 'release']);
  });

  it('links an unused wallet to an authenticated account and snapshots discount tier', async () => {
    const { privateKey, walletAddress } = createSolanaKeypair();
    const message = 'TrendScope Wallet Login link wallet';
    const signature = crypto.sign(null, Buffer.from(message), privateKey);
    const fakeClient = createFakeClient();
    const createdWallets = [];
    const snapshots = [];

    const result = await walletAuthService.linkWalletForUser({
      id: 77,
      username: 'paid_user',
      email: 'paid@test.com',
      role: 'user',
      is_active: true,
      is_email_verified: true,
      access_status: 'active',
      access_source: 'payment',
      access_expires_at: '2026-07-01T00:00:00.000Z',
    }, {
      walletAddress,
      message,
      signature: walletAuthService.__private.encodeBase58(signature),
      walletProvider: 'phantom',
      now: new Date('2026-06-23T12:00:00.000Z'),
    }, {
      config: gateConfig,
      getClient: async () => fakeClient,
      challengeModel: {
        findValidByMessage: async () => ({ id: 14 }),
        consume: async () => ({ id: 14 }),
      },
      balanceProvider: {
        providerName: 'helius',
        getWalletTokenBalance: async () => ({
          walletAddress,
          mintAddress: gateConfig.mintAddress,
          decimals: 6,
          balanceRaw: '1000000000000',
          balanceUiString: '1000000',
          rpcProvider: 'helius',
        }),
      },
      walletModel: {
        findByWalletAddress: async () => null,
        findByUserId: async () => null,
        createLink: async (payload) => {
          createdWallets.push(payload);
          return { id: 15, userId: payload.userId, walletAddress: payload.walletAddress };
        },
      },
      snapshotModel: {
        createSnapshot: async (payload) => {
          snapshots.push(payload);
          return payload;
        },
      },
    });

    assert.equal(result.mode, 'linked_wallet');
    assert.equal(result.wallet.userId, 77);
    assert.equal(result.tokenSnapshot.tier, 'discount_50');
    assert.equal(result.tokenSnapshot.discountPercent, 50);
    assert.equal(result.access.hasProductAccess, true);
    assert.equal(result.access.accessReason, 'payment');
    assert.equal(result.access.tokenTier, 'discount_50');
    assert.equal(createdWallets[0].metadata.authMethod, 'authenticated_link');
    assert.equal(snapshots[0].balanceRaw, '1000000000000');
    assert.deepEqual(fakeClient.calls, ['BEGIN', 'COMMIT', 'release']);
  });

  it('rejects linking a wallet that belongs to another account', async () => {
    const { privateKey, walletAddress } = createSolanaKeypair();
    const message = 'TrendScope Wallet Login conflicting wallet';
    const signature = crypto.sign(null, Buffer.from(message), privateKey);

    await assert.rejects(
      () => walletAuthService.linkWalletForUser({
        id: 77,
        username: 'paid_user',
        role: 'user',
        is_active: true,
        access_status: 'active',
      }, {
        walletAddress,
        message,
        signature: Array.from(signature),
      }, {
        config: gateConfig,
        challengeModel: {
          findValidByMessage: async () => ({ id: 15 }),
          consume: async () => ({ id: 15 }),
        },
        walletModel: {
          findByWalletAddress: async () => ({ id: 99, userId: 88, walletAddress }),
        },
      }),
      /already linked to another account/
    );
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const userWallet = require('../src/models/user-wallet');
const walletAuthChallenge = require('../src/models/wallet-auth-challenge');
const tokenHoldingSnapshot = require('../src/models/token-holding-snapshot');
const stage44 = require('../src/utils/db-init-stage44');

function createRunner(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    },
  };
}

describe('token-gated wallet model foundation', () => {
  it('declares the wallet access tables in stage 44', () => {
    const joined = stage44.STATEMENTS.join('\n');

    assert.match(joined, /CREATE TABLE IF NOT EXISTS user_wallets/);
    assert.match(joined, /CREATE TABLE IF NOT EXISTS wallet_auth_challenges/);
    assert.match(joined, /CREATE TABLE IF NOT EXISTS token_holding_snapshots/);
    assert.match(joined, /idx_user_wallets_wallet_address/);
    assert.match(joined, /idx_user_wallets_user_id/);
  });

  it('creates a one-wallet link with normalized defaults', async () => {
    const row = {
      id: 7,
      user_id: 3,
      wallet_address: 'Wallet1111111111111111111111111111111111111',
      chain: 'solana',
      wallet_provider: 'phantom',
      is_primary: true,
      linked_at: '2026-06-23T12:00:00.000Z',
      last_login_at: null,
      last_verified_at: null,
      metadata: { source: 'test' },
    };
    const runner = createRunner(row);

    const link = await userWallet.createLink({
      userId: 3,
      walletAddress: ' Wallet1111111111111111111111111111111111111 ',
      walletProvider: 'phantom',
      metadata: { source: 'test' },
    }, runner);

    assert.equal(runner.calls[0].params[1], 'Wallet1111111111111111111111111111111111111');
    assert.equal(runner.calls[0].params[2], 'solana');
    assert.equal(runner.calls[0].params[4], true);
    assert.equal(link.userId, 3);
    assert.equal(link.walletProvider, 'phantom');
  });

  it('hashes wallet auth challenge nonce and message before storage', async () => {
    const expiresAt = '2026-06-23T12:05:00.000Z';
    const row = {
      id: 11,
      wallet_address: 'Wallet2222222222222222222222222222222222222',
      nonce_hash: walletAuthChallenge.hashValue('nonce-1'),
      message_hash: walletAuthChallenge.hashValue('message-1'),
      issued_at: '2026-06-23T12:00:00.000Z',
      expires_at: expiresAt,
      consumed_at: null,
      ip_address: '127.0.0.1',
      user_agent: 'test',
    };
    const runner = createRunner(row);

    const challenge = await walletAuthChallenge.create({
      walletAddress: row.wallet_address,
      nonce: 'nonce-1',
      message: 'message-1',
      expiresAt,
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    }, runner);

    assert.equal(runner.calls[0].params[1], walletAuthChallenge.hashValue('nonce-1'));
    assert.equal(runner.calls[0].params[2], walletAuthChallenge.hashValue('message-1'));
    assert.equal(challenge.nonce, 'nonce-1');
    assert.equal(challenge.record.id, 11);
  });

  it('stores token balances as raw integer strings', async () => {
    const row = {
      id: 19,
      user_id: 3,
      wallet_address: 'Wallet3333333333333333333333333333333333333',
      mint_address: 'Mint11111111111111111111111111111111111111111',
      token_program: 'Tokenkeg111',
      decimals: 6,
      balance_raw: '2000000000000',
      balance_ui_string: '2000000',
      tier: 'unlimited',
      discount_percent: 50,
      has_unlimited_access: true,
      has_launch_promo_access: false,
      checked_at: '2026-06-23T12:00:00.000Z',
      expires_at: '2026-06-23T12:01:00.000Z',
      rpc_provider: 'helius',
      rpc_slot: '123',
      rpc_error: null,
      metadata: { snapshot: true },
    };
    const runner = createRunner(row);

    const snapshot = await tokenHoldingSnapshot.createSnapshot({
      userId: 3,
      walletAddress: row.wallet_address,
      mintAddress: row.mint_address,
      tokenProgram: 'Tokenkeg111',
      decimals: 6,
      balanceRaw: 2000000000000n,
      balanceUiString: '2000000',
      tier: 'unlimited',
      discountPercent: 50,
      hasUnlimitedAccess: true,
      expiresAt: row.expires_at,
      rpcProvider: 'helius',
      rpcSlot: 123,
      metadata: { snapshot: true },
    }, runner);

    assert.equal(runner.calls[0].params[5], '2000000000000');
    assert.equal(snapshot.balanceRaw, '2000000000000');
    assert.equal(snapshot.tier, 'unlimited');
    assert.equal(snapshot.hasUnlimitedAccess, true);
  });

  it('rejects non-integer raw balances', () => {
    assert.throws(
      () => tokenHoldingSnapshot.normalizeBalanceRaw('1.5'),
      /Invalid raw token balance/
    );
  });
});

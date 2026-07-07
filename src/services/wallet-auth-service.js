const crypto = require('crypto');
const config = require('../../config');
const User = require('../models/user');
const UserWallet = require('../models/user-wallet');
const WalletAuthChallenge = require('../models/wallet-auth-challenge');
const TokenHoldingSnapshot = require('../models/token-holding-snapshot');
const tokenHoldingService = require('./token-holding-service');
const tokenGateWebhookSync = require('./token-gate-webhook-sync-service');
const userAccess = require('../models/user-access');
const { getClient } = require('../models/db');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((char, index) => [char, BigInt(index)]));
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeBase58(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('Base58 value is required');
  }

  let decoded = 0n;
  for (const char of raw) {
    const digit = BASE58_MAP.get(char);
    if (digit == null) {
      throw new Error('Invalid base58 value');
    }
    decoded = decoded * 58n + digit;
  }

  let hex = decoded.toString(16);
  if (hex.length % 2) {
    hex = `0${hex}`;
  }
  const body = decoded === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  const leadingZeroes = raw.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(leadingZeroes), body]);
}

function encodeBase58(bytes) {
  const buffer = Buffer.from(bytes || []);
  let value = BigInt(`0x${buffer.toString('hex') || '0'}`);
  let encoded = '';
  while (value > 0n) {
    const mod = value % 58n;
    encoded = BASE58_ALPHABET[Number(mod)] + encoded;
    value /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function normalizeWalletAddress(walletAddress) {
  const normalized = String(walletAddress || '').trim();
  const publicKey = decodeBase58(normalized);
  if (publicKey.length !== 32) {
    throw Object.assign(new Error('Invalid Solana wallet address'), { status: 400 });
  }
  return normalized;
}

function decodeSignature(value) {
  if (Array.isArray(value)) {
    return Buffer.from(value);
  }
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw Object.assign(new Error('Signature is required'), { status: 400 });
  }
  try {
    return decodeBase58(normalized);
  } catch (_) {
    return Buffer.from(normalized, 'base64');
  }
}

function verifyEd25519Signature({ walletAddress, message, signature }) {
  const publicKeyBytes = decodeBase58(normalizeWalletAddress(walletAddress));
  const signatureBytes = decodeSignature(signature);
  if (signatureBytes.length !== 64) {
    return false;
  }
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, Buffer.from(String(message || ''), 'utf8'), publicKey, signatureBytes);
}

function buildChallengeMessage({ walletAddress, nonce, issuedAt, expiresAt }) {
  return [
    'TrendScope Wallet Login',
    '',
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
    'Purpose: Sign in to the Volume Bot Alert app.',
  ].join('\n');
}

async function createChallenge(input = {}, deps = {}) {
  tokenHoldingService.__private.assertEnabledConfig(deps.config || config.tokenGate);
  const walletAddress = normalizeWalletAddress(input.walletAddress);
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const issuedAt = now.toISOString();
  const nonce = crypto.randomBytes(24).toString('hex');
  const message = buildChallengeMessage({ walletAddress, nonce, issuedAt, expiresAt });
  const challengeModel = deps.challengeModel || WalletAuthChallenge;

  await challengeModel.create({
    walletAddress,
    nonce,
    message,
    issuedAt,
    expiresAt,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return {
    walletAddress,
    message,
    issuedAt,
    expiresAt,
  };
}

function getWalletUsernameBase(walletAddress) {
  return `user_${String(walletAddress || '').trim().slice(-4)}`;
}

async function createWalletOnlyUser(walletAddress, runner, deps = {}) {
  const userModel = deps.userModel || User;
  const base = getWalletUsernameBase(walletAddress);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const username = attempt === 0 ? base : `${base}_${attempt + 1}`;
    try {
      return await userModel.createWalletOnly({ username, walletAddress }, runner);
    } catch (err) {
      if (err.status !== 409 || !/Username already taken/i.test(err.message)) {
        throw err;
      }
    }
  }
  throw Object.assign(new Error('Could not allocate wallet username'), { status: 409 });
}

function serializeWalletAuthResult({ user, wallet, snapshot, access, mode }) {
  return {
    mode,
    user: user ? {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      isActive: Boolean(user.is_active),
      isEmailVerified: Boolean(user.is_email_verified),
    } : null,
    wallet,
    tokenSnapshot: snapshot,
    access,
    tokenAccessEligible: Boolean(snapshot?.hasUnlimitedAccess || snapshot?.hasLaunchPromoAccess),
    tokenDiscountEligible: Number(snapshot?.discountPercent) > 0,
    requiresAccessResolver: false,
  };
}

async function verifyWalletSignature(input = {}, deps = {}) {
  const { walletAddress } = await verifyChallengeSignature(input, deps);

  const walletModel = deps.walletModel || UserWallet;
  const snapshotModel = deps.snapshotModel;
  const existingWallet = await walletModel.findByWalletAddress(walletAddress);
  if (existingWallet) {
    return verifyExistingWallet({ walletAddress, existingWallet, input, deps, snapshotModel });
  }
  return verifyNewWallet({ walletAddress, input, deps, walletModel, snapshotModel });
}

async function verifyChallengeSignature(input = {}, deps = {}) {
  const walletAddress = normalizeWalletAddress(input.walletAddress);
  const message = String(input.message || '').trim();
  if (!message) {
    throw Object.assign(new Error('Challenge message is required'), { status: 400 });
  }

  const challengeModel = deps.challengeModel || WalletAuthChallenge;
  const challenge = await challengeModel.findValidByMessage(walletAddress, message);
  if (!challenge) {
    throw Object.assign(new Error('Wallet challenge is invalid or expired'), { status: 400 });
  }
  if (!verifyEd25519Signature({ walletAddress, message, signature: input.signature })) {
    throw Object.assign(new Error('Wallet signature is invalid'), { status: 401 });
  }
  await challengeModel.consume(challenge.id);
  return { walletAddress, message, challenge };
}

async function verifyExistingWallet({ walletAddress, existingWallet, input, deps, snapshotModel }) {
  const userModel = deps.userModel || User;
  const user = await userModel.findById(existingWallet.userId);
  if (!user || !user.is_active) {
    throw Object.assign(new Error('Account is deactivated'), { status: 403 });
  }

  const snapshot = await tokenHoldingService.refreshSnapshotForUser({
    userId: user.id,
    walletAddress,
    now: input.now,
  }, { ...deps, snapshotModel });
  await (deps.walletModel || UserWallet).markLastLogin(existingWallet.id);
  await (deps.walletModel || UserWallet).markVerified(existingWallet.id);

  return serializeWalletAuthResult({
    user,
    wallet: existingWallet,
    snapshot,
    access: userAccess.mergeTokenAccess(userAccess.buildAccessSnapshot(user, input.now || new Date()), snapshot, input.now || new Date(), deps.config || config.tokenGate),
    mode: 'existing_wallet',
  });
}

async function verifyNewWallet({ walletAddress, input, deps, walletModel, snapshotModel }) {
  const evaluation = await tokenHoldingService.evaluateWallet({
    walletAddress,
    now: input.now,
  }, deps);
  const hasTokenAccess = evaluation.tier.hasUnlimitedAccess || evaluation.tier.hasLaunchPromoAccess;
  const hasTokenDiscount = Number(evaluation.tier.discountPercent) > 0;
  if (!hasTokenAccess && !hasTokenDiscount) {
    return serializeWalletAuthResult({
      snapshot: {
        ...evaluation.balance,
        ...evaluation.tier,
      },
      mode: 'insufficient_balance',
    });
  }

  const clientFactory = deps.getClient || getClient;
  const client = await clientFactory();
  try {
    await client.query('BEGIN');
    const user = await createWalletOnlyUser(walletAddress, client, deps);
    const wallet = await walletModel.createLink({
      userId: user.id,
      walletAddress,
      walletProvider: input.walletProvider,
      metadata: { authMethod: 'wallet' },
    }, client);
    const checkedAt = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
    const snapshot = await tokenHoldingService.createSnapshotFromEvaluation({
      userId: user.id,
      evaluation,
      checkedAt,
      expiresAt: tokenHoldingService.__private.buildExpiresAt(checkedAt, deps.config || config.tokenGate),
    }, {
      createSnapshot: (payload) => (snapshotModel || TokenHoldingSnapshot).createSnapshot(payload, client),
    });
    await client.query('COMMIT');
    tokenGateWebhookSync.queueLinkedWalletSync();

    return serializeWalletAuthResult({
      user,
      wallet,
      snapshot,
      access: userAccess.mergeTokenAccess(userAccess.buildAccessSnapshot(user, checkedAt), snapshot, checkedAt, deps.config || config.tokenGate),
      mode: hasTokenAccess ? 'created_wallet_user' : 'created_wallet_discount_user',
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release?.();
  }
}

async function linkWalletForUser(user, input = {}, deps = {}) {
  assertLinkableUser(user);
  const { walletAddress } = await verifyChallengeSignature(input, deps);
  const walletModel = deps.walletModel || UserWallet;
  const snapshotModel = deps.snapshotModel;
  const existingWallet = await walletModel.findByWalletAddress(walletAddress);

  assertWalletLinkOwnership(user, existingWallet);
  if (existingWallet) {
    return refreshLinkedWallet({ user, walletAddress, existingWallet, input, deps, walletModel, snapshotModel });
  }

  await assertAccountHasNoWallet(user, walletModel);
  return createAuthenticatedWalletLink({ user, walletAddress, input, deps, walletModel, snapshotModel });
}

function assertLinkableUser(user) {
  if (!user?.id || !user.is_active) {
    throw Object.assign(new Error('Authenticated active account is required'), { status: 401 });
  }
}

function assertWalletLinkOwnership(user, existingWallet) {
  if (existingWallet && Number(existingWallet.userId) !== Number(user.id)) {
    throw Object.assign(new Error('Wallet is already linked to another account'), { status: 409 });
  }
}

async function assertAccountHasNoWallet(user, walletModel) {
  const currentWallet = await walletModel.findByUserId(user.id);
  if (currentWallet) {
    throw Object.assign(new Error('Account already has a linked wallet'), { status: 409 });
  }
}

async function refreshLinkedWallet({ user, walletAddress, existingWallet, input, deps, walletModel, snapshotModel }) {
  const snapshot = await tokenHoldingService.refreshSnapshotForUser({
    userId: user.id,
    walletAddress,
    now: input.now,
  }, { ...deps, snapshotModel });
  await walletModel.markVerified(existingWallet.id);
  return serializeWalletAuthResult({
    user,
    wallet: existingWallet,
    snapshot,
    access: userAccess.mergeTokenAccess(userAccess.buildAccessSnapshot(user, input.now || new Date()), snapshot, input.now || new Date(), deps.config || config.tokenGate),
    mode: 'wallet_already_linked',
  });
}

async function createAuthenticatedWalletLink({ user, walletAddress, input, deps, walletModel, snapshotModel }) {
  const evaluation = await tokenHoldingService.evaluateWallet({
    walletAddress,
    now: input.now,
  }, deps);
  const clientFactory = deps.getClient || getClient;
  const client = await clientFactory();
  try {
    await client.query('BEGIN');
    const wallet = await walletModel.createLink({
      userId: user.id,
      walletAddress,
      walletProvider: input.walletProvider,
      metadata: { authMethod: 'authenticated_link' },
    }, client);
    const checkedAt = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
    const snapshot = await tokenHoldingService.createSnapshotFromEvaluation({
      userId: user.id,
      evaluation,
      checkedAt,
      expiresAt: tokenHoldingService.__private.buildExpiresAt(checkedAt, deps.config || config.tokenGate),
    }, {
      createSnapshot: (payload) => (snapshotModel || TokenHoldingSnapshot).createSnapshot(payload, client),
    });
    await client.query('COMMIT');
    tokenGateWebhookSync.queueLinkedWalletSync();

    return serializeWalletAuthResult({
      user,
      wallet,
      snapshot,
      access: userAccess.mergeTokenAccess(userAccess.buildAccessSnapshot(user, checkedAt), snapshot, checkedAt, deps.config || config.tokenGate),
      mode: 'linked_wallet',
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release?.();
  }
}

module.exports = {
  createChallenge,
  linkWalletForUser,
  verifyWalletSignature,
  __private: {
    buildChallengeMessage,
    decodeBase58,
    encodeBase58,
    getWalletUsernameBase,
    normalizeWalletAddress,
    verifyEd25519Signature,
  },
};

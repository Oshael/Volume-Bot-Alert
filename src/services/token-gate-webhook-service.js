const config = require('../../config');
const User = require('../models/user');
const userAccess = require('../models/user-access');
const userWallet = require('../models/user-wallet');
const tokenHoldingSnapshot = require('../models/token-holding-snapshot');
const tokenHoldingService = require('./token-holding-service');
const socketHub = require('./socket-hub');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMint(value) {
  return normalizeText(value);
}

function addAddress(addresses, value) {
  const normalized = normalizeText(value);
  if (normalized) {
    addresses.add(normalized);
  }
}

function addTokenTransferAddresses(addresses, transfer = {}, mintAddress) {
  if (normalizeMint(transfer.mint) !== mintAddress) {
    return;
  }

  addAddress(addresses, transfer.fromUserAccount);
  addAddress(addresses, transfer.toUserAccount);
  addAddress(addresses, transfer.userAccount);
  addAddress(addresses, transfer.owner);
}

function addAccountDataAddresses(addresses, accountData = {}, mintAddress) {
  const balanceChanges = Array.isArray(accountData.tokenBalanceChanges)
    ? accountData.tokenBalanceChanges
    : [];

  for (const change of balanceChanges) {
    if (normalizeMint(change?.mint) !== mintAddress) {
      continue;
    }
    addAddress(addresses, change.userAccount);
    addAddress(addresses, change.owner);
    addAddress(addresses, accountData.account);
  }
}

function collectAffectedWalletAddresses(payload, mintAddress) {
  const normalizedMint = normalizeMint(mintAddress);
  if (!normalizedMint) {
    return [];
  }

  const events = Array.isArray(payload) ? payload : [payload];
  const addresses = new Set();

  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue;
    }

    const transfers = Array.isArray(event.tokenTransfers) ? event.tokenTransfers : [];
    for (const transfer of transfers) {
      addTokenTransferAddresses(addresses, transfer, normalizedMint);
    }

    const accountRows = Array.isArray(event.accountData) ? event.accountData : [];
    for (const accountData of accountRows) {
      addAccountDataAddresses(addresses, accountData, normalizedMint);
    }
  }

  return [...addresses];
}

async function refreshWalletAccess(wallet, options = {}) {
  const deps = resolveRefreshDeps(options);
  const now = options.now || new Date();

  const snapshot = await deps.holdingService.refreshSnapshotForUser({
    userId: wallet.userId,
    walletAddress: wallet.walletAddress,
    now,
  }, {
    ...options,
    config: deps.gateConfig,
    snapshotModel: deps.snapshotModel,
  });

  const user = await deps.userModel.findById(wallet.userId);
  const access = await resolveRefreshedAccess(user, now, options, deps);
  revokeSocketsWithoutAccess(wallet.userId, access, deps.hub);

  return {
    walletAddress: wallet.walletAddress,
    userId: wallet.userId,
    tokenTier: snapshot?.tier || 'none',
    hasProductAccess: Boolean(access?.hasProductAccess),
    accessReason: access?.accessReason || 'none',
  };
}

function resolveRefreshDeps(options = {}) {
  return {
    gateConfig: options.config || config.tokenGate || {},
    holdingService: options.tokenHoldingService || tokenHoldingService,
    snapshotModel: options.tokenHoldingSnapshotModel || tokenHoldingSnapshot,
    userModel: options.userModel || User,
    accessModel: options.userAccessModel || userAccess,
    hub: options.socketHub || socketHub,
  };
}

function resolveRefreshedAccess(user, now, options, deps) {
  if (!user) {
    return null;
  }
  return deps.accessModel.buildResolvedAccessSnapshot(user, now, {
    ...options,
    config: deps.gateConfig,
    tokenHoldingSnapshotModel: deps.snapshotModel,
  });
}

function revokeSocketsWithoutAccess(userId, access, hub) {
  if (access && !access.hasProductAccess) {
    hub.revokeUserSockets?.(userId, access.denialCode || 'token_access_lost');
  }
}

async function processHeliusTokenWebhook(payload, options = {}) {
  const gateConfig = options.config || config.tokenGate || {};
  if (!gateConfig.enabled || !gateConfig.mintAddress) {
    return {
      ignored: true,
      reason: 'token_gate_disabled',
      affectedWalletCount: 0,
      refreshedWalletCount: 0,
      revokedUserCount: 0,
    };
  }

  const affectedAddresses = collectAffectedWalletAddresses(payload, gateConfig.mintAddress);
  if (affectedAddresses.length === 0) {
    return {
      ignored: true,
      reason: 'no_matching_token_transfer',
      affectedWalletCount: 0,
      refreshedWalletCount: 0,
      revokedUserCount: 0,
    };
  }

  const walletModel = options.userWalletModel || userWallet;
  const wallets = await walletModel.findByWalletAddresses(affectedAddresses);
  const refreshed = [];

  for (const wallet of wallets) {
    refreshed.push(await refreshWalletAccess(wallet, options));
  }

  return {
    ignored: wallets.length === 0,
    reason: wallets.length === 0 ? 'no_linked_wallet_match' : null,
    affectedWalletCount: affectedAddresses.length,
    refreshedWalletCount: refreshed.length,
    revokedUserCount: refreshed.filter((entry) => !entry.hasProductAccess).length,
    refreshed,
  };
}

module.exports = {
  processHeliusTokenWebhook,
  __private: {
    collectAffectedWalletAddresses,
  },
};

const config = require('../../config');
const tokenHoldingSnapshot = require('../models/token-holding-snapshot');
const { createHeliusTokenBalanceProvider } = require('./token-balance-provider');

const DEFAULT_CONFIG = config.tokenGate || {};

function parseWholeTokenThreshold(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label} must be a whole-token integer`);
  }
  return BigInt(normalized);
}

function thresholdToRaw(value, decimals, label) {
  const places = Number.parseInt(String(decimals ?? ''), 10);
  if (!Number.isInteger(places) || places < 0) {
    throw new Error('Token decimals must be a non-negative integer');
  }
  return parseWholeTokenThreshold(value, label) * (10n ** BigInt(places));
}

function parseRawBalance(value) {
  const normalized = typeof value === 'bigint' ? value.toString() : String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('Raw token balance must be an integer string');
  }
  return BigInt(normalized);
}

function isWithinLaunchPromo(now, launchPromo = {}) {
  if (!launchPromo.enabled || !launchPromo.startAt || !launchPromo.endAt) {
    return false;
  }
  const ts = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const start = new Date(launchPromo.startAt).getTime();
  const end = new Date(launchPromo.endAt).getTime();
  return Number.isFinite(ts) && Number.isFinite(start) && Number.isFinite(end) && ts >= start && ts <= end;
}

function normalizeDiscountTierName(value, discountPercent) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw) {
    return raw.slice(0, 32);
  }
  return `discount_${discountPercent}`;
}

function getConfiguredDiscountTiers(gateConfig = DEFAULT_CONFIG) {
  if (Array.isArray(gateConfig.discountTiers) && gateConfig.discountTiers.length > 0) {
    return [...gateConfig.discountTiers].sort((left, right) => {
      const leftValue = parseWholeTokenThreshold(left.threshold, 'Discount threshold');
      const rightValue = parseWholeTokenThreshold(right.threshold, 'Discount threshold');
      if (leftValue === rightValue) return 0;
      return leftValue > rightValue ? -1 : 1;
    });
  }

  const discountPercent = Math.max(0, Number(gateConfig.discountPercent) || 0);
  if (discountPercent <= 0) {
    return [];
  }

  return [{
    threshold: gateConfig.discountThreshold,
    discountPercent,
    tier: `discount_${discountPercent}`,
  }];
}

function resolveDiscountTier(balanceRaw, decimals, gateConfig = DEFAULT_CONFIG) {
  for (const tier of getConfiguredDiscountTiers(gateConfig)) {
    const discountPercent = Math.max(0, Number(tier.discountPercent) || 0);
    if (discountPercent <= 0) {
      continue;
    }
    const thresholdRaw = thresholdToRaw(tier.threshold, decimals, 'Discount threshold');
    if (balanceRaw >= thresholdRaw) {
      return {
        tier: normalizeDiscountTierName(tier.tier, discountPercent),
        discountPercent,
        thresholdRaw: thresholdRaw.toString(),
      };
    }
  }
  return {
    tier: 'none',
    discountPercent: 0,
    thresholdRaw: null,
  };
}

function evaluateTier(input = {}, gateConfig = DEFAULT_CONFIG) {
  const decimals = Number.parseInt(String(input.decimals ?? ''), 10);
  const balanceRaw = parseRawBalance(input.balanceRaw);
  const unlimitedRaw = thresholdToRaw(gateConfig.unlimitedThreshold, decimals, 'Unlimited threshold');
  const discountTier = resolveDiscountTier(balanceRaw, decimals, gateConfig);
  const launchPromoRaw = thresholdToRaw(gateConfig.launchPromo?.threshold || '0', decimals, 'Launch promo threshold');
  const hasUnlimitedAccess = balanceRaw >= unlimitedRaw;
  const discountPercent = discountTier.discountPercent;
  const hasLaunchPromoAccess = !hasUnlimitedAccess
    && isWithinLaunchPromo(input.now || new Date(), gateConfig.launchPromo)
    && balanceRaw >= launchPromoRaw;

  let tier = 'none';
  if (hasUnlimitedAccess) {
    tier = 'unlimited';
  } else if (hasLaunchPromoAccess) {
    tier = 'launch_free';
  } else if (discountPercent > 0) {
    tier = discountTier.tier;
  }

  return {
    tier,
    discountPercent,
    hasUnlimitedAccess,
    hasLaunchPromoAccess,
    thresholds: {
      unlimitedRaw: unlimitedRaw.toString(),
      discountRaw: discountTier.thresholdRaw,
      launchPromoRaw: launchPromoRaw.toString(),
    },
  };
}

function assertEnabledConfig(gateConfig = DEFAULT_CONFIG) {
  if (!gateConfig.enabled) {
    throw Object.assign(new Error('Token gate is disabled'), { status: 503 });
  }
  if (gateConfig.chain !== 'solana') {
    throw Object.assign(new Error('Unsupported token gate chain'), { status: 400 });
  }
  if (!gateConfig.mintAddress) {
    throw Object.assign(new Error('TOKEN_GATE_MINT_ADDRESS is required'), { status: 500 });
  }
}

function getBalanceProvider(gateConfig = DEFAULT_CONFIG, deps = {}) {
  if (deps.balanceProvider) {
    return deps.balanceProvider;
  }
  if (gateConfig.rpcProvider !== 'helius') {
    throw Object.assign(new Error('Unsupported token gate RPC provider'), { status: 500 });
  }
  return createHeliusTokenBalanceProvider({ heliusApi: deps.heliusApi });
}

function buildExpiresAt(now, gateConfig = DEFAULT_CONFIG) {
  const cacheSeconds = Math.max(1, Number(gateConfig.balanceCacheSeconds) || 60);
  return new Date(now.getTime() + cacheSeconds * 1000).toISOString();
}

async function refreshSnapshotForUser(input = {}, deps = {}) {
  const gateConfig = deps.config || DEFAULT_CONFIG;
  assertEnabledConfig(gateConfig);

  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const evaluation = await evaluateWallet({
    walletAddress: input.walletAddress,
    mintAddress: input.mintAddress || gateConfig.mintAddress,
    now,
  }, deps);
  const snapshotStore = deps.snapshotModel || tokenHoldingSnapshot;

  return createSnapshotFromEvaluation({
    userId: input.userId,
    evaluation,
    checkedAt: now,
    expiresAt: buildExpiresAt(now, gateConfig),
  }, snapshotStore);
}

async function evaluateWallet(input = {}, deps = {}) {
  const gateConfig = deps.config || DEFAULT_CONFIG;
  assertEnabledConfig(gateConfig);

  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const provider = getBalanceProvider(gateConfig, deps);
  const balance = await provider.getWalletTokenBalance({
    walletAddress: input.walletAddress,
    mintAddress: input.mintAddress || gateConfig.mintAddress,
  });
  const tier = evaluateTier({ ...balance, now }, gateConfig);

  return {
    balance,
    tier,
    rpcProvider: balance.rpcProvider || provider.providerName || gateConfig.rpcProvider,
  };
}

async function createSnapshotFromEvaluation(input = {}, snapshotStore = tokenHoldingSnapshot) {
  const evaluation = input.evaluation || {};
  const balance = evaluation.balance || {};
  const tier = evaluation.tier || {};

  return snapshotStore.createSnapshot({
    userId: input.userId,
    walletAddress: balance.walletAddress,
    mintAddress: balance.mintAddress,
    tokenProgram: balance.tokenProgram,
    decimals: balance.decimals,
    balanceRaw: balance.balanceRaw,
    balanceUiString: balance.balanceUiString,
    tier: tier.tier,
    discountPercent: tier.discountPercent,
    hasUnlimitedAccess: tier.hasUnlimitedAccess,
    hasLaunchPromoAccess: tier.hasLaunchPromoAccess,
    checkedAt: input.checkedAt instanceof Date ? input.checkedAt.toISOString() : input.checkedAt,
    expiresAt: input.expiresAt,
    rpcProvider: evaluation.rpcProvider || balance.rpcProvider || null,
    rpcSlot: balance.rpcSlot,
    metadata: {
      thresholds: tier.thresholds,
    },
  });
}

module.exports = {
  createSnapshotFromEvaluation,
  evaluateWallet,
  evaluateTier,
  refreshSnapshotForUser,
  thresholdToRaw,
  __private: {
    assertEnabledConfig,
    buildExpiresAt,
    getBalanceProvider,
    getConfiguredDiscountTiers,
    isWithinLaunchPromo,
    parseRawBalance,
    parseWholeTokenThreshold,
    resolveDiscountTier,
  },
};

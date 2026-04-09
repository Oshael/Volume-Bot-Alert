function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMetric(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Number(parsed.toFixed(digits));
}

function parseUiAmount(value, amount, decimals) {
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const rawAmount = Number(amount);
  const rawDecimals = Number(decimals);
  if (!Number.isFinite(rawAmount) || !Number.isFinite(rawDecimals)) {
    return null;
  }

  return rawAmount / (10 ** rawDecimals);
}

function parseHolderCount(asset, tokenAccounts) {
  const tokenAccountsTotal = toNumberOrNull(tokenAccounts?.total);
  if (tokenAccountsTotal != null && tokenAccountsTotal >= 0) {
    return Math.trunc(tokenAccountsTotal);
  }

  const candidates = [
    asset?.token_info?.holder_count,
    asset?.token_info?.holders,
    asset?.token_info?.num_holders,
    asset?.ownership?.holder_count,
  ];

  for (const candidate of candidates) {
    const parsed = toNumberOrNull(candidate);
    if (parsed != null && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }

  return null;
}

function extractAuthorities(asset) {
  const tokenInfo = asset?.token_info || {};
  const mintAuthority = String(tokenInfo.mint_authority || '').trim() || null;
  const freezeAuthority = String(tokenInfo.freeze_authority || '').trim() || null;

  return {
    mintAuthority,
    freezeAuthority,
    mintAuthorityActive: Boolean(mintAuthority),
    freezeAuthorityActive: Boolean(freezeAuthority),
  };
}

function normalizeLargestAccounts(largestAccountsResult) {
  const rows = Array.isArray(largestAccountsResult?.value)
    ? largestAccountsResult.value
    : [];

  return rows
    .map((row) => {
      const address = String(row?.address || '').trim();
      if (!address) {
        return null;
      }

      const uiAmount = parseUiAmount(
        row?.uiAmountString ?? row?.uiAmount,
        row?.amount,
        row?.decimals
      );

      return {
        address,
        amount: String(row?.amount || '').trim() || null,
        decimals: toNumberOrNull(row?.decimals),
        uiAmount,
      };
    })
    .filter(Boolean);
}

function extractSupplyInfo(tokenSupplyResult, asset) {
  const supplyValue = tokenSupplyResult?.value || {};
  const tokenInfo = asset?.token_info || {};
  const uiAmount = parseUiAmount(
    supplyValue.uiAmountString ?? supplyValue.uiAmount,
    supplyValue.amount,
    supplyValue.decimals
  );
  const decimals = toNumberOrNull(supplyValue.decimals ?? tokenInfo.decimals);

  return {
    amount: String(supplyValue.amount || '').trim() || null,
    decimals,
    uiAmount,
    tokenProgram: String(tokenInfo.token_program || '').trim() || null,
  };
}

function computeTopPercentages(largestAccounts, totalSupplyUiAmount) {
  const totalSupply = Number(totalSupplyUiAmount);
  if (!Number.isFinite(totalSupply) || !(totalSupply > 0)) {
    return {
      top1Pct: null,
      top5Pct: null,
      top10Pct: null,
      top20Pct: null,
    };
  }

  const sorted = [...largestAccounts]
    .filter((row) => Number.isFinite(row.uiAmount))
    .sort((left, right) => right.uiAmount - left.uiAmount);

  const sumTopN = (count) => sorted
    .slice(0, count)
    .reduce((sum, row) => sum + row.uiAmount, 0);

  return {
    top1Pct: roundMetric((sumTopN(1) / totalSupply) * 100),
    top5Pct: roundMetric((sumTopN(5) / totalSupply) * 100),
    top10Pct: roundMetric((sumTopN(10) / totalSupply) * 100),
    top20Pct: roundMetric((sumTopN(20) / totalSupply) * 100),
  };
}

function buildConcentrationReasonCodes(percentages, thresholds) {
  const reasonCodes = [];

  if ((percentages.top10Pct || 0) >= thresholds.top10HighPct) {
    reasonCodes.push('top_10_concentration_high');
  }
  if ((percentages.top20Pct || 0) >= thresholds.top20HighPct) {
    reasonCodes.push('top_20_concentration_high');
  }

  return reasonCodes;
}

function buildAuthorityReasonCodes(authorities) {
  const reasonCodes = [];

  if (authorities.mintAuthorityActive) {
    reasonCodes.push('mint_authority_active');
  }
  if (authorities.freezeAuthorityActive) {
    reasonCodes.push('freeze_authority_active');
  }

  return reasonCodes;
}

function normalizeStructuralThresholds(options = {}) {
  return {
    top10HighPct: Math.max(0, Number(options.top10HighPct) || 70),
    top20HighPct: Math.max(0, Number(options.top20HighPct) || 85),
  };
}

function buildStructuralSignals(payload = {}, options = {}) {
  const thresholds = normalizeStructuralThresholds(options);
  const asset = payload.asset || null;
  const holderCount = parseHolderCount(asset, payload.tokenAccounts || null);
  const authorities = extractAuthorities(asset);
  const largestAccounts = normalizeLargestAccounts(payload.largestAccounts || null);
  const supply = extractSupplyInfo(payload.tokenSupply || null, asset);
  const topPercentages = computeTopPercentages(largestAccounts, supply.uiAmount);
  const topHolders = largestAccounts.slice(0, 20).map((row) => ({
    address: row.address,
    uiAmount: row.uiAmount,
    pctOfSupply: supply.uiAmount > 0 && row.uiAmount != null
      ? roundMetric((row.uiAmount / supply.uiAmount) * 100)
      : null,
  }));

  const reasonCodes = [
    ...buildAuthorityReasonCodes(authorities),
    ...buildConcentrationReasonCodes(topPercentages, thresholds),
  ];

  return {
    holderCount,
    supply,
    mintAuthority: authorities.mintAuthority,
    freezeAuthority: authorities.freezeAuthority,
    mintAuthorityActive: authorities.mintAuthorityActive,
    freezeAuthorityActive: authorities.freezeAuthorityActive,
    top1Pct: topPercentages.top1Pct,
    top5Pct: topPercentages.top5Pct,
    top10Pct: topPercentages.top10Pct,
    top20Pct: topPercentages.top20Pct,
    topHolders,
    reasonCodes,
  };
}

module.exports = {
  buildStructuralSignals,
  __private: {
    buildAuthorityReasonCodes,
    buildConcentrationReasonCodes,
    computeTopPercentages,
    extractAuthorities,
    extractSupplyInfo,
    normalizeLargestAccounts,
    normalizeStructuralThresholds,
    parseHolderCount,
    parseUiAmount,
    roundMetric,
    toNumberOrNull,
  },
};

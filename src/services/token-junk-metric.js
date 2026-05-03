function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildHolderThresholds(options, key, fallback) {
  return fallback.map((entry) => ({
    minMcap: entry.minMcap,
    maxHolderCount: Math.max(0, Math.trunc(toNumberOrNull(options?.[key]?.[entry.minMcap]) ?? entry.maxHolderCount)),
  }));
}

function normalizeStructuralOptions(options = {}) {
  return {
    meteoraIndicatorMinMcap: Math.max(0, toNumberOrNull(options.meteoraIndicatorMinMcap) ?? 400000),
    permanentStrongSignalThreshold: Math.max(1, Math.trunc(toNumberOrNull(options.permanentStrongSignalThreshold) ?? 3)),
    weakHolderThresholds: buildHolderThresholds(options, 'weakHolderThresholdsByMcap', [
      { minMcap: 1000000, maxHolderCount: 150 },
      { minMcap: 400000, maxHolderCount: 90 },
      { minMcap: 100000, maxHolderCount: 50 },
    ]),
    strongHolderThresholds: buildHolderThresholds(options, 'strongHolderThresholdsByMcap', [
      { minMcap: 4000000, maxHolderCount: 120 },
      { minMcap: 1000000, maxHolderCount: 80 },
      { minMcap: 400000, maxHolderCount: 60 },
      { minMcap: 100000, maxHolderCount: 30 },
    ]),
    highTop10Pct: Math.max(0, toNumberOrNull(options.highTop10Pct) ?? 70),
    highTop20Pct: Math.max(0, toNumberOrNull(options.highTop20Pct) ?? 85),
    extremeTop10Pct: Math.max(0, toNumberOrNull(options.extremeTop10Pct) ?? 85),
    extremeTop20Pct: Math.max(0, toNumberOrNull(options.extremeTop20Pct) ?? 95),
  };
}

function resolveNonNegativeOption(options, key, fallback) {
  return Math.max(0, toNumberOrNull(options[key]) ?? fallback);
}

function resolveMinOneOption(options, key, fallback) {
  return Math.max(1, toNumberOrNull(options[key]) ?? fallback);
}

function resolveNonNegativeIntegerOption(options, key, fallback) {
  return Math.max(0, Math.trunc(toNumberOrNull(options[key]) ?? fallback));
}

function normalizeBehavioralOptions(options = {}) {
  return {
    deadVolume1h: resolveNonNegativeOption(options, 'deadVolume1h', 100),
    deadVolume6h: resolveNonNegativeOption(options, 'deadVolume6h', 1500),
    lowVolToMcapMinMcap: resolveNonNegativeOption(options, 'lowVolToMcapMinMcap', 400000),
    lowVolToMcapRatio: resolveNonNegativeOption(options, 'lowVolToMcapRatio', 0.05),
    lowLiquidityToMcapMinMcap: resolveNonNegativeOption(options, 'lowLiquidityToMcapMinMcap', 150000),
    lowLiquidityToMcapRatio: resolveNonNegativeOption(options, 'lowLiquidityToMcapRatio', 0.05),
    minBuySellTxns24h: resolveNonNegativeIntegerOption(options, 'minBuySellTxns24h', 24),
    highBuySellImbalanceRatio: resolveMinOneOption(options, 'highBuySellImbalanceRatio', 3),
    extremeBuySellImbalanceRatio: resolveMinOneOption(options, 'extremeBuySellImbalanceRatio', 8),
    minDeadVolumeTxns24h: resolveNonNegativeIntegerOption(options, 'minDeadVolumeTxns24h', 30),
    extremePriceChange24hPct: resolveNonNegativeOption(options, 'extremePriceChange24hPct', 120),
    extremePriceChange6hPct: resolveNonNegativeOption(options, 'extremePriceChange6hPct', 60),
    microcapDeadMarketMaxMcap: resolveNonNegativeOption(options, 'microcapDeadMarketMaxMcap', 100000),
    microcapDeadVolume24h: resolveNonNegativeOption(options, 'microcapDeadVolume24h', 1500),
    microcapDeadLiquidityUsd: resolveNonNegativeOption(options, 'microcapDeadLiquidityUsd', 500),
    microcapCollapseMaxMcap: resolveNonNegativeOption(options, 'microcapCollapseMaxMcap', 20000),
    microcapCollapseMaxVolume1h: resolveNonNegativeOption(options, 'microcapCollapseMaxVolume1h', 500),
    microcapCollapseMaxTxns24h: resolveNonNegativeIntegerOption(options, 'microcapCollapseMaxTxns24h', 60),
    microcapCollapseMinPriceDrop24hPct: resolveNonNegativeOption(options, 'microcapCollapseMinPriceDrop24hPct', 50),
    dislocationSuspiciousMaxMcap: resolveNonNegativeOption(options, 'dislocationSuspiciousMaxMcap', 100000),
    dislocationSuspiciousMaxLiquidityUsd: resolveNonNegativeOption(options, 'dislocationSuspiciousMaxLiquidityUsd', 10000),
    dislocationSuspiciousMaxVolume1h: resolveNonNegativeOption(options, 'dislocationSuspiciousMaxVolume1h', 1500),
    extremeImbalanceProbableMaxMcap: resolveNonNegativeOption(options, 'extremeImbalanceProbableMaxMcap', 250000),
    extremeImbalanceProbableMaxVolume1h: resolveNonNegativeOption(options, 'extremeImbalanceProbableMaxVolume1h', 500),
  };
}

function normalizeMetricOptions(options = {}) {
  return {
    ...normalizeStructuralOptions(options),
    ...normalizeBehavioralOptions(options),
  };
}

function normalizeMeteora(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return {
    noPool: value.noPool === true,
    poolCount: Math.max(0, Math.trunc(toNumberOrNull(value.poolCount) ?? 0)),
    tvl: toNumberOrNull(value.tvl),
  };
}

function pickNumber(...values) {
  for (const value of values) {
    const parsed = toNumberOrNull(value);
    if (parsed != null) {
      return parsed;
    }
  }

  return null;
}

function pickBoolean(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return Boolean(value);
    }
  }

  return false;
}

function resolveMetricInput(input = {}) {
  const monitorPriority = String(
    input.monitorPriority ?? input.monitor_priority ?? ''
  ).trim().toLowerCase() || 'dormant';

  return {
    address: String(input.address || '').trim() || null,
    marketCap: pickNumber(input.mcap, input.marketCap, input.last_mcap),
    volume1h: pickNumber(input.volume1h, input.last_vol_1h),
    volume6h: pickNumber(input.volume6h, input.last_vol_6h),
    volume24h: pickNumber(input.volume24h, input.last_vol_24h),
    priceChange6h: pickNumber(input.priceChange6h, input.last_price_change_6h),
    priceChange24h: pickNumber(input.priceChange24h, input.last_price_change_24h),
    liquidityUsd: pickNumber(input.liquidityUsd, input.last_liquidity_usd),
    txns1hBuys: pickNumber(input.txns1hBuys, input.last_txns_1h_buys),
    txns1hSells: pickNumber(input.txns1hSells, input.last_txns_1h_sells),
    txns24hBuys: pickNumber(input.txns24hBuys, input.last_txns_24h_buys),
    txns24hSells: pickNumber(input.txns24hSells, input.last_txns_24h_sells),
    holderCount: pickNumber(input.holderCount, input.risk_holder_count),
    mintAuthorityActive: pickBoolean(input.mintAuthorityActive, input.risk_mint_authority_active),
    freezeAuthorityActive: pickBoolean(input.freezeAuthorityActive, input.risk_freeze_authority_active),
    top10Pct: pickNumber(input.top10Pct, input.risk_top_10_pct),
    top20Pct: pickNumber(input.top20Pct, input.risk_top_20_pct),
    monitorPriority,
    meteora: normalizeMeteora(input.meteora),
  };
}

function hasEnoughSignalContext(input) {
  return input.marketCap != null
    || input.holderCount != null
    || input.top10Pct != null
    || input.top20Pct != null
    || input.mintAuthorityActive
    || input.freezeAuthorityActive
    || input.meteora != null;
}

function buildHolderSignals(input, options) {
  const holderCount = input.holderCount;
  const marketCap = input.marketCap;

  if (!Number.isFinite(holderCount) || !(marketCap > 0)) {
    return {
      strongSignals: [],
      weakSignals: [],
    };
  }

  const strongThreshold = options.strongHolderThresholds.find((entry) => marketCap >= entry.minMcap);
  if (strongThreshold && holderCount <= strongThreshold.maxHolderCount) {
    return {
      strongSignals: ['holder_count_extremely_low_for_mcap'],
      weakSignals: [],
    };
  }

  const weakThreshold = options.weakHolderThresholds.find((entry) => marketCap >= entry.minMcap);
  if (weakThreshold && holderCount <= weakThreshold.maxHolderCount) {
    return {
      strongSignals: [],
      weakSignals: ['holder_count_low_for_mcap'],
    };
  }

  return {
    strongSignals: [],
    weakSignals: [],
  };
}

function buildConcentrationSignals(input, options) {
  const top10Pct = input.top10Pct ?? 0;
  const top20Pct = input.top20Pct ?? 0;

  if (top10Pct >= options.extremeTop10Pct || top20Pct >= options.extremeTop20Pct) {
    return {
      strongSignals: ['holder_concentration_extreme'],
      weakSignals: [],
    };
  }

  if (top10Pct >= options.highTop10Pct || top20Pct >= options.highTop20Pct) {
    return {
      strongSignals: [],
      weakSignals: ['holder_concentration_high'],
    };
  }

  return {
    strongSignals: [],
    weakSignals: [],
  };
}

function buildAuthoritySignals(input) {
  const strongSignals = [];

  if (input.mintAuthorityActive) {
    strongSignals.push('mint_authority_active');
  }
  if (input.freezeAuthorityActive) {
    strongSignals.push('freeze_authority_active');
  }

  return {
    strongSignals,
    weakSignals: [],
  };
}

function computeVolToMcapRatio(marketCap, volume24h) {
  return Number.isFinite(marketCap) && marketCap > 0 && Number.isFinite(volume24h) && volume24h >= 0
    ? volume24h / marketCap
    : null;
}

function computeLiquidityToMcapRatio(marketCap, liquidityUsd) {
  return Number.isFinite(marketCap) && marketCap > 0 && Number.isFinite(liquidityUsd) && liquidityUsd >= 0
    ? liquidityUsd / marketCap
    : null;
}

function computeBuySellImbalanceRatio(buys, sells) {
  if (buys == null || sells == null) {
    return null;
  }

  const buyCount = toNumberOrNull(buys);
  const sellCount = toNumberOrNull(sells);

  if (!Number.isFinite(buyCount) || !Number.isFinite(sellCount) || !(buyCount >= 0) || !(sellCount >= 0)) {
    return null;
  }

  const lowerCount = Math.min(buyCount, sellCount);
  const higherCount = Math.max(buyCount, sellCount);

  if (higherCount === 0) {
    return 1;
  }
  if (lowerCount === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return higherCount / lowerCount;
}

function shouldFlagMeteoraAbsence(input, options) {
  return (input.marketCap ?? 0) >= options.meteoraIndicatorMinMcap
    && input.meteora?.noPool === true;
}

function shouldFlagRecentVolumeDead(input, options, txns24hTotal) {
  const volume1h = input.volume1h;
  const volume6h = input.volume6h;
  const lowTxnContext = txns24hTotal == null || txns24hTotal < options.minDeadVolumeTxns24h;

  return (input.marketCap ?? 0) >= 100000
    && Number.isFinite(volume1h)
    && Number.isFinite(volume6h)
    && lowTxnContext
    && volume1h < options.deadVolume1h
    && volume6h < options.deadVolume6h;
}

function shouldFlagLowVolume24h(input) {
  return (input.marketCap ?? 0) >= 150000
    && (input.volume24h ?? 0) > 0
    && (input.volume24h ?? 0) < 5000;
}

function shouldFlagLowVolumeToMcap(input, options, volToMcapRatio) {
  return (input.marketCap ?? 0) >= options.lowVolToMcapMinMcap
    && volToMcapRatio != null
    && volToMcapRatio < options.lowVolToMcapRatio;
}

function shouldFlagLowLiquidityToMcap(input, options, liquidityToMcapRatio) {
  return (input.marketCap ?? 0) >= options.lowLiquidityToMcapMinMcap
    && liquidityToMcapRatio != null
    && liquidityToMcapRatio < options.lowLiquidityToMcapRatio;
}

function shouldFlagBuySellImbalance(input, options, buySellImbalanceRatio24h) {
  const txns24hBuys = input.txns24hBuys ?? 0;
  const txns24hSells = input.txns24hSells ?? 0;
  const totalTxns24h = txns24hBuys + txns24hSells;

  return totalTxns24h >= options.minBuySellTxns24h
    && buySellImbalanceRatio24h != null
    && buySellImbalanceRatio24h >= options.highBuySellImbalanceRatio;
}

function shouldFlagExtremeBuySellImbalance(input, options, buySellImbalanceRatio24h) {
  const txns24hBuys = input.txns24hBuys ?? 0;
  const txns24hSells = input.txns24hSells ?? 0;
  const totalTxns24h = txns24hBuys + txns24hSells;

  return totalTxns24h >= options.minBuySellTxns24h
    && buySellImbalanceRatio24h != null
    && buySellImbalanceRatio24h >= options.extremeBuySellImbalanceRatio;
}

function shouldFlagPriceDislocation(input, options) {
  const thinTrading = (input.volume1h ?? 0) < 1000
    || (input.volume6h ?? 0) < 30000
    || ((input.marketCap ?? 0) > 0 && (input.volume24h ?? 0) < (input.marketCap * 0.25));

  return thinTrading && (
    Math.abs(input.priceChange24h ?? 0) >= options.extremePriceChange24hPct
    || Math.abs(input.priceChange6h ?? 0) >= options.extremePriceChange6hPct
  );
}

function shouldFlagMarketDataUnavailable(input) {
  return !(input.marketCap > 0)
    && input.meteora?.noPool === true;
}

function hasHealthyAuthorityProfile(input) {
  return !input.mintAuthorityActive && !input.freezeAuthorityActive;
}

function hasHealthyHolderProfile(input) {
  if (!Number.isFinite(input.holderCount) || !(input.marketCap > 0)) {
    return false;
  }

  if (input.marketCap >= 1000000) {
    return input.holderCount >= 500;
  }
  if (input.marketCap >= 400000) {
    return input.holderCount >= 300;
  }
  if (input.marketCap >= 100000) {
    return input.holderCount >= 150;
  }

  return input.holderCount >= 100;
}

function hasHealthyDistributionProfile(input) {
  return Number.isFinite(input.top10Pct)
    && Number.isFinite(input.top20Pct)
    && input.top10Pct <= 60
    && input.top20Pct <= 75;
}

function hasHealthyTxFlowProfile(txns24hTotal, buySellImbalanceRatio24h, options) {
  return Number.isFinite(txns24hTotal)
    && txns24hTotal >= Math.max(options.minBuySellTxns24h, 40)
    && (buySellImbalanceRatio24h == null || buySellImbalanceRatio24h < options.highBuySellImbalanceRatio);
}

function hasHealthyLiquiditySupport(input, liquidityToMcapRatio) {
  return (input.meteora?.noPool === false && ((input.meteora?.poolCount ?? 0) > 0 || (input.meteora?.tvl ?? 0) > 0))
    || (Number.isFinite(input.liquidityUsd) && input.liquidityUsd >= 50000)
    || (liquidityToMcapRatio != null && liquidityToMcapRatio >= 0.08);
}

function hasStrongLegitMarketSupport(input, metrics) {
  const txns24hTotal = metrics.txns24hTotal ?? 0;
  const volume1h = input.volume1h ?? 0;
  const volume24h = input.volume24h ?? 0;
  const marketCap = input.marketCap ?? 0;
  const liquidityUsd = input.liquidityUsd ?? 0;
  const liquidityToMcapRatio = metrics.liquidityToMcapRatio ?? null;
  const volToMcapRatio = metrics.volToMcapRatio ?? null;

  return txns24hTotal >= 300
    && volume1h >= 500
    && (
      liquidityUsd >= 150000
      || (liquidityToMcapRatio != null && liquidityToMcapRatio >= 0.12)
      || ((marketCap > 0) && volume24h >= Math.max(30000, marketCap * 0.5))
      || (volToMcapRatio != null && volToMcapRatio >= 0.5)
    );
}

function buildPositiveProfileSignals(input, metrics, options) {
  const signals = [];

  if (hasHealthyAuthorityProfile(input)) {
    signals.push('no_authority_risk');
  }
  if (hasHealthyHolderProfile(input)) {
    signals.push('holder_count_healthy');
  }
  if (hasHealthyDistributionProfile(input)) {
    signals.push('holder_distribution_healthy');
  }
  if (hasHealthyTxFlowProfile(metrics.txns24hTotal, metrics.buySellImbalanceRatio24h, options)) {
    signals.push('tx_flow_healthy');
  }
  if (hasHealthyLiquiditySupport(input, metrics.liquidityToMcapRatio)) {
    signals.push('liquidity_support_healthy');
  }

  return signals;
}

const LEGIT_GUARDRAIL_MIN_POSITIVE_SIGNALS = 3;

function shouldApplyLegitGuardrail(strongSignals, positiveSignals) {
  return strongSignals.length === 0
    && positiveSignals.length >= LEGIT_GUARDRAIL_MIN_POSITIVE_SIGNALS;
}

function isStrongLegitBehavioralSignal(signal, strongLegitMarketSupport) {
  if (signal === 'meteora_absent_above_400k_mcap' || signal === 'volume_to_mcap_too_low' || signal === 'liquidity_to_mcap_too_low') {
    return true;
  }

  return strongLegitMarketSupport && signal === 'price_dislocation_extreme';
}

function canUpgradeToValid(input, metrics, strongSignals, weakSignals, behavioralSignals, positiveSignals) {
  const benignBehavioralSignals = new Set([
    'meteora_absent_above_400k_mcap',
    'volume_to_mcap_too_low',
    'liquidity_to_mcap_too_low',
  ]);
  const strongLegitMarketSupport = hasStrongLegitMarketSupport(input, metrics);
  const minimumPositiveSignals = strongLegitMarketSupport ? 2 : 4;

  return strongSignals.length === 0
    && weakSignals.length === 0
    && positiveSignals.length >= minimumPositiveSignals
    && behavioralSignals.length > 0
    && behavioralSignals.length <= 2
    && !behavioralSignals.includes('buy_sell_imbalance_extreme')
    && !behavioralSignals.includes('buy_sell_imbalance_high')
    && behavioralSignals.every((signal) => benignBehavioralSignals.has(signal) || isStrongLegitBehavioralSignal(signal, strongLegitMarketSupport));
}

function hasProbableBehavioralBundle(behavioralSignals) {
  const hasHighCapNoMeteora = behavioralSignals.includes('meteora_absent_above_400k_mcap');
  const hasLowVolumeMismatch = behavioralSignals.includes('volume_to_mcap_too_low');
  const hasLowLiquidityMismatch = behavioralSignals.includes('liquidity_to_mcap_too_low');
  const hasBuySellImbalance = behavioralSignals.includes('buy_sell_imbalance_high');
  const hasExtremeBuySellImbalance = behavioralSignals.includes('buy_sell_imbalance_extreme');

  return ((behavioralSignals.length >= 3)
    && (hasHighCapNoMeteora || hasLowVolumeMismatch || hasLowLiquidityMismatch || hasBuySellImbalance))
    || (hasExtremeBuySellImbalance
      && (
        behavioralSignals.includes('volume24h_too_low')
        || behavioralSignals.includes('recent_volume_dead')
        || behavioralSignals.includes('meteora_absent_above_400k_mcap')
      ));
}

function hasMicrocapDeadMarketBundle(input, metrics, options) {
  return (input.marketCap ?? 0) > 0
    && (input.marketCap ?? 0) <= options.microcapDeadMarketMaxMcap
    && (
      (
        (input.volume24h ?? 0) <= options.microcapDeadVolume24h
        && (metrics.txns24hTotal ?? 0) <= options.minDeadVolumeTxns24h
        && (
          (input.liquidityUsd ?? Number.POSITIVE_INFINITY) <= options.microcapDeadLiquidityUsd
          || (metrics.liquidityToMcapRatio == null || metrics.liquidityToMcapRatio < 0.03)
        )
      )
      || ((input.liquidityUsd ?? Number.POSITIVE_INFINITY) <= options.microcapDeadLiquidityUsd
        && (metrics.volToMcapRatio == null || metrics.volToMcapRatio < 0.05))
    );
}

function hasMicrocapCollapseBundle(input, metrics, options) {
  return (input.marketCap ?? 0) > 0
    && (input.marketCap ?? 0) <= options.microcapCollapseMaxMcap
    && Math.abs(input.priceChange24h ?? 0) >= options.microcapCollapseMinPriceDrop24hPct
    && (input.priceChange24h ?? 0) < 0
    && (input.volume1h ?? Number.POSITIVE_INFINITY) <= options.microcapCollapseMaxVolume1h
    && (metrics.txns24hTotal ?? 0) <= options.microcapCollapseMaxTxns24h;
}

function hasDislocationSuspiciousLowCapBundle(input, options, behavioralSignals) {
  if (!behavioralSignals.includes('price_dislocation_extreme')) {
    return false;
  }

  return (input.marketCap ?? 0) <= options.dislocationSuspiciousMaxMcap
    && (
      (input.liquidityUsd ?? Number.POSITIVE_INFINITY) <= options.dislocationSuspiciousMaxLiquidityUsd
      || (input.volume1h ?? Number.POSITIVE_INFINITY) <= options.dislocationSuspiciousMaxVolume1h
    );
}

function hasExtremeImbalanceLowCapBundle(input, options, behavioralSignals) {
  return behavioralSignals.includes('buy_sell_imbalance_extreme')
    && (input.marketCap ?? 0) <= options.extremeImbalanceProbableMaxMcap
    && (input.volume1h ?? Number.POSITIVE_INFINITY) <= options.extremeImbalanceProbableMaxVolume1h;
}

function hasUnavailableZeroMarketBundle(input, metrics, behavioralSignals) {
  return behavioralSignals.includes('market_data_unavailable')
    && input.marketCap === 0
    && input.volume24h === 0
    && input.liquidityUsd === 0
    && input.txns24hBuys === 0
    && input.txns24hSells === 0;
}

function hasTerminalMicrocapCollapseBundle(input, metrics) {
  return (input.marketCap ?? 0) > 0
    && (input.marketCap ?? 0) <= 5000
    && (input.priceChange24h ?? 0) <= -90
    && (metrics.txns24hTotal ?? 0) >= 50;
}

function hasHighCapThinSupportProbableBundle(input, behavioralSignals, metrics) {
  return (input.marketCap ?? 0) >= 400000
    && behavioralSignals.includes('meteora_absent_above_400k_mcap')
    && behavioralSignals.includes('volume_to_mcap_too_low')
    && (metrics.txns24hTotal ?? 0) <= 300
    && (
      metrics.liquidityToMcapRatio == null
      || metrics.liquidityToMcapRatio < 0.1
    );
}

function hasWeakButLegitMicrocapProfile(input, metrics, strongSignals, weakSignals, behavioralSignals) {
  return strongSignals.length === 0
    && weakSignals.length === 0
    && behavioralSignals.length === 0
    && (input.marketCap ?? 0) > 0
    && (input.marketCap ?? 0) < 100000
    && (metrics.txns24hTotal ?? 0) > 0
    && (metrics.txns24hTotal ?? 0) < 20
    && (metrics.liquidityToMcapRatio != null && metrics.liquidityToMcapRatio >= 0.5);
}

function hasProbableLabelTriggers(input, strongSignals, weakSignals, behavioralSignals, metrics, options) {
  return strongSignals.length >= 2
    || (strongSignals.length >= 1 && (weakSignals.length + behavioralSignals.length) >= 1)
    || (weakSignals.length >= 2 && behavioralSignals.length >= 1)
    || hasWeakBehavioralProbableCombo(weakSignals, behavioralSignals)
    || hasNoPoolSuspiciousProbableBundle(input, weakSignals, behavioralSignals, metrics)
    || hasProbableBehavioralBundle(behavioralSignals)
    || hasUnavailableZeroMarketBundle(input, metrics, behavioralSignals)
    || hasTerminalMicrocapCollapseBundle(input, metrics)
    || hasHighCapThinSupportProbableBundle(input, behavioralSignals, metrics)
    || hasMicrocapDeadMarketBundle(input, metrics, options)
    || hasMicrocapCollapseBundle(input, metrics, options)
    || hasDislocationSuspiciousLowCapBundle(input, options, behavioralSignals)
    || hasExtremeImbalanceLowCapBundle(input, options, behavioralSignals);
}

function hasWeakBehavioralProbableCombo(weakSignals, behavioralSignals) {
  const hasWeakStructuralSignal = weakSignals.length >= 1;
  if (!hasWeakStructuralSignal || behavioralSignals.length < 2) {
    return false;
  }

  return behavioralSignals.includes('meteora_absent_above_400k_mcap')
    || behavioralSignals.includes('volume_to_mcap_too_low')
    || behavioralSignals.includes('liquidity_to_mcap_too_low')
    || behavioralSignals.includes('buy_sell_imbalance_high');
}

function hasNoPoolSuspiciousProbableBundle(input, weakSignals, behavioralSignals, metrics) {
  if (input.meteora?.noPool !== true) {
    return false;
  }

  const txns24hTotal = metrics.txns24hTotal ?? 0;
  const holderCount = input.holderCount ?? Number.POSITIVE_INFINITY;
  const top20Pct = input.top20Pct ?? Number.POSITIVE_INFINITY;
  const hasLowVolumeMismatch = behavioralSignals.includes('volume_to_mcap_too_low');
  const hasLowLiquidityMismatch = behavioralSignals.includes('liquidity_to_mcap_too_low');
  const hasLowVolume24h = behavioralSignals.includes('volume24h_too_low');
  const hasRecentVolumeDead = behavioralSignals.includes('recent_volume_dead');
  const hasHighImbalance = behavioralSignals.includes('buy_sell_imbalance_high');
  const hasWeakConcentration = weakSignals.includes('holder_concentration_high');

  if (hasHighImbalance && hasLowVolumeMismatch && txns24hTotal >= 80) {
    return true;
  }

  if (
    hasLowVolumeMismatch
    && hasLowLiquidityMismatch
    && (
      hasLowVolume24h
      || hasWeakConcentration
      || txns24hTotal >= 60
    )
  ) {
    return true;
  }

  return hasRecentVolumeDead
    && hasLowVolume24h
    && txns24hTotal <= 30
    && holderCount <= 250
    && top20Pct <= 80;
}

function buildBehavioralSignals(input, options) {
  const signals = [];
  const volToMcapRatio = computeVolToMcapRatio(input.marketCap, input.volume24h);
  const liquidityToMcapRatio = computeLiquidityToMcapRatio(input.marketCap, input.liquidityUsd);
  const buySellImbalanceRatio24h = computeBuySellImbalanceRatio(input.txns24hBuys, input.txns24hSells);
  const txns24hTotal = Number.isFinite(input.txns24hBuys) && Number.isFinite(input.txns24hSells)
    ? input.txns24hBuys + input.txns24hSells
    : null;

  if (shouldFlagMarketDataUnavailable(input)) {
    signals.push('market_data_unavailable');
  }
  if (shouldFlagMeteoraAbsence(input, options)) {
    signals.push('meteora_absent_above_400k_mcap');
  }
  if (shouldFlagRecentVolumeDead(input, options, txns24hTotal)) {
    signals.push('recent_volume_dead');
  }
  if (shouldFlagLowVolume24h(input)
    && (input.meteora?.noPool === true || (liquidityToMcapRatio != null && liquidityToMcapRatio < options.lowLiquidityToMcapRatio))) {
    signals.push('volume24h_too_low');
  }
  if (shouldFlagLowVolumeToMcap(input, options, volToMcapRatio)) {
    signals.push('volume_to_mcap_too_low');
  }
  if (shouldFlagLowLiquidityToMcap(input, options, liquidityToMcapRatio)) {
    signals.push('liquidity_to_mcap_too_low');
  }
  if (shouldFlagBuySellImbalance(input, options, buySellImbalanceRatio24h)) {
    signals.push('buy_sell_imbalance_high');
  }
  if (shouldFlagExtremeBuySellImbalance(input, options, buySellImbalanceRatio24h)) {
    signals.push('buy_sell_imbalance_extreme');
  }
  if (shouldFlagPriceDislocation(input, options)) {
    signals.push('price_dislocation_extreme');
  }

  return {
    behavioralSignals: signals,
    volToMcapRatio,
    liquidityToMcapRatio,
    buySellImbalanceRatio24h,
    txns24hTotal,
  };
}

function determineSuggestedLabel(input, strongSignals, weakSignals, behavioralSignals, metrics, options) {
  if (strongSignals.length >= options.permanentStrongSignalThreshold) {
    return 'junk_permanent';
  }

  if (hasProbableLabelTriggers(input, strongSignals, weakSignals, behavioralSignals, metrics, options)) {
    return 'junk_probable';
  }

  if (strongSignals.length >= 1 || weakSignals.length >= 1 || behavioralSignals.length >= 1) {
    return 'valid_but_weak';
  }

  if (hasWeakButLegitMicrocapProfile(input, metrics, strongSignals, weakSignals, behavioralSignals)) {
    return 'valid_but_weak';
  }

  return 'valid';
}

function applyLegitGuardrail(input, suggestedLabel, strongSignals, weakSignals, behavioralSignals, positiveSignals, metrics, options) {
  if (suggestedLabel === 'junk_permanent') {
    return suggestedLabel;
  }

  if (behavioralSignals.includes('buy_sell_imbalance_extreme')) {
    return suggestedLabel;
  }

  if (hasNoPoolSuspiciousProbableBundle(input, weakSignals, behavioralSignals, metrics)) {
    return suggestedLabel;
  }

  if (
    hasMicrocapCollapseBundle(input, metrics, options)
    || hasTerminalMicrocapCollapseBundle(input, metrics)
    || hasHighCapThinSupportProbableBundle(input, behavioralSignals, metrics)
  ) {
    return suggestedLabel;
  }

  if (canUpgradeToValid(input, metrics, strongSignals, weakSignals, behavioralSignals, positiveSignals)) {
    return 'valid';
  }

  if (suggestedLabel === 'junk_probable' && shouldApplyLegitGuardrail(strongSignals, positiveSignals)) {
    return 'valid_but_weak';
  }

  return suggestedLabel;
}

function determineConfidence(label, strongSignals, weakSignals, behavioralSignals) {
  if (label === 'junk_permanent') {
    return strongSignals.length >= 4 ? 'high' : 'medium';
  }

  if (label === 'junk_probable') {
    return (strongSignals.length >= 2 && behavioralSignals.length >= 1) || (strongSignals.length + weakSignals.length + behavioralSignals.length) >= 4
      ? 'high'
      : 'medium';
  }

  if (label === 'valid_but_weak') {
    return strongSignals.length >= 1 || weakSignals.length >= 1 ? 'medium' : 'low';
  }

  return behavioralSignals.length === 0 && weakSignals.length === 0 && strongSignals.length === 0
    ? 'medium'
    : 'low';
}

function classifyTokenJunk(input = {}, options = {}) {
  const normalizedOptions = normalizeMetricOptions(options);
  const resolved = resolveMetricInput(input);

  if (!hasEnoughSignalContext(resolved)) {
    return null;
  }

  const authoritySignals = buildAuthoritySignals(resolved);
  const holderSignals = buildHolderSignals(resolved, normalizedOptions);
  const concentrationSignals = buildConcentrationSignals(resolved, normalizedOptions);
  const behavioral = buildBehavioralSignals(resolved, normalizedOptions);
  const positiveSignals = buildPositiveProfileSignals(resolved, behavioral, normalizedOptions);

  const strongSignals = [
    ...authoritySignals.strongSignals,
    ...holderSignals.strongSignals,
    ...concentrationSignals.strongSignals,
  ];
  const weakSignals = [
    ...holderSignals.weakSignals,
    ...concentrationSignals.weakSignals,
  ];
  const behavioralSignals = behavioral.behavioralSignals;
  const rawSuggestedLabel = determineSuggestedLabel(
    resolved,
    strongSignals,
    weakSignals,
    behavioralSignals,
    behavioral,
    normalizedOptions,
  );
  const suggestedLabel = applyLegitGuardrail(
    resolved,
    rawSuggestedLabel,
    strongSignals,
    weakSignals,
    behavioralSignals,
    positiveSignals,
    behavioral,
    normalizedOptions,
  );
  const confidence = determineConfidence(suggestedLabel, strongSignals, weakSignals, behavioralSignals);

  return {
    label: suggestedLabel,
    confidence,
    manualReviewRequired: suggestedLabel !== 'valid',
    autoBlock: false,
    mode: 'v1_manual_review',
    strongSignalCount: strongSignals.length,
    reasonCodes: [
      ...strongSignals,
      ...weakSignals,
      ...behavioralSignals,
    ],
    strongSignals,
    weakSignals,
    behavioralSignals,
    positiveSignals,
    marketCap: resolved.marketCap,
    holderCount: resolved.holderCount,
    top10Pct: resolved.top10Pct,
    top20Pct: resolved.top20Pct,
    meteoraConsidered: Boolean(resolved.meteora && (resolved.marketCap ?? 0) >= normalizedOptions.meteoraIndicatorMinMcap),
    volToMcapRatio: behavioral.volToMcapRatio,
    liquidityUsd: resolved.liquidityUsd,
    liquidityToMcapRatio: behavioral.liquidityToMcapRatio,
    txns24hBuys: resolved.txns24hBuys,
    txns24hSells: resolved.txns24hSells,
    txns24hTotal: behavioral.txns24hTotal,
    buySellImbalanceRatio24h: behavioral.buySellImbalanceRatio24h,
  };
}

module.exports = {
  classifyTokenJunk,
  __private: {
    buildAuthoritySignals,
    buildBehavioralSignals,
    buildConcentrationSignals,
    buildHolderSignals,
    buildPositiveProfileSignals,
    normalizeBehavioralOptions,
    determineConfidence,
    determineSuggestedLabel,
    applyLegitGuardrail,
    hasEnoughSignalContext,
    hasNoPoolSuspiciousProbableBundle,
    normalizeMetricOptions,
    normalizeStructuralOptions,
    normalizeMeteora,
    pickBoolean,
    pickNumber,
    shouldFlagLowVolume24h,
    shouldFlagLowLiquidityToMcap,
    resolveMetricInput,
    computeBuySellImbalanceRatio,
    computeLiquidityToMcapRatio,
    shouldFlagLowVolumeToMcap,
    shouldFlagBuySellImbalance,
    shouldFlagExtremeBuySellImbalance,
    shouldFlagMarketDataUnavailable,
    shouldFlagMeteoraAbsence,
    shouldFlagPriceDislocation,
    shouldFlagRecentVolumeDead,
    toNumberOrNull,
  },
};

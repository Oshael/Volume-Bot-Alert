const fs = require('node:fs');
const path = require('node:path');

const { classifyTokenJunk, __private: junkMetricPrivate } = require('../services/token-junk-metric');

const DEFAULT_INPUT_PATH = path.resolve(process.cwd(), 'data/token-junk-samples.json');
const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), 'data/token-junk-analysis.json');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index] || '').trim();
    if (!raw.startsWith('--')) {
      continue;
    }

    const withoutPrefix = raw.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      args[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next != null && !String(next).startsWith('--')) {
      args[withoutPrefix] = String(next);
      index += 1;
      continue;
    }

    args[withoutPrefix] = 'true';
  }

  return args;
}

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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizePath(value, fallback) {
  return path.resolve(String(value || fallback || '').trim() || fallback);
}

function incrementCounter(map, key) {
  const normalizedKey = String(key || 'unknown');
  map[normalizedKey] = (map[normalizedKey] || 0) + 1;
}

function normalizeHumanLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return null;
  }

  if (raw === 'junk' || raw === 'junk_probable') {
    return 'junk_probable';
  }
  if (raw === 'junk_permanent') {
    return 'junk_permanent';
  }
  if (raw === 'legit' || raw === 'valid') {
    return 'valid';
  }
  if (raw === 'valid_but_weak' || raw === 'weak but legit' || raw === 'weak/monitoring') {
    return 'valid_but_weak';
  }

  return raw;
}

function pickSnapshotOpen(snapshot) {
  return toNumberOrNull(snapshot?.openMcap ?? snapshot?.openPrice);
}

function pickSnapshotClose(snapshot) {
  return toNumberOrNull(snapshot?.closeMcap ?? snapshot?.closePrice ?? snapshot?.mcap ?? snapshot?.price);
}

function getDirection(openValue, closeValue) {
  if (!Number.isFinite(openValue) || !Number.isFinite(closeValue)) {
    return 0;
  }
  if (closeValue > openValue) {
    return 1;
  }
  if (closeValue < openValue) {
    return -1;
  }
  return 0;
}

function updateDirectionalStreaks(direction, streaks) {
  if (direction === 1) {
    streaks.currentGreen += 1;
    streaks.currentRed = 0;
    streaks.longestGreen = Math.max(streaks.longestGreen, streaks.currentGreen);
    return;
  }

  if (direction === -1) {
    streaks.currentRed += 1;
    streaks.currentGreen = 0;
    streaks.longestRed = Math.max(streaks.longestRed, streaks.currentRed);
    return;
  }

  streaks.currentGreen = 0;
  streaks.currentRed = 0;
}

function createShapeAccumulator() {
  return {
    streaks: {
      currentGreen: 0,
      currentRed: 0,
      longestGreen: 0,
      longestRed: 0,
    },
    greenCandles: 0,
    redCandles: 0,
    flatCandles: 0,
    directionalCandles: 0,
    directionChanges: 0,
    previousDirection: 0,
    firstOpen: null,
    lastClose: null,
    totalAbsTravel: 0,
    candleMovePcts: [],
  };
}

function countDirectionalCandle(direction, accumulator) {
  if (direction === 1) {
    accumulator.greenCandles += 1;
    accumulator.directionalCandles += 1;
    return;
  }

  if (direction === -1) {
    accumulator.redCandles += 1;
    accumulator.directionalCandles += 1;
    return;
  }

  accumulator.flatCandles += 1;
}

function maybeCountDirectionChange(direction, accumulator) {
  if (direction !== 0 && accumulator.previousDirection !== 0 && direction !== accumulator.previousDirection) {
    accumulator.directionChanges += 1;
  }
  if (direction !== 0) {
    accumulator.previousDirection = direction;
  }
}

function consumeSnapshotForShape(snapshot, accumulator) {
  const openValue = pickSnapshotOpen(snapshot);
  const closeValue = pickSnapshotClose(snapshot);
  if (!Number.isFinite(openValue) || !Number.isFinite(closeValue)) {
    return;
  }

  if (accumulator.firstOpen == null) {
    accumulator.firstOpen = openValue;
  }
  accumulator.lastClose = closeValue;

  const direction = getDirection(openValue, closeValue);
  const absTravel = Math.abs(closeValue - openValue);
  accumulator.totalAbsTravel += absTravel;
  if (openValue > 0) {
    accumulator.candleMovePcts.push((absTravel / openValue) * 100);
  }

  countDirectionalCandle(direction, accumulator);
  maybeCountDirectionChange(direction, accumulator);
  updateDirectionalStreaks(direction, accumulator.streaks);
}

function buildMoveConcentration(movePcts = []) {
  if (movePcts.length === 0) {
    return null;
  }

  const totalMove = movePcts.reduce((sum, value) => sum + value, 0);
  if (totalMove <= 0) {
    return null;
  }

  const topMoveTotal = [...movePcts]
    .sort((left, right) => right - left)
    .slice(0, 3)
    .reduce((sum, value) => sum + value, 0);

  return roundMetric((topMoveTotal / totalMove) * 100);
}

function buildPathEfficiency(accumulator) {
  if (
    accumulator.totalAbsTravel <= 0
    || accumulator.firstOpen == null
    || accumulator.lastClose == null
  ) {
    return null;
  }

  return roundMetric((Math.abs(accumulator.lastClose - accumulator.firstOpen) / accumulator.totalAbsTravel) * 100);
}

function buildDirectionalRates(accumulator, totalCandles) {
  const { directionalCandles, greenCandles, redCandles, flatCandles, directionChanges } = accumulator;
  const directionChangeRate = directionalCandles > 1
    ? (directionChanges / (directionalCandles - 1)) * 100
    : null;

  return {
    greenRate: roundMetric(directionalCandles > 0 ? (greenCandles / directionalCandles) * 100 : null),
    redRate: roundMetric(directionalCandles > 0 ? (redCandles / directionalCandles) * 100 : null),
    flatRate: roundMetric(totalCandles > 0 ? (flatCandles / totalCandles) * 100 : null),
    directionChangeRate: roundMetric(directionChangeRate),
  };
}

function summarizeCandleShape(marketHistoryPayload = {}) {
  const snapshots = Array.isArray(marketHistoryPayload?.snapshots) ? marketHistoryPayload.snapshots : [];
  const accumulator = createShapeAccumulator();

  for (const snapshot of snapshots) {
    consumeSnapshotForShape(snapshot, accumulator);
  }

  const totalCandles = accumulator.greenCandles + accumulator.redCandles + accumulator.flatCandles;
  const rates = buildDirectionalRates(accumulator, totalCandles);

  return {
    totalCandles,
    directionalCandles: accumulator.directionalCandles,
    greenCandles: accumulator.greenCandles,
    redCandles: accumulator.redCandles,
    flatCandles: accumulator.flatCandles,
    greenRate: rates.greenRate,
    redRate: rates.redRate,
    flatRate: rates.flatRate,
    longestGreenStreak: accumulator.streaks.longestGreen,
    longestRedStreak: accumulator.streaks.longestRed,
    directionChanges: accumulator.directionChanges,
    directionChangeRate: rates.directionChangeRate,
    pathEfficiencyPct: buildPathEfficiency(accumulator),
    top3MovePctShare: buildMoveConcentration(accumulator.candleMovePcts),
  };
}

function buildMetricInputFromSample(entry = {}) {
  const dex = entry?.collection?.dexscreener?.summary || {};
  const meteora = entry?.collection?.meteora?.summary || null;

  return {
    address: entry.address || null,
    mcap: dex.marketCap,
    volume1h: dex.volume1h,
    volume6h: dex.volume6h,
    volume24h: dex.volume24h,
    priceChange6h: dex.priceChange6h,
    priceChange24h: dex.priceChange24h,
    liquidityUsd: dex.liquidityUsd,
    txns1hBuys: dex.txns1hBuys,
    txns1hSells: dex.txns1hSells,
    txns24hBuys: dex.txns24hBuys,
    txns24hSells: dex.txns24hSells,
    meteora: meteora
      ? {
        noPool: meteora.noPool,
        poolCount: meteora.poolCount,
        tvl: meteora.latestTvl,
      }
      : null,
  };
}

function buildHeuristicFlags(entry = {}, shape = {}) {
  const dex = entry?.collection?.dexscreener?.summary || {};
  const marketCap = toNumberOrNull(dex.marketCap);
  const liquidityUsd = toNumberOrNull(dex.liquidityUsd);
  const volume24h = toNumberOrNull(dex.volume24h);
  const txns24hBuys = toNumberOrNull(dex.txns24hBuys);
  const txns24hSells = toNumberOrNull(dex.txns24hSells);
  const imbalance24h = junkMetricPrivate.computeBuySellImbalanceRatio(txns24hBuys, txns24hSells);
  const liquidityToMcapRatio = marketCap > 0 && liquidityUsd != null ? liquidityUsd / marketCap : null;
  const volumeToMcapRatio = marketCap > 0 && volume24h != null ? volume24h / marketCap : null;

  return {
    lowLiquidityToMcap: isBelowThreshold(marketCap, 150000, liquidityToMcapRatio, 0.05),
    lowVolumeToMcap: isBelowThreshold(marketCap, 400000, volumeToMcapRatio, 0.05),
    extremeBuySellImbalance24h: meetsMinimum(imbalance24h, 8),
    oneSidedOrderFlow24h: meetsMinimum(imbalance24h, 3),
    lineUpStructure: hasLineUpStructure(shape),
  };
}

function meetsMinimum(value, threshold) {
  return Boolean(value != null && value >= threshold);
}

function isBelowThreshold(gateValue, minimumGate, comparedValue, threshold) {
  return Boolean(gateValue >= minimumGate && comparedValue != null && comparedValue < threshold);
}

function hasLineUpStructure(shape = {}) {
  return Boolean(
    (shape.greenRate ?? 0) >= 75
    && (shape.directionChangeRate ?? 100) <= 25
    && (shape.pathEfficiencyPct ?? 0) >= 55
    && (shape.longestGreenStreak ?? 0) >= 6
  );
}

function buildDexSummary(dex = {}) {
  const marketCap = toNumberOrNull(dex.marketCap);
  const liquidityUsd = toNumberOrNull(dex.liquidityUsd);
  const volume24h = toNumberOrNull(dex.volume24h);

  return {
    symbol: dex.symbol || null,
    dexId: dex.dexId || null,
    mcap: marketCap,
    liquidityUsd,
    liquidityToMcapRatio: roundMetric(marketCap > 0 && liquidityUsd != null ? liquidityUsd / marketCap : null, 4),
    volume5m: toNumberOrNull(dex.volume5m),
    volume1h: toNumberOrNull(dex.volume1h),
    volume6h: toNumberOrNull(dex.volume6h),
    volume24h,
    vol24hToMcapRatio: roundMetric(marketCap > 0 && volume24h != null ? volume24h / marketCap : null, 4),
    txns1hTotal: (toNumberOrNull(dex.txns1hBuys) || 0) + (toNumberOrNull(dex.txns1hSells) || 0),
    txns24hTotal: (toNumberOrNull(dex.txns24hBuys) || 0) + (toNumberOrNull(dex.txns24hSells) || 0),
    buySellImbalance24h: roundMetric(
      junkMetricPrivate.computeBuySellImbalanceRatio(dex.txns24hBuys, dex.txns24hSells),
      3
    ),
    priceChange24h: toNumberOrNull(dex.priceChange24h),
  };
}

function buildMarketHistorySummary(summary = {}, shape = {}) {
  return {
    snapshotCount: Number(summary.snapshotCount) || 0,
    totalSampleCount: Number(summary.totalSampleCount) || 0,
    rangePct: toNumberOrNull(summary.rangePct),
    driftPct: toNumberOrNull(summary.driftPct),
    mcapStddev: toNumberOrNull(summary.mcapStddev),
    priceRangePct: toNumberOrNull(summary.priceRangePct),
    latestVolume1h: toNumberOrNull(summary.latestVolume1h),
    latestVolume6h: toNumberOrNull(summary.latestVolume6h),
    latestVolume24h: toNumberOrNull(summary.latestVolume24h),
    shape,
  };
}

function buildMeteoraSummary(summary = {}) {
  return {
    noPool: Boolean(summary.noPool),
    poolCount: Number(summary.poolCount) || 0,
    latestTvl: toNumberOrNull(summary.latestTvl),
    change24h: toNumberOrNull(summary.change24h),
  };
}

function buildHumanAssessment(entry = {}) {
  const rawHumanLabel = entry.label || null;
  const normalizedHumanLabel = normalizeHumanLabel(rawHumanLabel);

  return {
    address: entry.address || null,
    humanLabel: normalizedHumanLabel,
    rawHumanLabel,
    humanConfidence: entry.confidence || null,
    reason: entry.reason || null,
    notes: entry.notes || null,
  };
}

function buildMetricAssessmentFields(metricAssessment, humanLabel) {
  return {
    metricLabel: metricAssessment?.label || null,
    metricConfidence: metricAssessment?.confidence || null,
    metricReasonCodes: metricAssessment?.reasonCodes || [],
    metricPartialContext: true,
    agreesWithHuman: metricAssessment?.label === humanLabel,
  };
}

function buildCompactEntry(entry = {}) {
  const dex = entry?.collection?.dexscreener?.summary || {};
  const marketHistorySummary = entry?.collection?.marketHistory?.summary || {};
  const meteoraSummary = entry?.collection?.meteora?.summary || {};
  const shape = summarizeCandleShape(entry?.collection?.marketHistory?.payload || {});
  const metricAssessment = classifyTokenJunk(buildMetricInputFromSample(entry));
  const humanAssessment = buildHumanAssessment(entry);

  return {
    ...humanAssessment,
    ...buildMetricAssessmentFields(metricAssessment, humanAssessment.humanLabel),
    dex: buildDexSummary(dex),
    marketHistory: buildMarketHistorySummary(marketHistorySummary, shape),
    meteora: buildMeteoraSummary(meteoraSummary),
    heuristicFlags: buildHeuristicFlags(entry, shape),
  };
}

function buildConfusionMatrix(entries = []) {
  const matrix = {};

  for (const entry of entries) {
    const humanLabel = String(entry.humanLabel || 'unknown');
    const metricLabel = String(entry.metricLabel || 'null');
    matrix[humanLabel] ||= {};
    matrix[humanLabel][metricLabel] = (matrix[humanLabel][metricLabel] || 0) + 1;
  }

  return matrix;
}

function buildAnalysisSummary(entries = []) {
  const humanLabelCounts = {};
  const metricLabelCounts = {};
  let agreementCount = 0;

  for (const entry of entries) {
    incrementCounter(humanLabelCounts, entry.humanLabel);
    incrementCounter(metricLabelCounts, entry.metricLabel || 'null');
    if (entry.agreesWithHuman) {
      agreementCount += 1;
    }
  }

  return {
    totalEntries: entries.length,
    humanLabelCounts,
    metricLabelCounts,
    agreementCount,
    disagreementCount: Math.max(0, entries.length - agreementCount),
    confusionMatrix: buildConfusionMatrix(entries),
    metricContext: 'partial_sample_only',
  };
}

function resolveRunOptions(options = {}) {
  return {
    inputPath: normalizePath(options.inputPath, DEFAULT_INPUT_PATH),
    outputPath: normalizePath(options.outputPath, DEFAULT_OUTPUT_PATH),
    onlyMismatches: String(options.onlyMismatches || '').trim().toLowerCase() === 'true',
  };
}

function runAnalysis(options = {}) {
  const resolved = resolveRunOptions(options);
  const payload = readJsonFile(resolved.inputPath);
  const sourceEntries = Array.isArray(payload?.entries) ? payload.entries : [];
  const compactEntries = sourceEntries.map(buildCompactEntry);
  const filteredEntries = resolved.onlyMismatches
    ? compactEntries.filter((entry) => !entry.agreesWithHuman)
    : compactEntries;

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      inputPath: resolved.inputPath,
      onlyMismatches: resolved.onlyMismatches,
      sourceMeta: payload?.meta || null,
    },
    summary: buildAnalysisSummary(filteredEntries),
    entries: filteredEntries,
  };

  writeJsonFile(resolved.outputPath, output);
  return output;
}

async function main() {
  const args = parseArgs();
  const output = runAnalysis({
    inputPath: args.input,
    outputPath: args.output,
    onlyMismatches: args['only-mismatches'],
  });

  console.log(
    `[token-junk-analysis] wrote ${output.entries.length} entries to ${normalizePath(args.output, DEFAULT_OUTPUT_PATH)}`
  );
}

if (require.main === module) {
  Promise.resolve(main()).catch((err) => {
    console.error(`[token-junk-analysis] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCompactEntry,
  buildHeuristicFlags,
  buildAnalysisSummary,
  normalizeHumanLabel,
  parseArgs,
  runAnalysis,
  summarizeCandleShape,
};

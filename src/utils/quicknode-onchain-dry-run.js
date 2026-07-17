require('dotenv').config();

const quicknodeOnchainIngestion = require('../services/quicknode-onchain-ingestion');
const onchainPriceChangeTracker = require('../services/quicknode-onchain-price-change-tracker');
const onchainPriceObservation = require('../services/quicknode-onchain-price-observation');
const onchainWindowAggregator = require('../services/quicknode-onchain-window-aggregator');
const {
  estimateQuickNodeCredits,
  formatTrafficStats,
  probeProgram,
  resolveProgram,
} = require('./quicknode-transaction-probe');

const DEFAULT_SECONDS = 60;
const DEFAULT_MATCHES = 5;
const DEFAULT_MAX_SEEN = 250;
const DEFAULT_TOKEN_REPORT_LIMIT = 10;
const DEFAULT_WINDOW_REPORT_LIMIT = 10;
const DEFAULT_MIN_SOL_VOLUME = 0.01;
const DEFAULT_MIN_USD_VOLUME = 1.5;
const DEFAULT_PROGRAMS = Object.freeze([
  'pumpswap',
  'meteora-dlmm',
  'raydium-cpmm',
  'raydium-clmm',
  'raydium-amm-v4',
]);

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumber(value, fallback = 0) {
  if (String(value ?? '').trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseAddressList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toFiniteNumberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeWsUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error('QUICKNODE_SOLANA_WS_URL is required');
  }
  const url = new URL(normalized);
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error('QUICKNODE_SOLANA_WS_URL must be a WS(S) URL');
  }
  return url.toString();
}

function maskEndpoint(value) {
  try {
    const url = new URL(String(value || '').trim());
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1].slice(0, 6)}...`;
      url.pathname = `/${parts.join('/')}/`;
    }
    return url.toString();
  } catch (_) {
    return '(invalid-url)';
  }
}

function resolveDryRunPrograms(value) {
  const configured = parseAddressList(value);
  const requested = configured.length ? configured : DEFAULT_PROGRAMS;
  return requested.map(resolveProgram);
}

function readOptionsFromEnv() {
  return {
    wsUrl: normalizeWsUrl(readEnv('QUICKNODE_SOLANA_WS_URL')),
    programs: resolveDryRunPrograms(readEnv('QUICKNODE_DRY_RUN_PROGRAMS')),
    seconds: parsePositiveInteger(readEnv('QUICKNODE_DRY_RUN_SECONDS'), DEFAULT_SECONDS),
    matches: parsePositiveInteger(readEnv('QUICKNODE_DRY_RUN_MATCHES'), DEFAULT_MATCHES),
    maxSeen: parsePositiveInteger(readEnv('QUICKNODE_DRY_RUN_MAX_SEEN'), DEFAULT_MAX_SEEN),
    minSolVolume: parseNonNegativeNumber(readEnv('QUICKNODE_DRY_RUN_MIN_SOL_VOLUME'), DEFAULT_MIN_SOL_VOLUME),
    minUsdVolume: parseNonNegativeNumber(readEnv('QUICKNODE_DRY_RUN_MIN_USD_VOLUME'), DEFAULT_MIN_USD_VOLUME),
    tokenReportLimit: parsePositiveInteger(readEnv('QUICKNODE_DRY_RUN_TOKEN_REPORT_LIMIT'), DEFAULT_TOKEN_REPORT_LIMIT),
    windowReportLimit: parsePositiveInteger(readEnv('QUICKNODE_DRY_RUN_WINDOW_REPORT_LIMIT'), DEFAULT_WINDOW_REPORT_LIMIT),
    exclude: parseAddressList(readEnv('QUICKNODE_DRY_RUN_EXCLUDE')),
    required: parseAddressList(readEnv('QUICKNODE_DRY_RUN_REQUIRED')),
  };
}

function buildTrafficSummary(traffic = {}) {
  const receivedBytes = Number(traffic.receivedBytes) || 0;
  return {
    messages: Number(traffic.messages) || 0,
    receivedBytes,
    estimatedCredits: Math.round(estimateQuickNodeCredits(receivedBytes) * 100) / 100,
    notificationBytes: Number(traffic.notificationBytes) || 0,
    mentionOnlyBytes: Number(traffic.mentionOnlyBytes) || 0,
    matchBytes: Number(traffic.matchBytes) || 0,
  };
}

function normalizeCandidateForReport(candidate = {}) {
  return {
    accepted: Boolean(candidate.accepted),
    tokenMint: String(candidate.tokenMint || '').trim(),
    program: String(candidate.program || '').trim(),
    signature: String(candidate.signature || '').trim(),
    skipReason: String(candidate.skipReason || '').trim(),
    estimatedSolVolume: toFiniteNumberOrNull(candidate.estimatedSolVolume),
    estimatedUsdVolume: toFiniteNumberOrNull(candidate.estimatedUsdVolume),
    volumeSource: String(candidate.volumeSource || '').trim() || 'none',
    slot: toFiniteNumberOrNull(candidate.slot),
    blockTime: toFiniteNumberOrNull(candidate.blockTime),
    observedAtMs: toFiniteNumberOrNull(candidate.observedAtMs),
    tokenDelta: toFiniteNumberOrNull(candidate.tokenDelta),
    wsolDelta: toFiniteNumberOrNull(candidate.wsolDelta),
    stableMint: String(candidate.stableMint || '').trim() || null,
    stableDelta: toFiniteNumberOrNull(candidate.stableDelta),
    uniqueNonQuoteMintCount: toFiniteNumberOrNull(candidate.uniqueNonQuoteMintCount),
  };
}

function buildProgramReport(program, probeResult = {}, ingestionResult = {}, error = null) {
  const traffic = buildTrafficSummary(probeResult.traffic);
  return {
    program: program.label,
    address: program.address,
    ok: !error,
    error: error ? String(error.message || error) : null,
    seen: Number(probeResult.seen) || 0,
    matches: Array.isArray(probeResult.matches) ? probeResult.matches.length : 0,
    skippedMentionOnly: Number(probeResult.skippedMentionOnly) || 0,
    accepted: Number(ingestionResult.accepted) || 0,
    blocked: Number(ingestionResult.blocked) || 0,
    lowVolume: Number(ingestionResult.lowVolume) || 0,
    skippedAfterIngestion: Number(ingestionResult.skipped) || 0,
    candidates: (Array.isArray(ingestionResult.candidates) ? ingestionResult.candidates : [])
      .map(normalizeCandidateForReport),
    skippedEvents: (Array.isArray(ingestionResult.skippedEvents) ? ingestionResult.skippedEvents : [])
      .map(normalizeCandidateForReport),
    traffic,
  };
}

function createDryRunSummary(reports = []) {
  return reports.reduce((summary, report) => {
    summary.programs += 1;
    summary.seen += report.seen;
    summary.matches += report.matches;
    summary.skippedMentionOnly += report.skippedMentionOnly;
    summary.accepted += report.accepted;
    summary.blocked += report.blocked;
    summary.lowVolume += report.lowVolume;
    summary.receivedBytes += report.traffic.receivedBytes;
    summary.estimatedCredits += report.traffic.estimatedCredits;
    return summary;
  }, {
    programs: 0,
    seen: 0,
    matches: 0,
    skippedMentionOnly: 0,
    accepted: 0,
    blocked: 0,
    lowVolume: 0,
    receivedBytes: 0,
    estimatedCredits: 0,
  });
}

function createEmptyTokenReport(tokenMint) {
  return {
    tokenMint,
    accepted: 0,
    blocked: 0,
    lowVolume: 0,
    skipped: 0,
    estimatedSolVolume: 0,
    estimatedUsdVolume: 0,
    programs: new Set(),
    volumeSources: new Map(),
    sampleSignatures: [],
  };
}

function addTokenReportEvent(report, event = {}, status) {
  const program = String(event.program || '').trim();
  const signature = String(event.signature || '').trim();
  const source = String(event.volumeSource || '').trim() || 'none';

  if (program) {
    report.programs.add(program);
  }
  report.volumeSources.set(source, (report.volumeSources.get(source) || 0) + 1);
  if (signature && !report.sampleSignatures.includes(signature) && report.sampleSignatures.length < 3) {
    report.sampleSignatures.push(signature);
  }

  if (status === 'accepted') {
    report.accepted += 1;
    report.estimatedSolVolume += Number(event.estimatedSolVolume) || 0;
    report.estimatedUsdVolume += Number(event.estimatedUsdVolume) || 0;
  } else if (event.skipReason === 'admin_blocked') {
    report.blocked += 1;
    report.skipped += 1;
  } else if (event.skipReason === 'low_volume' || event.skipReason === 'low_sol_volume') {
    report.lowVolume += 1;
    report.skipped += 1;
  } else {
    report.skipped += 1;
  }
}

function finalizeTokenReport(report) {
  return {
    ...report,
    estimatedSolVolume: Math.round(report.estimatedSolVolume * 1e9) / 1e9,
    estimatedUsdVolume: Math.round(report.estimatedUsdVolume * 100) / 100,
    programs: [...report.programs].sort(),
    volumeSources: Object.fromEntries([...report.volumeSources.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

function createTokenReports(reports = [], limit = DEFAULT_TOKEN_REPORT_LIMIT) {
  const byToken = new Map();

  function addEvent(event, status) {
    const tokenMint = String(event?.tokenMint || '').trim();
    if (!tokenMint) {
      return;
    }
    if (!byToken.has(tokenMint)) {
      byToken.set(tokenMint, createEmptyTokenReport(tokenMint));
    }
    addTokenReportEvent(byToken.get(tokenMint), event, status);
  }

  for (const report of Array.isArray(reports) ? reports : []) {
    for (const candidate of Array.isArray(report.candidates) ? report.candidates : []) {
      addEvent(candidate, 'accepted');
    }
    for (const skipped of Array.isArray(report.skippedEvents) ? report.skippedEvents : []) {
      addEvent(skipped, 'skipped');
    }
  }

  return [...byToken.values()]
    .map(finalizeTokenReport)
    .sort((a, b) => {
      if (b.accepted !== a.accepted) {
        return b.accepted - a.accepted;
      }
      if (b.estimatedUsdVolume !== a.estimatedUsdVolume) {
        return b.estimatedUsdVolume - a.estimatedUsdVolume;
      }
      return b.estimatedSolVolume - a.estimatedSolVolume;
    })
    .slice(0, Math.max(0, Number(limit) || DEFAULT_TOKEN_REPORT_LIMIT));
}

function collectAcceptedCandidates(reports = []) {
  return (Array.isArray(reports) ? reports : [])
    .flatMap((report) => (Array.isArray(report.candidates) ? report.candidates : []));
}

function createPriceObservationReport(reports = []) {
  const observations = [];
  const skippedByReason = {};

  for (const candidate of collectAcceptedCandidates(reports)) {
    const result = onchainPriceObservation.buildPriceObservation(candidate);
    if (result.accepted) {
      observations.push(result);
    } else {
      skippedByReason[result.skipReason] = (skippedByReason[result.skipReason] || 0) + 1;
    }
  }

  return { observations, skippedByReason };
}

function createPriceChangeReport(priceObservationReport = {}, options = {}) {
  const tracker = onchainPriceChangeTracker.createOnchainPriceChangeTracker(options);
  const results = (Array.isArray(priceObservationReport.observations)
    ? priceObservationReport.observations
    : [])
    .sort((a, b) => Number(a.observedAtMs) - Number(b.observedAtMs))
    .map((observation) => tracker.add(observation));
  const changes = results.filter((result) => result.ready === true);
  const rejectedByReason = results.reduce((counts, result) => {
    if (result.accepted !== false) return counts;
    counts[result.skipReason] = (counts[result.skipReason] || 0) + 1;
    return counts;
  }, {});
  const pendingByReason = results.reduce((counts, result) => {
    if (result.ready !== false) return counts;
    counts[result.reason] = (counts[result.reason] || 0) + 1;
    return counts;
  }, {});
  return { changes, pendingByReason, rejectedByReason, trackedObservations: tracker.size() };
}

function createWindowReports(reports = [], options = {}) {
  return onchainWindowAggregator.buildWindowReports(collectAcceptedCandidates(reports), {
    limit: options.windowReportLimit || DEFAULT_WINDOW_REPORT_LIMIT,
    nowMs: options.nowMs,
  });
}

async function evaluateProbeResult(probeResult, options = {}) {
  return quicknodeOnchainIngestion.evaluateTransactionSummaries(probeResult.matches || [], {
    minSolVolume: options.minSolVolume,
    minUsdVolume: options.minUsdVolume,
  });
}

function printProgramReport(report) {
  console.log(`[QuickNodeDryRun] ${report.program} ok=${report.ok} seen=${report.seen} matches=${report.matches} accepted=${report.accepted} blocked=${report.blocked} lowVolume=${report.lowVolume} skippedMentionOnly=${report.skippedMentionOnly}`);
  console.log(`[QuickNodeDryRun] ${report.program} traffic ${formatTrafficStats(report.traffic)}`);
  if (report.error) {
    console.log(`[QuickNodeDryRun] ${report.program} error=${report.error}`);
  }
}

function printFinalSummary(summary) {
  console.log(`[QuickNodeDryRun] summary programs=${summary.programs} seen=${summary.seen} matches=${summary.matches} accepted=${summary.accepted} blocked=${summary.blocked} lowVolume=${summary.lowVolume} skippedMentionOnly=${summary.skippedMentionOnly} receivedBytes=${summary.receivedBytes} estimatedCredits=${Math.round(summary.estimatedCredits * 100) / 100}`);
}

function printTokenReports(tokenReports = []) {
  if (!tokenReports.length) {
    console.log('[QuickNodeDryRun] tokenReport empty');
    return;
  }
  console.log(`[QuickNodeDryRun] tokenReport count=${tokenReports.length}`);
  for (const report of tokenReports) {
    console.log(`[QuickNodeDryRun] token=${report.tokenMint} accepted=${report.accepted} blocked=${report.blocked} lowVolume=${report.lowVolume} solVolume=${report.estimatedSolVolume} usdVolume=${report.estimatedUsdVolume} programs=${report.programs.join('|')} sources=${Object.keys(report.volumeSources).join('|')} samples=${report.sampleSignatures.join('|')}`);
  }
}

function printWindowReports(windowReports = []) {
  if (!windowReports.length) {
    console.log('[QuickNodeDryRun] windowReport empty');
    return;
  }
  console.log(`[QuickNodeDryRun] windowReport count=${windowReports.length}`);
  for (const report of windowReports) {
    console.log(`[QuickNodeDryRun] window=${report.window} token=${report.tokenMint} swaps=${report.swaps} solVolume=${report.estimatedSolVolume} usdVolume=${report.estimatedUsdVolume} programs=${report.programs.join('|')} sources=${Object.keys(report.volumeSources).join('|')} latest=${report.latestSignature || 'n/a'} samples=${report.sampleSignatures.join('|')}`);
  }
}

function printPriceObservationReport(report = {}) {
  const observations = Array.isArray(report.observations) ? report.observations : [];
  console.log(`[QuickNodeDryRun] priceObservations accepted=${observations.length} skipped=${JSON.stringify(report.skippedByReason || {})}`);
  for (const observation of observations.slice(0, 10)) {
    console.log(`[QuickNodeDryRun] price token=${observation.tokenMint} program=${observation.program} price=${observation.price} quoteUnit=${observation.quoteUnit} quoteMint=${observation.quoteMint} signature=${observation.signature}`);
  }
}

function printPriceChangeReport(report = {}) {
  console.log(`[QuickNodeDryRun] priceChange1h ready=${report.changes?.length || 0} tracked=${report.trackedObservations || 0} pending=${JSON.stringify(report.pendingByReason || {})} rejected=${JSON.stringify(report.rejectedByReason || {})}`);
  for (const change of report.changes || []) {
    console.log(`[QuickNodeDryRun] pchange token=${change.tokenMint} change1h=${change.priceChangePct} quoteUnit=${change.quoteUnit} current=${change.currentPrice} baseline=${change.baselinePrice}`);
  }
}

async function runDryRun(options = readOptionsFromEnv()) {
  console.log(`[QuickNodeDryRun] WS ${maskEndpoint(options.wsUrl)}`);
  console.log(`[QuickNodeDryRun] programs=${options.programs.map((program) => program.label).join(', ')} seconds=${options.seconds} matches=${options.matches}`);
  console.log(`[QuickNodeDryRun] mode=dry-run publishAlerts=false includeBondingCurve=false minSolVolume=${options.minSolVolume} minUsdVolume=${options.minUsdVolume}`);
  console.log('[QuickNodeDryRun] priceChangeMode=dry-run window=1H publishAlerts=false');

  const reports = [];
  for (const program of options.programs) {
    try {
      const probeResult = await probeProgram(options.wsUrl, program, options);
      const ingestionResult = await evaluateProbeResult(probeResult, options);
      const report = buildProgramReport(program, probeResult, ingestionResult);
      reports.push(report);
      printProgramReport(report);
    } catch (error) {
      const probeResult = error.result || {};
      const ingestionResult = await evaluateProbeResult(probeResult, options);
      const report = buildProgramReport(program, probeResult, ingestionResult, error);
      reports.push(report);
      printProgramReport(report);
    }
  }

  const summary = createDryRunSummary(reports);
  const tokenReports = createTokenReports(reports, options.tokenReportLimit);
  const priceObservationReport = createPriceObservationReport(reports);
  const priceChangeReport = createPriceChangeReport(priceObservationReport);
  const windowReports = createWindowReports(reports, {
    windowReportLimit: options.windowReportLimit,
  });
  printFinalSummary(summary);
  printTokenReports(tokenReports);
  printPriceObservationReport(priceObservationReport);
  printPriceChangeReport(priceChangeReport);
  printWindowReports(windowReports);
  return {
    reports,
    summary,
    tokenReports,
    priceObservationReport,
    priceChangeReport,
    windowReports,
  };
}

if (require.main === module) {
  runDryRun().catch((error) => {
    console.error(`[QuickNodeDryRun] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_PROGRAMS,
  buildProgramReport,
  buildTrafficSummary,
  collectAcceptedCandidates,
  createDryRunSummary,
  createPriceChangeReport,
  createPriceObservationReport,
  createTokenReports,
  createWindowReports,
  readOptionsFromEnv,
  resolveDryRunPrograms,
  runDryRun,
};

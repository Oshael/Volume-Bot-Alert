const { createRobinhoodTokenReadRepository } = require('../models/robinhood-token-read');
const {
  createRobinhoodSignalDryRunEvaluator,
  normalizeRobinhoodSignalConfig,
} = require('./robinhood-signal-policy');

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function summarize(decisions) {
  const summary = {
    candidates: decisions.length,
    uniqueTokens: new Set(decisions.map(({ result }) => result.tokenAddress)).size,
    expectedSignals: 0,
    suppressed: 0,
    byProtocol: {},
    byProtocolContribution: {},
    byReason: {},
    byLiquidityStatus: {},
  };
  for (const { candidate, result } of decisions) {
    const protocol = summary.byProtocol[result.protocol] ||= {
      candidates: 0,
      expectedSignals: 0,
      suppressed: 0,
    };
    protocol.candidates += 1;
    if (result.expectedSignal) {
      summary.expectedSignals += 1;
      protocol.expectedSignals += 1;
    } else {
      summary.suppressed += 1;
      protocol.suppressed += 1;
    }
    for (const reason of result.reasons) increment(summary.byReason, reason);
    increment(summary.byLiquidityStatus, candidate.liquidityStatus || 'unknown');
    for (const [name, contribution] of Object.entries(candidate.protocolBreakdown || {})) {
      const totals = summary.byProtocolContribution[name] ||= {
        tokens: 0, markets: 0, volumeUsd: 0, swaps: 0, transactions: 0,
      };
      totals.tokens += 1;
      totals.markets += Number(contribution.markets) || 0;
      totals.volumeUsd += Number(contribution.volumeUsd) || 0;
      totals.swaps += Number(contribution.swaps) || 0;
      totals.transactions += Number(contribution.transactions) || 0;
    }
  }
  return summary;
}

function compactDecision(candidate, result) {
  return {
    chain: result.chain,
    protocol: result.protocol,
    marketKey: result.marketKey,
    tokenAddress: result.tokenAddress,
    quoteAddress: candidate.quoteAddress,
    decision: result.decision,
    expectedSignal: result.expectedSignal,
    publishable: false,
    reasons: result.reasons,
    gates: result.gates,
    liquidityStatus: candidate.liquidityStatus,
    liquidityCoverage: candidate.liquidityCoverage,
    protocolBreakdown: candidate.protocolBreakdown || {},
    windowStart: candidate.windowStart,
    windowEnd: candidate.windowEnd,
    lastObservedAt: candidate.lastObservedAt,
  };
}

function inactiveReport(config, generatedAt) {
  return {
    mode: 'dry-run',
    status: config.enabled ? 'gates-not-configured' : 'disabled',
    generatedAt,
    publishable: false,
    publicationAttempts: 0,
    config,
    summary: summarize([]),
    candidateLimitReached: false,
    samples: [],
  };
}

function createRobinhoodSignalDryRunReporter(options = {}) {
  const config = normalizeRobinhoodSignalConfig(options.config);
  const repository = options.repository || createRobinhoodTokenReadRepository();
  const now = options.now || Date.now;
  const candidateLimit = boundedPositiveInteger(options.candidateLimit, 1000, 5000);
  const sampleLimit = boundedPositiveInteger(options.sampleLimit, 25, 100);
  const statementTimeoutMs = boundedPositiveInteger(options.statementTimeoutMs, 10_000, 60_000);

  async function runOnce(input = {}) {
    const generatedAt = new Date(input.asOf ?? now());
    if (!Number.isFinite(generatedAt.getTime())) throw new Error('dry-run asOf must be valid');
    if (!config.enabled || !config.configured) return inactiveReport(config, generatedAt.toISOString());

    const candidates = await repository.listSignalDryRunCandidates({
      windowMs: config.windowMs,
      limit: candidateLimit,
      asOf: generatedAt,
      statementTimeoutMs,
    });
    const blockedTokens = new Set(
      candidates.filter((candidate) => candidate.adminBlocked).map((candidate) => candidate.tokenAddress)
    );
    const evaluator = createRobinhoodSignalDryRunEvaluator({
      config,
      now: () => generatedAt.getTime(),
      adminBlocklist: { hasAddress: async (address) => blockedTokens.has(address) },
      policyOptions: options.policyOptions,
    });
    const results = await Promise.all(candidates.map((candidate) => evaluator.evaluate(candidate)));
    const decisions = candidates.map((candidate, index) => ({ candidate, result: results[index] }));
    return {
      mode: 'dry-run',
      status: 'completed',
      generatedAt: generatedAt.toISOString(),
      publishable: false,
      publicationAttempts: 0,
      config,
      summary: summarize(decisions),
      candidateLimitReached: candidates.length === candidateLimit,
      samples: decisions.slice(0, sampleLimit).map(({ candidate, result }) => (
        compactDecision(candidate, result)
      )),
    };
  }

  return Object.freeze({ runOnce });
}

module.exports = {
  compactDecision,
  createRobinhoodSignalDryRunReporter,
  summarize,
};

const { createRobinhoodTokenReadRepository } = require('../models/robinhood-token-read');
const { createRobinhoodCatalogProjector } = require('./robinhood-catalog-projector');
const {
  createRobinhoodSignalDryRunEvaluator,
  normalizeRobinhoodSignalConfig,
} = require('./robinhood-signal-policy');

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function inactive(status, reason, generatedAt, config) {
  return Object.freeze({
    status,
    reason,
    generatedAt,
    queried: 0,
    expectedSignals: 0,
    staged: 0,
    suppressed: 0,
    candidateLimitReached: false,
    config,
  });
}

function authorizeForStaging(decision) {
  return decision?.expectedSignal === true
    ? Object.freeze({ ...decision, mode: 'staging', publishable: true })
    : decision;
}

function createRobinhoodCatalogStagingBatch(options = {}) {
  const repository = options.repository || createRobinhoodTokenReadRepository();
  const projector = options.projector || createRobinhoodCatalogProjector(options.projectorOptions);
  const evaluatorFactory = options.evaluatorFactory || createRobinhoodSignalDryRunEvaluator;
  const now = options.now || Date.now;

  function prepareRun(input) {
    const generatedAtDate = new Date(input.asOf ?? now());
    if (!Number.isFinite(generatedAtDate.getTime())) throw new Error('staging asOf must be valid');
    const generatedAt = generatedAtDate.toISOString();
    const config = normalizeRobinhoodSignalConfig({
      ...(input.signalConfig || {}),
      enabled: true,
    });
    return { config, generatedAt, generatedAtDate };
  }

  function closedResult(input, run) {
    if (input.alertsRequested !== true) {
      return inactive('disabled', 'alerts_disabled', run.generatedAt, run.config);
    }
    if (input.publishable !== true) {
      return inactive('blocked', 'rollout_not_publishable', run.generatedAt, run.config);
    }
    if (!run.config.configured) {
      return inactive('blocked', 'gates_not_configured', run.generatedAt, run.config);
    }
    return null;
  }

  async function evaluateCandidates(candidates, run, candidateLimitReached) {
    const blockedTokens = new Set(
      candidates.filter((candidate) => candidate.adminBlocked).map((candidate) => candidate.tokenAddress)
    );
    const evaluator = evaluatorFactory({
      config: run.config,
      now: () => run.generatedAtDate.getTime(),
      adminBlocklist: { hasAddress: async (address) => blockedTokens.has(address) },
      policyOptions: options.policyOptions,
    });
    const decisions = await Promise.all(candidates.map((candidate) => evaluator.evaluate(candidate)));
    const outcomes = await Promise.all(candidates.map((candidate, index) => (
      candidate.protocol === 'uniswap-v2'
        ? projector.stage(
            candidate,
            authorizeForStaging(decisions[index]),
            { alertsRequested: true, publishable: true }
          )
        : Object.freeze({
            status: 'skipped',
            reason: 'legacy_catalog_projector_protocol_unsupported',
            staged: false,
          })
    )));
    const staged = outcomes.filter((outcome) => outcome.staged === true).length;
    const expectedSignals = decisions.filter((decision) => decision.expectedSignal === true).length;
    const approved = candidates.flatMap((candidate, index) => (
      decisions[index]?.expectedSignal === true
        ? [{ candidate, decision: authorizeForStaging(decisions[index]), outcome: outcomes[index] }]
        : []
    ));
    const publication = typeof options.approvedConsumer === 'function'
      ? await options.approvedConsumer(approved, {
          alertsRequested: true,
          publishable: true,
          generatedAt: run.generatedAt,
        }, { candidates })
      : null;

    return Object.freeze({
      status: 'completed',
      reason: null,
      generatedAt: run.generatedAt,
      queried: candidates.length,
      expectedSignals,
      staged,
      suppressed: candidates.length - expectedSignals,
      candidateLimitReached,
      config: run.config,
      publication,
    });
  }

  async function runOnce(input = {}) {
    const run = prepareRun(input);
    const closed = closedResult(input, run);
    if (closed) return closed;
    const candidateLimit = boundedInteger(input.candidateLimit, 1000, 5000);
    const candidates = await repository.listSignalDryRunCandidates({
      windowMs: run.config.windowMs,
      limit: candidateLimit,
      asOf: run.generatedAtDate,
      statementTimeoutMs: boundedInteger(input.statementTimeoutMs, 10_000, 60_000),
    });
    return evaluateCandidates(candidates, run, candidates.length === candidateLimit);
  }

  async function runCandidates(candidates, input = {}) {
    if (!Array.isArray(candidates)) throw new TypeError('staging candidates must be an array');
    if (candidates.length > 5000) throw new RangeError('staging accepts at most 5000 candidates');
    const run = prepareRun(input);
    const closed = closedResult(input, run);
    return closed || evaluateCandidates(candidates, run, false);
  }

  return Object.freeze({ runCandidates, runOnce });
}

module.exports = {
  createRobinhoodCatalogStagingBatch,
  __private: { authorizeForStaging, boundedInteger },
};

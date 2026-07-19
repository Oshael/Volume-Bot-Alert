const userAlertProfileCache = require('./user-alert-profile-cache');
const { createRobinhoodTokenReadRepository } = require('../models/robinhood-token-read');
const {
  MAX_INTENTS_PER_DELIVERY,
  createRobinhoodAlertDelivery,
} = require('./robinhood-alert-delivery');
const { createRobinhoodAlertMatcher } = require('./robinhood-alert-matcher');
const { createRobinhoodCatalogStagingBatch } = require('./robinhood-catalog-staging-batch');
const { createRobinhoodCustomAlertAdapter } = require('./robinhood-custom-alert-adapter');
const { normalizeRobinhoodSignalConfig } = require('./robinhood-signal-policy');

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function emptyPublication() {
  return Object.freeze({
    evaluatedProfiles: 0,
    matchedProfiles: 0,
    evaluatedCustomRules: 0,
    matchedCustomRules: 0,
    intents: 0,
    delivery: null,
  });
}

function shadowDelivery() {
  return Object.freeze({
    status: 'blocked', reason: 'shadow_only', attempted: 0, persisted: 0,
    duplicates: 0, notified: 0, publishErrors: 0, errors: 0, lastError: null,
  });
}

async function deliverInBatches(delivery, intents, rollout) {
  const batches = [];
  if (!intents.length) batches.push([]);
  for (let index = 0; index < intents.length; index += MAX_INTENTS_PER_DELIVERY) {
    batches.push(intents.slice(index, index + MAX_INTENTS_PER_DELIVERY));
  }
  const summary = {
    status: 'completed', reason: null, attempted: 0, persisted: 0,
    duplicates: 0, notified: 0, publishErrors: 0, errors: 0, lastError: null,
  };
  for (const batch of batches) {
    const result = await delivery.deliver({
      alertsRequested: rollout.alertsRequested,
      publishable: rollout.publishable,
      intents: batch,
    });
    if (result?.status && result.status !== 'completed') {
      summary.status = 'partial';
      summary.reason ||= result.reason || 'delivery_batch_incomplete';
    }
    for (const field of [
      'attempted', 'persisted', 'duplicates', 'notified', 'publishErrors', 'errors',
    ]) {
      summary[field] += Number(result?.[field]) || 0;
    }
    if (result?.lastError) summary.lastError = String(result.lastError);
  }
  return Object.freeze(summary);
}

function createRobinhoodAlertPublicationBatch(options = {}) {
  const profileCache = options.userAlertProfileCache || userAlertProfileCache;
  const matcher = options.matcher || createRobinhoodAlertMatcher();
  const customAdapter = options.customAlertAdapter || createRobinhoodCustomAlertAdapter({
    userCustomAlertRule: options.userCustomAlertRule,
  });
  const delivery = options.delivery || createRobinhoodAlertDelivery(options.deliveryOptions);
  const shadowRepository = options.shadowRepository
    || options.stagingOptions?.repository
    || createRobinhoodTokenReadRepository();

  function prepareShadow(input) {
    const config = normalizeRobinhoodSignalConfig({
      ...(input.signalConfig || {}),
      enabled: true,
    });
    if (!config.configured) return null;

    const generatedAtDate = new Date(input.asOf ?? Date.now());
    if (!Number.isFinite(generatedAtDate.getTime())) throw new Error('shadow asOf must be valid');
    return { config, generatedAtDate };
  }

  async function buildShadowResult(run, candidates, candidateLimitReached) {
    const custom = await customAdapter.evaluate(candidates);
    return Object.freeze({
      status: 'shadow',
      reason: 'rollout_not_publishable',
      generatedAt: run.generatedAtDate.toISOString(),
      queried: candidates.length,
      expectedSignals: 0,
      staged: 0,
      suppressed: 0,
      candidateLimitReached,
      config: run.config,
      publication: Object.freeze({
        mode: 'shadow',
        evaluatedProfiles: 0,
        matchedProfiles: 0,
        evaluatedCustomRules: custom.evaluatedRules,
        matchedCustomRules: custom.matchedRules,
        intents: custom.intents.length,
        delivery: shadowDelivery(),
      }),
    });
  }

  async function evaluateCustomRulesInShadow(input) {
    const run = prepareShadow(input);
    if (!run) return null;
    const candidateLimit = boundedInteger(input.candidateLimit, 25, 25);
    const read = shadowRepository.listColdRepairCandidates
      || shadowRepository.listSignalDryRunCandidates;
    const candidates = await read.call(shadowRepository, {
      windowMs: run.config.windowMs,
      limit: candidateLimit,
      asOf: run.generatedAtDate,
      statementTimeoutMs: boundedInteger(input.statementTimeoutMs, 10_000, 60_000),
    });
    return buildShadowResult(run, candidates, candidates.length === candidateLimit);
  }

  async function publishApproved(approved, rollout, context = {}) {
    const candidates = Array.isArray(context.candidates) ? context.candidates : [];
    if (!approved.length && !candidates.length) return emptyPublication();

    const profiles = approved.length
      ? await profileCache.listActiveProfiles({ sharedPresence: options.sharedPresence ?? true })
      : [];
    const matches = approved.map(({ candidate, decision }) => matcher.match({
      alertsRequested: rollout.alertsRequested,
      publishable: rollout.publishable,
      candidate,
      decision,
      profiles,
    }));
    const custom = await customAdapter.evaluate(candidates);
    const intents = [
      ...matches.flatMap((result) => result.intents),
      ...custom.intents,
    ];
    const deliveryResult = await deliverInBatches(delivery, intents, rollout);

    return Object.freeze({
      evaluatedProfiles: profiles.length,
      matchedProfiles: matches.reduce((sum, result) => sum + result.matchedProfiles, 0),
      evaluatedCustomRules: custom.evaluatedRules,
      matchedCustomRules: custom.matchedRules,
      intents: intents.length,
      delivery: deliveryResult,
    });
  }

  const stagingBatch = options.stagingBatch || createRobinhoodCatalogStagingBatch({
    ...(options.stagingOptions || {}),
    approvedConsumer: publishApproved,
  });

  async function runOnce(input = {}) {
    if (input.alertsRequested === true && input.publishable !== true) {
      const shadow = await evaluateCustomRulesInShadow(input);
      if (shadow) return shadow;
    }
    return stagingBatch.runOnce(input);
  }

  async function runCandidates(candidates, input = {}) {
    if (input.alertsRequested === true && input.publishable !== true) {
      const run = prepareShadow(input);
      if (run) return buildShadowResult(run, candidates, false);
    }
    return stagingBatch.runCandidates(candidates, input);
  }

  return Object.freeze({ runCandidates, runOnce });
}

module.exports = {
  createRobinhoodAlertPublicationBatch,
  __private: { boundedInteger, deliverInBatches, emptyPublication, shadowDelivery },
};

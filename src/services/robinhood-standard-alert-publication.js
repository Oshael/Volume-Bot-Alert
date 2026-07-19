const db = require('../models/db');
const userAlertEvent = require('../models/user-alert-event');
const userAlertRuleState = require('../models/user-alert-rule-state');
const backendAlertPublisher = require('./backend-alert-publisher');
const userAlertProfileCache = require('./user-alert-profile-cache');
const {
  issueAutomaticAlertPublicationAuthorization,
} = require('./automatic-alert-publication-guard');
const {
  CHAIN,
  STANDARD_RULE_KEYS,
} = require('./robinhood-standard-alert-contract');
const {
  evaluateRobinhoodStandardSignal,
} = require('./robinhood-standard-alert-matcher');

const SURGE_CONTINUATION_RULE_KEY = 'surge-continuation-6h';
const MUTATING_ACTIONS = new Set(['emit', 'prime', 'rearm']);

function cooldownUntil(candidate, triggeredAt) {
  const cooldownMs = Number(candidate?.cooldownMs);
  return Number.isFinite(cooldownMs) && cooldownMs > 0
    ? new Date(triggeredAt.getTime() + cooldownMs) : null;
}

function buildEventIntent(userId, signal, plan, triggeredAt) {
  const candidate = plan.candidate;
  return {
    userId, chain: CHAIN, ruleKey: plan.ruleKey, kind: candidate.kind,
    tokenAddress: signal.address,
    dedupeKey: `${userId}:${plan.ruleKey}:${signal.address}:${candidate.fingerprint}`,
    payload: {
      ...candidate.payload, chain: CHAIN, address: signal.address,
      label: candidate.label || null, pct: candidate.pct ?? null,
    },
    triggeredAt,
  };
}

function buildTriggeredMetadata(plan, event, triggeredAt) {
  return {
    ...(plan.state?.metadata || {}),
    lastDecision: 'triggered', lastEventId: event.id,
    lastAlertedFdv: plan.candidate.payload?.fdv ?? null,
    label: plan.candidate.label || null,
    triggeredAt: triggeredAt.toISOString(),
  };
}

async function markTriggered(context, plan, event, metadata) {
  const { stateModel, client, authorization, userId, signal, triggeredAt } = context;
  const candidate = plan.candidate;
  await stateModel.markTriggered({
    userId, chain: CHAIN, tokenAddress: signal.address, ruleKey: plan.ruleKey,
    lastAlertedAt: triggeredAt, lastAlertedValue: candidate.lastAlertedValue,
    lastAlertedPct: candidate.pct, cooldownUntil: cooldownUntil(candidate, triggeredAt),
    lastFingerprint: candidate.fingerprint, metadata, authorization,
  }, client);
}

async function rearmSurgeAfterEmit(context, plan, metadata) {
  if (plan.candidate.kind !== 'old-surge') return 0;
  await context.stateModel.markRearmed({
    userId: context.userId, chain: CHAIN, tokenAddress: context.signal.address,
    ruleKey: plan.ruleKey,
    cooldownUntil: cooldownUntil(plan.candidate, context.triggeredAt),
    lastFingerprint: plan.candidate.fingerprint,
    metadata: {
      ...metadata, lastDecision: 'rearmed', rearmedAt: context.triggeredAt.toISOString(),
    },
    authorization: context.authorization,
  }, context.client);
  return 1;
}

async function persistContinuation(context, plan, event) {
  const baseRuleKey = plan.candidate.payload.baseRuleKey;
  await context.stateModel.markRearmed({
    userId: context.userId, chain: CHAIN, tokenAddress: context.signal.address,
    ruleKey: baseRuleKey, cooldownUntil: plan.state?.cooldownUntil || null,
    metadata: {
      ...(plan.state?.metadata || {}), lastDecision: 'rearmed',
      surgeContinuation6hLastBaseEventId: plan.candidate.payload.baseEventId,
      surgeContinuation6hEventId: event.id,
      surgeContinuation6hAlertedAt: context.triggeredAt.toISOString(),
    },
    authorization: context.authorization,
  }, context.client);
}

async function persistEmit(context, plan) {
  const intent = buildEventIntent(context.userId, context.signal, plan, context.triggeredAt);
  const event = await context.eventModel.createEventOnce(intent, {
    db: context.client, authorization: context.authorization,
  });
  if (!event) return { duplicate: 1, events: [], stateWrites: 0 };
  if (plan.ruleKey === SURGE_CONTINUATION_RULE_KEY) {
    await persistContinuation(context, plan, event);
    return { duplicate: 0, events: [event], stateWrites: 1 };
  }
  const metadata = buildTriggeredMetadata(plan, event, context.triggeredAt);
  await markTriggered(context, plan, event, metadata);
  const rearmed = await rearmSurgeAfterEmit(context, plan, metadata);
  return { duplicate: 0, events: [event], stateWrites: 1 + rearmed };
}

async function persistPrime(context, plan) {
  const candidate = plan.candidate;
  await context.stateModel.markTriggered({
    userId: context.userId, chain: CHAIN, tokenAddress: context.signal.address,
    ruleKey: plan.ruleKey, lastAlertedAt: null,
    lastAlertedValue: candidate.lastAlertedValue, lastAlertedPct: candidate.pct,
    cooldownUntil: null, lastFingerprint: candidate.fingerprint,
    metadata: {
      ...(plan.state?.metadata || {}), lastDecision: 'primed-hot',
      lastAlertedFdv: candidate.payload?.fdv ?? null,
      primedAt: context.triggeredAt.toISOString(),
    },
    authorization: context.authorization,
  }, context.client);
  return { duplicate: 0, events: [], stateWrites: 1 };
}

async function persistRearm(context, plan) {
  await context.stateModel.markRearmed({
    userId: context.userId, chain: CHAIN, tokenAddress: context.signal.address,
    ruleKey: plan.ruleKey, cooldownUntil: plan.state?.cooldownUntil || null,
    metadata: {
      ...(plan.state?.metadata || {}), lastDecision: 'rearmed',
      rearmedAt: context.triggeredAt.toISOString(),
    },
    authorization: context.authorization,
  }, context.client);
  return { duplicate: 0, events: [], stateWrites: 1 };
}

function persistPlan(context, plan) {
  if (plan.action === 'emit') return persistEmit(context, plan);
  if (plan.action === 'prime') return persistPrime(context, plan);
  if (plan.action === 'rearm') return persistRearm(context, plan);
  return Promise.resolve({ duplicate: 0, events: [], stateWrites: 0 });
}

async function transactEvaluation(context, evaluation) {
  const plans = evaluation.plans.filter((plan) => MUTATING_ACTIONS.has(plan.action));
  if (!plans.length) return { duplicate: 0, events: [], stateWrites: 0 };
  const client = await context.database.getClient();
  const totals = { duplicate: 0, events: [], stateWrites: 0 };
  try {
    await client.query('BEGIN');
    for (const plan of plans) {
      const result = await persistPlan({ ...context, client, userId: evaluation.userId }, plan);
      totals.duplicate += result.duplicate;
      totals.events.push(...result.events);
      totals.stateWrites += result.stateWrites;
    }
    await client.query('COMMIT');
    return totals;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function createSummary(status, reason = null) {
  return {
    status, reason, signals: 0, evaluatedProfiles: 0, plans: 0,
    plannedEmits: 0, persisted: 0, duplicates: 0, stateWrites: 0,
    notified: 0, publishErrors: 0,
  };
}

function createRobinhoodStandardAlertPublication(options = {}) {
  const dependencies = {
    database: options.db || db,
    eventModel: options.userAlertEvent || userAlertEvent,
    stateModel: options.userAlertRuleState || userAlertRuleState,
  };
  const profileCache = options.userAlertProfileCache || userAlertProfileCache;
  const publisher = options.backendAlertPublisher || backendAlertPublisher;
  const evaluateSignal = options.evaluateSignal || evaluateRobinhoodStandardSignal;
  const authorize = options.issueAuthorization || issueAutomaticAlertPublicationAuthorization;

  async function consume(input = {}) {
    const signals = Array.isArray(input.signals) ? input.signals : [];
    if (input.alertsRequested !== true) return Object.freeze(createSummary('disabled', 'alerts_disabled'));
    const profiles = await profileCache.listActiveProfiles({ sharedPresence: true });
    const evaluated = [];
    for (const signal of signals) {
      const states = await dependencies.stateModel.listStatesByUsersForToken({
        userIds: profiles.map((profile) => profile.userId),
        ruleKeys: STANDARD_RULE_KEYS, chain: CHAIN, tokenAddress: signal.address,
      });
      evaluated.push({
        signal,
        result: evaluateSignal({ signal, profiles, states, now: signal.generatedAt }),
      });
    }
    const summary = createSummary(input.publishable === true ? 'completed' : 'shadow',
      input.publishable === true ? null : 'rollout_not_publishable');
    summary.signals = signals.length;
    summary.evaluatedProfiles = evaluated.reduce((sum, item) => sum + item.result.evaluations.length, 0);
    summary.plans = evaluated.reduce((sum, item) => sum
      + item.result.evaluations.reduce((count, value) => count + value.plans.length, 0), 0);
    summary.plannedEmits = evaluated.reduce((sum, item) => sum
      + item.result.evaluations.flatMap((value) => value.plans)
        .filter((plan) => plan.action === 'emit').length, 0);
    if (input.publishable !== true) return Object.freeze(summary);
    const authorization = authorize({ chain: CHAIN, alertsRequested: true, publishable: true });
    for (const item of evaluated) {
      const triggeredAt = new Date(item.signal.generatedAt);
      for (const evaluation of item.result.evaluations) {
        const persisted = await transactEvaluation({
          ...dependencies, authorization, signal: item.signal, triggeredAt,
        }, evaluation);
        summary.persisted += persisted.events.length;
        summary.duplicates += persisted.duplicate;
        summary.stateWrites += persisted.stateWrites;
        for (const event of persisted.events) {
          const publication = await publisher.publishEventSafe(event, {
            logLabel: 'RobinhoodStandardAlertPublication',
          });
          if (publication?.notified === true) summary.notified += 1;
          if (publication?.error) summary.publishErrors += 1;
        }
      }
    }
    return Object.freeze(summary);
  }

  return Object.freeze({ consume });
}

module.exports = {
  SURGE_CONTINUATION_RULE_KEY,
  createRobinhoodStandardAlertPublication,
  __private: { buildEventIntent, persistPlan, transactEvaluation },
};

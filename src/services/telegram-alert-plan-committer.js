const db = require('../models/db');
const deliveryModel = require('../models/telegram-alert-delivery');
const stateModel = require('../models/telegram-alert-rule-state');

const EVENT_REFERENCE_FIELDS = new Set([
  'metadata.lastEventId',
  'metadata.surgeContinuation6hEventId',
]);

class TelegramAlertPlanCommitError extends Error {
  constructor(message, code = 'plan_commit_failed') {
    super(message);
    this.name = 'TelegramAlertPlanCommitError';
    this.code = code;
  }
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function indexIntents(intents, profileId, connectionId) {
  const intentsByRef = new Map();
  const referenceCount = new Map();
  for (const intent of intents) {
    const intentRef = String(intent?.intentRef || '').trim();
    if (!intentRef || intentsByRef.has(intentRef)) {
      throw new TypeError('Telegram alert intentRef must be unique');
    }
    if (String(intent.profileId) !== profileId || String(intent.connectionId) !== connectionId) {
      throw new TypeError(`Telegram alert intent identity mismatch: ${intentRef}`);
    }
    intentsByRef.set(intentRef, intent);
    referenceCount.set(intentRef, 0);
  }
  return { intentsByRef, referenceCount };
}

function validateReference(reference, transition, intentsByRef, fields) {
  const field = String(reference?.field || '').trim();
  const intentRef = String(reference?.intentRef || '').trim();
  const intent = intentsByRef.get(intentRef);
  if (!EVENT_REFERENCE_FIELDS.has(field) || fields.has(field) || !intent) {
    throw new TypeError('Invalid Telegram alert state event reference');
  }
  if (intent.chain !== transition.chain
    || intent.ruleKey !== transition.ruleKey
    || intent.tokenAddress !== transition.tokenAddress) {
    throw new TypeError(`Telegram alert state event identity mismatch: ${intentRef}`);
  }
  fields.add(field);
  return intentRef;
}

function validateTransition(transition, profileId, indexed) {
  if (String(transition?.profileId) !== profileId) {
    throw new TypeError('Telegram alert state transition profile mismatch');
  }
  const references = requireArray(
    transition.eventReferences,
    'state transition eventReferences'
  );
  const fields = new Set();
  for (const reference of references) {
    const intentRef = validateReference(
      reference,
      transition,
      indexed.intentsByRef,
      fields
    );
    indexed.referenceCount.set(
      intentRef,
      indexed.referenceCount.get(intentRef) + 1
    );
  }
  if (transition.state?.metadata?.lastDecision === 'triggered' && !references.length) {
    throw new TypeError('Triggered Telegram alert state requires a durable intent');
  }
}

function ensureIntentsReferenced(referenceCount) {
  for (const [intentRef, count] of referenceCount) {
    if (count === 0) {
      throw new TypeError(`Telegram alert intent is not referenced by state: ${intentRef}`);
    }
  }
}

function preparePlan(plan = {}) {
  const profileId = String(plan.profileId || '').trim();
  const connectionId = String(plan.connectionId || '').trim();
  if (!profileId || !connectionId) {
    throw new TypeError('Telegram alert plan profile and connection are required');
  }
  const intents = requireArray(plan.intents, 'plan intents');
  const transitions = requireArray(plan.stateTransitions, 'plan stateTransitions');
  const indexed = indexIntents(intents, profileId, connectionId);
  transitions.forEach((transition) => validateTransition(transition, profileId, indexed));
  ensureIntentsReferenced(indexed.referenceCount);
  return { profileId, connectionId, intents, transitions };
}

function resolveState(transition, persistedByRef) {
  const state = transition.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('Telegram alert transition state must be an object');
  }
  const metadata = { ...(state.metadata || {}) };
  for (const reference of transition.eventReferences) {
    const persisted = persistedByRef.get(reference.intentRef);
    metadata[reference.field.slice('metadata.'.length)] = persisted.delivery.id;
  }
  return { ...state, metadata };
}

function createTelegramAlertPlanCommitter(options = {}) {
  const database = options.database || db;
  const deliveries = options.deliveryModel || deliveryModel;
  const states = options.stateModel || stateModel;

  async function commit(plan = {}) {
    const prepared = preparePlan(plan);
    if (!prepared.intents.length && !prepared.transitions.length) {
      return Object.freeze({ deliveries: Object.freeze([]), statesWritten: 0, duplicate: false });
    }

    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const persistedByRef = new Map();
      for (const intent of prepared.intents) {
        persistedByRef.set(intent.intentRef, await deliveries.createPending(intent, client));
      }
      const allDuplicate = prepared.intents.length > 0
        && [...persistedByRef.values()].every(({ created }) => !created);
      let statesWritten = 0;
      for (const transition of prepared.transitions) {
        const referenced = transition.eventReferences.map(
          ({ intentRef }) => persistedByRef.get(intentRef)
        );
        if (referenced.length && referenced.every(({ created }) => !created)) continue;
        if (referenced.some(({ created }) => !created)) {
          throw new TelegramAlertPlanCommitError(
            'State transition mixes new and existing Telegram intents',
            'mixed_intent_state'
          );
        }
        const written = await states.write({
          ...transition,
          state: resolveState(transition, persistedByRef),
        }, client);
        if (!written) {
          throw new TelegramAlertPlanCommitError(
            `Telegram alert state changed: ${transition.ruleKey}`,
            'state_conflict'
          );
        }
        statesWritten += 1;
      }
      await client.query('COMMIT');
      return Object.freeze({
        deliveries: Object.freeze(
          [...persistedByRef.values()].map(({ delivery }) => delivery)
        ),
        statesWritten,
        duplicate: allDuplicate,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ commit });
}

module.exports = {
  TelegramAlertPlanCommitError,
  createTelegramAlertPlanCommitter,
};

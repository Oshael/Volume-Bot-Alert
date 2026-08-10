const db = require('../models/db');
const userAlertEvent = require('../models/user-alert-event');
const userCustomAlertRule = require('../models/user-custom-alert-rule');
const backendAlertPublisher = require('./backend-alert-publisher');
const alertTickerPeers = require('./alert-ticker-peers');
const {
  issueAutomaticAlertPublicationAuthorization,
} = require('./automatic-alert-publication-guard');
const {
  CHAIN,
  KIND,
  RULE_KEY,
} = require('./robinhood-alert-matcher');

const MAX_INTENTS_PER_DELIVERY = 500;
const CUSTOM_ALERT_RULE_KEY = 'custom-alert';

function inactive(status, reason) {
  return Object.freeze({
    status,
    reason,
    attempted: 0,
    persisted: 0,
    duplicates: 0,
    notified: 0,
    publishErrors: 0,
    errors: 0,
    lastError: null,
  });
}

function validateIntent(intent) {
  const customRuleId = Number(intent?.customRuleId);
  const isHvnc = intent?.ruleKey === RULE_KEY && intent?.kind === KIND;
  const isCustom = intent?.ruleKey === CUSTOM_ALERT_RULE_KEY
    && intent?.kind === CUSTOM_ALERT_RULE_KEY
    && Number.isSafeInteger(customRuleId) && customRuleId > 0;
  if (intent?.chain !== CHAIN || (!isHvnc && !isCustom)) {
    throw new Error('Robinhood alert delivery received an unsupported intent');
  }
  return intent;
}

function isCustomIntent(intent) {
  return intent.ruleKey === CUSTOM_ALERT_RULE_KEY;
}

function createRobinhoodAlertDelivery(options = {}) {
  const eventModel = options.userAlertEvent || userAlertEvent;
  const customRuleModel = options.userCustomAlertRule || userCustomAlertRule;
  const publisher = options.backendAlertPublisher || backendAlertPublisher;
  const tickerPeerService = options.alertTickerPeers || alertTickerPeers;
  const database = options.db || db;

  async function enrichIntentWithTickerPeers(intent, cache) {
    const address = intent.tokenAddress;
    let snapshotPromise = cache.get(address);
    if (!snapshotPromise) {
      snapshotPromise = tickerPeerService.buildTickerPeerSnapshotForAlert({
        chain: CHAIN,
        address,
        symbol: intent.payload?.symbol || null,
        name: intent.payload?.name || null,
      }, { snapshotTsMs: new Date(intent.triggeredAt).getTime() });
      cache.set(address, snapshotPromise);
    }
    const tickerPeers = await snapshotPromise;
    if (!tickerPeers) return intent;
    return {
      ...intent,
      payload: { ...intent.payload, tickerPeers },
    };
  }

  async function persistCustomIntent(intent, authorization) {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const triggered = await customRuleModel.markTriggered(
        intent.customRuleId,
        intent.userId,
        {
          chain: CHAIN,
          triggeredAt: intent.triggeredAt,
          authorization,
        },
        client,
      );
      if (!triggered) {
        await client.query('ROLLBACK');
        return null;
      }
      const event = await eventModel.createEventOnce(intent, { authorization, db: client });
      await client.query('COMMIT');
      return event;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
      }
      throw error;
    } finally {
      client.release();
    }
  }

  function persistIntent(intent, authorization) {
    return isCustomIntent(intent)
      ? persistCustomIntent(intent, authorization)
      : eventModel.createEventOnce(intent, { authorization, db: options.db });
  }

  async function deliver(input = {}) {
    if (input.alertsRequested !== true) return inactive('disabled', 'alerts_disabled');
    if (input.publishable !== true) return inactive('blocked', 'rollout_not_publishable');
    const intents = Array.isArray(input.intents) ? input.intents : [];
    if (intents.length > MAX_INTENTS_PER_DELIVERY) {
      throw new Error(`Robinhood alert delivery accepts at most ${MAX_INTENTS_PER_DELIVERY} intents`);
    }

    const authorization = issueAutomaticAlertPublicationAuthorization({
      chain: CHAIN,
      alertsRequested: true,
      publishable: true,
    });
    const summary = {
      status: 'completed',
      reason: null,
      attempted: intents.length,
      persisted: 0,
      duplicates: 0,
      notified: 0,
      publishErrors: 0,
      errors: 0,
      lastError: null,
    };
    const tickerPeersByAddress = new Map();

    for (const rawIntent of intents) {
      try {
        const intent = await enrichIntentWithTickerPeers(
          validateIntent(rawIntent), tickerPeersByAddress,
        );
        const event = await persistIntent(intent, authorization);
        if (!event) {
          summary.duplicates += 1;
          continue;
        }

        summary.persisted += 1;
        const publication = await publisher.publishEventSafe(event, {
          logLabel: 'RobinhoodAlertDelivery',
        });
        if (publication?.notified === true) summary.notified += 1;
        if (publication?.error) summary.publishErrors += 1;
      } catch (error) {
        summary.errors += 1;
        summary.lastError = String(error?.message || error || 'Unknown delivery error').slice(0, 240);
      }
    }

    return Object.freeze(summary);
  }

  return Object.freeze({ deliver });
}

module.exports = {
  CUSTOM_ALERT_RULE_KEY,
  MAX_INTENTS_PER_DELIVERY,
  createRobinhoodAlertDelivery,
  __private: { isCustomIntent, validateIntent },
};

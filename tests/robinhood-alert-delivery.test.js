const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const userAlertEvent = require('../src/models/user-alert-event');
const {
  issueAutomaticAlertPublicationAuthorization,
} = require('../src/services/automatic-alert-publication-guard');
const {
  createRobinhoodAlertDelivery,
} = require('../src/services/robinhood-alert-delivery');
const {
  KIND,
  RULE_KEY,
} = require('../src/services/robinhood-alert-matcher');

const TOKEN = '0x1111111111111111111111111111111111111111';

function intent(overrides = {}) {
  return {
    userId: 7,
    chain: 'robinhood',
    ruleKey: RULE_KEY,
    kind: KIND,
    tokenAddress: TOKEN,
    dedupeKey: `7:${RULE_KEY}:robinhood:${TOKEN}`,
    payload: { address: TOKEN, mcap: null, fdv: 500000, valuationType: 'fdv' },
    triggeredAt: new Date('2026-07-14T18:00:00.000Z'),
    ...overrides,
  };
}

describe('Robinhood alert delivery', () => {
  it('does not touch persistence while either rollout gate is closed', async () => {
    let writes = 0;
    const delivery = createRobinhoodAlertDelivery({
      userAlertEvent: { createEventOnce: async () => { writes += 1; } },
    });

    assert.equal((await delivery.deliver({ intents: [intent()] })).reason, 'alerts_disabled');
    assert.equal((await delivery.deliver({
      alertsRequested: true,
      publishable: false,
      intents: [intent()],
    })).reason, 'rollout_not_publishable');
    assert.equal(writes, 0);
  });

  it('persists once and publishes only newly inserted events', async () => {
    let writes = 0;
    let publishes = 0;
    const delivery = createRobinhoodAlertDelivery({
      userAlertEvent: {
        async createEventOnce(value) {
          writes += 1;
          return writes === 1 ? { id: 91, ...value } : null;
        },
      },
      backendAlertPublisher: {
        async publishEventSafe() {
          publishes += 1;
          return { notified: true };
        },
      },
    });

    const result = await delivery.deliver({
      alertsRequested: true,
      publishable: true,
      intents: [intent(), intent()],
    });

    assert.equal(result.attempted, 2);
    assert.equal(result.persisted, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.notified, 1);
    assert.equal(publishes, 1);
  });

  it('marks a custom rule and inserts its event in one authorized transaction', async () => {
    const transaction = [];
    const client = {
      async query(sql) { transaction.push(sql); return { rows: [] }; },
      release() { transaction.push('RELEASE'); },
    };
    let markOptions = null;
    const delivery = createRobinhoodAlertDelivery({
      db: { getClient: async () => client },
      userCustomAlertRule: {
        async markTriggered(_id, _userId, options, runner) {
          assert.equal(runner, client);
          markOptions = options;
          return { id: 81, status: 'triggered' };
        },
      },
      userAlertEvent: {
        async createEventOnce(value, options) {
          assert.equal(options.db, client);
          assert.equal(options.authorization, markOptions.authorization);
          return { id: 92, ...value };
        },
      },
      backendAlertPublisher: {
        publishEventSafe: async () => ({ notified: true }),
      },
    });

    const result = await delivery.deliver({
      alertsRequested: true,
      publishable: true,
      intents: [intent({
        ruleKey: 'custom-alert', kind: 'custom-alert', customRuleId: 81,
        dedupeKey: '7:custom-alert:81:triggered',
      })],
    });

    assert.equal(markOptions.chain, 'robinhood');
    assert.deepEqual(transaction, ['BEGIN', 'COMMIT', 'RELEASE']);
    assert.equal(result.persisted, 1);
    assert.equal(result.notified, 1);
  });

  it('keeps custom duplicate and failure outcomes atomic and unpublished', async () => {
    const scenarios = [
      {
        label: 'already triggered', markResult: null, eventResult: 'unused',
        transaction: ['BEGIN', 'ROLLBACK', 'RELEASE'], duplicates: 1, errors: 0,
      },
      {
        label: 'event conflict', markResult: { id: 81 }, eventResult: null,
        transaction: ['BEGIN', 'COMMIT', 'RELEASE'], duplicates: 1, errors: 0,
      },
      {
        label: 'event insert failure', markResult: { id: 81 }, eventError: new Error('insert failed'),
        transaction: ['BEGIN', 'ROLLBACK', 'RELEASE'], duplicates: 0, errors: 1,
      },
    ];

    for (const scenario of scenarios) {
      const transaction = [];
      let eventCalls = 0;
      let publishes = 0;
      const client = {
        async query(sql) { transaction.push(sql); return { rows: [] }; },
        release() { transaction.push('RELEASE'); },
      };
      const delivery = createRobinhoodAlertDelivery({
        db: { getClient: async () => client },
        userCustomAlertRule: {
          markTriggered: async () => scenario.markResult,
        },
        userAlertEvent: {
          async createEventOnce() {
            eventCalls += 1;
            if (scenario.eventError) throw scenario.eventError;
            return scenario.eventResult;
          },
        },
        backendAlertPublisher: {
          async publishEventSafe() { publishes += 1; return { notified: true }; },
        },
      });

      const result = await delivery.deliver({
        alertsRequested: true,
        publishable: true,
        intents: [intent({
          ruleKey: 'custom-alert', kind: 'custom-alert', customRuleId: 81,
          dedupeKey: '7:custom-alert:81:triggered',
        })],
      });

      assert.deepEqual(transaction, scenario.transaction, scenario.label);
      assert.equal(result.duplicates, scenario.duplicates, scenario.label);
      assert.equal(result.errors, scenario.errors, scenario.label);
      assert.equal(eventCalls, scenario.eventResult === 'unused' ? 0 : 1, scenario.label);
      assert.equal(publishes, 0, scenario.label);
    }
  });

  it('keeps the model fail-closed without a rollout-issued authorization', async () => {
    let queries = 0;
    const runner = { query: async () => { queries += 1; return { rows: [] }; } };

    await assert.rejects(
      () => userAlertEvent.createEventOnce(intent(), { db: runner }),
      (error) => error.code === 'NON_SOLANA_ALERT_TRIGGER_DISABLED',
    );
    assert.equal(queries, 0);

    const authorization = issueAutomaticAlertPublicationAuthorization({
      chain: 'robinhood',
      alertsRequested: true,
      publishable: true,
    });
    await userAlertEvent.createEventOnce(intent(), { db: runner, authorization });
    assert.equal(queries, 1);
  });
});

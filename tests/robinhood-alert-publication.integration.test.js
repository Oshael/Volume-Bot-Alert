process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const userAlertEvent = require('../src/models/user-alert-event');
const userCustomAlertRule = require('../src/models/user-custom-alert-rule');
const {
  issueAutomaticAlertPublicationAuthorization,
} = require('../src/services/automatic-alert-publication-guard');
const backendAlertFeed = require('../src/services/backend-alert-feed');
const { ROBINHOOD_USDG } = require('../src/services/evm-market-metrics');
const {
  createRobinhoodAlertPublicationBatch,
} = require('../src/services/robinhood-alert-publication-batch');
const stage30 = require('../src/utils/db-init-stage30');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const SOLANA_TOKEN = 'So11111111111111111111111111111111111111112';

function buildRobinhoodAddress(suffix) {
  const hex = Buffer.from(suffix).toString('hex').slice(-40).padStart(40, '0');
  return `0x${hex}`;
}

async function createTestUser(suffix) {
  const { rows } = await db.query(
    `INSERT INTO users (
       username,
       email,
       password_hash,
       is_email_verified,
       access_status,
       access_source
     )
     VALUES ($1, $2, $3, TRUE, 'active', 'manual')
     RETURNING id`,
    [
      `rhp_${suffix}`.slice(0, 32),
      `robinhood_publication_${suffix}@test.local`,
      'test-password-hash',
    ]
  );
  return Number(rows[0].id);
}

describe('Robinhood alert publication integration', () => {
  const suffix = `${Date.now()}_${process.pid}`;
  const robinhoodToken = buildRobinhoodAddress(suffix);
  const robinhoodDedupeKey = `integration:robinhood:${suffix}`;
  const solanaDedupeKey = `integration:solana:${suffix}`;
  let userId;

  before(async () => {
    await assertUsingTestDatabase(db);
    await stage30.init({ closePool: false });
    userId = await createTestUser(suffix);
    await db.query(
      `INSERT INTO token_catalog (
         chain,
         address,
         symbol,
         name,
         source,
         last_fdv,
         last_price,
         last_vol_5m,
         last_liquidity_usd
       )
       VALUES ('robinhood', $1, 'RHV', 'Robinhood Integration Token', 'test', 500000, 0.0042, 2000, 5000)`,
      [robinhoodToken]
    );
  });

  after(async () => {
    if (userId) {
      await db.query('DELETE FROM alert_delivery_cursors WHERE user_id = $1', [userId]).catch(() => {});
      await db.query('DELETE FROM user_alert_events WHERE user_id = $1', [userId]).catch(() => {});
      await db.query('DELETE FROM user_custom_alert_rules WHERE user_id = $1', [userId]).catch(() => {});
      await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    }
    await db.query(
      `DELETE FROM token_catalog WHERE chain = 'robinhood' AND address = $1`,
      [robinhoodToken]
    ).catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('persists each chain once and reads Solana and Robinhood through the combined feed', async () => {
    const triggeredAt = new Date('2026-07-14T18:00:00.000Z');
    const solanaIntent = {
      userId,
      chain: 'solana',
      ruleKey: 'hvnc',
      kind: 'hvnc',
      tokenAddress: SOLANA_TOKEN,
      dedupeKey: solanaDedupeKey,
      payload: {
        chain: 'solana',
        address: SOLANA_TOKEN,
        symbol: 'SOLHV',
        mcap: 300000,
        isHvnc: true,
        label: 'HVNC',
      },
      triggeredAt,
    };
    const robinhoodIntent = {
      userId,
      chain: 'robinhood',
      ruleKey: 'robinhood-hvnc-v2',
      kind: 'hvnc',
      tokenAddress: robinhoodToken,
      dedupeKey: robinhoodDedupeKey,
      payload: {
        chain: 'robinhood',
        address: robinhoodToken,
        symbol: 'RHV',
        mcap: null,
        fdv: 500000,
        priceUsd: 0.0042,
        liquidityUsd: 5000,
        transactions: 15,
        volume5m: 2000,
        isHvnc: true,
        label: 'HVNC',
      },
      triggeredAt,
    };
    const authorization = issueAutomaticAlertPublicationAuthorization({
      chain: 'robinhood',
      alertsRequested: true,
      publishable: true,
    });

    const firstSolana = await userAlertEvent.createEventOnce(solanaIntent);
    const duplicateSolana = await userAlertEvent.createEventOnce(solanaIntent);
    const firstRobinhood = await userAlertEvent.createEventOnce(robinhoodIntent, { authorization });
    const duplicateRobinhood = await userAlertEvent.createEventOnce(robinhoodIntent, { authorization });

    assert.ok(firstSolana?.id);
    assert.equal(duplicateSolana, null);
    assert.ok(firstRobinhood?.id);
    assert.equal(duplicateRobinhood, null);

    const combined = await backendAlertFeed.listDashboardAlertFeeds({
      userId,
      ruleKeys: ['hvnc', 'robinhood-hvnc-v2'],
      mode: 'all',
      limit: 20,
    });

    assert.equal(combined.count, 2);
    assert.deepEqual(combined.feeds.map((feed) => feed.ruleKey), [
      'hvnc',
      'robinhood-hvnc-v2',
    ]);
    assert.deepEqual(combined.feeds.map((feed) => feed.events[0].chain), [
      'solana',
      'robinhood',
    ]);

    const robinhoodEvent = combined.feeds[1].events[0];
    assert.equal(robinhoodEvent.address, robinhoodToken);
    assert.equal(robinhoodEvent.mcap, null);
    assert.equal(robinhoodEvent.fdv, 500000);
    assert.equal(robinhoodEvent.valuationType, 'fdv');
    assert.equal(robinhoodEvent.priceUsd, 0.0042);
    assert.equal(robinhoodEvent.liquidityUsd, 5000);
    assert.equal(robinhoodEvent.transactions, 15);
    assert.equal(robinhoodEvent.volume5m, 2000);
  });

  it('keeps a blocked rule active, then emits one custom FDV event after rollout opens', async () => {
    const rule = await userCustomAlertRule.createRule(userId, {
      chain: 'robinhood',
      tokenAddress: robinhoodToken,
      title: 'Robinhood FDV target',
      metric: 'fdv',
      window: 'spot',
      operator: 'cross_above',
      targetValue: 450000,
      metadata: {
        baselineFdv: 400000,
        baselineAt: '2026-07-14T17:58:00.000Z',
      },
    });
    const candidate = {
      chain: 'robinhood',
      protocol: 'uniswap-v3',
      marketKey: 'robinhood:uniswap-v3:0x2222222222222222222222222222222222222222',
      tokenAddress: robinhoodToken,
      quoteAddress: ROBINHOOD_USDG,
      discoveredAt: '2026-07-14T17:57:00.000Z',
      firstObservedAt: '2026-07-14T17:57:30.000Z',
      lastObservedAt: '2026-07-14T17:59:00.000Z',
      windowMs: 300000,
      windowStart: '2026-07-14T17:55:00.000Z',
      windowEnd: '2026-07-14T18:00:00.000Z',
      volumeUsd: '100',
      swaps: 1,
      buys: 1,
      sells: 0,
      transactions: 1,
      lastPriceUsd: '0.0042',
      lastFdvUsd: '500000',
      liquidityUsd: null,
      liquidityCoverage: 'partial',
      liquidityStatus: 'partial_protocol_coverage',
      adminBlocked: false,
      protocolBreakdown: { 'uniswap-v3': { volumeUsd: '100', transactions: '1' } },
      marketBreakdown: [],
    };
    let publications = 0;
    const batch = createRobinhoodAlertPublicationBatch({
      deliveryOptions: {
        backendAlertPublisher: {
          async publishEventSafe() { publications += 1; return { notified: true }; },
        },
      },
      stagingOptions: {
        repository: { listSignalDryRunCandidates: async () => [candidate] },
        now: () => Date.parse('2026-07-14T18:00:00.000Z'),
      },
    });
    const input = {
      alertsRequested: true,
      signalConfig: {
        protocols: ['uniswap-v3'], windowMs: 300000,
        minLiquidityUsd: '3000', minVolumeUsd: '1000', minTransactions: 10,
        maxAgeMs: 5 * 60 * 1000,
      },
    };

    const blocked = await batch.runOnce({ ...input, publishable: false });
    const active = await userCustomAlertRule.listRules(userId, {
      chains: ['robinhood'], status: 'active',
    });
    assert.equal(blocked.reason, 'rollout_not_publishable');
    assert.equal(active.some((item) => item.id === rule.id), true);

    const first = await batch.runOnce({ ...input, publishable: true });
    const duplicate = await batch.runOnce({ ...input, publishable: true });
    assert.equal(first.publication.matchedCustomRules, 1);
    assert.equal(first.publication.delivery.persisted, 1);
    assert.equal(duplicate.publication.matchedCustomRules, 0);
    assert.equal(duplicate.publication.delivery.persisted, 0);
    assert.equal(publications, 1);

    const { rows } = await db.query(
      `SELECT status FROM user_custom_alert_rules WHERE id = $1`, [rule.id],
    );
    const feed = await backendAlertFeed.listDashboardAlertEvents({
      userId, ruleKey: 'custom-alert', mode: 'all', limit: 20,
    });
    const event = feed.events.find((item) => item.customRuleId === rule.id);
    assert.equal(rows[0].status, 'triggered');
    assert.ok(event);
    assert.equal(event.chain, 'robinhood');
    assert.equal(event.mcap, null);
    assert.equal(event.fdv, 500000);
    assert.equal(event.valuationType, 'fdv');
    assert.equal(event.customMetric, 'FDV');
  });
});

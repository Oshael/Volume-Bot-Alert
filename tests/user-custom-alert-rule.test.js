const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const userCustomAlertRule = require('../src/models/user-custom-alert-rule');
const {
  issueAutomaticAlertPublicationAuthorization,
} = require('../src/services/automatic-alert-publication-guard');

const originalQuery = db.query;
const SAMPLE_SOUND_DATA_URL = 'data:audio/mpeg;base64,SUQzBAAAAAAA';

afterEach(() => {
  db.query = originalQuery;
});

describe('user custom alert rule model', () => {
  it('creates a normalized price cross rule', async () => {
    let capturedParams = null;
    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          id: 12,
          user_id: 7,
          chain: 'solana',
          token_address: 'So11111111111111111111111111111111111111112',
          title: 'Price target',
          metric: 'price',
          operator: 'cross_above',
          target_value: '0.000100000000',
          color_hex: '#22c55e',
          sound_name: 'alert.mp3',
          status: 'active',
          metadata: { soundDataUrl: SAMPLE_SOUND_DATA_URL },
          triggered_at: null,
          created_at: '2026-07-06T06:00:00.000Z',
          updated_at: '2026-07-06T06:00:00.000Z',
        }],
      };
    };

    const rule = await userCustomAlertRule.createRule(7, {
      tokenAddress: 'So11111111111111111111111111111111111111112',
      title: 'Price target',
      metric: 'PRICE',
      operator: 'cross above',
      target: '$0.0001',
      colorHex: '#22C55E',
      soundName: 'alert.mp3',
      soundDataUrl: SAMPLE_SOUND_DATA_URL,
    });

    assert.deepEqual(capturedParams.slice(0, 9), [
      7,
      'solana',
      'So11111111111111111111111111111111111111112',
      'Price target',
      'price',
      'cross_above',
      0.0001,
      '#22c55e',
      'alert.mp3',
    ]);
    assert.equal(rule.id, 12);
    assert.equal(rule.targetValue, 0.0001);
    assert.equal(JSON.parse(capturedParams[9]).soundDataUrl, SAMPLE_SOUND_DATA_URL);
    assert.equal(capturedParams[10], 'spot');
    assert.equal(rule.chain, 'solana');
    assert.equal(rule.window, 'spot');
    assert.equal(rule.soundDataUrl, SAMPLE_SOUND_DATA_URL);
    assert.equal(rule.status, 'active');
  });

  it('lists active rules for a token', async () => {
    let capturedParams = null;
    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          id: 22,
          user_id: 8,
          chain: 'solana',
          token_address: 'So11111111111111111111111111111111111111112',
          title: 'Mcap alert',
          metric: 'mcap',
          operator: 'cross_below',
          target_value: '25000',
          color_hex: null,
          sound_name: null,
          status: 'active',
          metadata: {},
          triggered_at: null,
          created_at: '2026-07-06T06:00:00.000Z',
          updated_at: '2026-07-06T06:00:00.000Z',
        }],
      };
    };

    const rules = await userCustomAlertRule.listActiveByTokenAddress(
      'So11111111111111111111111111111111111111112'
    );

    assert.deepEqual(capturedParams, ['solana', 'So11111111111111111111111111111111111111112']);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].operator, 'cross_below');
  });

  it('loads active rules for canonical token identities in one query', async () => {
    let capturedParams = null;
    db.query = async (_sql, params) => {
      capturedParams = params;
      return { rows: [] };
    };
    const address = '0x1234567890abcdef1234567890abcdef12345678';

    const rules = await userCustomAlertRule.listActiveByTokenIdentities([
      { chain: 'robinhood', address },
      { chain: 'robinhood', address: address.toUpperCase() },
    ]);

    assert.deepEqual(capturedParams, [['robinhood'], [address]]);
    assert.deepEqual(rules, []);
  });

  it('marks an active rule as triggered for its owner', async () => {
    let capturedParams = null;
    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          id: 22,
          user_id: 8,
          chain: 'solana',
          token_address: 'So11111111111111111111111111111111111111112',
          title: 'Mcap alert',
          metric: 'mcap',
          operator: 'cross_below',
          target_value: '25000',
          color_hex: null,
          sound_name: null,
          status: 'triggered',
          metadata: {},
          triggered_at: '2026-07-06T06:05:00.000Z',
          created_at: '2026-07-06T06:00:00.000Z',
          updated_at: '2026-07-06T06:05:00.000Z',
        }],
      };
    };

    const triggeredAt = new Date('2026-07-06T06:05:00.000Z');
    const rule = await userCustomAlertRule.markTriggered(22, 8, { triggeredAt });

    assert.deepEqual(capturedParams, [22, 8, triggeredAt, 'solana']);
    assert.equal(rule.status, 'triggered');
    assert.equal(rule.triggeredAt, '2026-07-06T06:05:00.000Z');
  });

  it('updates a rule, re-arms it, and keeps the existing sound when none is provided', async () => {
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return { rows: [{ metadata: { soundDataUrl: SAMPLE_SOUND_DATA_URL }, sound_name: 'alert.mp3' }] };
      }
      return {
        rows: [{
          id: 30,
          user_id: 9,
          token_address: 'So11111111111111111111111111111111111111112',
          title: 'Edited alert',
          metric: 'mcap',
          operator: 'cross_above',
          target_value: '300000',
          color_hex: '#2ea8ff',
          sound_name: 'alert.mp3',
          status: 'active',
          metadata: { soundDataUrl: SAMPLE_SOUND_DATA_URL },
          triggered_at: null,
          created_at: '2026-07-06T06:00:00.000Z',
          updated_at: '2026-07-06T06:10:00.000Z',
        }],
      };
    };

    const rule = await userCustomAlertRule.updateRule(30, 9, {
      title: 'Edited alert',
      metric: 'mcap',
      operator: 'cross above',
      target: '$300k',
      colorHex: '#2EA8FF',
      soundName: null,
      soundDataUrl: null,
    });

    assert.equal(calls.length, 2);
    const updateParams = calls[1].params;
    assert.deepEqual(updateParams.slice(0, 8), [30, 9, 'Edited alert', 'mcap', 'cross_above', 300000, '#2ea8ff', 'alert.mp3']);
    assert.deepEqual(JSON.parse(updateParams[8]), { soundDataUrl: SAMPLE_SOUND_DATA_URL });
    assert.equal(rule.status, 'active');
    assert.equal(rule.triggeredAt, null);
    assert.equal(rule.soundDataUrl, SAMPLE_SOUND_DATA_URL);
  });

  it('replaces the rule sound and sets a new expiry when provided', async () => {
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return { rows: [{ metadata: {}, sound_name: null }] };
      }
      return { rows: [{ id: 31, user_id: 9, status: 'active', metadata: {} }] };
    };

    await userCustomAlertRule.updateRule(31, 9, {
      title: 'Edited alert',
      metric: 'price',
      operator: 'cross below',
      target: '$0.0002',
      soundName: 'new.mp3',
      soundDataUrl: SAMPLE_SOUND_DATA_URL,
      expiresInHours: 24,
    });

    const updateParams = calls[1].params;
    assert.equal(updateParams[7], 'new.mp3');
    const metadata = JSON.parse(updateParams[8]);
    assert.equal(metadata.soundDataUrl, SAMPLE_SOUND_DATA_URL);
    assert.ok(new Date(metadata.expiresAt).getTime() > Date.now());
  });

  it('clears the expiry when expiresInHours is null and keeps it when undefined', async () => {
    const runUpdate = async (payload) => {
      const calls = [];
      db.query = async (sql, params) => {
        calls.push({ sql, params });
        if (calls.length === 1) {
          return { rows: [{ metadata: { expiresAt: '2026-07-07T00:00:00.000Z' }, sound_name: null }] };
        }
        return { rows: [{ id: 32, user_id: 9, status: 'active', metadata: {} }] };
      };
      await userCustomAlertRule.updateRule(32, 9, {
        title: 'Edited alert',
        metric: 'mcap',
        operator: 'cross above',
        target: '$300k',
        ...payload,
      });
      return JSON.parse(calls[1].params[8]);
    };

    const cleared = await runUpdate({ expiresInHours: null });
    assert.equal(cleared.expiresAt, undefined);

    const kept = await runUpdate({});
    assert.equal(kept.expiresAt, '2026-07-07T00:00:00.000Z');
  });

  it('derives the hit direction from the creation baseline when no operator is given', async () => {
    const captured = [];
    db.query = async (_sql, params) => {
      captured.push(params);
      return { rows: [{ id: 50, user_id: 7, status: 'active', metadata: {} }] };
    };

    await userCustomAlertRule.createRule(7, {
      tokenAddress: 'So11111111111111111111111111111111111111112',
      title: 'Hit below',
      metric: 'mcap',
      target: '412m',
      metadata: { baselineMcap: 412500000 },
    });
    assert.equal(captured[0][5], 'cross_below');

    await userCustomAlertRule.createRule(7, {
      tokenAddress: 'So11111111111111111111111111111111111111112',
      title: 'Hit above',
      metric: 'mcap',
      target: '412m',
      metadata: { baselineMcap: 400000000 },
    });
    assert.equal(captured[1][5], 'cross_above');
  });

  it('stores Robinhood rules and requires publication authorization to trigger them', async () => {
    let capturedParams = null;
    db.query = async (_sql, params) => {
      capturedParams = params;
      return { rows: [{
        id: 51,
        user_id: 7,
        chain: 'robinhood',
        token_address: '0x1234567890abcdef1234567890abcdef12345678',
        title: 'Robinhood price',
        metric: 'price',
        operator: 'cross_above',
        target_value: '1.25',
        status: 'active',
        metadata: {},
      }] };
    };

    const rule = await userCustomAlertRule.createRule(7, {
      chain: 'robinhood',
      tokenAddress: '0x1234567890ABCDEF1234567890ABCDEF12345678',
      title: 'Robinhood price',
      metric: 'price',
      operator: 'cross above',
      target: '1.25',
    });

    assert.deepEqual(capturedParams.slice(0, 3), [
      7,
      'robinhood',
      '0x1234567890abcdef1234567890abcdef12345678',
    ]);
    assert.equal(rule.chain, 'robinhood');
    await assert.rejects(
      () => userCustomAlertRule.markTriggered(51, 7, { chain: 'robinhood' }),
      (error) => error.code === 'NON_SOLANA_CUSTOM_ALERT_TRIGGER_DISABLED'
    );
    const authorization = issueAutomaticAlertPublicationAuthorization({
      chain: 'robinhood', alertsRequested: true, publishable: true,
    });
    const triggered = await userCustomAlertRule.markTriggered(51, 7, {
      chain: 'robinhood', authorization,
    });
    assert.equal(triggered.chain, 'robinhood');
    assert.equal(capturedParams[3], 'robinhood');
  });

  it('stores a Robinhood FDV spot rule and derives direction from its FDV baseline', async () => {
    let capturedSql = null;
    let capturedParams = null;
    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [{
        id: 52,
        user_id: 7,
        chain: 'robinhood',
        token_address: '0x1234567890abcdef1234567890abcdef12345678',
        metric: 'fdv',
        window: 'spot',
        operator: 'cross_below',
        target_value: '1000000',
        status: 'active',
        metadata: { baselineFdv: 1250000 },
      }] };
    };

    const rule = await userCustomAlertRule.createRule(7, {
      chain: 'robinhood',
      tokenAddress: '0x1234567890ABCDEF1234567890ABCDEF12345678',
      metric: 'FDV',
      window: 'SPOT',
      target: '1m',
      metadata: { baselineFdv: 1250000 },
    });

    assert.match(capturedSql, /"window"/);
    assert.equal(capturedParams[4], 'fdv');
    assert.equal(capturedParams[5], 'cross_below');
    assert.equal(capturedParams[10], 'spot');
    assert.equal(rule.metric, 'fdv');
    assert.equal(rule.window, 'spot');
  });

  it('rejects unsupported chain, metric, and window combinations with stable codes', async () => {
    const cases = [
      [{
        chain: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112',
        metric: 'fdv', target: 1,
      }, 'CUSTOM_ALERT_METRIC_UNSUPPORTED'],
      [{
        chain: 'robinhood', tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
        metric: 'mcap', target: 1,
      }, 'CUSTOM_ALERT_METRIC_UNSUPPORTED'],
      [{
        chain: 'robinhood', tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
        metric: 'fdv', window: '5m', target: 1,
      }, 'CUSTOM_ALERT_WINDOW_UNSUPPORTED'],
    ];
    let writes = 0;
    db.query = async () => { writes += 1; return { rows: [] }; };

    for (const [payload, code] of cases) {
      await assert.rejects(
        () => userCustomAlertRule.createRule(7, payload),
        (error) => error.status === 400 && error.code === code,
      );
    }
    assert.equal(writes, 0);
  });

  it('lists rules for explicit selected chains without collapsing identities', async () => {
    let capturedSql = null;
    let capturedParams = null;
    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [
        {
          id: 60, user_id: 7, chain: 'solana', token_address: 'same-address',
          metric: 'price', target_value: '1', status: 'active', metadata: {},
        },
        {
          id: 61, user_id: 7, chain: 'robinhood', token_address: 'same-address',
          metric: 'fdv', window: 'spot', target_value: '2', status: 'active', metadata: {},
        },
      ] };
    };

    const rules = await userCustomAlertRule.listRules(7, {
      chains: ['solana', 'robinhood', 'solana'],
      status: 'active',
    });

    assert.match(capturedSql, /chain = ANY\(\$2::text\[\]\)/);
    assert.deepEqual(capturedParams, [7, ['solana', 'robinhood'], 'active']);
    assert.deepEqual(rules.map(({ id, chain, window }) => ({ id, chain, window })), [
      { id: 60, chain: 'solana', window: 'spot' },
      { id: 61, chain: 'robinhood', window: 'spot' },
    ]);
  });

  it('uses chain ownership for update and disable mutations', async () => {
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    };

    const updated = await userCustomAlertRule.updateRule(70, 7, {
      chain: 'robinhood',
      metric: 'fdv',
      window: 'spot',
      target: '2m',
    });
    const disabled = await userCustomAlertRule.disableRule(70, 7, { chain: 'robinhood' });

    assert.equal(updated, null);
    assert.equal(disabled, null);
    assert.match(calls[0].sql, /AND chain = \$3/);
    assert.deepEqual(calls[0].params, [70, 7, 'robinhood']);
    assert.match(calls[1].sql, /AND chain = \$3/);
    assert.deepEqual(calls[1].params, [70, 7, 'robinhood']);
  });

  it('updates Robinhood FDV only within the selected chain', async () => {
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) return { rows: [{ metadata: {}, sound_name: null }] };
      return { rows: [{
        id: 71, user_id: 7, chain: 'robinhood', metric: 'fdv', window: 'spot',
        target_value: '3000000', status: 'active', metadata: {},
      }] };
    };

    const rule = await userCustomAlertRule.updateRule(71, 7, {
      chain: 'robinhood', metric: 'fdv', window: 'spot', target: '3m',
    });

    assert.deepEqual(calls[0].params, [71, 7, 'robinhood']);
    assert.match(calls[1].sql, /"window" = \$10/);
    assert.match(calls[1].sql, /AND chain = \$11/);
    assert.equal(calls[1].params[9], 'spot');
    assert.equal(calls[1].params[10], 'robinhood');
    assert.equal(rule.metric, 'fdv');
  });

  it('parses shorthand k/m/b targets', () => {
    const { normalizeTargetValue } = userCustomAlertRule.__private;
    assert.equal(normalizeTargetValue('100k'), 100000);
    assert.equal(normalizeTargetValue('$2.5m'), 2500000);
    assert.equal(normalizeTargetValue('1B'), 1000000000);
    assert.equal(normalizeTargetValue('$250,000'), 250000);
    assert.equal(normalizeTargetValue('0.0001'), 0.0001);
    assert.throws(() => normalizeTargetValue('abc'), /greater than 0/i);
  });

  it('rejects an update with an invalid target', async () => {
    await assert.rejects(
      () => userCustomAlertRule.updateRule(30, 9, {
        title: 'Edited alert',
        metric: 'mcap',
        operator: 'cross above',
        target: '$0',
      }),
      /target must be greater than 0/i
    );
  });
});

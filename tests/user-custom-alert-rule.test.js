const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const userCustomAlertRule = require('../src/models/user-custom-alert-rule');

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

    assert.deepEqual(capturedParams.slice(0, 8), [
      7,
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
    assert.equal(JSON.parse(capturedParams[8]).soundDataUrl, SAMPLE_SOUND_DATA_URL);
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

    assert.deepEqual(capturedParams, ['So11111111111111111111111111111111111111112']);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].operator, 'cross_below');
  });

  it('marks an active rule as triggered for its owner', async () => {
    let capturedParams = null;
    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          id: 22,
          user_id: 8,
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

    assert.deepEqual(capturedParams, [22, 8, triggeredAt]);
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
    assert.equal(captured[0][4], 'cross_below');

    await userCustomAlertRule.createRule(7, {
      tokenAddress: 'So11111111111111111111111111111111111111112',
      title: 'Hit above',
      metric: 'mcap',
      target: '412m',
      metadata: { baselineMcap: 400000000 },
    });
    assert.equal(captured[1][4], 'cross_above');
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

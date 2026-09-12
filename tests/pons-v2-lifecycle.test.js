'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  CAPTURE_TOPICS, PONS_V2_FACTORY, TOPICS, decodePonsV2LifecycleEvent,
} = require('../src/services/pons-v2-lifecycle-decoder');
const {
  appendRobinhoodTokenLifecycleEvidence,
} = require('../src/models/robinhood-token-lifecycle-evidence');
const stage216 = require('../src/utils/db-init-stage216');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

const TOKEN = `0x${'1'.repeat(40)}`;
const CURVE = `0x${'2'.repeat(40)}`;
const USER = `0x${'3'.repeat(40)}`;
const topicAddress = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const data = (...values) => `0x${values.map((value) => (
  BigInt(value).toString(16).padStart(64, '0')
)).join('')}`;

describe('Pons V2 lifecycle evidence', () => {
  it('decodes launches and exact curve reserve deltas', () => {
    assert.deepEqual(decodePonsV2LifecycleEvent({
      address: PONS_V2_FACTORY, topic0: TOPICS.tokenLaunched,
      topics: [TOPICS.tokenLaunched, topicAddress(TOKEN), topicAddress(CURVE), topicAddress(USER)],
      data: data(0, 7, 1000),
    }), {
      eventKind: 'launched', tokenAddress: TOKEN, curveAddress: CURVE,
      quoteDeltaRaw: null, graduationThresholdRaw: '1000',
    });
    assert.equal(decodePonsV2LifecycleEvent({
      address: CURVE, topic0: TOPICS.curveBuy,
      topics: [TOPICS.curveBuy, topicAddress(USER), topicAddress(USER)],
      data: data(110, 20, 6, 4),
    }).quoteDeltaRaw, '100');
    assert.equal(decodePonsV2LifecycleEvent({
      address: CURVE, topic0: TOPICS.curveSell,
      topics: [TOPICS.curveSell, topicAddress(USER), topicAddress(USER)],
      data: data(20, 90, 6, 4),
    }).quoteDeltaRaw, '-100');
  });

  it('accepts only authoritative factory transitions', () => {
    for (const [topic0, words, eventKind] of [
      [TOPICS.launchSwept, [9, 8], 'swept'],
      [TOPICS.poolGraduated, [7, 6, 5], 'migrated'],
      [TOPICS.launchRescued, [4, 3], 'rescued'],
    ]) {
      assert.equal(decodePonsV2LifecycleEvent({
        address: PONS_V2_FACTORY, topic0, topics: [topic0, topicAddress(TOKEN)],
        data: data(...words),
      }).eventKind, eventKind);
      assert.equal(decodePonsV2LifecycleEvent({
        address: USER, topic0, topics: [topic0, topicAddress(TOKEN)], data: data(...words),
      }), null);
    }
    assert.equal(new Set(CAPTURE_TOPICS).size, 6);
  });

  it('writes direct evidence before resolving curve emitters', async () => {
    const calls = [];
    const client = { query: async (sql, params) => {
      calls.push({ sql, params }); return { rowCount: 1 };
    } };
    const base = {
      block_hash: `0x${'4'.repeat(64)}`, block_number: '10',
      transaction_hash: `0x${'5'.repeat(64)}`, log_index: 1,
      event_address: PONS_V2_FACTORY, curve_address: CURVE,
      graduation_threshold_raw: '1000', quote_delta_raw: null,
    };
    assert.equal(await appendRobinhoodTokenLifecycleEvidence(client, [
      { ...base, token_address: TOKEN, event_kind: 'launched' },
      { ...base, log_index: 2, event_address: CURVE, token_address: null,
        event_kind: 'curve_progress', graduation_threshold_raw: null, quote_delta_raw: '50' },
    ]), 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].params[1], false);
    assert.equal(calls[1].params[1], true);
    assert.match(calls[1].sql, /block\.canonical=TRUE/);
  });

  it('registers the reorg-safe schema and current-state view', async () => {
    const sql = stage216.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => key === 'stage216-robinhood-launchpad-lifecycle');
    assert.equal(group.repair, 'node src/utils/db-init-stage216.js');
    assert.match(sql, /REFERENCES robinhood_chain_events.*ON DELETE CASCADE/s);
    assert.match(sql, /CREATE OR REPLACE VIEW token_launchpad_lifecycle/);
    assert.match(sql, /block\.canonical=TRUE/);
    const calls = [];
    await stage216.init({ database: { query: async (statement) => calls.push(statement) }, closePool: false });
    assert.deepEqual(calls, stage216.STATEMENTS);
  });
});

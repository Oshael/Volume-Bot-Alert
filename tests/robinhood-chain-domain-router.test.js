'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const noxa = require('../src/services/noxa-launch-decoder');
const v2 = require('../src/services/uniswap-v2-decoder');
const v3 = require('../src/services/uniswap-v3-decoder');
const v4 = require('../src/services/uniswap-v4-decoder');
const {
  routeCanonicalEvents,
} = require('../src/services/robinhood-chain-domain-router');

function event(topic0, address, logIndex = 0) {
  return { topic0, address, log_index: logIndex };
}

describe('Robinhood canonical event domain router', () => {
  it('requires the matching trusted emitter for discovery events', () => {
    const routed = routeCanonicalEvents([
      event(v2.TOPICS.pairCreated, v2.ROBINHOOD_V2_FACTORY, 1),
      event(v3.TOPICS.poolCreated, v2.ROBINHOOD_V2_FACTORY, 2),
      event(noxa.TOKEN_LAUNCHED_TOPIC, noxa.NOXA_FACTORY, 3),
    ]);
    assert.deepEqual(routed, [
      { domain: 'discovery', log_index: 1 },
      { domain: 'discovery', log_index: 3 },
    ]);
  });

  it('routes market topics independently of the dynamic pool registry', () => {
    const pool = `0x${'a'.repeat(40)}`;
    assert.deepEqual(routeCanonicalEvents([
      event(v2.TOPICS.swap, pool, 4),
      event(v3.TOPICS.initialize, pool, 5),
      event(v4.TOPICS.modifyLiquidity, v4.ROBINHOOD_V4_POOL_MANAGER, 6),
    ]), [
      { domain: 'market', log_index: 4 },
      { domain: 'market', log_index: 5 },
      { domain: 'market', log_index: 6 },
    ]);
  });

  it('preserves discovery and same-block market ordering', () => {
    assert.deepEqual(routeCanonicalEvents([
      event(v3.TOPICS.poolCreated, v3.ROBINHOOD_V3_FACTORY, 7),
      event(v3.TOPICS.initialize, `0x${'b'.repeat(40)}`, 8),
    ]), [
      { domain: 'discovery', log_index: 7 },
      { domain: 'market', log_index: 8 },
    ]);
  });
});

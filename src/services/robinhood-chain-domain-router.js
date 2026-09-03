'use strict';

const noxa = require('./noxa-launch-decoder');
const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');

const DISCOVERY_EMITTER_BY_TOPIC = new Map([
  [v2.TOPICS.pairCreated, v2.ROBINHOOD_V2_FACTORY],
  [v3.TOPICS.poolCreated, v3.ROBINHOOD_V3_FACTORY],
  [v4.TOPICS.initialize, v4.ROBINHOOD_V4_POOL_MANAGER],
  [noxa.TOKEN_LAUNCHED_TOPIC, noxa.NOXA_FACTORY],
]);
const MARKET_TOPICS = new Set([
  v2.TOPICS.swap,
  v2.TOPICS.sync,
  v3.TOPICS.initialize,
  v3.TOPICS.swap,
  v4.TOPICS.modifyLiquidity,
  v4.TOPICS.swap,
]);

function routeCanonicalEvents(events = []) {
  return events.flatMap((event) => {
    const domains = [];
    if (DISCOVERY_EMITTER_BY_TOPIC.get(event.topic0) === event.address) {
      domains.push('discovery');
    }
    if (MARKET_TOPICS.has(event.topic0)) domains.push('market');
    return domains.map((domain) => ({ domain, log_index: event.log_index }));
  });
}

module.exports = {
  routeCanonicalEvents,
  __private: { DISCOVERY_EMITTER_BY_TOPIC, MARKET_TOPICS },
};

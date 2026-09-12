'use strict';

// Official Robinhood deployment and ABI:
// https://github.com/ponsdotdev/ponsfamily/blob/main/README.md
const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const TOPICS = Object.freeze({
  tokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  launchSwept: '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4',
  poolGraduated: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',
  launchRescued: '0x7017304fdd491394686dce984eac721f0be1a22228346210f16694772bde44ca',
  curveBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  curveSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
});
const FACTORY_TOPICS = new Set([
  TOPICS.tokenLaunched, TOPICS.launchSwept, TOPICS.poolGraduated, TOPICS.launchRescued,
]);
const CURVE_TOPICS = new Set([TOPICS.curveBuy, TOPICS.curveSell]);
const CAPTURE_TOPICS = Object.freeze([...FACTORY_TOPICS, ...CURVE_TOPICS]);

function addressTopic(value, label) {
  const topic = String(value || '').toLowerCase();
  if (!/^0x0{24}[0-9a-f]{40}$/.test(topic)) throw new Error(`${label} is invalid`);
  return `0x${topic.slice(-40)}`;
}
function words(value, expected, label) {
  const data = String(value || '').toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${expected * 64}}$`).test(data)) {
    throw new Error(`${label} data is invalid`);
  }
  return Array.from({ length: expected }, (_, index) => (
    BigInt(`0x${data.slice(2 + (index * 64), 66 + (index * 64))}`)
  ));
}
function directEvidence(event, eventKind, extra = {}) {
  return {
    eventKind, tokenAddress: addressTopic(event.topics[1], `${eventKind} token`),
    curveAddress: null, quoteDeltaRaw: null, graduationThresholdRaw: null,
    ...extra,
  };
}

function decodeFactoryEvent(event, topic0) {
  if (topic0 === TOPICS.tokenLaunched) {
    if (event.topics?.length !== 4) throw new Error('Pons V2 launch topics are invalid');
    const data = words(event.data, 3, 'Pons V2 launch');
    return directEvidence(event, 'launched', {
      curveAddress: addressTopic(event.topics[2], 'Pons V2 curve'),
      graduationThresholdRaw: data[2].toString(),
    });
  }
  if (event.topics?.length < 2) throw new Error('Pons V2 transition topics are invalid');
  if (topic0 === TOPICS.launchSwept) {
    words(event.data, 2, 'Pons V2 sweep'); return directEvidence(event, 'swept');
  }
  if (topic0 === TOPICS.poolGraduated) {
    words(event.data, 3, 'Pons V2 graduation'); return directEvidence(event, 'migrated');
  }
  words(event.data, 2, 'Pons V2 rescue'); return directEvidence(event, 'rescued');
}
function decodeCurveEvent(event, topic0, address) {
  try {
    if (event.topics?.length !== 3) return null;
    const data = words(event.data, 4, 'Pons V2 curve trade');
    const delta = topic0 === TOPICS.curveBuy
      ? data[0] - data[2] - data[3]
      : -(data[1] + data[2] + data[3]);
    if (topic0 === TOPICS.curveBuy && delta < 0n) return null;
    return {
      eventKind: 'curve_progress', tokenAddress: null, curveAddress: address,
      quoteDeltaRaw: delta.toString(), graduationThresholdRaw: null,
    };
  } catch (_) {
    // The signature is global; an untrusted emitter must not block canonical capture.
    return null;
  }
}
function decodePonsV2LifecycleEvent(event = {}) {
  const topic0 = String(event.topic0 || event.topics?.[0] || '').toLowerCase();
  const address = String(event.address || '').toLowerCase();
  if (address === PONS_V2_FACTORY && FACTORY_TOPICS.has(topic0)) {
    return decodeFactoryEvent(event, topic0);
  }
  return CURVE_TOPICS.has(topic0) ? decodeCurveEvent(event, topic0, address) : null;
}

module.exports = {
  CAPTURE_TOPICS, PONS_V2_FACTORY, TOPICS, decodePonsV2LifecycleEvent,
};

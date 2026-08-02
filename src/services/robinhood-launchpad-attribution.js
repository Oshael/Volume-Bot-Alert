const { normalizeTokenAddress } = require('../utils/token-identity');

const LAUNCHPADS = Object.freeze({
  pons: Object.freeze({ id: 'pons', label: 'pons' }),
  'bankr-doppler': Object.freeze({ id: 'bankr-doppler', label: 'Bankr / Doppler' }),
  launchhood: Object.freeze({ id: 'launchhood', label: 'LaunchHood' }),
  robinpad: Object.freeze({ id: 'robinpad', label: 'RobinPad' }),
  'robinhood-stock': Object.freeze({ id: 'robinhood-stock', label: 'Robinhood Stock Token' }),
  robinhood: Object.freeze({ id: 'robinhood', label: 'Robinhood Chain' }),
});

const FACTORY_LAUNCHPADS = new Map([
  ['0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', 'pons'],
  ['0x0c37a24f5d23a486fa692d1500881d698b1f77a4', 'pons'],
  ['0x62b33a039d289cbda50ebeb72fe4261449e61bcf', 'launchhood'],
  ['0x5c1c1de6950f9dcfe31be99d457fa7732b2ce93b', 'robinpad'],
]);

const SOURCE_LAUNCHPADS = Object.freeze({
  'pons-onchain': 'pons',
  'robinhood-stock-api': 'robinhood-stock',
});

function normalizeLaunchpadId(value) {
  const id = String(value || '').trim().toLowerCase();
  return Object.hasOwn(LAUNCHPADS, id) ? id : null;
}

function normalizeCreatorAddress(value) {
  if (!value) return null;
  try {
    return normalizeTokenAddress('robinhood', value);
  } catch (_) {
    return null;
  }
}

function result(id, evidence) {
  const launchpad = LAUNCHPADS[id];
  return Object.freeze({ ...launchpad, evidence });
}

function classifyRobinhoodLaunchpad(input = {}) {
  const source = String(input.metadataSource || '').trim().toLowerCase();
  if (source === 'robinhood-stock-api') return result('robinhood-stock', 'stock-registry');
  if (input.bankrDopplerVerified === true) {
    return result('bankr-doppler', 'bankr-registry');
  }

  const creatorAddress = normalizeCreatorAddress(input.creatorAddress);
  const factoryLaunchpad = creatorAddress ? FACTORY_LAUNCHPADS.get(creatorAddress) : null;
  if (factoryLaunchpad) return result(factoryLaunchpad, 'creator-factory');

  const sourceLaunchpad = SOURCE_LAUNCHPADS[source];
  if (sourceLaunchpad) return result(sourceLaunchpad, 'token-metadata');
  return result('robinhood', 'chain-fallback');
}

module.exports = {
  FACTORY_LAUNCHPADS,
  LAUNCHPADS,
  classifyRobinhoodLaunchpad,
  normalizeLaunchpadId,
};

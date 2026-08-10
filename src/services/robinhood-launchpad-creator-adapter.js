const PONS_TOKEN_LAUNCHED_TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
const LAUNCHHOOD_TOKEN_LAUNCHED_TOPIC = '0x235e34a4e0e6a401dae6851f6fab4a919a1fdd0ae0073ac2fc4d1d4a87e548e5';

const FACTORIES = new Map([
  ['0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', { launchpadId: 'pons', topic: PONS_TOKEN_LAUNCHED_TOPIC }],
  ['0x0c37a24f5d23a486fa692d1500881d698b1f77a4', { launchpadId: 'pons', topic: PONS_TOKEN_LAUNCHED_TOPIC }],
  ['0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb', { launchpadId: 'noxa', topic: PONS_TOKEN_LAUNCHED_TOPIC }],
  ['0x62b33a039d289cbda50ebeb72fe4261449e61bcf', { launchpadId: 'launchhood', topic: LAUNCHHOOD_TOKEN_LAUNCHED_TOPIC }],
]);

function hex(value, bytes, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function quantity(value, label) {
  const raw = String(value ?? '');
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw).toString();
}

function topicAddress(value, label) {
  const word = hex(value, 32, label);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word)) throw new Error(`${label} is not an ABI address`);
  return `0x${word.slice(-40)}`;
}

function buildLaunchpadCreatorFilter(fromBlock, toBlock = fromBlock) {
  return {
    fromBlock: `0x${BigInt(fromBlock).toString(16)}`,
    toBlock: `0x${BigInt(toBlock).toString(16)}`,
    address: [...FACTORIES.keys()],
    topics: [[PONS_TOKEN_LAUNCHED_TOPIC, LAUNCHHOOD_TOKEN_LAUNCHED_TOPIC]],
  };
}

function decodeLaunchpadCreatorLog(log) {
  if (log?.removed === true) throw new Error('removed launchpad creator log is unsupported');
  const factoryAddress = hex(log?.address, 20, 'log.address');
  const spec = FACTORIES.get(factoryAddress);
  if (!spec) throw new Error('launchpad creator factory is unsupported');
  if (!Array.isArray(log.topics) || log.topics.length !== 4) {
    throw new Error('launchpad creator topics are invalid');
  }
  if (hex(log.topics[0], 32, 'topic0') !== spec.topic) {
    throw new Error('launchpad creator topic is unsupported');
  }
  if (!/^0x[0-9a-f]{448}$/i.test(String(log.data || ''))) {
    throw new Error('launchpad creator data layout is invalid');
  }
  return Object.freeze({
    tokenAddress: topicAddress(log.topics[1], 'token topic'),
    creatorAddress: topicAddress(log.topics[2], 'deployer topic'),
    transactionHash: hex(log.transactionHash, 32, 'transactionHash'),
    blockNumber: quantity(log.blockNumber, 'blockNumber'),
    blockHash: hex(log.blockHash, 32, 'blockHash'),
    factoryAddress,
    launchpadId: spec.launchpadId,
    source: 'launchpad_event',
  });
}

module.exports = {
  FACTORIES,
  LAUNCHHOOD_TOKEN_LAUNCHED_TOPIC,
  PONS_TOKEN_LAUNCHED_TOPIC,
  buildLaunchpadCreatorFilter,
  decodeLaunchpadCreatorLog,
};

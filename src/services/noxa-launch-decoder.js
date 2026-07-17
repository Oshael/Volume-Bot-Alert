const NOXA_FACTORY = '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb';
const UNISWAP_V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const TOKEN_LAUNCHED_TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
const GET_LAUNCHED_TOKEN_SELECTOR = '0x3cf28b5a';
const GET_POOL_SELECTOR = '0x1698ee82';

function normalizeAddress(value, label = 'address') {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function normalizeWord(value, label = 'word') {
  const word = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(word)) throw new Error(`${label} must be a 32-byte hex value`);
  return word;
}

function decodeWords(data, count, label) {
  const raw = String(data || '').toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${count * 64}}$`).test(raw)) {
    throw new Error(`${label} must contain exactly ${count} ABI words`);
  }
  return Array.from({ length: count }, (_, index) => (
    `0x${raw.slice(2 + (index * 64), 2 + ((index + 1) * 64))}`
  ));
}

function decodeAddressWord(word, label) {
  const normalized = normalizeWord(word, label);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} is not an ABI address`);
  return `0x${normalized.slice(-40)}`;
}

function decodeUint(word, label = 'uint256') {
  return BigInt(normalizeWord(word, label));
}

function decodeBool(word, label) {
  const value = decodeUint(word, label);
  if (value !== 0n && value !== 1n) throw new Error(`${label} is not an ABI bool`);
  return value === 1n;
}

function decimalQuantity(value, label) {
  const raw = String(value ?? '');
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) throw new Error(`${label} is not a quantity`);
  return BigInt(raw).toString();
}

function eventContext(log) {
  return {
    chain: 'robinhood',
    blockNumber: decimalQuantity(log?.blockNumber, 'blockNumber'),
    blockHash: normalizeWord(log?.blockHash, 'blockHash'),
    transactionHash: normalizeWord(log?.transactionHash, 'transactionHash'),
    logIndex: decimalQuantity(log?.logIndex, 'logIndex'),
    timestampMs: log?.blockTimestamp == null
      ? null
      : (BigInt(decimalQuantity(log.blockTimestamp, 'blockTimestamp')) * 1000n).toString(),
    source: 'robinhood-onchain',
  };
}

function decodeTokenLaunched(log, options = {}) {
  const factoryAddress = normalizeAddress(options.factoryAddress || NOXA_FACTORY, 'factory address');
  if (normalizeAddress(log?.address, 'log.address') !== factoryAddress) throw new Error('Unexpected NOXA emitter');
  if (!Array.isArray(log?.topics) || log.topics.length !== 4) throw new Error('Expected 4 TokenLaunched topics');
  if (normalizeWord(log.topics[0], 'topic0') !== TOKEN_LAUNCHED_TOPIC) throw new Error('Unexpected NOXA topic');
  const words = decodeWords(log.data, 7, 'TokenLaunched data');
  return {
    kind: 'token-launched',
    ...eventContext(log),
    factoryAddress,
    tokenAddress: decodeAddressWord(log.topics[1], 'TokenLaunched token'),
    deployerAddress: decodeAddressWord(log.topics[2], 'TokenLaunched deployer'),
    dexFactoryAddress: decodeAddressWord(log.topics[3], 'TokenLaunched dexFactory'),
    pairTokenAddress: decodeAddressWord(words[0], 'TokenLaunched pairToken'),
    poolAddress: decodeAddressWord(words[1], 'TokenLaunched pool'),
    dexId: decodeUint(words[2]).toString(),
    launchConfigId: decodeUint(words[3]).toString(),
    positionId: decodeUint(words[4]).toString(),
    restrictionsEndBlockL1: decodeUint(words[5]).toString(),
    initialBuyAmountRaw: decodeUint(words[6]).toString(),
    launchSource: 'noxa-fun',
  };
}

function decodeLaunchedTokenResult(data) {
  const words = decodeWords(data, 13, 'getLaunchedToken result');
  const poolFee = decodeUint(words[10], 'poolFee');
  if (poolFee >= 1n << 24n) throw new Error('poolFee exceeds uint24');
  return {
    tokenAddress: decodeAddressWord(words[0], 'record token'),
    deployerAddress: decodeAddressWord(words[1], 'record deployer'),
    pairedTokenAddress: decodeAddressWord(words[2], 'record pairedToken'),
    positionManagerAddress: decodeAddressWord(words[3], 'record positionManager'),
    positionId: decodeUint(words[4]).toString(),
    dexId: decodeUint(words[5]).toString(),
    launchConfigId: decodeUint(words[6]).toString(),
    restrictionsEndBlockL1: decodeUint(words[7]).toString(),
    supplyRaw: decodeUint(words[8]).toString(),
    isToken0: decodeBool(words[9], 'isToken0'),
    poolFee: Number(poolFee),
    exists: decodeBool(words[11], 'exists'),
    initialBuyAmountRaw: decodeUint(words[12]).toString(),
  };
}

function decodeAddressResult(data, label = 'address result') {
  return decodeAddressWord(decodeWords(data, 1, label)[0], label);
}

function addressArgument(address) {
  return normalizeAddress(address).slice(2).padStart(64, '0');
}

function buildGetLaunchedTokenCall(tokenAddress) {
  return `${GET_LAUNCHED_TOKEN_SELECTOR}${addressArgument(tokenAddress)}`;
}

function buildGetPoolCall(tokenAddress, pairTokenAddress, poolFee) {
  const fee = BigInt(poolFee);
  if (fee < 0n || fee >= 1n << 24n) throw new Error('poolFee exceeds uint24');
  return `${GET_POOL_SELECTOR}${addressArgument(tokenAddress)}${addressArgument(pairTokenAddress)}${fee.toString(16).padStart(64, '0')}`;
}

function validateLaunch(launch, context = {}) {
  const errors = [];
  const record = context.launchedToken;
  const pool = context.v3Pool;
  const canonicalPool = context.canonicalPoolAddress == null
    ? null
    : normalizeAddress(context.canonicalPoolAddress, 'canonical pool');
  const check = (condition, code) => { if (!condition) errors.push(code); };
  check(launch.factoryAddress === NOXA_FACTORY, 'unexpected_launch_factory');
  check(launch.dexFactoryAddress === UNISWAP_V3_FACTORY, 'unexpected_dex_factory');
  check(launch.pairTokenAddress === ROBINHOOD_WETH, 'unexpected_pair_token');
  check(Boolean(pool), 'missing_v3_pool');
  if (pool) {
    check(pool.tracked === true, 'v3_pool_not_tracked');
    check(pool.factoryAddress === UNISWAP_V3_FACTORY, 'untrusted_v3_pool_factory');
    check(pool.poolAddress === launch.poolAddress, 'pool_event_mismatch');
    check(pool.tokenAddress === launch.tokenAddress, 'pool_token_mismatch');
    check(pool.quoteAddress === ROBINHOOD_WETH, 'pool_quote_mismatch');
  }
  check(Boolean(record), 'missing_factory_record');
  if (record) {
    check(record.exists === true, 'factory_record_missing');
    check(record.tokenAddress === launch.tokenAddress, 'record_token_mismatch');
    check(record.deployerAddress === launch.deployerAddress, 'record_deployer_mismatch');
    check(record.pairedTokenAddress === launch.pairTokenAddress, 'record_pair_token_mismatch');
    check(record.positionId === launch.positionId, 'record_position_mismatch');
    check(record.dexId === launch.dexId, 'record_dex_mismatch');
    check(record.launchConfigId === launch.launchConfigId, 'record_config_mismatch');
    check(record.restrictionsEndBlockL1 === launch.restrictionsEndBlockL1, 'record_restrictions_mismatch');
    check(record.initialBuyAmountRaw === launch.initialBuyAmountRaw, 'record_initial_buy_mismatch');
    if (pool) {
      check(record.poolFee === pool.fee, 'record_pool_fee_mismatch');
      check(record.isToken0 === (pool.token0 === launch.tokenAddress), 'record_token_order_mismatch');
    }
  }
  check(canonicalPool != null, 'missing_canonical_pool');
  if (canonicalPool) check(canonicalPool === launch.poolAddress, 'canonical_pool_mismatch');
  check(Number(context.tokenCodeBytes) > 0, 'token_without_code');
  check(Number(context.poolCodeBytes) > 0, 'pool_without_code');
  const accepted = errors.length === 0;
  return {
    ...launch,
    accepted,
    validationErrors: errors,
    factoryRecord: record || null,
    marketDiscoveryKey: accepted ? `robinhood:uniswap-v3:${launch.poolAddress}` : null,
    isNewMarket: false,
    deduplicatedWith: accepted ? 'uniswap-v3' : null,
  };
}

module.exports = {
  GET_LAUNCHED_TOKEN_SELECTOR,
  GET_POOL_SELECTOR,
  NOXA_FACTORY,
  ROBINHOOD_WETH,
  TOKEN_LAUNCHED_TOPIC,
  UNISWAP_V3_FACTORY,
  buildGetLaunchedTokenCall,
  buildGetPoolCall,
  decodeAddressResult,
  decodeLaunchedTokenResult,
  decodeTokenLaunched,
  validateLaunch,
};

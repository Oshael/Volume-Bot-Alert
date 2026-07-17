const { formatDecimal, multiply, parseDecimal, rational } = require('./evm-market-metrics');

const CANONICAL_CONTRACTS = Object.freeze({
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  MULTICALL3: '0xca11bde05977b3631167028862be2a173976ca11',
  UNISWAP_V2_FACTORY: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
  UNISWAP_V2_ROUTER: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',
  UNISWAP_V3_FACTORY: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  UNISWAP_V3_ROUTER: '0xcaf681a66d020601342297493863e78c959e5cb2',
  UNISWAP_V4_POOL_MANAGER: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  UNISWAP_V4_POSITION_DESCRIPTOR: '0x9639443158e8c5efa35bd45287bf2effd3d8dc06',
  UNISWAP_V4_POSITION_MANAGER: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  UNISWAP_V4_QUOTER: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  UNISWAP_V4_STATE_VIEW: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  UNISWAP_V4_UNIVERSAL_ROUTER: '0x8876789976decbfcbbbe364623c63652db8c0904',
  UNISWAP_PERMIT2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
  NOXA_FACTORY: '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb',
  NOXA_LOCKER: '0x7f03effbd7ceb22a3f80dd468f67ef27826acd85',
});

const ROBINHOOD_TOKENIZED_ASSETS = Object.freeze({
  AAPL: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
  AMD: '0x86923f96303d656e4aa86d9d42d1e57ad2023fdc',
  AMZN: '0x12f190a9f9d7d37a250758b26824b97ce941bf54',
  BABA: '0xad25ac6c84d497db898fa1e8387bf6af3532a1c4',
  BE: '0x822cc93ffd030293e9842c30bbd678f530701867',
  COIN: '0x6330d8c3178a418788df01a47479c0ce7ccf450b',
  CRCL: '0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5',
  CRWV: '0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3',
  GOOGL: '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3',
  INTC: '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681',
  META: '0xc0d6457c16cc70d6790dd43521c899c87ce02f35',
  MSFT: '0xe93237c50d904957cf27e7b1133b510c669c2e74',
  MU: '0xff080c8ce2e5feadaca0da81314ae59d232d4afd',
  NVDA: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
  ORCL: '0xb0992820e760d836549ba69bc7598b4af75dee03',
  PLTR: '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a',
  SNDK: '0xb90a19ff0af67f7779aff50a882a9cff42446400',
  SPCX: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea',
  TSLA: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
  USAR: '0xd917b029c761d264c6a312bbbcda868658ef86a6',
  QQQ: '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68',
  SGOV: '0x92fd66527192e3e61d4ddd13322aa222de86f9b5',
  SLV: '0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f',
  SPY: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c',
  CUSO: '0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344',
});

function normalizeAddress(value, label = 'address') {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function reverseIndex(entries) {
  return new Map(Object.entries(entries).map(([label, address]) => [normalizeAddress(address), label]));
}

const CANONICAL_BY_ADDRESS = reverseIndex(CANONICAL_CONTRACTS);
const TOKENIZED_BY_ADDRESS = reverseIndex(ROBINHOOD_TOKENIZED_ASSETS);

function classifyTokenEligibility(tokenAddress, options = {}) {
  const address = normalizeAddress(tokenAddress, 'token address');
  if (CANONICAL_BY_ADDRESS.has(address)) {
    return { eligible: false, reason: 'canonical_contract', label: CANONICAL_BY_ADDRESS.get(address), address };
  }
  if (TOKENIZED_BY_ADDRESS.has(address)) {
    return { eligible: false, reason: 'robinhood_tokenized_asset', label: TOKENIZED_BY_ADDRESS.get(address), address };
  }
  const extraDenied = reverseIndex(options.extraDenied || {});
  if (extraDenied.has(address)) {
    return { eligible: false, reason: 'configured_denylist', label: extraDenied.get(address), address };
  }
  return { eligible: true, reason: null, label: null, address };
}

function exactOutput(value) {
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}

function v2Liquidity(input) {
  if (input.quoteReserveRaw == null || input.quoteDecimals == null || input.quoteUsdPrice == null) {
    return { liquidityUsd: null, status: 'missing_v2_reserve_or_quote', confidence: 'none' };
  }
  const reserve = BigInt(input.quoteReserveRaw);
  const decimals = Number(input.quoteDecimals);
  if (reserve < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Invalid v2 quote reserve or decimals');
  }
  const quoteValue = rational(reserve, 10n ** BigInt(decimals));
  const liquidity = multiply(quoteValue, parseDecimal(input.quoteUsdPrice), rational(2n));
  return {
    liquidityUsd: formatDecimal(liquidity, input.usdDecimalPlaces ?? 12),
    exact: exactOutput(liquidity),
    status: 'spot_estimate_from_double_quote_reserve',
    confidence: 'medium',
    warning: 'spot_price_and_reserves_are_manipulable',
  };
}

function buildLiquidityAssessment(input = {}) {
  const protocol = String(input.protocol || '');
  if (protocol === 'uniswap-v2') return { protocol, ...v2Liquidity(input) };
  if (protocol === 'uniswap-v3' || protocol === 'uniswap-v4') {
    return {
      protocol,
      liquidityUsd: null,
      liquidityRaw: input.liquidityRaw == null ? null : String(input.liquidityRaw),
      status: 'requires_tick_liquidity_distribution',
      confidence: 'none',
    };
  }
  return { protocol: protocol || null, liquidityUsd: null, status: 'unsupported_protocol', confidence: 'none' };
}

module.exports = {
  CANONICAL_CONTRACTS,
  ROBINHOOD_TOKENIZED_ASSETS,
  buildLiquidityAssessment,
  classifyTokenEligibility,
};

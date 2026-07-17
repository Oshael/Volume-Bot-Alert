const { formatDecimal, rational } = require('./evm-market-metrics');

const ROBINHOOD_V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ROBINHOOD_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const CANONICAL_FEE = 100;
const GET_POOL_SELECTOR = '0x1698ee82';
const SLOT0_SELECTOR = '0x3850c7bd';
const LIQUIDITY_SELECTOR = '0x1a686502';
const Q192 = 1n << 192n;

function normalizeAddress(value, label = 'address') {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function addressWord(address) {
  return normalizeAddress(address).slice(2).padStart(64, '0');
}

function uintWord(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function buildGetPoolCall() {
  return `${GET_POOL_SELECTOR}${addressWord(ROBINHOOD_WETH)}${addressWord(ROBINHOOD_USDG)}${uintWord(CANONICAL_FEE)}`;
}

function decodeWord(data, index, label) {
  const raw = String(data || '').toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(raw) || (raw.length - 2) % 64 !== 0) throw new Error(`${label} is malformed ABI data`);
  const value = raw.slice(2 + (index * 64), 2 + ((index + 1) * 64));
  if (value.length !== 64) throw new Error(`${label} is missing ABI word ${index}`);
  return BigInt(`0x${value}`);
}

function decodeAddressResult(data) {
  const value = decodeWord(data, 0, 'getPool result').toString(16).padStart(64, '0');
  if (!/^0{24}[0-9a-f]{40}$/.test(value)) throw new Error('getPool result is not an ABI address');
  return `0x${value.slice(-40)}`;
}

function priceFromSqrtPriceX96(sqrtPriceX96) {
  const sqrt = BigInt(sqrtPriceX96);
  if (sqrt <= 0n || sqrt >= 1n << 160n) throw new Error('sqrtPriceX96 is outside uint160');
  return rational(sqrt * sqrt * (10n ** 18n), Q192 * (10n ** 6n));
}

function createRobinhoodWethUsdQuoteReader(options = {}) {
  if (typeof options.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const rpcClient = options.rpcClient;
  const factoryAddress = normalizeAddress(options.factoryAddress || ROBINHOOD_V3_FACTORY);
  const now = options.now || Date.now;
  let verifiedPool = null;

  async function resolvePool(blockTag) {
    if (verifiedPool) return verifiedPool;
    const result = await rpcClient.request('eth_call', [{ to: factoryAddress, data: buildGetPoolCall() }, blockTag]);
    const poolAddress = decodeAddressResult(result);
    if (poolAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('Canonical WETH/USDG pool is not deployed');
    }
    const code = String(await rpcClient.request('eth_getCode', [poolAddress, blockTag]) || '').toLowerCase();
    if (!/^0x[0-9a-f]+$/.test(code) || code === '0x' || code === '0x00') {
      throw new Error('Canonical WETH/USDG pool has no bytecode');
    }
    verifiedPool = poolAddress;
    return verifiedPool;
  }

  async function getSnapshot(requestOptions = {}) {
    const blockTag = String(requestOptions.blockTag || 'latest');
    const poolAddress = await resolvePool(blockTag);
    const [slot0, liquidityResult] = await Promise.all([
      rpcClient.request('eth_call', [{ to: poolAddress, data: SLOT0_SELECTOR }, blockTag]),
      rpcClient.request('eth_call', [{ to: poolAddress, data: LIQUIDITY_SELECTOR }, blockTag]),
    ]);
    const sqrtPriceX96 = decodeWord(slot0, 0, 'slot0').toString();
    const liquidityRaw = decodeWord(liquidityResult, 0, 'liquidity').toString();
    const price = priceFromSqrtPriceX96(sqrtPriceX96);
    return {
      pair: 'WETH/USDG',
      priceUsd: formatDecimal(price, requestOptions.decimalPlaces ?? 12),
      exact: { numerator: price.numerator.toString(), denominator: price.denominator.toString() },
      source: 'canonical-uniswap-v3-weth-usdg-100',
      status: 'observed',
      confidence: 'medium',
      poolAddress,
      factoryAddress,
      fee: CANONICAL_FEE,
      sqrtPriceX96,
      liquidityRaw,
      blockTag,
      observedAtMs: now(),
    };
  }

  return Object.freeze({ getSnapshot });
}

module.exports = {
  CANONICAL_FEE,
  GET_POOL_SELECTOR,
  LIQUIDITY_SELECTOR,
  ROBINHOOD_USDG,
  ROBINHOOD_V3_FACTORY,
  ROBINHOOD_WETH,
  SLOT0_SELECTOR,
  buildGetPoolCall,
  createRobinhoodWethUsdQuoteReader,
  decodeAddressResult,
  priceFromSqrtPriceX96,
};

const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const ROBINHOOD_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

// A token whose reported totalSupply sits in the top half of uint256 is an
// uncapped/sentinel supply (e.g. 2^256-1 for "infinite"/rebasing tokens); FDV =
// price * supply is meaningless and, left unguarded, poisons the 1m bucket
// high_fdv. No real finite supply comes near this (a 1e15-token, 18-decimal
// supply is ~1e33), so we suppress FDV while keeping the valid price/volume.
const UNCAPPED_TOTAL_SUPPLY_RAW = 1n << 255n;

function normalizeAddress(value, label = 'address') {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${label} must be a 20-byte hex address`);
  return address;
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator, denominator = 1n) {
  let num = BigInt(numerator);
  let den = BigInt(denominator);
  if (den === 0n) throw new Error('Rational denominator cannot be zero');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const divisor = gcd(num, den) || 1n;
  return { numerator: num / divisor, denominator: den / divisor };
}

function multiply(...values) {
  return values.reduce((result, value) => rational(
    result.numerator * value.numerator,
    result.denominator * value.denominator
  ), rational(1n));
}

function parseDecimal(value, label = 'decimal') {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`${label} must be a base-10 decimal`);
  const fraction = match[3] || '';
  const numerator = BigInt(`${match[2]}${fraction}`) * (match[1] === '-' ? -1n : 1n);
  return rational(numerator, 10n ** BigInt(fraction.length));
}

function decimalScale(decimals, label) {
  const value = Number(decimals);
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`${label} must be uint8`);
  return 10n ** BigInt(value);
}

function formatDecimal(value, places = 24) {
  const digits = Math.max(0, Math.min(80, Number(places)));
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const integer = numerator / value.denominator;
  if (digits === 0) return `${negative ? '-' : ''}${integer}`;
  const scale = 10n ** BigInt(digits);
  let fraction = ((numerator % value.denominator) * scale) / value.denominator;
  let whole = integer;
  const remainder = ((numerator % value.denominator) * scale) % value.denominator;
  if (remainder * 2n >= value.denominator) fraction += 1n;
  if (fraction === scale) {
    whole += 1n;
    fraction = 0n;
  }
  const suffix = fraction.toString().padStart(digits, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${suffix ? `.${suffix}` : ''}`;
}

function exactOutput(value) {
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}

function reject(reason, swap) {
  return {
    accepted: false,
    reason,
    chain: swap?.chain || 'robinhood',
    protocol: swap?.protocol || null,
    transactionHash: swap?.transactionHash || null,
    logIndex: swap?.logIndex || null,
  };
}

function resolveQuoteUsd(quoteAddress, options) {
  if (quoteAddress === ROBINHOOD_USDG) {
    const price = parseDecimal(options.usdgUsdPrice ?? '1', 'USDG/USD price');
    return { price, source: options.usdgUsdSource || 'usdg-peg-assumption', status: 'assumed' };
  }
  if (quoteAddress === ROBINHOOD_WETH && options.wethUsdPrice != null) {
    const price = parseDecimal(options.wethUsdPrice, 'WETH/USD price');
    return { price, source: options.wethUsdSource || 'canonical-weth-usdg-pool', status: 'observed' };
  }
  return null;
}

function prepareObservation(input) {
  const swap = input.swap;
  if (!swap?.accepted) return { error: reject('swap_not_accepted', swap) };
  if (!input.eligibility) return { error: reject('eligibility_not_checked', swap) };
  if (!input.eligibility.eligible) return { error: reject('token_ineligible', swap) };
  const tokenMetadata = input.tokenMetadata;
  const quoteMetadata = input.quoteMetadata;
  if (!tokenMetadata?.usable) return { error: reject('token_metadata_unusable', swap) };
  if (!quoteMetadata?.usable) return { error: reject('quote_metadata_unusable', swap) };
  const tokenAddress = normalizeAddress(swap.tokenAddress, 'swap token');
  const quoteAddress = normalizeAddress(swap.quoteAddress, 'swap quote');
  if (normalizeAddress(tokenMetadata.address, 'metadata token') !== tokenAddress) {
    return { error: reject('token_metadata_mismatch', swap) };
  }
  if (normalizeAddress(quoteMetadata.address, 'metadata quote') !== quoteAddress) {
    return { error: reject('quote_metadata_mismatch', swap) };
  }
  const tokenRaw = BigInt(swap.tokenAmountRaw);
  const quoteRaw = BigInt(swap.quoteAmountRaw);
  if (tokenRaw <= 0n || quoteRaw <= 0n) return { error: reject('non_positive_swap_amount', swap) };
  const tokenScale = decimalScale(tokenMetadata.decimals, 'token decimals');
  const quoteScale = decimalScale(quoteMetadata.decimals, 'quote decimals');
  if (swap.protocol === 'uniswap-v2' && swap.tokenReserveRaw != null
    && BigInt(swap.tokenReserveRaw) < tokenScale) {
    return { error: reject('v2_token_reserve_depleted', swap) };
  }
  const quoteUsd = resolveQuoteUsd(quoteAddress, input);
  if (!quoteUsd || quoteUsd.price.numerator <= 0n) return { error: reject('quote_usd_unavailable', swap) };
  return {
    swap, tokenMetadata, quoteMetadata, tokenAddress, quoteAddress,
    tokenRaw, quoteRaw, tokenScale, quoteScale, quoteUsd,
  };
}

function buildMarketObservation(input = {}) {
  const prepared = prepareObservation(input);
  if (prepared.error) return prepared.error;
  const {
    swap, tokenMetadata, quoteMetadata, tokenAddress, quoteAddress,
    tokenRaw, quoteRaw, tokenScale, quoteScale, quoteUsd,
  } = prepared;
  const tokenAmount = rational(tokenRaw, tokenScale);
  const quoteAmount = rational(quoteRaw, quoteScale);
  const priceQuote = rational(quoteRaw * tokenScale, tokenRaw * quoteScale);
  const priceUsd = multiply(priceQuote, quoteUsd.price);
  const volumeUsd = multiply(quoteAmount, quoteUsd.price);
  const totalSupplyRaw = BigInt(tokenMetadata.totalSupplyRaw);
  const supply = rational(totalSupplyRaw, tokenScale);
  const fdvUsd = totalSupplyRaw < UNCAPPED_TOTAL_SUPPLY_RAW ? multiply(priceUsd, supply) : null;
  const priceDecimalPlaces = input.priceDecimalPlaces ?? 80;
  const persistedPriceQuote = formatDecimal(priceQuote, priceDecimalPlaces);
  const persistedPriceUsd = formatDecimal(priceUsd, priceDecimalPlaces);
  if (persistedPriceQuote === '0' || persistedPriceUsd === '0') {
    return reject('price_below_persisted_precision', swap);
  }
  return {
    accepted: true,
    chain: swap.chain,
    protocol: swap.protocol,
    blockNumber: swap.blockNumber,
    timestampMs: swap.timestampMs ?? null,
    transactionHash: swap.transactionHash,
    logIndex: swap.logIndex,
    marketKey: swap.marketKey || null,
    poolAddress: swap.poolAddress ?? null,
    poolId: swap.poolId ?? null,
    tokenAddress,
    quoteAddress,
    side: swap.side,
    tokenDecimals: tokenMetadata.decimals,
    quoteDecimals: quoteMetadata.decimals,
    tokenTotalSupplyRaw: String(tokenMetadata.totalSupplyRaw),
    tokenSupplyStatus: tokenMetadata.tokenSupplyStatus || null,
    tokenSupplyBlockTag: tokenMetadata.tokenSupplyBlockTag || null,
    tokenAmountRaw: tokenRaw.toString(),
    quoteAmountRaw: quoteRaw.toString(),
    tokenAmount: formatDecimal(tokenAmount),
    quoteAmount: formatDecimal(quoteAmount),
    priceQuote: persistedPriceQuote,
    priceUsd: persistedPriceUsd,
    volumeUsd: formatDecimal(volumeUsd, input.usdDecimalPlaces ?? 12),
    fdvUsd: fdvUsd ? formatDecimal(fdvUsd, input.usdDecimalPlaces ?? 12) : null,
    marketCapUsd: null,
    valuationType: 'fdv',
    quoteUsdPrice: formatDecimal(quoteUsd.price, 12),
    quoteUsdSource: quoteUsd.source,
    quoteUsdStatus: quoteUsd.status,
    exact: {
      tokenAmount: exactOutput(tokenAmount),
      quoteAmount: exactOutput(quoteAmount),
      priceQuote: exactOutput(priceQuote),
      priceUsd: exactOutput(priceUsd),
      volumeUsd: exactOutput(volumeUsd),
      fdvUsd: fdvUsd ? exactOutput(fdvUsd) : null,
    },
  };
}

module.exports = {
  ROBINHOOD_USDG,
  ROBINHOOD_WETH,
  buildMarketObservation,
  formatDecimal,
  multiply,
  parseDecimal,
  rational,
  resolveQuoteUsd,
};

/**
 * Pure builder of Robinhood head-capture evidence payloads.
 *
 * It transforms the state-dependent reads gathered at the head (metadata,
 * supply, quote, V3 pool balances, V4 deltas, NOXA validation) into the
 * versioned JSONB payload defined in
 * docs/robinhood-head-capture-evidence-contract.md (section 4).
 *
 * It is fail-closed: a missing state-dependent read that cannot be
 * reconstructed later from logs alone throws a terminal error instead of being
 * silently written as zero. No RPC, no database, no valuation here.
 */
const HEAD_EVIDENCE_VERSION = 1;
const MARKET_PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const QUOTE_STATUSES = new Set(['observed', 'assumed']);

function terminal(message) {
  const error = new Error(message);
  error.terminal = true;
  return error;
}

function requireRaw(value, label) {
  if (value == null) throw terminal(`${label} is required`);
  const raw = String(value).trim();
  if (!/^-?\d+$/.test(raw)) throw terminal(`${label} must be an integer string`);
  return raw;
}

function requireUnsignedRaw(value, label) {
  const raw = requireRaw(value, label);
  if (raw.startsWith('-')) throw terminal(`${label} must not be negative`);
  return raw;
}

function optionalRaw(value, label) {
  return value == null ? null : requireRaw(value, label);
}

function requireDecimals(value, label) {
  const decimals = Number(value);
  if (!Number.isInteger(decimals) || decimals < 0) throw terminal(`${label} decimals are required`);
  return decimals;
}

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw terminal(`${label} is required`);
  return text;
}

function normalizeTokenMetadata(metadata = {}) {
  return {
    name: metadata.name == null ? null : String(metadata.name),
    symbol: metadata.symbol == null ? null : String(metadata.symbol),
    decimals: requireDecimals(metadata.decimals, 'token metadata'),
    totalSupplyRaw: requireUnsignedRaw(metadata.totalSupplyRaw, 'token totalSupply'),
    tokenSupplyStatus: requireText(metadata.tokenSupplyStatus, 'token supply status'),
    tokenSupplyBlockTag: requireText(metadata.tokenSupplyBlockTag, 'token supply block tag'),
  };
}

function normalizeQuoteUsd(quoteUsd) {
  if (!quoteUsd) throw terminal('quote USD evidence is required');
  const status = requireText(quoteUsd.status, 'quote USD status');
  if (!QUOTE_STATUSES.has(status)) throw terminal('quote USD status is invalid');
  return {
    priceUsd: requireText(quoteUsd.priceUsd, 'quote USD price'),
    source: requireText(quoteUsd.source, 'quote USD source'),
    status,
    blockTag: requireText(quoteUsd.blockTag, 'quote USD block tag'),
  };
}

function normalizeModifyLiquidity(deltas) {
  if (!Array.isArray(deltas)) throw terminal('V4 modifyLiquidity deltas are required');
  return deltas.map((delta, index) => ({
    tickLower: Number(delta?.tickLower),
    tickUpper: Number(delta?.tickUpper),
    liquidityDelta: requireRaw(delta?.liquidityDelta, `modifyLiquidity[${index}].liquidityDelta`),
  }));
}

function buildProtocolEvidence(input) {
  const { protocol } = input;
  if (protocol === 'uniswap-v2') {
    return { v2: { quoteReserveRaw: requireUnsignedRaw(input.v2?.quoteReserveRaw, 'V2 quote reserve') } };
  }
  if (protocol === 'uniswap-v3') {
    const v3 = input.v3 || {};
    return {
      v3: {
        poolAddress: requireText(v3.poolAddress, 'V3 pool address'),
        blockTag: requireText(v3.blockTag, 'V3 block tag'),
        tokenBalanceRaw: requireUnsignedRaw(v3.tokenBalanceRaw, 'V3 token balance'),
        quoteBalanceRaw: requireUnsignedRaw(v3.quoteBalanceRaw, 'V3 quote balance'),
        sqrtPriceX96: optionalRaw(v3.sqrtPriceX96, 'V3 sqrtPriceX96'),
      },
    };
  }
  const v4 = input.v4 || {};
  return {
    v4: {
      poolId: requireText(v4.poolId, 'V4 pool id'),
      sqrtPriceX96: requireUnsignedRaw(v4.sqrtPriceX96, 'V4 sqrtPriceX96'),
      liquidityRaw: requireUnsignedRaw(v4.liquidityRaw, 'V4 active liquidity'),
      modifyLiquidity: normalizeModifyLiquidity(v4.modifyLiquidity),
    },
  };
}

function buildMarketEvidence(input = {}) {
  const protocol = String(input.protocol || '').trim();
  if (!MARKET_PROTOCOLS.has(protocol)) throw terminal('capture protocol is invalid');
  if (input.eligibility?.eligible !== true) {
    throw terminal('market evidence requires an eligible swap');
  }
  const evidence = {
    evidenceVersion: HEAD_EVIDENCE_VERSION,
    timestampMs: requireUnsignedRaw(input.timestampMs, 'swap timestampMs'),
    tokenAddress: requireText(input.tokenAddress, 'token address'),
    quoteAddress: requireText(input.quoteAddress, 'quote address'),
    quoteIndex: Number(input.quoteIndex ?? 0),
    eligibility: { eligible: true, reason: input.eligibility?.reason ?? null },
    tokenMetadata: normalizeTokenMetadata(input.tokenMetadata),
    quoteMetadata: { decimals: requireDecimals(input.quoteMetadata?.decimals, 'quote metadata') },
    quoteUsd: normalizeQuoteUsd(input.quoteUsd),
    ...buildProtocolEvidence({ protocol, v2: input.v2, v3: input.v3, v4: input.v4 }),
  };
  return { evidenceVersion: HEAD_EVIDENCE_VERSION, protocol, evidence };
}

function buildDiscoveryEvidence(input = {}) {
  const event = input.event;
  if (!event || typeof event !== 'object') throw terminal('discovery event is required');
  const evidence = {
    evidenceVersion: HEAD_EVIDENCE_VERSION,
    event,
  };
  if (input.noxa != null) {
    const noxa = input.noxa;
    evidence.noxa = {
      accepted: noxa.accepted === true,
      reason: noxa.reason ?? null,
      launchedToken: noxa.launchedToken ?? null,
      canonicalPoolAddress: noxa.canonicalPoolAddress ?? null,
      tokenCodeBytes: Number(noxa.tokenCodeBytes ?? 0),
      poolCodeBytes: Number(noxa.poolCodeBytes ?? 0),
    };
  }
  return { evidenceVersion: HEAD_EVIDENCE_VERSION, evidence };
}

module.exports = {
  HEAD_EVIDENCE_VERSION,
  buildMarketEvidence,
  buildDiscoveryEvidence,
};

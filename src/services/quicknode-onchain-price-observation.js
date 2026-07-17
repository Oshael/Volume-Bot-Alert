const {
  USDC_MINT,
  USDT_MINT,
  WSOL_MINT,
} = require('./quicknode-onchain-event');

const SUPPORTED_PROGRAMS = new Set([
  'pumpswap',
  'meteora-dlmm',
  'raydium-cpmm',
  'raydium-clmm',
  'raydium-amm-v4',
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function toNonZeroNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number !== 0 ? number : null;
}

function buildFailure(reason, candidate = {}) {
  return {
    accepted: false,
    skipReason: reason,
    tokenMint: normalizeText(candidate.tokenMint) || null,
    program: normalizeText(candidate.program) || null,
    signature: normalizeText(candidate.signature) || null,
  };
}

function resolveQuote(candidate = {}) {
  const stableDelta = toNonZeroNumber(candidate.stableDelta);
  const stableMint = normalizeText(candidate.stableMint);
  if (stableDelta != null && (stableMint === USDC_MINT || stableMint === USDT_MINT)) {
    return {
      quoteMint: stableMint,
      quoteUnit: 'USD',
      quoteAmount: Math.abs(stableDelta),
    };
  }

  const wsolDelta = toNonZeroNumber(candidate.wsolDelta);
  if (wsolDelta != null) {
    return {
      quoteMint: WSOL_MINT,
      quoteUnit: 'SOL',
      quoteAmount: Math.abs(wsolDelta),
    };
  }

  return null;
}

function buildPriceObservation(candidate = {}) {
  if (!candidate.accepted) {
    return buildFailure('swap_not_accepted', candidate);
  }

  const program = normalizeText(candidate.program);
  if (!SUPPORTED_PROGRAMS.has(program)) {
    return buildFailure('unsupported_program', candidate);
  }

  const tokenMint = normalizeText(candidate.tokenMint);
  const signature = normalizeText(candidate.signature);
  if (!tokenMint || !signature) {
    return buildFailure('missing_identity', candidate);
  }

  const tokenDelta = toNonZeroNumber(candidate.tokenDelta);
  if (tokenDelta == null) {
    return buildFailure('missing_token_amount', candidate);
  }

  if (Number(candidate.uniqueNonQuoteMintCount) > 1) {
    return buildFailure('ambiguous_non_quote_mints', candidate);
  }

  const quote = resolveQuote(candidate);
  if (!quote) {
    return buildFailure('missing_quote_amount', candidate);
  }

  const tokenAmount = Math.abs(tokenDelta);
  const price = quote.quoteAmount / tokenAmount;
  if (!Number.isFinite(price) || price <= 0) {
    return buildFailure('invalid_execution_price', candidate);
  }

  const blockTime = Number(candidate.blockTime);
  const receivedAtMs = Number(candidate.observedAtMs);
  return {
    accepted: true,
    source: 'quicknode-onchain',
    tokenMint,
    program,
    signature,
    slot: Number.isFinite(Number(candidate.slot)) ? Number(candidate.slot) : null,
    observedAtMs: blockTime > 0 ? blockTime * 1000 : (receivedAtMs > 0 ? receivedAtMs : null),
    tokenAmount,
    quoteAmount: quote.quoteAmount,
    quoteMint: quote.quoteMint,
    quoteUnit: quote.quoteUnit,
    price,
  };
}

module.exports = {
  SUPPORTED_PROGRAMS,
  buildPriceObservation,
  __private: {
    resolveQuote,
    toNonZeroNumber,
  },
};

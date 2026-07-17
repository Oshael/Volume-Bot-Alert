const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeAddressSet(values = []) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizeText)
      .filter(Boolean),
  );
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeMinSolVolume(value) {
  const num = toNumberOrNull(value);
  return num != null && num > 0 ? num : 0;
}

function normalizeMinUsdVolume(value) {
  const num = toNumberOrNull(value);
  return num != null && num > 0 ? num : 0;
}

function pickLargestNonQuoteDelta(deltas = []) {
  return (Array.isArray(deltas) ? deltas : [])
    .filter((delta) => {
      const mint = normalizeText(delta?.mint);
      return mint && !QUOTE_MINTS.has(mint);
    })
    .sort((a, b) => Math.abs(toNumberOrNull(b?.delta) || 0) - Math.abs(toNumberOrNull(a?.delta) || 0))[0] || null;
}

function pickLargestStableDelta(deltas = []) {
  return (Array.isArray(deltas) ? deltas : [])
    .filter((delta) => {
      const mint = normalizeText(delta?.mint);
      return mint === USDC_MINT || mint === USDT_MINT;
    })
    .sort((a, b) => Math.abs(toNumberOrNull(b?.delta) || 0) - Math.abs(toNumberOrNull(a?.delta) || 0))[0] || null;
}

function pickLargestDeltaForMint(deltas = [], mint) {
  const normalizedMint = normalizeText(mint);
  return (Array.isArray(deltas) ? deltas : [])
    .filter((delta) => normalizeText(delta?.mint) === normalizedMint)
    .sort((a, b) => Math.abs(toNumberOrNull(b?.delta) || 0) - Math.abs(toNumberOrNull(a?.delta) || 0))[0] || null;
}

function resolveCandidateMint(summary = {}) {
  const explicitMint = normalizeText(summary.tokenMint);
  if (explicitMint && !QUOTE_MINTS.has(explicitMint)) {
    return explicitMint;
  }

  return normalizeText(pickLargestNonQuoteDelta(summary.topDeltas)?.mint) || null;
}

function resolveTokenDelta(summary = {}, tokenMint) {
  const explicitDelta = toNumberOrNull(summary.tokenDelta);
  if (explicitDelta != null) {
    return explicitDelta;
  }
  return toNumberOrNull(pickLargestDeltaForMint(summary.topDeltas, tokenMint)?.delta);
}

function resolveStableQuote(summary = {}) {
  const explicitMint = normalizeText(summary.stableMint);
  const explicitDelta = toNumberOrNull(summary.stableDelta);
  if ((explicitMint === USDC_MINT || explicitMint === USDT_MINT) && explicitDelta != null) {
    return { mint: explicitMint, delta: explicitDelta };
  }

  const largestStable = pickLargestStableDelta(summary.topDeltas);
  return largestStable
    ? { mint: normalizeText(largestStable.mint), delta: toNumberOrNull(largestStable.delta) }
    : { mint: null, delta: null };
}

function resolveSolVolume(summary = {}) {
  const estimated = toNumberOrNull(summary.estimatedSolVolume);
  if (estimated != null && estimated >= 0) {
    return estimated;
  }

  const wsolDelta = toNumberOrNull(summary.wsolDelta);
  return wsolDelta != null ? Math.abs(wsolDelta) : null;
}

function resolveUsdVolume(summary = {}) {
  const estimated = toNumberOrNull(summary.estimatedUsdVolume);
  if (estimated != null && estimated >= 0) {
    return estimated;
  }

  const stableDelta = toNumberOrNull(summary.stableDelta);
  if (stableDelta != null) {
    return Math.abs(stableDelta);
  }

  const largestStable = pickLargestStableDelta(summary.topDeltas);
  return largestStable ? Math.abs(toNumberOrNull(largestStable.delta) || 0) : null;
}

function resolveVolumeSource(summary = {}, estimatedSolVolume, estimatedUsdVolume) {
  const explicit = normalizeText(summary.volumeSource);
  if (explicit) {
    return explicit;
  }
  if (estimatedSolVolume != null) {
    return 'wsol';
  }
  const stableMint = normalizeText(summary.stableMint || pickLargestStableDelta(summary.topDeltas)?.mint);
  if (stableMint === USDC_MINT && estimatedUsdVolume != null) {
    return 'usdc';
  }
  if (stableMint === USDT_MINT && estimatedUsdVolume != null) {
    return 'usdt';
  }
  return 'none';
}

function passesVolumeGate({ estimatedSolVolume, estimatedUsdVolume, minSolVolume, minUsdVolume }) {
  if (!(minSolVolume > 0) && !(minUsdVolume > 0)) {
    return true;
  }
  return (minSolVolume > 0 && estimatedSolVolume >= minSolVolume)
    || (minUsdVolume > 0 && estimatedUsdVolume >= minUsdVolume);
}

function buildOnchainSwapCandidate(summary = {}, options = {}) {
  const program = normalizeText(summary.program);
  const signature = normalizeText(summary.signature);
  const tokenMint = resolveCandidateMint(summary);
  const tokenDelta = resolveTokenDelta(summary, tokenMint);
  const stableQuote = resolveStableQuote(summary);
  const blockedMints = normalizeAddressSet(options.blockedTokenAddresses);
  const estimatedSolVolume = resolveSolVolume(summary);
  const estimatedUsdVolume = resolveUsdVolume(summary);
  const volumeSource = resolveVolumeSource(summary, estimatedSolVolume, estimatedUsdVolume);
  const minSolVolume = normalizeMinSolVolume(options.minSolVolume);
  const minUsdVolume = normalizeMinUsdVolume(options.minUsdVolume);

  if (!program) {
    return { accepted: false, skipReason: 'missing_program' };
  }
  if (!signature) {
    return { accepted: false, skipReason: 'missing_signature' };
  }
  if (!tokenMint) {
    return { accepted: false, skipReason: 'missing_token_mint' };
  }
  if (blockedMints.has(tokenMint)) {
    return {
      accepted: false,
      skipReason: 'admin_blocked',
      tokenMint,
      program,
      signature,
    };
  }
  if (!passesVolumeGate({
    estimatedSolVolume,
    estimatedUsdVolume,
    minSolVolume,
    minUsdVolume,
  })) {
    return {
      accepted: false,
      skipReason: 'low_volume',
      tokenMint,
      program,
      signature,
      estimatedSolVolume,
      estimatedUsdVolume,
      volumeSource,
      minSolVolume,
      minUsdVolume,
    };
  }

  return {
    accepted: true,
    source: 'quicknode-onchain',
    program,
    signature,
    slot: toNumberOrNull(summary.slot),
    blockTime: toNumberOrNull(summary.blockTime),
    observedAtMs: toNumberOrNull(summary.observedAtMs),
    tokenMint,
    tokenDelta,
    wsolDelta: toNumberOrNull(summary.wsolDelta),
    stableMint: stableQuote.mint,
    stableDelta: stableQuote.delta,
    uniqueNonQuoteMintCount: toNumberOrNull(summary.uniqueNonQuoteMintCount),
    estimatedSolVolume,
    estimatedUsdVolume,
    volumeSource,
  };
}

module.exports = {
  USDC_MINT,
  USDT_MINT,
  WSOL_MINT,
  buildOnchainSwapCandidate,
  __private: {
    normalizeAddressSet,
    normalizeMinSolVolume,
    normalizeMinUsdVolume,
    passesVolumeGate,
    pickLargestDeltaForMint,
    pickLargestNonQuoteDelta,
    pickLargestStableDelta,
    resolveCandidateMint,
    resolveStableQuote,
    resolveTokenDelta,
    resolveSolVolume,
    resolveUsdVolume,
    resolveVolumeSource,
    toNumberOrNull,
  },
};

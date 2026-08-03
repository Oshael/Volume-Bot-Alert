/**
 * Orchestrates the state-dependent reads at the head and turns them into
 * capture payloads, keeping this logic out of the pipeline hub.
 *
 * It performs the same reads the valuation path does (eligibility, ERC-20
 * metadata + supply, WETH/USD quote, V3 pool balances at the swap block) but
 * stops at evidence: no TVL, no buckets, no valuation. Transient RPC failures
 * propagate (the range is not committed and the capture cursor holds);
 * eligibility/metadata/quote decisions become rejection captures so the cursor
 * still advances with an auditable reason.
 */
const { classifyTokenEligibility } = require('./robinhood-market-policy');
const { formatDecimal, resolveQuoteUsd, ROBINHOOD_WETH } = require('./evm-market-metrics');
const {
  HEAD_EVIDENCE_VERSION,
  buildMarketEvidence,
  buildDiscoveryEvidence,
} = require('./robinhood-head-evidence');

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function createRobinhoodHeadCaptureBuilder(deps = {}) {
  const metadataReader = deps.metadataReader;
  const quoteReader = deps.quoteReader;
  const policyOptions = deps.policyOptions;
  const classifyEligibility = deps.classifyEligibility || classifyTokenEligibility;
  if (typeof metadataReader?.getMetadata !== 'function') throw new Error('metadataReader is required');
  if (typeof quoteReader?.getCurrent !== 'function') throw new Error('quoteReader is required');

  async function resolveTokenMetadata(address, blockNumber) {
    const metadata = await metadataReader.getMetadata(address);
    if (!metadata?.usable) return { usable: false };
    return {
      usable: true,
      name: metadata.name ?? null,
      symbol: metadata.symbol ?? null,
      decimals: metadata.decimals,
      totalSupplyRaw: metadata.totalSupplyRaw,
      tokenSupplyStatus: 'latest_call',
      tokenSupplyBlockTag: blockTag(blockNumber),
    };
  }

  function rejectionCapture(swap, reason) {
    return {
      protocol: swap.protocol ?? null,
      marketKey: swap.marketKey ?? null,
      evidenceVersion: HEAD_EVIDENCE_VERSION,
      evidence: { rejected: reason, tokenAddress: swap.tokenAddress ?? null },
    };
  }

  async function resolveV3Balances(swap) {
    if (swap.protocol !== 'uniswap-v3' || typeof metadataReader.getBalanceOf !== 'function') return undefined;
    const tag = blockTag(swap.blockNumber);
    const [tokenBalance, quoteBalance] = await Promise.all([
      metadataReader.getBalanceOf(swap.tokenAddress, swap.poolAddress, { blockTag: tag }),
      metadataReader.getBalanceOf(swap.quoteAddress, swap.poolAddress, { blockTag: tag }),
    ]);
    return {
      poolAddress: swap.poolAddress,
      blockTag: tag,
      tokenBalanceRaw: tokenBalance.balanceRaw,
      quoteBalanceRaw: quoteBalance.balanceRaw,
      sqrtPriceX96: swap.sqrtPriceX96 ?? null,
    };
  }

  async function buildMarketCapture(swap) {
    const eligibility = classifyEligibility(swap.tokenAddress, policyOptions);
    if (!eligibility.eligible) return rejectionCapture(swap, eligibility.reason || 'token_ineligible');
    const [tokenMetadata, quoteMetadata] = await Promise.all([
      resolveTokenMetadata(swap.tokenAddress, swap.blockNumber),
      metadataReader.getMetadata(swap.quoteAddress),
    ]);
    if (!tokenMetadata.usable) return rejectionCapture(swap, 'token_metadata_unusable');
    if (!quoteMetadata?.usable) return rejectionCapture(swap, 'quote_metadata_unusable');
    const quoteOptions = swap.quoteAddress === ROBINHOOD_WETH ? await quoteReader.getCurrent() : null;
    const quoteUsd = resolveQuoteUsd(swap.quoteAddress, {
      wethUsdPrice: quoteOptions?.priceUsd,
      wethUsdSource: quoteOptions?.source,
    });
    if (!quoteUsd || quoteUsd.price.numerator <= 0n) return rejectionCapture(swap, 'quote_usd_unavailable');
    const built = buildMarketEvidence({
      protocol: swap.protocol,
      timestampMs: swap.timestampMs,
      tokenAddress: swap.tokenAddress,
      quoteAddress: swap.quoteAddress,
      quoteIndex: swap.quoteIndex,
      eligibility,
      tokenMetadata,
      quoteMetadata: { decimals: quoteMetadata.decimals },
      quoteUsd: {
        priceUsd: formatDecimal(quoteUsd.price, 12),
        source: quoteUsd.source,
        status: quoteUsd.status,
        blockTag: quoteOptions?.blockTag ?? 'latest',
      },
      v2: swap.protocol === 'uniswap-v2' ? { quoteReserveRaw: swap.quoteReserveRaw } : undefined,
      v3: await resolveV3Balances(swap),
      v4: swap.protocol === 'uniswap-v4'
        ? { poolId: swap.poolId, sqrtPriceX96: swap.sqrtPriceX96, liquidityRaw: swap.liquidityRaw, modifyLiquidity: [] }
        : undefined,
    });
    return {
      protocol: swap.protocol,
      marketKey: swap.marketKey ?? null,
      evidenceVersion: built.evidenceVersion,
      evidence: built.evidence,
    };
  }

  function buildEventCapture(event) {
    return {
      protocol: event.protocol ?? null,
      marketKey: event.marketKey ?? null,
      evidenceVersion: HEAD_EVIDENCE_VERSION,
      evidence: { event },
    };
  }

  function buildDiscoveryCapture(event, noxa = null) {
    const built = buildDiscoveryEvidence({ event, noxa });
    return {
      protocol: event.protocol ?? null,
      marketKey: event.marketKey ?? null,
      evidenceVersion: built.evidenceVersion,
      evidence: built.evidence,
    };
  }

  return Object.freeze({ buildMarketCapture, buildEventCapture, buildDiscoveryCapture });
}

module.exports = { createRobinhoodHeadCaptureBuilder };

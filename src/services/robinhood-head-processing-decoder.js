/**
 * Pure decode-from-evidence core for `robinhood-processing` (Corte 4).
 *
 * Reconstructs a market observation from a durable head-capture row WITHOUT any
 * RPC or database read. The swap trade amounts are re-decoded from the stored
 * log (`address`/`topics`/`data`) against a pool context synthesized from the
 * frozen evidence, and every state-dependent input (token metadata + supply,
 * quote USD, V3 pool balances, V4 sqrtPrice/liquidity) is read back from the
 * evidence payload. This is exactly what lets processing restart and reprocess
 * without historical `eth_call` (evidence contract §1/§7, plan §5.2).
 *
 * Valuation that needs the V4 tick ledger (materialized ranges) is deliberately
 * out of scope here: this module emits the `buildLiquidityAssessment` inputs and
 * leaves the ranges to the consumer (Corte 4c) that owns the ledger.
 */
const v2 = require('./uniswap-v2-decoder');
const v3 = require('./uniswap-v3-decoder');
const v4 = require('./uniswap-v4-decoder');
const { buildMarketObservation, ROBINHOOD_WETH } = require('./evm-market-metrics');
const { buildLiquidityAssessment } = require('./robinhood-market-policy');
const { HEAD_EVIDENCE_VERSION } = require('./robinhood-head-evidence');

const SUPPORTED_EVIDENCE_VERSIONS = new Set([HEAD_EVIDENCE_VERSION]);
const MARKET_PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);

function terminal(message) {
  const error = new Error(message);
  error.terminal = true;
  return error;
}

function assertSupportedVersion(version) {
  if (!SUPPORTED_EVIDENCE_VERSIONS.has(Number(version))) {
    throw terminal(`Unsupported head evidence version: ${version}`);
  }
}

function parseEvidence(row) {
  const evidence = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw terminal('capture evidence must be a JSON object');
  }
  return evidence;
}

function reconstructLog(row) {
  const topics = Array.isArray(row.topics) ? row.topics : JSON.parse(row.topics);
  return {
    address: row.address,
    topics,
    data: row.data,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
    transactionIndex: row.transaction_index,
  };
}

// The tracked pool/pair context the low-level decoders need is fully derivable
// from the frozen evidence plus the row's emitter address; no discovery replay
// and no RPC are involved.
// The Uniswap factories sort token0/token1 by address, so the tracked pool's quote
// slot is fully determined by the two frozen addresses — the same rule `selectQuote`
// applies live. We derive it here instead of trusting `evidence.quoteIndex`: v2/v3
// captures before this fix never surfaced the swap's quoteIndex and froze the default
// 0, which transposed token/quote for every pool whose quote is token1.
function resolveQuoteIndex(evidence) {
  return BigInt(evidence.quoteAddress) < BigInt(evidence.tokenAddress) ? 0 : 1;
}

function syntheticPool(protocol, row, evidence) {
  const base = {
    tracked: true,
    marketKey: row.market_key,
    tokenAddress: evidence.tokenAddress,
    quoteAddress: evidence.quoteAddress,
    quoteIndex: resolveQuoteIndex(evidence),
  };
  if (protocol === 'uniswap-v2') return { ...base, pairAddress: row.address };
  if (protocol === 'uniswap-v3') return { ...base, poolAddress: row.address, fee: null };
  return { ...base, poolManagerAddress: v4.ROBINHOOD_V4_POOL_MANAGER, poolId: evidence.v4?.poolId ?? null };
}

function decodeSwapFromRow(protocol, log, pool) {
  if (protocol === 'uniswap-v2') return v2.decodeSwap(log, pool);
  if (protocol === 'uniswap-v3') return v3.decodeSwap(log, pool);
  return v4.decodeSwap(log, pool);
}

function tokenMetadataFromEvidence(evidence) {
  const metadata = evidence.tokenMetadata || {};
  return {
    usable: true,
    address: evidence.tokenAddress,
    name: metadata.name ?? null,
    symbol: metadata.symbol ?? null,
    decimals: metadata.decimals,
    totalSupplyRaw: metadata.totalSupplyRaw,
    tokenSupplyStatus: metadata.tokenSupplyStatus ?? null,
    tokenSupplyBlockTag: metadata.tokenSupplyBlockTag ?? null,
  };
}

function quoteMetadataFromEvidence(evidence) {
  return { usable: true, address: evidence.quoteAddress, decimals: evidence.quoteMetadata?.decimals };
}

// Feed the frozen quote back through the same resolver the live path uses: WETH
// takes the observed price recorded in evidence, USDG resolves to its peg.
function quoteOptionsFromEvidence(evidence) {
  const quote = evidence.quoteUsd || {};
  if (evidence.quoteAddress === ROBINHOOD_WETH) {
    return { wethUsdPrice: quote.priceUsd, wethUsdSource: quote.source };
  }
  return {};
}

function liquidityInputsFromEvidence(protocol, evidence, swap, observation) {
  if (protocol === 'uniswap-v2') {
    return {
      protocol,
      quoteReserveRaw: evidence.v2?.quoteReserveRaw,
      quoteDecimals: evidence.quoteMetadata?.decimals,
      quoteUsdPrice: observation.quoteUsdPrice,
    };
  }
  if (protocol === 'uniswap-v3') {
    return {
      protocol,
      liquidityRaw: swap.liquidityRaw,
      tokenBalanceRaw: evidence.v3?.tokenBalanceRaw,
      quoteBalanceRaw: evidence.v3?.quoteBalanceRaw,
      tokenDecimals: evidence.tokenMetadata?.decimals,
      quoteDecimals: evidence.quoteMetadata?.decimals,
      tokenUsdPrice: observation.priceUsd,
      quoteUsdPrice: observation.quoteUsdPrice,
    };
  }
  return {
    protocol,
    liquidityRaw: swap.liquidityRaw,
    sqrtPriceX96: evidence.v4?.sqrtPriceX96 ?? swap.sqrtPriceX96,
    quoteIndex: Number(evidence.quoteIndex ?? 0),
    tokenDecimals: evidence.tokenMetadata?.decimals,
    quoteDecimals: evidence.quoteMetadata?.decimals,
    tokenUsdPrice: observation.priceUsd,
    quoteUsdPrice: observation.quoteUsdPrice,
    requiresRanges: true,
  };
}

/**
 * Runs the liquidity assessment for a decoded capture. V2/V3 are self-contained
 * from evidence; V4 requires the caller (ledger owner) to supply the current
 * materialized tick ranges.
 */
function assessLiquidity(inputs, options = {}) {
  if (!inputs) return null;
  if (inputs.requiresRanges) {
    const { requiresRanges: _ignored, ...v4Inputs } = inputs;
    return buildLiquidityAssessment({ ...v4Inputs, v4Ranges: options.v4Ranges ?? null });
  }
  return buildLiquidityAssessment(inputs);
}

// Mirrors the merge the live pipeline performs when it folds the liquidity
// assessment into the observation it persists.
function attachLiquidity(observation, assessment) {
  if (!observation?.accepted || !assessment) return observation;
  return {
    ...observation,
    liquidityUsd: assessment.liquidityUsd,
    liquidityRaw: assessment.liquidityRaw ?? null,
    liquidityStatus: assessment.status,
    liquidityConfidence: assessment.confidence,
    liquidityWarning: assessment.warning ?? null,
  };
}

/**
 * Decodes a single head-capture row into the entry the processing consumer
 * persists. Kinds:
 *  - `rejected`      the head already classified this swap as non-valuable;
 *  - `observation`   a valuation-ready swap (`observation` + `liquidityInputs`);
 *  - `liquidity-delta` a V4 ModifyLiquidity log for the ledger;
 *  - `discovery`     a discovery/launch event.
 */
function decodeCapture(row) {
  assertSupportedVersion(row.evidence_version);
  const evidence = parseEvidence(row);
  const log = reconstructLog(row);

  if (evidence.rejected != null) {
    return { kind: 'rejected', reason: String(evidence.rejected), log };
  }
  if (row.stream === 'discovery') {
    return { kind: 'discovery', log, event: evidence.event ?? null, noxa: evidence.noxa ?? null };
  }
  // Non-swap market events (e.g. V4 ModifyLiquidity) were frozen already decoded.
  if (evidence.event != null) {
    return { kind: 'liquidity-delta', log, event: evidence.event };
  }

  const protocol = String(row.protocol || '');
  if (!MARKET_PROTOCOLS.has(protocol)) throw terminal('capture protocol is invalid');

  const swap = decodeSwapFromRow(protocol, log, syntheticPool(protocol, row, evidence));
  swap.timestampMs = evidence.timestampMs ?? swap.timestampMs ?? null;

  const observation = buildMarketObservation({
    swap,
    tokenMetadata: tokenMetadataFromEvidence(evidence),
    quoteMetadata: quoteMetadataFromEvidence(evidence),
    eligibility: { eligible: true, reason: evidence.eligibility?.reason ?? null },
    ...quoteOptionsFromEvidence(evidence),
  });

  const liquidityInputs = observation.accepted
    ? liquidityInputsFromEvidence(protocol, evidence, swap, observation)
    : null;

  return { kind: 'observation', log, swap, observation, liquidityInputs };
}

module.exports = {
  SUPPORTED_EVIDENCE_VERSIONS,
  decodeCapture,
  assessLiquidity,
  attachLiquidity,
};

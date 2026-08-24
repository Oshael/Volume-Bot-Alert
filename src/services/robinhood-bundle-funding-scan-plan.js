const BUNDLE_RULE_VERSION = 'rh_possible_bundle_v1';
const MAX_LAUNCH_DELTA_BLOCKS = 3n;

function uint(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized);
}

function address(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} must be an address`);
  return normalized;
}

function normalizeCandidate(input = {}) {
  const launchBlock = uint(input.launchBlock ?? input.launch_block, 'launchBlock');
  const firstBuyBlock = uint(
    input.firstBuyBlock ?? input.first_buy_block ?? input.blockNumber,
    'firstBuyBlock',
  );
  if (firstBuyBlock < launchBlock) throw new Error('firstBuyBlock precedes launchBlock');
  return Object.freeze({
    tokenAddress: address(input.tokenAddress ?? input.token_address, 'tokenAddress'),
    walletAddress: address(input.walletAddress ?? input.wallet_address, 'walletAddress'),
    launchBlock: launchBlock.toString(),
    firstBuyBlock: firstBuyBlock.toString(),
    firstBuyTransactionIndex: uint(
      input.firstBuyTransactionIndex ?? input.transactionIndex ?? input.transaction_index,
      'firstBuyTransactionIndex',
    ).toString(),
    deltaBlocks: (firstBuyBlock - launchBlock).toString(),
  });
}

function compareCandidates(left, right) {
  const token = left.tokenAddress.localeCompare(right.tokenAddress);
  if (token !== 0) return token;
  const block = BigInt(left.firstBuyBlock) - BigInt(right.firstBuyBlock);
  if (block !== 0n) return block < 0n ? -1 : 1;
  const transaction = BigInt(left.firstBuyTransactionIndex)
    - BigInt(right.firstBuyTransactionIndex);
  if (transaction !== 0n) return transaction < 0n ? -1 : 1;
  return left.walletAddress.localeCompare(right.walletAddress);
}

function eligibleCandidates(input = []) {
  if (!Array.isArray(input)) throw new TypeError('candidates must be a list');
  const unique = new Map();
  const launches = new Map();
  for (const candidate of input.map(normalizeCandidate)) {
    if (BigInt(candidate.deltaBlocks) > MAX_LAUNCH_DELTA_BLOCKS) continue;
    const launch = launches.get(candidate.tokenAddress);
    if (launch != null && launch !== candidate.launchBlock) {
      throw new Error('candidate launch evidence conflicts');
    }
    launches.set(candidate.tokenAddress, candidate.launchBlock);
    const key = `${candidate.tokenAddress}:${candidate.walletAddress}`;
    const current = unique.get(key);
    if (current && (current.firstBuyBlock !== candidate.firstBuyBlock
      || current.firstBuyTransactionIndex !== candidate.firstBuyTransactionIndex)) {
      throw new Error('candidate first-buy evidence conflicts');
    }
    unique.set(key, current || candidate);
  }
  const counts = new Map();
  for (const candidate of unique.values()) {
    counts.set(candidate.tokenAddress, (counts.get(candidate.tokenAddress) || 0) + 1);
  }
  return [...unique.values()]
    .filter((candidate) => counts.get(candidate.tokenAddress) >= 2)
    .sort(compareCandidates);
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((left, right) => (
    left.fromBlock < right.fromBlock ? -1 : left.fromBlock > right.fromBlock ? 1 : 0
  ))) {
    const current = merged.at(-1);
    if (!current || range.fromBlock > current.toBlock + 1n) {
      merged.push({ ...range });
    } else if (range.toBlock > current.toBlock) {
      current.toBlock = range.toBlock;
    }
  }
  return merged;
}

function planBundleFundingScan(input = {}) {
  const sourceFrom = uint(input.sourceFromBlock, 'sourceFromBlock');
  const sourceThrough = uint(input.sourceThroughBlock, 'sourceThroughBlock');
  const lookbackBlocks = uint(input.lookbackBlocks, 'lookbackBlocks');
  if (sourceFrom > sourceThrough) throw new Error('sourceThroughBlock precedes sourceFromBlock');
  const candidates = eligibleCandidates(input.candidates);
  const rawRanges = candidates.map((candidate) => {
    const firstBuy = uint(candidate.firstBuyBlock, 'firstBuyBlock');
    if (firstBuy < sourceFrom) throw new Error('firstBuyBlock precedes source frontier');
    if (firstBuy > sourceThrough) throw new Error('firstBuyBlock exceeds source frontier');
    const wantedFrom = firstBuy > lookbackBlocks ? firstBuy - lookbackBlocks : 0n;
    return {
      fromBlock: wantedFrom > sourceFrom ? wantedFrom : sourceFrom,
      toBlock: firstBuy,
    };
  });
  const merged = mergeRanges(rawRanges);
  const blocksToScan = merged.reduce(
    (sum, range) => sum + range.toBlock - range.fromBlock + 1n, 0n,
  );
  const fullSourceBlocks = sourceThrough - sourceFrom + 1n;
  const tokens = new Set(candidates.map(({ tokenAddress }) => tokenAddress));
  return Object.freeze({
    ruleVersion: BUNDLE_RULE_VERSION,
    maxLaunchDeltaBlocks: MAX_LAUNCH_DELTA_BLOCKS.toString(),
    lookbackBlocks: lookbackBlocks.toString(),
    sourceFromBlock: sourceFrom.toString(),
    sourceThroughBlock: sourceThrough.toString(),
    candidateTokens: tokens.size,
    candidateWallets: candidates.length,
    candidateRanges: rawRanges.length,
    mergedRanges: merged.length,
    blocksToScan: blocksToScan.toString(),
    sourceBlocks: fullSourceBlocks.toString(),
    sourceCoverageBps: Number((blocksToScan * 10_000n) / fullSourceBlocks),
    candidates: Object.freeze(candidates),
    ranges: Object.freeze(merged.map((range) => Object.freeze({
      fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString(),
    }))),
  });
}

module.exports = {
  BUNDLE_RULE_VERSION,
  MAX_LAUNCH_DELTA_BLOCKS,
  planBundleFundingScan,
  __private: { eligibleCandidates, mergeRanges, normalizeCandidate },
};

const REPLAY_STATUSES = new Set(['idle', 'committed', 'drifted', 'resyncing']);
function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`${label} must be between ${minimum} and ${maximum}`);
    error.code = 'configuration_error';
    throw error;
  }
  return parsed;
}
function normalizeOptions(input = {}) {
  const admittedBefore = new Date(input.admittedBefore);
  if (!Number.isFinite(admittedBefore.getTime())) {
    const error = new Error('holder cold admittedBefore must be a timestamp');
    error.code = 'configuration_error';
    throw error;
  }
  return Object.freeze({
    admittedBefore: admittedBefore.toISOString(),
    candidateLimit: boundedInteger(input.candidateLimit, 10, 1, 10, 'candidateLimit'),
    retryMs: boundedInteger(input.retryMs, 7 * 86_400_000, 60_000, 30 * 86_400_000, 'retryMs'),
    rangeSize: boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize'),
    confirmations: boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations'),
  });
}
function requireDependencies(deps) {
  const contracts = [
    [deps.repository, 'listHolderDirectVerificationCandidates'],
    [deps.repository, 'recordDirectVerificationFailure'],
    [deps.repository, 'recordVerifiedDirectDeployments'],
    [deps.blockscoutClient, 'getContractCreators'],
    [deps.requestScheduler, 'schedule'],
    [deps.verifier, 'verifyDirectDeployment'],
    [deps.bootstrap, 'seedColdTokens'],
    [deps.executor, 'runOnce'],
  ];
  if (contracts.some(([owner, method]) => typeof owner?.[method] !== 'function')) {
    throw new TypeError('holder cold tick dependencies are incomplete');
  }
}
function publicErrorCode(error) {
  return String(error?.code || 'provider_error')
    .replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 64) || 'provider_error';
}
async function discoverDirectDeployments(deps, candidates) {
  if (!candidates.length) return { verified: 0, failed: 0, providerError: null };
  let hints;
  try {
    hints = await deps.requestScheduler.schedule(
      () => deps.blockscoutClient.getContractCreators(
        candidates.map(({ tokenAddress }) => tokenAddress)
      )
    );
  } catch (error) {
    return { verified: 0, failed: 0, providerError: publicErrorCode(error) };
  }
  if (!Array.isArray(hints)) {
    const error = new Error('holder cold Blockscout result is invalid');
    error.code = 'holder_cold_contract_error';
    throw error;
  }
  const byToken = new Map(hints.map((hint) => [hint.tokenAddress, hint]));
  let verified = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const hint = byToken.get(candidate.tokenAddress);
    try {
      if (!hint?.transactionHash || hint.creatorAddress !== candidate.creatorAddress) {
        throw Object.assign(new Error('Blockscout direct deployment hint is incomplete'), {
          code: 'holder_deployment_hint_incomplete',
        });
      }
      const deployment = await deps.verifier.verifyDirectDeployment(hint);
      await deps.repository.recordVerifiedDirectDeployments([deployment]);
      verified += 1;
    } catch (error) {
      if (error.code === 'configuration_error') throw error;
      await deps.repository.recordDirectVerificationFailure({
        tokenAddress: candidate.tokenAddress,
        error: publicErrorCode(error),
      });
      failed += 1;
    }
  }
  return { verified, failed, providerError: null };
}
async function runRobinhoodHolderColdTick(deps = {}, input = {}) {
  requireDependencies(deps);
  const options = normalizeOptions(input);
  const now = Number((deps.now || Date.now)());
  if (!Number.isFinite(now)) throw new TypeError('holder cold clock is invalid');
  const candidates = await deps.repository.listHolderDirectVerificationCandidates({
    admittedBefore: options.admittedBefore,
    retryBefore: new Date(now - options.retryMs).toISOString(),
    limit: options.candidateLimit,
  });
  const discovery = await discoverDirectDeployments(deps, candidates);
  const replayOptions = {
    rangeSize: options.rangeSize, confirmations: options.confirmations,
  };
  let replay = await deps.executor.runOnce(replayOptions);
  if (!REPLAY_STATUSES.has(replay?.status)) {
    const error = new Error(`unexpected holder cold replay result: ${replay?.status}`);
    error.code = 'holder_cold_contract_error';
    throw error;
  }
  let seeded = [];
  if (replay.status === 'idle') {
    seeded = await deps.bootstrap.seedColdTokens({
      admittedBefore: options.admittedBefore, limit: 1,
    });
    if (!Array.isArray(seeded) || seeded.length > 1) {
      const error = new Error('unexpected holder cold admission result');
      error.code = 'holder_cold_contract_error';
      throw error;
    }
    if (seeded.length) replay = await deps.executor.runOnce(replayOptions);
  }
  if (!REPLAY_STATUSES.has(replay?.status)) {
    const error = new Error(`unexpected holder cold replay result: ${replay?.status}`);
    error.code = 'holder_cold_contract_error';
    throw error;
  }
  return Object.freeze({
    candidates: candidates.length, ...discovery,
    seededTokens: seeded.length, replayStatus: replay.status,
    tokenAddress: replay.tokenAddress || null,
    atBarrier: replay.atBarrier === true,
  });
}
module.exports = {
  runRobinhoodHolderColdTick,
  __private: { discoverDirectDeployments, normalizeOptions },
};

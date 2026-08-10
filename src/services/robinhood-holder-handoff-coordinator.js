function createRobinhoodHolderHandoffCoordinator(options = {}) {
  const repository = options.repository;
  const reader = options.reader;
  if (typeof repository?.getNextCandidate !== 'function'
      || typeof repository?.markResyncing !== 'function'
      || typeof repository?.promoteAtLiveBarrier !== 'function') {
    throw new TypeError('holder handoff repository is required');
  }
  if (typeof reader?.matchesCheckpoint !== 'function') {
    throw new TypeError('holder transfer reader is required');
  }

  async function runOnce() {
    const candidate = await repository.getNextCandidate();
    if (!candidate) return Object.freeze({ status: 'idle' });
    if (!await reader.matchesCheckpoint(candidate.checkpoint)) {
      const isolated = await repository.markResyncing(candidate);
      return Object.freeze({
        ...isolated, reason: 'holder_handoff_checkpoint_orphaned',
      });
    }
    return repository.promoteAtLiveBarrier({
      tokenAddress: candidate.tokenAddress,
      verifiedCheckpoint: candidate.checkpoint,
    });
  }

  return Object.freeze({ runOnce });
}

module.exports = { createRobinhoodHolderHandoffCoordinator };

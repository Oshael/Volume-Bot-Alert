'use strict';

function envelopeInput(envelope) {
  return envelope?.payload?.eventKind === 'callout'
    ? { calloutEnvelopes: [envelope], profileEnvelopes: [] }
    : { calloutEnvelopes: [], profileEnvelopes: [envelope] };
}

function createImmediateCalloutPersistence(options = {}) {
  const repository = options.repository;
  const checkpointKey = String(options.checkpointKey || '').trim();
  if (!repository?.commitCapture || !repository?.loadCheckpoint || !checkpointKey) {
    throw new TypeError('Immediate persistence requires repository and checkpoint key');
  }
  const now = options.now || Date.now;
  let sequence = 0;
  let loaded = false;
  let queue = Promise.resolve();
  let committed = 0;

  function append(envelope) {
    const operation = queue.then(async () => {
      if (!loaded) {
        const checkpoint = await repository.loadCheckpoint(checkpointKey);
        sequence = Number.isSafeInteger(checkpoint?.state?.sequence) ? checkpoint.state.sequence : 0;
        loaded = true;
      }
      sequence += 1;
      await repository.commitCapture({
        ...envelopeInput(envelope), checkpointKey,
        checkpointState: { version: 1, sequence, lastDedupeKey: envelope.dedupeKey },
        committedAt: new Date(now()).toISOString(),
      });
      committed += 1;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return {
    eventSpool: { append }, identitySpool: { append },
    flush: () => queue,
    getStatus: () => ({ committed, sequence }),
  };
}

function createPumpCalloutPersistence(options = {}) {
  const repository = options.repository;
  const checkpointKey = String(options.checkpointKey || '').trim();
  if (!repository?.commitCapture || !repository?.loadCheckpoint || !checkpointKey) {
    throw new TypeError('Pump persistence requires repository and checkpoint key');
  }
  const now = options.now || Date.now;
  const callouts = [];
  const profiles = [];
  let committedBatches = 0;

  return {
    eventSpool: { append: async (envelope) => { callouts.push(envelope); } },
    identitySpool: { append: async (envelope) => { profiles.push(envelope); } },
    stateStore: {
      async load() { return (await repository.loadCheckpoint(checkpointKey))?.state || {}; },
      async save(state) {
        const calloutCount = callouts.length;
        const profileCount = profiles.length;
        await repository.commitCapture({
          calloutEnvelopes: callouts.slice(0, calloutCount),
          profileEnvelopes: profiles.slice(0, profileCount),
          checkpointKey, checkpointState: state,
          committedAt: new Date(now()).toISOString(),
        });
        callouts.splice(0, calloutCount);
        profiles.splice(0, profileCount);
        committedBatches += 1;
      },
    },
    getStatus: () => ({ committedBatches, bufferedCallouts: callouts.length, bufferedProfiles: profiles.length }),
  };
}

module.exports = { createImmediateCalloutPersistence, createPumpCalloutPersistence };

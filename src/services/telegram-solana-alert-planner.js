const { normalizeTokenAddress } = require('../utils/token-identity');

const EVENT_ID_FIELDS = Object.freeze(['lastEventId', 'surgeContinuation6hEventId']);

function toIso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function latestUpdatedAt(profile) {
  const values = [profile.updatedAt, ...profile.rules.map((rule) => rule.updatedAt)];
  return values.reduce((latest, value) => (
    new Date(value).getTime() > new Date(latest).getTime() ? value : latest
  ));
}

function buildMatcherProfile(profile) {
  const rules = Object.fromEntries(profile.rules.map((rule) => [rule.ruleKey, rule]));
  const settings = (ruleKey) => rules[ruleKey]?.settings || {};
  return {
    userId: profile.userId,
    loadedAt: latestUpdatedAt(profile),
    alertSessionKey: [
      'telegram',
      profile.profileId,
      profile.version,
      ...profile.rules.map((rule) => `${rule.ruleKey}:${rule.version}`),
    ].join(':'),
    ruleEnabled: profile.ruleEnabled,
    thresholdPct: settings('monitored-vol').thresholdPct,
    mcapThresholdPct: settings('monitored-mcap').thresholdPct,
    hvncMinVol: settings('hvnc').minHvncVolumeUsd,
    recentSurge1hThresholdPct: settings('recent-surge-1h').thresholdPct,
    recentSurge6hThresholdPct: settings('recent-surge-6h').thresholdPct,
    oldWeekSurge1hThresholdPct: settings('old-week-surge-1h').thresholdPct,
    oldWeekSurge6hThresholdPct: settings('old-week-surge-6h').thresholdPct,
    meteoraAlert1hThreshold: settings('meteora-surge').thresholdPct,
    minVol: 0,
    minMcap: 0,
    maxMcap: 0,
    ruleSettingsByKey: Object.fromEntries(
      profile.rules.map((rule) => [rule.ruleKey, rule.settings])
    ),
    cooldownMsByRule: Object.fromEntries(
      profile.rules.map((rule) => [rule.ruleKey, rule.cooldownMs])
    ),
  };
}

function buildMemoryRuntime(profile, stateRows, tokenAddress, resetState = false) {
  const rules = new Map(profile.rules.map((rule) => [rule.ruleKey, rule]));
  const source = new Map();
  const states = new Map();
  for (const row of stateRows) {
    if (String(row.profileId) !== profile.profileId
      || row.chain !== profile.chain
      || row.tokenAddress !== tokenAddress
      || !rules.has(row.ruleKey)) continue;
    source.set(row.ruleKey, row);
    if (!resetState && row.ruleVersion === rules.get(row.ruleKey).version) {
      states.set(row.ruleKey, row.state);
    }
  }

  const touched = new Set();
  const intents = [];
  const temporaryEvents = new Map();

  function setState(ruleKey, value) {
    states.set(ruleKey, value);
    touched.add(ruleKey);
    return value;
  }

  const statePort = {
    async getState(_userId, ruleKey) {
      return states.get(ruleKey) || null;
    },
    async markTriggered(payload) {
      return setState(payload.ruleKey, {
        status: 'triggered',
        lastAlertedAt: toIso(payload.lastAlertedAt),
        lastAlertedValue: payload.lastAlertedValue ?? null,
        lastAlertedPct: payload.lastAlertedPct ?? null,
        cooldownUntil: toIso(payload.cooldownUntil),
        rearmRequired: payload.rearmRequired ?? true,
        lastFingerprint: payload.lastFingerprint || null,
        metadata: payload.metadata || {},
      });
    },
    async markRearmed(payload) {
      const current = states.get(payload.ruleKey) || {};
      return setState(payload.ruleKey, {
        ...current,
        status: 'rearmed',
        cooldownUntil: toIso(payload.cooldownUntil),
        rearmRequired: false,
        lastFingerprint: payload.lastFingerprint ?? current.lastFingerprint ?? null,
        metadata: payload.metadata ?? current.metadata ?? {},
      });
    },
  };

  async function createIntent(payload) {
    const intentRef = `intent:${intents.length + 1}`;
    const temporaryId = 9_000_000_000 + intents.length;
    temporaryEvents.set(temporaryId, intentRef);
    const event = { id: temporaryId, ...payload };
    intents.push(Object.freeze({
      intentRef,
      connectionId: profile.connectionId,
      profileId: profile.profileId,
      chain: payload.chain,
      ruleKey: payload.ruleKey,
      kind: payload.kind,
      tokenAddress: payload.tokenAddress,
      dedupeKey: `profile:${profile.profileId}:${payload.dedupeKey}`,
      payload: payload.payload,
      triggeredAt: toIso(payload.triggeredAt),
    }));
    return event;
  }

  const client = Object.freeze({
    async query() { return { rows: [] }; },
    release() {},
  });
  const deps = {
    db: { async getClient() { return client; } },
    userAlertRuleState: statePort,
    userAlertEvent: { createEvent: createIntent },
    backendAlertPublisher: { async publishEventSafe() {} },
    alertTickerPeers: { async buildTickerPeerSnapshotForAlert() { return null; } },
  };

  function transitions() {
    return [...touched].map((ruleKey) => {
      const row = source.get(ruleKey);
      const state = states.get(ruleKey);
      const metadata = { ...(state.metadata || {}) };
      const eventReferences = [];
      for (const field of EVENT_ID_FIELDS) {
        const intentRef = temporaryEvents.get(metadata[field]);
        if (!intentRef) continue;
        metadata[field] = null;
        eventReferences.push(Object.freeze({ field: `metadata.${field}`, intentRef }));
      }
      return Object.freeze({
        profileId: profile.profileId,
        chain: profile.chain,
        ruleKey,
        tokenAddress,
        ruleVersion: rules.get(ruleKey).version,
        expectedVersion: row?.version ?? null,
        state: Object.freeze({ ...state, metadata: Object.freeze(metadata) }),
        eventReferences: Object.freeze(eventReferences),
      });
    });
  }

  return { deps, intents, transitions };
}

function reactivationEpoch(profile) {
  const value = profile.reactivation?.pending
    ? profile.reactivation.requestedAt
    : profile.reactivation?.reactivatedAt;
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenCreatedAfter(token, epochMs) {
  const createdAt = Number(token?.last_token_created_at_ms);
  return Number.isFinite(createdAt) && createdAt > epochMs;
}

function hasFreshStates(profile, stateRows, epochMs) {
  const indexed = new Map(stateRows.map((row) => [row.ruleKey, row]));
  return profile.rules.filter(({ enabled }) => enabled).every((rule) => {
    const row = indexed.get(rule.ruleKey);
    const updatedAt = row?.updatedAt ? new Date(row.updatedAt).getTime() : NaN;
    return row?.ruleVersion === rule.version
      && Number.isFinite(updatedAt)
      && updatedAt >= epochMs;
  });
}

function baselineContext(profile, stateRows, token) {
  const epochMs = reactivationEpoch(profile);
  if (epochMs == null) return null;
  if (!profile.reactivation.pending
    && (tokenCreatedAfter(token, epochMs) || hasFreshStates(profile, stateRows, epochMs))) {
    return null;
  }
  return Object.freeze({
    epoch: new Date(epochMs).toISOString(),
    pending: profile.reactivation.pending,
    requestedAt: profile.reactivation.requestedAt,
  });
}

function emptyBaselineState(epoch) {
  return {
    status: 'rearmed',
    lastAlertedAt: null,
    lastAlertedValue: null,
    lastAlertedPct: null,
    cooldownUntil: null,
    rearmRequired: false,
    lastFingerprint: null,
    metadata: { lastDecision: 'reactivation_baseline', reactivatedAt: epoch },
  };
}

function baselineState(state, epoch) {
  const value = state || emptyBaselineState(epoch);
  const metadata = {
    ...(value.metadata || {}),
    lastDecision: 'reactivation_baseline',
    reactivatedAt: epoch,
  };
  for (const field of EVENT_ID_FIELDS) metadata[field] = null;
  return Object.freeze({ ...value, metadata: Object.freeze(metadata) });
}

function baselineTransitions(profile, stateRows, transitions, tokenAddress, baseline) {
  const rows = new Map(stateRows.map((row) => [row.ruleKey, row]));
  const planned = new Map(transitions.map((transition) => [transition.ruleKey, transition]));
  return Object.freeze(profile.rules.filter(({ enabled }) => enabled).map((rule) => {
    const existing = rows.get(rule.ruleKey);
    const transition = planned.get(rule.ruleKey);
    return Object.freeze({
      profileId: profile.profileId,
      chain: profile.chain,
      ruleKey: rule.ruleKey,
      tokenAddress,
      ruleVersion: rule.version,
      expectedVersion: existing?.version ?? null,
      state: baselineState(transition?.state, baseline.epoch),
      eventReferences: Object.freeze([]),
    });
  }));
}

function baselineSummary(summary, intentCount) {
  return Object.freeze({
    ...summary,
    emitted: 0,
    suppressed: Number(summary.suppressed || 0) + intentCount,
    events: Object.freeze([]),
  });
}

function emptyPlan(profile) {
  return Object.freeze({
    profileId: profile.profileId,
    connectionId: profile.connectionId,
    intents: Object.freeze([]),
    stateTransitions: Object.freeze([]),
  });
}

function createTelegramSolanaAlertPlanner(options = {}) {
  const evaluateProfile = options.evaluateProfile;
  if (typeof evaluateProfile !== 'function') {
    throw new TypeError('Telegram Solana profile evaluator port is required');
  }

  async function plan(input = {}) {
    const profile = input.profile;
    if (!profile || profile.destination !== 'telegram' || profile.chain !== 'solana') {
      throw new TypeError('Telegram Solana evaluation profile is required');
    }
    if (!profile.enabled) return emptyPlan(profile);
    if (!Array.isArray(input.states)) {
      throw new TypeError('Telegram Solana rule states must be an array');
    }
    const tokenAfter = input.tokenAfter;
    const tokenAddress = normalizeTokenAddress('solana', tokenAfter?.address);
    const baseline = baselineContext(profile, input.states, tokenAfter);
    const runtime = buildMemoryRuntime(profile, input.states, tokenAddress, Boolean(baseline));
    const summary = {
      evaluatedProfiles: 1,
      emitted: 0,
      rearmed: 0,
      suppressed: 0,
      errors: 0,
      events: [],
    };
    await evaluateProfile({
      profile: buildMatcherProfile(profile),
      tokenAfter,
      signals: input.signals,
      nowMs: Number(input.nowMs),
      deps: runtime.deps,
      summary,
    });
    const transitions = runtime.transitions();
    if (baseline) {
      return Object.freeze({
        profileId: profile.profileId,
        connectionId: profile.connectionId,
        intents: Object.freeze([]),
        stateTransitions: baselineTransitions(
          profile, input.states, transitions, tokenAddress, baseline,
        ),
        summary: baselineSummary(summary, runtime.intents.length),
        reactivationBaseline: baseline,
      });
    }
    return Object.freeze({
      profileId: profile.profileId,
      connectionId: profile.connectionId,
      intents: Object.freeze([...runtime.intents]),
      stateTransitions: Object.freeze(transitions),
      summary: Object.freeze({ ...summary, events: Object.freeze([...summary.events]) }),
    });
  }

  return Object.freeze({ plan });
}

module.exports = {
  createTelegramSolanaAlertPlanner,
};

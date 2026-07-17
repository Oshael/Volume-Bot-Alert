const { HVNC_MAX_AGE_MS } = require('./robinhood-signal-policy');

const MANDATORY_PROTOCOLS = Object.freeze(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const PUBLISHABLE_PROTOCOLS = MANDATORY_PROTOCOLS;
const REQUIRED_DRY_RUN_GATES = Object.freeze([
  'windowMs',
  'minVolumeUsd',
  'minTransactions',
  'maxAgeMs',
]);

function safeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function blockNumber(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function addConfirmations(safeHead, confirmations) {
  const normalized = blockNumber(safeHead);
  return normalized == null ? null : (BigInt(normalized) + BigInt(confirmations)).toString();
}

function lagBlocks(safeHead, cursor) {
  const normalizedHead = blockNumber(safeHead);
  const normalizedCursor = blockNumber(cursor);
  if (normalizedHead == null || normalizedCursor == null) return null;
  const head = BigInt(normalizedHead);
  const nextBlock = BigInt(normalizedCursor);
  return Number(head >= nextBlock ? head - nextBlock + 1n : 0n);
}

function compactProviders(rpc = {}) {
  return Object.fromEntries(Object.entries(rpc).slice(0, 4).map(([name, metrics]) => [
    String(name).slice(0, 64),
    {
      requests: safeCount(metrics?.requests),
      errors: safeCount(metrics?.errors),
      fallbacks: safeCount(metrics?.fallbacks),
      rateLimited: safeCount(metrics?.rateLimited),
      requestBytes: safeCount(metrics?.requestBytes),
      responseBytes: safeCount(metrics?.responseBytes),
    },
  ]));
}

function compactStreamCoverage(coverage, prefix, confirmations) {
  const safeHead = blockNumber(coverage?.[`${prefix}SafeHead`]);
  const cursor = blockNumber(coverage?.[`${prefix}Cursor`]);
  return {
    head: addConfirmations(safeHead, confirmations),
    safeHead,
    cursor,
    lagBlocks: lagBlocks(safeHead, cursor),
  };
}

function compactError(error) {
  if (!error) return null;
  return {
    code: String(error.code || 'error').slice(0, 64),
    message: String(error.message || error).slice(0, 500),
  };
}

function hasSharedHeadCursor(coverage) {
  return Boolean(
    coverage?.discovery?.safeHead
    && coverage.discovery.cursor
    && coverage?.market?.safeHead
    && coverage.market.cursor
  );
}

function compactInMemoryState(state) {
  if (!state) return null;
  return {
    rollbackEnabled: state.rollbackEnabled === true,
    rollbackLimit: safeCount(state.rollbackLimit),
    observations: safeCount(state.observations),
    discoveries: safeCount(state.discoveries),
    windowAggregationEnabled: state.windowAggregationEnabled === true,
    windowEvents: safeCount(state.windowEvents),
  };
}

function buildRobinhoodLeaseTelemetry(input = {}) {
  const ingestionStatus = input.ingestionStatus || {};
  const snapshot = ingestionStatus.lastSnapshot || {};
  const coverage = snapshot.coverage || {};
  const confirmations = Math.max(0, Math.min(1000, Math.trunc(Number(input.confirmations) || 0)));
  const capturedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const compactCoverage = {
    status: coverage.status || null,
    caughtUp: coverage.caughtUp === true,
    unexplainedGaps: safeCount(coverage.unexplainedGaps),
    headProcessingDelayMs: coverage.headProcessingDelayMs == null
      ? null
      : safeCount(coverage.headProcessingDelayMs),
    discovery: compactStreamCoverage(coverage, 'discovery', confirmations),
    market: compactStreamCoverage(coverage, 'market', confirmations),
  };
  return {
    version: 1,
    status: hasSharedHeadCursor(compactCoverage) ? 'available' : 'warming-up',
    capturedAt,
    worker: {
      running: ingestionStatus.running === true,
      inFlight: ingestionStatus.inFlight === true,
      halted: ingestionStatus.halted === true,
      lastCompletedAt: ingestionStatus.lastCompletedAt || null,
      consecutiveErrors: safeCount(ingestionStatus.consecutiveErrors),
      totalErrors: safeCount(ingestionStatus.totalErrors),
      lastError: compactError(ingestionStatus.lastError),
    },
    coverage: compactCoverage,
    transport: {
      kind: 'http-polling',
      reconnectApplicable: false,
      recoveries: safeCount(snapshot.runner?.recoveries),
    },
    runner: {
      cycles: safeCount(snapshot.runner?.cycles),
      errors: safeCount(snapshot.runner?.errors),
      consecutiveErrors: safeCount(snapshot.runner?.consecutiveErrors),
    },
    providers: compactProviders(snapshot.rpc),
    inMemoryState: compactInMemoryState(snapshot.inMemoryState),
  };
}

function uniqueProtocols(protocols) {
  return [...new Set(
    (Array.isArray(protocols) ? protocols : [])
      .map((protocol) => String(protocol).trim().toLowerCase())
      .filter(Boolean)
  )];
}

function hasConfiguredDryRunGates(config) {
  return config.enabled === true
    && REQUIRED_DRY_RUN_GATES.every((field) => config[field] != null)
    && Number.isSafeInteger(Number(config.maxAgeMs))
    && Number(config.maxAgeMs) > 0
    && Number(config.maxAgeMs) <= HVNC_MAX_AGE_MS;
}

function resolveRolloutAxes(config = {}) {
  const masterEnabled = config.robinhoodIngestionWorker?.enabled === true;
  const rollout = config.robinhoodRollout || {};
  return {
    masterEnabled,
    transportRequested: rollout.transport?.enabled ?? masterEnabled,
    transportExplicit: rollout.transport?.explicit === true,
    persistenceRequested: rollout.persistence?.enabled ?? masterEnabled,
    persistenceExplicit: rollout.persistence?.explicit === true,
    alertsRequested: rollout.alerts?.requested === true,
    alertsExplicit: rollout.alerts?.explicit === true,
  };
}

function evaluateRobinhoodIngestionGate(config = {}) {
  const axes = resolveRolloutAxes(config);
  const blockers = [];
  if (!axes.masterEnabled) blockers.push('ingestion_master_disabled');
  if (!axes.transportRequested) blockers.push('transport_disabled');
  if (!axes.persistenceRequested) blockers.push('persistence_disabled');
  return {
    ...axes,
    allowed: blockers.length === 0,
    blockers,
  };
}

function evaluateRobinhoodCatalogStagingGate(config = {}) {
  const ingestionGate = evaluateRobinhoodIngestionGate(config);
  const blockers = [...ingestionGate.blockers];
  if (!ingestionGate.alertsRequested) blockers.push('alerts_disabled');
  const signalConfig = config.robinhoodSignalDryRun || {};
  const signalGatesConfigured = hasConfiguredDryRunGates({
    ...signalConfig,
    enabled: true,
    protocols: uniqueProtocols(signalConfig.protocols),
  });
  if (!signalGatesConfigured) blockers.push('signal_gates_incomplete');
  return {
    ...ingestionGate,
    signalGatesConfigured,
    allowed: blockers.length === 0,
    blockers,
  };
}

function isActiveLease(lease, nowMs) {
  if (!lease || lease.metadata?.state === 'halted') return false;
  const leaseUntilMs = Date.parse(String(lease.leaseUntil || ''));
  return Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs;
}

function derivePhase({ halted, ingestionEffective, dryRunConfigured, publishable }) {
  if (halted) return 'halted';
  if (!ingestionEffective) return 'off';
  if (publishable) return 'delivering-aggregate-alerts';
  return dryRunConfigured ? 'dry-run-ready' : 'ingestion-only';
}

function selectSharedTelemetry(sharedLease, sharedLeaseActive) {
  if (!sharedLeaseActive) return null;
  const telemetry = sharedLease?.metadata?.telemetry;
  return telemetry?.version === 1 ? telemetry : null;
}

function selectTelemetryScope(localWorkerActive, sharedLeaseActive, sharedTelemetry) {
  if (localWorkerActive) return 'local-worker';
  if (sharedTelemetry) return 'shared-worker-lease';
  return sharedLeaseActive ? 'remote-worker-lease-only' : 'no-worker';
}

function deriveRolloutState(input) {
  const config = input.config || {};
  const signalConfig = config.robinhoodSignalDryRun || {};
  const ingestionStatus = input.ingestionStatus || {};
  const sharedLease = input.sharedLease || null;
  const nowMs = Number(input.nowMs ?? Date.now());
  const requestedProtocols = uniqueProtocols(signalConfig.protocols);
  const protocols = [...MANDATORY_PROTOCOLS];
  const missingMandatoryProtocols = MANDATORY_PROTOCOLS.filter(
    (protocol) => !protocols.includes(protocol)
  );
  const localWorkerActive = ingestionStatus.running === true;
  const sharedLeaseActive = isActiveLease(sharedLease, nowMs);
  const sharedTelemetry = selectSharedTelemetry(sharedLease, sharedLeaseActive);
  const ingestionEffective = localWorkerActive || sharedLeaseActive;
  const halted = ingestionStatus.halted === true || sharedLease?.metadata?.state === 'halted';
  const dryRunEnabled = signalConfig.enabled === true;
  const dryRunConfigured = hasConfiguredDryRunGates({ ...signalConfig, protocols });
  const ingestionGate = evaluateRobinhoodIngestionGate(config);
  const telemetryScope = selectTelemetryScope(
    localWorkerActive,
    sharedLeaseActive,
    sharedTelemetry
  );
  const localCoverage = ingestionStatus.lastSnapshot?.coverage || null;
  const sharedCoverage = sharedTelemetry?.coverage || null;
  const publicationCoverage = localWorkerActive ? localCoverage : sharedCoverage;
  const coverageReady = publicationCoverage?.caughtUp === true
    && publicationCoverage.unexplainedGaps != null
    && safeCount(publicationCoverage.unexplainedGaps) === 0;
  return {
    ingestionStatus,
    protocols,
    requestedProtocols,
    missingMandatoryProtocols,
    localWorkerActive,
    sharedLeaseActive,
    sharedTelemetry,
    ingestionGate,
    ingestionEffective,
    halted,
    dryRunEnabled,
    dryRunConfigured,
    telemetryScope,
    coverageReady,
  };
}

function buildPublicationBlockers(input) {
  const blockers = [];
  if (input.halted) blockers.push('worker_halted');
  blockers.push(...input.ingestionGate.blockers);
  if (!input.ingestionGate.alertsRequested) blockers.push('alerts_disabled');
  if (input.ingestionGate.allowed && !input.ingestionEffective) blockers.push('worker_not_active');
  if (input.ingestionEffective && !input.coverageReady) blockers.push('ingestion_not_caught_up');
  if (!input.dryRunEnabled) blockers.push('signal_dry_run_disabled');
  if (input.dryRunEnabled && !input.dryRunConfigured) blockers.push('signal_gates_incomplete');
  if (input.telemetryScope === 'remote-worker-lease-only') {
    blockers.push('worker_metrics_process_local');
  }
  return blockers;
}

function buildBlockers(publicationBlockers, missingMandatoryProtocols) {
  const blockers = [...publicationBlockers];
  if (missingMandatoryProtocols.length) blockers.push('mandatory_protocols_disabled');
  return [...new Set(blockers)];
}

function buildRobinhoodRolloutStatus(input = {}) {
  const state = deriveRolloutState(input);
  const {
    ingestionStatus,
    protocols,
    requestedProtocols,
    missingMandatoryProtocols,
    localWorkerActive,
    sharedLeaseActive,
    sharedTelemetry,
    ingestionGate,
    ingestionEffective,
    halted,
    dryRunEnabled,
    dryRunConfigured,
    telemetryScope,
    coverageReady,
  } = state;
  const publicationBlockers = buildPublicationBlockers({
    halted,
    ingestionGate,
    ingestionEffective,
    coverageReady,
    dryRunEnabled,
    dryRunConfigured,
    protocols,
    telemetryScope,
  });
  const publishable = publicationBlockers.length === 0;
  const blockers = buildBlockers(publicationBlockers, missingMandatoryProtocols);

  return {
    chain: 'robinhood',
    phase: derivePhase({ halted, ingestionEffective, dryRunConfigured, publishable }),
    publishable,
    alertPublicationReady: true,
    publicationBlockers,
    axes: {
      transport: {
        requested: ingestionGate.transportRequested,
        effective: ingestionEffective,
        explicit: ingestionGate.transportExplicit,
        mode: 'http-polling',
        killSwitch: 'ROBINHOOD_TRANSPORT_ENABLED',
        masterSwitch: 'ROBINHOOD_INGESTION_ENABLED',
      },
      protocols: {
        mode: 'dry-run',
        enabled: dryRunEnabled,
        allowlist: protocols,
        requestedAllowlist: requestedProtocols,
        mandatory: [...MANDATORY_PROTOCOLS],
        missingMandatory: missingMandatoryProtocols,
        publishable: [...PUBLISHABLE_PROTOCOLS],
        coverageComplete: missingMandatoryProtocols.length === 0,
      },
      persistence: {
        requested: ingestionGate.persistenceRequested,
        effective: ingestionEffective,
        explicit: ingestionGate.persistenceExplicit,
        coupledToTransport: true,
        activationCoupledToTransport: true,
        killSwitch: 'ROBINHOOD_PERSISTENCE_ENABLED',
        masterSwitch: 'ROBINHOOD_INGESTION_ENABLED',
      },
      alerts: {
        requested: ingestionGate.alertsRequested,
        effective: publishable,
        explicit: ingestionGate.alertsExplicit,
        publishable,
        killSwitch: 'ROBINHOOD_ALERTS_ENABLED',
        reason: publishable ? null : publicationBlockers[0] || 'blocked',
      },
    },
    health: {
      halted,
      localWorkerActive,
      sharedLeaseActive,
      telemetryScope,
      telemetryCapturedAt: sharedTelemetry?.capturedAt || null,
      headCursorAvailable: Boolean(ingestionStatus.lastSnapshot?.coverage)
        || hasSharedHeadCursor(sharedTelemetry?.coverage),
      sharedHeadCursorAvailable: hasSharedHeadCursor(sharedTelemetry?.coverage),
      coverageReady,
    },
    telemetry: sharedTelemetry,
    blockers,
  };
}

module.exports = {
  MANDATORY_PROTOCOLS,
  PUBLISHABLE_PROTOCOLS,
  buildRobinhoodLeaseTelemetry,
  buildRobinhoodRolloutStatus,
  evaluateRobinhoodCatalogStagingGate,
  evaluateRobinhoodIngestionGate,
};

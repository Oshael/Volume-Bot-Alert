export type TokenValuationType = 'market-cap' | 'fdv';
export type WorkspaceValuationType = 'mcap' | 'fdv';
export type TokenValuationFreshness = 'fresh' | 'stale' | 'unknown';
export type TokenMetricCoverage = 'complete' | 'partial' | 'unavailable';
export type TokenMetricWindow = '5m' | '1h' | '6h' | '24h';
export type TokenMetricCoverageMap = Partial<Record<TokenMetricWindow, TokenMetricCoverage>>;

export type TokenValuationSnapshot = {
  type: WorkspaceValuationType | null;
  usd: number | null;
  observedAt: string | null;
  freshness: TokenValuationFreshness;
};

export type TokenValuationInput = {
  mcap?: number | null;
  fdv?: number | null;
  valuationType?: TokenValuationType | null;
  valuation?: TokenValuationSnapshot | null;
};

export type ResolvedTokenValuation = {
  label: 'MCAP' | 'FDV';
  value: number | null;
  type: TokenValuationType | null;
  observedAt: string | null;
  freshness: TokenValuationFreshness;
};

export type ResolvedCoveredMetric = {
  value: number | null;
  coverage: TokenMetricCoverage;
  available: boolean;
  isZero: boolean;
  isPartial: boolean;
};

export type WorkspaceMarketTimestampInput = {
  windowEnd?: string | null;
  lastActivityAt?: string | null;
  lastSeenAt?: string | null;
  lastEvaluatedAt?: string | null;
  valuation?: Pick<TokenValuationSnapshot, 'observedAt'> | null;
};

function toFiniteValuation(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeObservedAt(value: string | null | undefined) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null;
  return value;
}

export function resolveWorkspaceMarketSnapshotMs(input: WorkspaceMarketTimestampInput) {
  const windowEndMs = new Date(input.windowEnd || '').getTime();
  if (Number.isFinite(windowEndMs)) return windowEndMs;
  const timestamps = [
    input.valuation?.observedAt,
    input.lastActivityAt,
    input.lastSeenAt,
    input.lastEvaluatedAt,
  ].map((value) => new Date(value || '').getTime()).filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function resolveValuationMetadata(
  valuation: TokenValuationSnapshot | null | undefined,
  type: TokenValuationType,
  value: number,
): Pick<ResolvedTokenValuation, 'observedAt' | 'freshness'> {
  const expectedType: WorkspaceValuationType = type === 'market-cap' ? 'mcap' : 'fdv';
  if (valuation?.type !== expectedType || toFiniteValuation(valuation.usd) !== value) {
    return { observedAt: null, freshness: 'unknown' as const };
  }
  const observedAt = normalizeObservedAt(valuation.observedAt);
  return {
    observedAt,
    freshness: observedAt && (valuation.freshness === 'fresh' || valuation.freshness === 'stale')
      ? valuation.freshness
      : 'unknown',
  };
}

function buildResolvedValuation(
  input: TokenValuationInput,
  type: TokenValuationType,
  value: number,
): ResolvedTokenValuation {
  return {
    label: type === 'fdv' ? 'FDV' : 'MCAP',
    value,
    type,
    ...resolveValuationMetadata(input.valuation, type, value),
  };
}

export function resolveTokenValuation(input: TokenValuationInput): ResolvedTokenValuation {
  const mcap = toFiniteValuation(input.mcap);
  if (mcap != null) {
    return buildResolvedValuation(input, 'market-cap', mcap);
  }

  const fdv = toFiniteValuation(input.fdv);
  if (fdv != null) {
    return buildResolvedValuation(input, 'fdv', fdv);
  }

  return {
    label: input.valuationType === 'fdv' || input.valuation?.type === 'fdv' ? 'FDV' : 'MCAP',
    value: null,
    type: null,
    observedAt: null,
    freshness: 'unknown',
  };
}

export function resolveCoveredMetric(
  value: number | null | undefined,
  coverage: TokenMetricCoverage | null | undefined,
): ResolvedCoveredMetric {
  const normalizedCoverage: TokenMetricCoverage = coverage === 'complete' || coverage === 'partial'
    ? coverage
    : 'unavailable';
  const normalizedValue = toFiniteValuation(value);
  const available = normalizedCoverage !== 'unavailable' && normalizedValue != null;
  return {
    value: available ? normalizedValue : null,
    coverage: normalizedCoverage,
    available,
    isZero: available && normalizedValue === 0,
    isPartial: normalizedCoverage === 'partial',
  };
}

export function selectWorkspaceSnapshotValue<T>(
  applyIncoming: boolean,
  incoming: T | null | undefined,
  existing: T | null | undefined,
  base: T | null | undefined,
): T | null {
  return applyIncoming ? incoming ?? null : existing ?? base ?? incoming ?? null;
}

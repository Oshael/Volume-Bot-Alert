type MonitoredIdentity = {
  chain?: string | null;
  address: string;
};

type DashboardMarketSnapshot = {
  windowEnd?: string | null;
  lastActivityAt?: string | null;
  valuation?: { observedAt?: string | null } | null;
};

function identityKey(item: MonitoredIdentity) {
  const chain = String(item.chain || 'solana').toLowerCase();
  const address = String(item.address || '');
  return `${chain}:${chain === 'robinhood' ? address.toLowerCase() : address}`;
}

function timestampMs(value: string | null | undefined) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function mergeMonitoredFirstPage<T extends MonitoredIdentity>(
  existing: readonly T[],
  incoming: readonly T[],
) {
  const incomingKeys = new Set(incoming.map(identityKey));
  return [
    ...incoming,
    ...existing.filter((item) => !incomingKeys.has(identityKey(item))),
  ];
}

export function shouldRunFullMonitoredHydration(
  hasSnapshot: boolean,
  nextFullHydrationAt: number,
  now = Date.now(),
) {
  return !hasSnapshot || now >= nextFullHydrationAt;
}

export function shouldApplyDashboardValuation(
  liveObservedAt: string | null | undefined,
  incoming: DashboardMarketSnapshot | null | undefined,
) {
  if (!incoming) return false;
  const liveMs = timestampMs(liveObservedAt);
  if (liveMs == null) return true;
  const incomingMs = timestampMs(incoming.valuation?.observedAt)
    ?? timestampMs(incoming.lastActivityAt)
    ?? timestampMs(incoming.windowEnd);
  return incomingMs != null && incomingMs >= liveMs;
}

export function addUnincludedLiveActivity(
  snapshotValue: number | null | undefined,
  snapshotWindowEnd: string | null | undefined,
  liveBucketTs: string | null | undefined,
  liveValue: number | null | undefined,
) {
  if (snapshotValue == null || liveValue == null || liveValue < 0) return snapshotValue ?? null;
  const windowEndMs = timestampMs(snapshotWindowEnd);
  const bucketMs = timestampMs(liveBucketTs);
  return windowEndMs != null && bucketMs != null && bucketMs >= windowEndMs
    ? snapshotValue + liveValue
    : snapshotValue;
}

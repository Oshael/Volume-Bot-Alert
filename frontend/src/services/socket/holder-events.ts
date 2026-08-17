import type {
  RobinhoodHolderCountSeries,
  RobinhoodHolderDelta,
  RobinhoodHolderInterval,
} from '../api/robinhood-holders';
import { normalizeMarketSubscription } from './market-events';

interface RobinhoodHolderEventBase {
  chain: 'robinhood';
  address: string;
  source: 'ledger_live';
  observedAt: string;
  ledgerVersion: string;
  liveThroughBlock: string;
  liveThroughHash: string;
  sequence: string;
}

export interface RobinhoodHolderCountEvent extends RobinhoodHolderEventBase {
  type: 'holder:count';
  holderCount: number;
}

export interface RobinhoodHolderInvalidateEvent extends RobinhoodHolderEventBase {
  type: 'holder:invalidate';
  reason: 'reorg_resync';
}

export type RobinhoodHolderRealtimeEvent = RobinhoodHolderCountEvent | RobinhoodHolderInvalidateEvent;

function decimal(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return null;
  try { return BigInt(normalized).toString(); } catch (_) { return null; }
}

function timestamp(value: unknown) {
  const parsed = new Date(String(value || ''));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeHolderEventBase(source: Record<string, unknown>) {
  const identity = normalizeMarketSubscription(source.address, source.chain);
  const observedAt = timestamp(source.observedAt);
  const ledgerVersion = decimal(source.ledgerVersion);
  const liveThroughBlock = decimal(source.liveThroughBlock);
  const liveThroughHash = String(source.liveThroughHash || '').toLowerCase();
  const type = String(source.type || '');
  if (identity?.chain !== 'robinhood' || source.source !== 'ledger_live' || !observedAt
    || !ledgerVersion || !liveThroughBlock || !/^0x[0-9a-f]{64}$/.test(liveThroughHash)
    || !['holder:count', 'holder:invalidate'].includes(type)) return null;
  const sequence = `robinhood-holder:${identity.address}:${ledgerVersion.padStart(24, '0')}`;
  if (source.sequence !== sequence) return null;
  return {
    type,
    common: {
      chain: 'robinhood' as const, address: identity.address, source: 'ledger_live' as const,
      observedAt, ledgerVersion, liveThroughBlock, liveThroughHash, sequence,
    },
  };
}

export function normalizeRobinhoodHolderEvent(value: unknown): RobinhoodHolderRealtimeEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const normalized = normalizeHolderEventBase(source);
  if (!normalized) return null;
  if (normalized.type === 'holder:invalidate') {
    return source.reason === 'reorg_resync'
      ? { type: 'holder:invalidate', ...normalized.common, reason: 'reorg_resync' }
      : null;
  }
  const normalizedHolderCount = decimal(source.holderCount);
  if (normalizedHolderCount == null) return null;
  const holderCount = Number(normalizedHolderCount);
  return Number.isSafeInteger(holderCount) && holderCount >= 0
    ? { type: 'holder:count', ...normalized.common, holderCount }
    : null;
}

export function createRobinhoodHolderEventOrderGate(maxEntries = 512) {
  const limit = Math.max(1, Math.trunc(maxEntries));
  const versions = new Map<string, bigint>();
  const accept = (event: RobinhoodHolderRealtimeEvent) => {
    const version = BigInt(event.ledgerVersion);
    const current = versions.get(event.address);
    if (current != null && version <= current) return false;
    versions.set(event.address, version);
    while (versions.size > limit) {
      const oldest = versions.keys().next().value;
      if (typeof oldest !== 'string') break;
      versions.delete(oldest);
    }
    return true;
  };
  return Object.freeze({
    accept,
    clear: () => versions.clear(),
    clearAddress: (address: string) => versions.delete(address.toLowerCase()),
  });
}

function laterTimestamp(left: string, right: string) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function patchRobinhoodHolderSeries(
  history: RobinhoodHolderCountSeries,
  event: RobinhoodHolderCountEvent,
): RobinhoodHolderCountSeries | null {
  const observedMs = Date.parse(event.observedAt);
  const eventHourMs = Math.floor(observedMs / 3_600_000) * 3_600_000;
  const current = history.current;
  const latestHourly = history.series['1h'].at(-1);
  if (!current || !latestHourly || Date.parse(latestHourly.start) !== eventHourMs) return null;
  const countChange = event.holderCount - current.holderCount;
  const intervals: RobinhoodHolderInterval[] = ['1h', '4h', '12h', '24h'];
  const series = { ...history.series };
  for (const interval of intervals) {
    const bars = history.series[interval];
    const latest = bars.at(-1);
    if (!latest || latest.status !== 'open'
      || observedMs < Date.parse(latest.start) || observedMs >= Date.parse(latest.end)) return null;
    series[interval] = [...bars.slice(0, -1), {
      ...latest,
      holderCount: event.holderCount,
      observedAt: event.observedAt,
      delta: latest.comparison === 'complete' && latest.delta != null
        ? latest.delta + countChange : null,
    }];
  }
  const deltas = { ...history.deltas };
  for (const key of Object.keys(deltas) as Array<keyof typeof deltas>) {
    const previous: RobinhoodHolderDelta = deltas[key];
    deltas[key] = {
      ...previous,
      delta: previous.comparison === 'complete' && previous.delta != null
        ? previous.delta + countChange : null,
      through: event.observedAt,
    };
  }
  return {
    ...history,
    asOf: laterTimestamp(history.asOf, event.observedAt),
    range: { ...history.range, through: laterTimestamp(history.range.through, event.observedAt) },
    current: { holderCount: event.holderCount, source: 'ledger_live', observedAt: event.observedAt },
    deltas,
    series,
  };
}

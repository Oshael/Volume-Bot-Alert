import type { AlertEntry } from './app-state';
import type { ChainFilterPreferences, TokenChain } from '../utils/token-chain';

export function getVisibleAlertFeedChains(filters: ChainFilterPreferences): TokenChain[] {
  return [...filters.enabledChains];
}

export function getBackendAlertEventId(alert: AlertEntry): number | null {
  const explicitId = Number(alert.backendEventId);
  if (Number.isInteger(explicitId) && explicitId > 0) return explicitId;
  if (!String(alert.id || '').startsWith('backend')) return null;
  const legacyId = Number(String(alert.id).slice(String(alert.id).lastIndexOf(':') + 1));
  return Number.isInteger(legacyId) && legacyId > 0 ? legacyId : null;
}

export function partitionVisibleAlertEntries(
  alerts: AlertEntry[],
  filters: ChainFilterPreferences,
) {
  const chains = getVisibleAlertFeedChains(filters);
  const visibleChains = new Set(chains);
  return {
    chains,
    clearedAlerts: alerts.filter((item) => visibleChains.has(item.chain)),
    remainingAlerts: alerts.filter((item) => !visibleChains.has(item.chain)),
  };
}

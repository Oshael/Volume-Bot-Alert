import type {
  CustomAlertCapabilityEntry,
  CustomAlertMetric,
  CustomAlertWindow,
} from '../../state/app-state';
import { normalizeTokenChain, type TokenChain } from '../../utils/token-chain';

const CUSTOM_ALERT_METRICS = new Set<CustomAlertMetric>(['price', 'mcap', 'fdv']);
const CUSTOM_ALERT_WINDOWS = new Set<CustomAlertWindow>(['spot']);

export function normalizeCustomAlertMetric(value: unknown): string {
  const metric = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (metric === 'price' || metric === 'price usd') return 'price';
  if (metric === 'mcap' || metric === 'market cap' || metric === 'market cap usd') return 'mcap';
  if (metric === 'fdv' || metric === 'fdv usd') return 'fdv';
  return metric;
}

export function normalizeCustomAlertCapabilities(
  value: unknown,
): Partial<Record<TokenChain, CustomAlertCapabilityEntry>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Partial<Record<TokenChain, CustomAlertCapabilityEntry>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Partial<CustomAlertCapabilityEntry>;
    const chain = normalizeTokenChain(entry.chain ?? key);
    if (!chain) continue;
    const metrics = Array.isArray(entry.metrics)
      ? entry.metrics.filter((metric): metric is CustomAlertMetric => CUSTOM_ALERT_METRICS.has(metric))
      : [];
    const windows = Array.isArray(entry.windows)
      ? entry.windows.filter((window): window is CustomAlertWindow => CUSTOM_ALERT_WINDOWS.has(window))
      : [];
    normalized[chain] = {
      chain,
      supported: entry.supported === true,
      ready: entry.ready === true,
      metrics,
      windows,
      reason: typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim() : null,
    };
  }
  return normalized;
}

export function requireCustomAlertCapability(
  capabilities: Partial<Record<TokenChain, CustomAlertCapabilityEntry>>,
  input: { chain: unknown; metric: unknown; window: unknown },
) {
  const chain = normalizeTokenChain(input.chain);
  const metric = normalizeCustomAlertMetric(input.metric);
  const window = String(input.window || '').trim().toLowerCase();
  const capability = chain ? capabilities[chain] : null;
  if (!chain || !capability?.supported) {
    throw new Error('Custom alerts are unsupported for this network.');
  }
  if (!capability.metrics.includes(metric as CustomAlertMetric)) {
    throw new Error('This custom-alert metric is unsupported for the selected network.');
  }
  if (!capability.windows.includes(window as CustomAlertWindow)) {
    throw new Error('This custom-alert window is unsupported for the selected network.');
  }
  if (!capability.ready) {
    const reason = capability.reason ? ` (${capability.reason})` : '';
    throw new Error(`Custom alerts are temporarily unavailable for this network${reason}.`);
  }
  return {
    chain,
    metric: metric as CustomAlertMetric,
    window: window as CustomAlertWindow,
    capability,
  };
}

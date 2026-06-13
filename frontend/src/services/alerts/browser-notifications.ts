import type { AlertEntry } from '../../state/app-state';

const STORAGE_KEY_PREFIX = 'trendscope_browser_notifications_v1';
const DEFAULT_ICON_URL = '/favicon.png';

export type BrowserNotificationStatus = 'unsupported' | 'default' | 'granted' | 'denied';

export type BrowserNotificationSettings = { enabled: boolean; notifyWhenVisible: boolean };

export type BrowserNotificationOptions = { enabled?: boolean; notifyWhenVisible?: boolean; documentHidden?: boolean; configs?: Record<string, string | number>; fallbackIconUrl?: string };

const DEFAULT_SETTINGS: BrowserNotificationSettings = {
  enabled: false,
  notifyWhenVisible: false,
};

const ALERT_KIND_CONFIG_KEY: Partial<Record<AlertEntry['kind'], string>> = {
  'monitored-vol': 'alert-vol-enabled',
  'monitored-mcap': 'alert-mcap-enabled',
  hvnc: 'alert-hvnc-enabled',
  'meteora-surge': 'alert-meteora-surge-enabled',
  'high-cap-dump-5m': 'alert-high-cap-dump-enabled',
  'gmgn-claim-signal': 'alert-gmgn-claim-signal-enabled',
};

type AlertVolumeKey = 'volume1m' | 'volume5m' | 'volume1h' | 'volume6h' | 'volume24h';

const ALERT_VOLUME_KEYS: Record<Exclude<AlertEntry['kind'], 'old-surge'>, AlertVolumeKey[]> = {
  'monitored-vol': ['volume5m', 'volume1m', 'volume1h', 'volume6h', 'volume24h'],
  'monitored-mcap': ['volume5m', 'volume1m', 'volume1h', 'volume6h', 'volume24h'],
  hvnc: ['volume24h', 'volume6h', 'volume1h', 'volume5m', 'volume1m'],
  'meteora-surge': ['volume5m', 'volume1m', 'volume1h', 'volume6h', 'volume24h'],
  'high-cap-dump-5m': ['volume5m', 'volume1m', 'volume1h'],
  'gmgn-claim-signal': ['volume5m', 'volume1m', 'volume1h'],
};

const notifiedAlertIds = new Set<string>();

function buildScopedKey(scope: string) {
  return `${STORAGE_KEY_PREFIX}:${scope || 'anonymous'}`;
}

function normalizeSettings(settings: Partial<BrowserNotificationSettings> | null | undefined): BrowserNotificationSettings {
  return {
    enabled: settings?.enabled === true,
    notifyWhenVisible: settings?.notifyWhenVisible === true,
  };
}

function getNotificationConstructor() {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }

  return window.Notification;
}

function hasSecureNotificationContext() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.isSecureContext !== false;
}

function isConfigEnabled(configs: Record<string, string | number> | undefined, key: string, fallback = true) {
  return String(configs?.[key] ?? (fallback ? 'on' : 'off')) !== 'off';
}

function resolveOldSurgeConfigKey(alert: Pick<AlertEntry, 'ruleKey' | 'surgeWindow'>) {
  switch (alert.ruleKey) {
    case 'recent-surge-1h':
      return 'alert-recent-surge-1h-enabled';
    case 'recent-surge-6h':
      return 'alert-recent-surge-6h-enabled';
    case 'old-week-surge-1h':
      return 'alert-old-week-surge-1h-enabled';
    case 'old-week-surge-6h':
      return 'alert-old-week-surge-6h-enabled';
    default:
      return alert.surgeWindow === '6H' ? 'alert-old-surge-6h-enabled' : 'alert-old-surge-1h-enabled';
  }
}

function isAlertEnabledByConfig(alert: AlertEntry, configs?: Record<string, string | number>) {
  const configKey = alert.kind === 'old-surge'
    ? resolveOldSurgeConfigKey(alert)
    : ALERT_KIND_CONFIG_KEY[alert.kind];

  return configKey ? isConfigEnabled(configs, configKey) : true;
}

function formatMoney(value?: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function formatPercent(value?: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatMoneyTransition(label: string, previous?: number | null, current?: number | null) {
  const currentText = formatMoney(current);
  if (!currentText) {
    return null;
  }

  const previousText = formatMoney(previous);
  return previousText ? `${label} ${previousText}->${currentText}` : `${label} ${currentText}`;
}

function formatAddressFragment(address: string) {
  const normalized = String(address || '').trim();
  if (normalized.length <= 10) {
    return normalized || null;
  }
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function selectFirstNumber(alert: AlertEntry, keys: AlertVolumeKey[]) {
  for (const key of keys) {
    const value = alert[key];
    if (value != null && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function getAlertVolume(alert: AlertEntry) {
  if (alert.kind === 'old-surge') {
    return selectFirstNumber(alert, alert.surgeWindow === '6H'
      ? ['volume6h', 'volume1h', 'volume24h']
      : ['volume1h', 'volume6h', 'volume24h']);
  }
  return selectFirstNumber(alert, ALERT_VOLUME_KEYS[alert.kind]);
}

function getNotificationMcapLine(alert: AlertEntry) {
  return formatMoneyTransition(
    'MCAP',
    alert.kind === 'high-cap-dump-5m' ? alert.baselineMcap ?? alert.prevMcap : alert.prevMcap,
    alert.mcap,
  );
}

function getNotificationVolumeLine(alert: AlertEntry) {
  if (alert.ruleKey === 'gmgn-vol-1m') {
    return formatMoneyTransition('VOL 1M', alert.prevVolume1m, alert.volume1m);
  }

  if (alert.kind === 'old-surge') {
    const label = alert.surgeWindow === '6H' ? 'VOL 6H' : 'VOL 1H';
    const currentVolume = alert.surgeWindow === '6H' ? alert.volume6h : alert.volume1h;
    return formatMoneyTransition(label, null, currentVolume ?? getAlertVolume(alert));
  }

  const currentVolume = alert.volume5m ?? getAlertVolume(alert);
  return formatMoneyTransition('VOL 5M', alert.prevVolume5m, currentVolume);
}

function getOldSurgePrefix(alert: AlertEntry) {
  const bucket = alert.ageBucket === 'recent' ? 'RECENT' : 'OLD';
  return `${bucket} ${alert.surgeWindow === '6H' ? '6H' : '1H'} surge`;
}

function getNotificationTitle(alert: AlertEntry) {
  const symbol = String(alert.symbol || alert.address.slice(0, 8) || 'TOKEN').toUpperCase();

  switch (alert.kind) {
    case 'monitored-vol':
      return `VOL alert: ${symbol}`;
    case 'monitored-mcap':
      return `MCAP alert: ${symbol}`;
    case 'hvnc':
      return `HVNC: ${symbol}`;
    case 'old-surge':
      return `${getOldSurgePrefix(alert)}: ${symbol}`;
    case 'meteora-surge':
      return `METEORA 1H: ${symbol}`;
    case 'high-cap-dump-5m':
      return `HIGH CAP DUMP: ${symbol}`;
    case 'gmgn-claim-signal':
      return `${alert.signalType === 17 ? 'BAGS' : 'PUMP'} CLAIM #${alert.claimSequence || '?'}: ${symbol}`;
    default:
      return `Alert: ${symbol}`;
  }
}

function sanitizeHttpUrl(value?: string | null) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    const protocol = url.protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function buildNotificationBody(alert: AlertEntry) {
  if (alert.kind === 'gmgn-claim-signal') {
    return [
      formatMoney(alert.totalFeeUsd),
      alert.claimedAt ? `claimed ${new Date(alert.claimedAt).toLocaleTimeString()}` : null,
      formatAddressFragment(alert.address),
    ].filter(Boolean).join(' · ');
  }

  const parts = [
    formatPercent(alert.pct),
    getNotificationMcapLine(alert),
    getNotificationVolumeLine(alert),
    formatAddressFragment(alert.address),
  ];

  return parts.filter(Boolean).join(' · ');
}

export function loadBrowserNotificationSettings(scope: string): BrowserNotificationSettings {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const raw = window.localStorage.getItem(buildScopedKey(scope));
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }

    return normalizeSettings(JSON.parse(raw) as Partial<BrowserNotificationSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveBrowserNotificationSettings(scope: string, settings: BrowserNotificationSettings) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(buildScopedKey(scope), JSON.stringify(normalizeSettings(settings)));
}

export function getBrowserNotificationStatus(): BrowserNotificationStatus {
  const NotificationCtor = getNotificationConstructor();
  if (!NotificationCtor || !hasSecureNotificationContext()) {
    return 'unsupported';
  }

  return NotificationCtor.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationStatus> {
  const NotificationCtor = getNotificationConstructor();
  if (!NotificationCtor || !hasSecureNotificationContext()) {
    return 'unsupported';
  }

  if (NotificationCtor.permission !== 'default') {
    return NotificationCtor.permission;
  }

  const permission = await NotificationCtor.requestPermission();
  return permission === 'granted' || permission === 'denied' ? permission : 'default';
}

export function formatBrowserNotificationContent(
  alert: AlertEntry,
  options?: Pick<BrowserNotificationOptions, 'fallbackIconUrl'>,
) {
  return {
    title: getNotificationTitle(alert),
    body: buildNotificationBody(alert),
    tag: `alert:${alert.id}`,
    icon: sanitizeHttpUrl(alert.imageUrl) || options?.fallbackIconUrl || DEFAULT_ICON_URL,
    data: {
      address: alert.address,
      alertId: alert.id,
      ruleKey: alert.ruleKey ?? null,
    },
  };
}

export function maybeNotifyAlert(alert: AlertEntry, options: BrowserNotificationOptions = {}) {
  if (options.enabled !== true || getBrowserNotificationStatus() !== 'granted') {
    return false;
  }
  if (notifiedAlertIds.has(alert.id) || !isAlertEnabledByConfig(alert, options.configs)) {
    return false;
  }

  const isHidden = options.documentHidden ?? (typeof document !== 'undefined' ? document.hidden : true);
  if (!isHidden && options.notifyWhenVisible !== true) {
    return false;
  }

  const NotificationCtor = getNotificationConstructor();
  if (!NotificationCtor) {
    return false;
  }

  const content = formatBrowserNotificationContent(alert, { fallbackIconUrl: options.fallbackIconUrl });
  const notification = new NotificationCtor(content.title, {
    body: content.body,
    tag: content.tag,
    icon: content.icon,
    data: content.data,
  });

  notification.onclick = () => {
    if (typeof window !== 'undefined') {
      window.focus();
    }
  };
  notifiedAlertIds.add(alert.id);
  return true;
}

export function resetBrowserNotificationSession() {
  notifiedAlertIds.clear();
}

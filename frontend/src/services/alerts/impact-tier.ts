import type { AlertEntry } from '../../state/app-state';

const RECENT_TOKEN_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const RECENT_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ALERT_ARRIVAL_WINDOW_MS = 1600;

export type AlertImpactTier = 'normal' | 'critical' | 'mega';

export function isHighCapDumpAlert(alert: AlertEntry) {
  return alert.kind === 'high-cap-dump-5m';
}

export function isHvncAlert(alert: AlertEntry) {
  return alert.isHvnc === true || alert.kind === 'hvnc' || alert.kind === 'pumpfun-hvnc';
}

function getOldSurgeToneClass(alert: AlertEntry, now: number) {
  const tokenAgeMs = alert.tokenCreatedAt ? now - alert.tokenCreatedAt : Number.POSITIVE_INFINITY;
  return tokenAgeMs >= RECENT_TOKEN_MIN_AGE_MS && tokenAgeMs <= RECENT_TOKEN_MAX_AGE_MS
    ? 'recent-surge'
    : 'old-surge';
}

export function getAlertImpactTier(alert: AlertEntry): AlertImpactTier {
  if (isHighCapDumpAlert(alert) || isHvncAlert(alert)) {
    return 'mega';
  }

  const pct = Math.abs(Number(alert.pct) || 0);
  if (pct >= 200) return 'mega';
  if (pct >= 100) return 'critical';
  return 'normal';
}

export function getAlertToneClass(alert: AlertEntry, now = Date.now()) {
  if (isHighCapDumpAlert(alert)) {
    return 'dump-alert';
  }

  if (alert.isOldSurge) {
    return getOldSurgeToneClass(alert, now);
  }

  if (isHvncAlert(alert)) {
    return 'mega';
  }

  if (alert.kind === 'pumpfun-vol') {
    return 'pump-alert';
  }

  if (alert.kind === 'meteora-surge') {
    return 'meteora-surge';
  }

  return getAlertImpactTier(alert);
}

export function isAlertInArrivalWindow(alert: AlertEntry, now = Date.now()) {
  const ageMs = now - Number(alert.createdAt || 0);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ALERT_ARRIVAL_WINDOW_MS;
}

function getAlertExclusiveClass(alert: AlertEntry) {
  if (isHighCapDumpAlert(alert)) {
    return 'impact-special-dump';
  }

  if (isHvncAlert(alert)) {
    return 'impact-special-hvnc';
  }

  if (alert.kind === 'meteora-surge') {
    return 'impact-special-meteora';
  }

  if (alert.isOldSurge) {
    return 'impact-special-surge';
  }

  return '';
}

function getAlertArrivalClass(alert: AlertEntry, now: number) {
  void alert;
  void now;
  return '';

  /*
  if (!isAlertInArrivalWindow(alert, now)) {
    return '';
  }

  if (isHighCapDumpAlert(alert)) {
    return 'impact-enter impact-enter-dump';
  }

  if (isHvncAlert(alert)) {
    return 'impact-enter impact-enter-hvnc';
  }

  const tier = getAlertImpactTier(alert);
  if (tier === 'mega') {
    return 'impact-enter impact-enter-mega';
  }

  if (tier === 'critical') {
    return 'impact-enter impact-enter-critical';
  }

  return 'impact-enter impact-enter-normal';
  */
}

export function getAlertVisualClasses(alert: AlertEntry, now = Date.now(), includeArrival = true) {
  return [
    getAlertToneClass(alert, now),
    getAlertExclusiveClass(alert),
    includeArrival ? getAlertArrivalClass(alert, now) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

import type { AlertEntry } from '../../state/app-state';

const RECENT_TOKEN_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const RECENT_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ALERT_ARRIVAL_WINDOW_MS = 1600;

export type AlertImpactTier = 'normal' | 'critical' | 'mega';

export function isHvncAlert(alert: AlertEntry) {
  return alert.isHvnc === true || alert.kind === 'hvnc';
}

function getOldSurgeToneClass(alert: AlertEntry, now: number) {
  if (alert.ageBucket === 'recent') {
    return 'recent-surge';
  }
  if (alert.ageBucket === 'old-week') {
    return 'old-surge';
  }

  const tokenAgeMs = alert.tokenCreatedAt ? now - alert.tokenCreatedAt : Number.POSITIVE_INFINITY;
  return tokenAgeMs >= RECENT_TOKEN_MIN_AGE_MS && tokenAgeMs <= RECENT_TOKEN_MAX_AGE_MS
    ? 'recent-surge'
    : 'old-surge';
}

export function getAlertImpactTier(alert: AlertEntry): AlertImpactTier {
  if (alert.kind === 'admin-token-review') {
    return 'critical';
  }

  if (isHvncAlert(alert)) {
    return 'mega';
  }

  const pct = Math.abs(Number(alert.pct) || 0);
  if (pct >= 200) return 'mega';
  if (pct >= 100) return 'critical';
  return 'normal';
}

export function getAlertToneClass(alert: AlertEntry, now = Date.now()) {
  if (alert.kind === 'admin-token-review') {
    return 'admin-token-review';
  }

  if (alert.isOldSurge) {
    return getOldSurgeToneClass(alert, now);
  }

  if (isHvncAlert(alert)) {
    return 'mega';
  }

  if (alert.kind === 'meteora-surge') {
    return 'meteora-surge';
  }

  if (alert.kind === 'gmgn-claim-signal' && alert.signalType === 18) {
    return 'gmgn-claim-pump';
  }

  if (alert.kind === 'gmgn-claim-signal' && alert.signalType === 17) {
    return 'gmgn-claim-bags';
  }

  return getAlertImpactTier(alert);
}

export function isAlertInArrivalWindow(alert: AlertEntry, now = Date.now()) {
  const ageMs = now - Number(alert.createdAt || 0);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ALERT_ARRIVAL_WINDOW_MS;
}

function getAlertExclusiveClass(alert: AlertEntry) {
  if (alert.kind === 'admin-token-review') {
    return 'impact-special-admin-review';
  }

  if (isHvncAlert(alert)) {
    return 'impact-special-hvnc';
  }

  if (alert.kind === 'meteora-surge') {
    return 'impact-special-meteora';
  }

  if (alert.kind === 'gmgn-claim-signal' && alert.signalType === 18) {
    return 'impact-special-gmgn-pump';
  }

  if (alert.kind === 'gmgn-claim-signal' && alert.signalType === 17) {
    return 'impact-special-gmgn-bags';
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

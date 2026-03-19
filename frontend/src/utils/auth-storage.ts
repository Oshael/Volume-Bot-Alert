const AUTH_TOKEN_KEY = 'volume_alert_auth_token';

export function clearLegacyAuthToken() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  window.localStorage.removeItem(AUTH_TOKEN_KEY);
}

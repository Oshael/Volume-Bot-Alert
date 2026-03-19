export const LOGIN_EMAIL_MAX_LENGTH = 254;
export const LOGIN_PASSWORD_MAX_LENGTH = 128;

const LOGIN_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sanitizeLoginEmailValue(value: string) {
  return value.replace(/\s+/g, '').slice(0, LOGIN_EMAIL_MAX_LENGTH);
}

export function trimLoginEmailValue(value: string) {
  return sanitizeLoginEmailValue(value.trim());
}

export function isValidLoginEmail(value: string) {
  return LOGIN_EMAIL_PATTERN.test(value);
}

export function clampLoginPasswordValue(value: string) {
  return value.slice(0, LOGIN_PASSWORD_MAX_LENGTH);
}

export function adjustCaretAfterEmailSanitize(value: string, caret: number | null) {
  const safeCaret = caret ?? value.length;
  const removedBeforeCaret = (value.slice(0, safeCaret).match(/\s/g) || []).length;
  return Math.max(0, safeCaret - removedBeforeCaret);
}

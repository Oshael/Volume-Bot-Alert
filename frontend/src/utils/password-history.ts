const PASSWORD_HISTORY_KEY = 'trendscope_password_history';

type StoredPasswordHistoryEntry = {
  email: string;
  previousPasswordHash: string;
  changedAt: string;
};

function getStorage() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  return window.localStorage;
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
}

async function hashPasswordValue(password: string) {
  if (!globalThis.crypto?.subtle) {
    return null;
  }
  const encoded = new TextEncoder().encode(password);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return toBase64(new Uint8Array(digest));
}

function readPasswordHistory(): StoredPasswordHistoryEntry[] {
  const storage = getStorage();
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(PASSWORD_HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePasswordHistory(entries: StoredPasswordHistoryEntry[]) {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  storage.setItem(PASSWORD_HISTORY_KEY, JSON.stringify(entries.slice(0, 12)));
}

export async function rememberPreviousPassword(email: string, previousPassword: string, changedAt = new Date()) {
  const normalizedEmail = String(email || '').trim();
  const normalizedPassword = String(previousPassword || '');
  if (!normalizedEmail || !normalizedPassword) {
    return;
  }

  const hashed = await hashPasswordValue(normalizedPassword);
  if (!hashed) {
    return;
  }

  const entries = readPasswordHistory().filter((entry) => entry.email !== normalizedEmail);
  entries.unshift({
    email: normalizedEmail,
    previousPasswordHash: hashed,
    changedAt: changedAt.toISOString(),
  });
  writePasswordHistory(entries);
}

export async function findPreviousPasswordMatch(email: string, password: string) {
  const normalizedEmail = String(email || '').trim();
  const normalizedPassword = String(password || '');
  if (!normalizedEmail || !normalizedPassword) {
    return null;
  }

  const hashed = await hashPasswordValue(normalizedPassword);
  if (!hashed) {
    return null;
  }

  const match = readPasswordHistory().find((entry) => entry.email === normalizedEmail && entry.previousPasswordHash === hashed);
  return match || null;
}

export function formatPasswordChangedDate(isoString: string) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(date);
}

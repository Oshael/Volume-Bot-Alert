const DEFAULT_LANGUAGE_CODE = 'en';
const SUPPORTED_LOCALES = Object.freeze(['en', 'pt']);

function normalizeTelegramLanguageCode(value) {
  const raw = String(value || '').trim().replaceAll('_', '-');
  if (!raw || raw.length > 35
    || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(raw)) {
    return null;
  }
  try {
    return Intl.getCanonicalLocales(raw)[0] || null;
  } catch (_) {
    return null;
  }
}

function resolveTelegramLocale(value) {
  const languageCode = normalizeTelegramLanguageCode(value);
  return languageCode?.split('-')[0].toLowerCase() === 'pt' ? 'pt' : 'en';
}

module.exports = {
  DEFAULT_LANGUAGE_CODE,
  SUPPORTED_LOCALES,
  normalizeTelegramLanguageCode,
  resolveTelegramLocale,
};

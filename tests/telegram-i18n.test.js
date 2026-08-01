const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CATALOGS,
  createTelegramTranslator,
} = require('../src/services/telegram-i18n');

describe('Telegram i18n', () => {
  it('keeps Portuguese and English catalogs contract-compatible', () => {
    assert.deepEqual(Object.keys(CATALOGS.pt).sort(), Object.keys(CATALOGS.en).sort());
  });

  it('selects Portuguese from Telegram tags and interpolates values', () => {
    const translator = createTelegramTranslator('pt-BR');
    assert.equal(translator.locale, 'pt');
    assert.equal(
      translator.t('button.change', { field: 'Threshold' }),
      '✏️ Alterar Threshold',
    );
  });

  it('defaults unsupported and missing languages to English', () => {
    assert.equal(createTelegramTranslator('es').t('button.alerts'), '🔔 Alerts');
    assert.equal(createTelegramTranslator(null).t('state.disabled'), 'Disabled ❌');
  });

  it('fails closed for missing keys and interpolation values', () => {
    const { t } = createTelegramTranslator('en');
    assert.throws(() => t('missing.key'), /Missing Telegram translation/);
    assert.throws(() => t('button.change'), /Missing Telegram translation value/);
  });
});

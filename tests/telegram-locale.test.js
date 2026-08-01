const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  DEFAULT_LANGUAGE_CODE,
  normalizeTelegramLanguageCode,
  resolveTelegramLocale,
} = require('../src/utils/telegram-locale');

describe('Telegram locale', () => {
  it('canonicalizes valid Telegram IETF language tags', () => {
    assert.equal(normalizeTelegramLanguageCode('pt_br'), 'pt-BR');
    assert.equal(normalizeTelegramLanguageCode('EN-us'), 'en-US');
    assert.equal(normalizeTelegramLanguageCode('zh-Hans'), 'zh-Hans');
  });

  it('rejects malformed values without guessing', () => {
    assert.equal(normalizeTelegramLanguageCode(''), null);
    assert.equal(normalizeTelegramLanguageCode('portuguese'), null);
    assert.equal(normalizeTelegramLanguageCode('pt<script>'), null);
  });

  it('supports Portuguese and falls back to English', () => {
    assert.equal(DEFAULT_LANGUAGE_CODE, 'en');
    assert.equal(resolveTelegramLocale('pt-BR'), 'pt');
    assert.equal(resolveTelegramLocale('pt-PT'), 'pt');
    assert.equal(resolveTelegramLocale('es'), 'en');
    assert.equal(resolveTelegramLocale(null), 'en');
  });
});

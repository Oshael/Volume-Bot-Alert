const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, '..', 'frontend/src/ui/sections/telegram-settings.ts');
const source = fs.readFileSync(file, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const moduleRecord = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleRecord,
  exports: moduleRecord.exports,
  require: (specifier) => specifier === './html-safety'
    ? { escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;') }
    : {},
  URL,
}, { filename: file });

const { renderTelegramSettings } = moduleRecord.exports;
const state = (telegram) => ({ telegram: {
  loaded: true, loading: false, mutating: false, available: true,
  status: 'disconnected', identity: null, botUrl: 'https://t.me/trend_scope_bot',
  linkedAt: null, lastDeliveryAt: null, lastError: null,
  pendingDeepLink: null, pendingDeepLinkExpiresAt: null, error: null,
  ...telegram,
} });

describe('frontend Telegram settings', () => {
  it('keeps Telegram configuration explicitly independent from dashboard alerts', () => {
    const html = renderTelegramSettings(state({}));
    assert.match(html, /stay independent from dashboard alerts/);
    assert.match(html, /Connect Telegram/);
  });

  it('renders linked identity and operational delivery status', () => {
    const html = renderTelegramSettings(state({
      status: 'paused',
      identity: { username: 'alice', firstName: 'Alice' },
      lastDeliveryAt: '2026-07-29T12:00:00.000Z',
      lastError: { code: 'rate_limited', at: null },
    }));
    assert.match(html, /@alice/);
    assert.match(html, /rate_limited/);
    assert.match(html, /Disconnect/);
  });

  it('renders only safe Telegram links', () => {
    const unsafe = renderTelegramSettings(state({
      pendingDeepLink: 'javascript:alert(1)',
      botUrl: 'https://example.com/not-telegram',
    }));
    const safe = renderTelegramSettings(state({
      pendingDeepLink: 'https://t.me/trend_scope_bot?start=opaque',
    }));
    assert.doesNotMatch(unsafe, /javascript:|example\.com/);
    assert.match(safe, /target="_blank" rel="noopener noreferrer"/);
  });
});

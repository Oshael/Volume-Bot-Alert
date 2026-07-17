const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SERVICE_PATH = path.join(
  __dirname,
  '..',
  'frontend/src/state/alert-feed-actions.ts',
);

function loadModule() {
  const source = fs.readFileSync(SERVICE_PATH, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    require,
    Set,
  }, { filename: SERVICE_PATH });
  return module.exports;
}

const { getBackendAlertEventId, partitionVisibleAlertEntries } = loadModule();

function alert(id, chain) {
  return { id, chain };
}

describe('alert feed chain actions', () => {
  it('reads current and legacy backend event ids without treating local alerts as backend events', () => {
    assert.equal(getBackendAlertEventId({ id: 'backend:hvnc:101', backendEventId: 102 }), 102);
    assert.equal(getBackendAlertEventId({ id: 'backend:custom-alert:91' }), 91);
    assert.equal(getBackendAlertEventId({ id: 'custom-preview:91' }), null);
  });

  it('clears only the alert-feed chains that are also enabled globally', () => {
    const result = partitionVisibleAlertEntries([
      alert('sol', 'solana'),
      alert('rh', 'robinhood'),
    ], {
      enabledChains: ['solana'],
      alertFeedChains: ['solana', 'robinhood'],
      radarChains: ['solana'],
      browserNotificationChains: ['solana'],
    });

    assert.deepEqual([...result.chains], ['solana']);
    assert.deepEqual(result.clearedAlerts.map((item) => item.id), ['sol']);
    assert.deepEqual(result.remainingAlerts.map((item) => item.id), ['rh']);
  });

  it('clears both networks when both are visible in the alert feed', () => {
    const result = partitionVisibleAlertEntries([
      alert('sol', 'solana'),
      alert('rh', 'robinhood'),
    ], {
      enabledChains: ['solana', 'robinhood'],
      alertFeedChains: ['solana', 'robinhood'],
      radarChains: ['solana', 'robinhood'],
      browserNotificationChains: ['solana', 'robinhood'],
    });

    assert.deepEqual(result.clearedAlerts.map((item) => item.id), ['sol', 'rh']);
    assert.deepEqual(result.remainingAlerts, []);
  });
});

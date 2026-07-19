const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SERVICE_PATH = path.join(__dirname, '..', 'frontend/src/services/alerts/browser-notifications.ts');

function createLocalStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
  };
}

function createNotificationMock(permission = 'granted') {
  class MockNotification {
    static permission = permission;
    static instances = [];

    static async requestPermission() {
      return MockNotification.permission;
    }

    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.onclick = null;
      MockNotification.instances.push(this);
    }
  }

  return MockNotification;
}

function loadTypeScriptModule(filePath, sandboxOverrides = {}, cache = new Map()) {
  const resolvedPath = path.resolve(filePath);
  if (cache.has(resolvedPath)) {
    return cache.get(resolvedPath).exports;
  }

  const source = fs.readFileSync(resolvedPath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  cache.set(resolvedPath, module);
  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      const dependencyPath = path.resolve(path.dirname(resolvedPath), specifier);
      const typeScriptPath = dependencyPath.endsWith('.ts') ? dependencyPath : `${dependencyPath}.ts`;
      if (fs.existsSync(typeScriptPath)) {
        return loadTypeScriptModule(typeScriptPath, sandboxOverrides, cache);
      }
    }
    return require(specifier);
  };
  const sandbox = {
    module,
    exports: module.exports,
    require: localRequire,
    URL,
    ...sandboxOverrides,
  };

  vm.runInNewContext(compiled.outputText, sandbox, { filename: resolvedPath });
  return module.exports;
}

function loadBrowserNotificationModule(options = {}) {
  return loadTypeScriptModule(SERVICE_PATH, {
    window: options.window,
    document: options.document,
  });
}

function buildAlert(overrides = {}) {
  return {
    id: 'alert-1',
    chain: 'solana',
    kind: 'monitored-vol',
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'sol',
    createdAt: Date.now(),
    pct: 123.456,
    label: 'VOL',
    prevVolume5m: 2_000,
    volume5m: 45_000,
    prevMcap: 250_000,
    mcap: 1_250_000,
    imageUrl: 'https://example.com/token.png',
    ...overrides,
  };
}

describe('browser notification service', () => {
  it('loads defaults and persists scoped local settings', () => {
    const localStorage = createLocalStorage({
      'trendscope_browser_notifications_v1:broken': '{',
    });
    const service = loadBrowserNotificationModule({
      window: { isSecureContext: true, localStorage, Notification: createNotificationMock() },
    });

    assert.equal(JSON.stringify(service.loadBrowserNotificationSettings('missing')), '{"enabled":false,"notifyWhenVisible":false}');
    assert.equal(JSON.stringify(service.loadBrowserNotificationSettings('broken')), '{"enabled":false,"notifyWhenVisible":false}');

    service.saveBrowserNotificationSettings('user@example.com', {
      enabled: true,
      notifyWhenVisible: true,
    });

    assert.equal(JSON.stringify(service.loadBrowserNotificationSettings('user@example.com')), '{"enabled":true,"notifyWhenVisible":true}');
  });

  it('formats notification content with safe icon and alert metadata', () => {
    const service = loadBrowserNotificationModule();
    const content = service.formatBrowserNotificationContent(buildAlert(), {
      fallbackIconUrl: '/fallback.png',
    });

    assert.equal(content.title, 'VOL alert: SOL');
    assert.equal(content.body, '+123.46% · MCAP $250K->$1.25M · VOL 5M $2K->$45K · So11...1112');
    assert.equal(content.tag, 'alert:alert-1');
    assert.equal(content.icon, 'https://example.com/token.png');
    assert.equal(JSON.stringify(content.data), '{"address":"So11111111111111111111111111111111111111112","chain":"solana","alertId":"alert-1","ruleKey":null,"navigationTarget":"/alerts/So11111111111111111111111111111111111111112"}');

    const unsafe = service.formatBrowserNotificationContent(buildAlert({ imageUrl: 'javascript:alert(1)' }), {
      fallbackIconUrl: '/fallback.png',
    });
    assert.equal(unsafe.icon, '/fallback.png');

    const surge = service.formatBrowserNotificationContent(buildAlert({
      kind: 'old-surge',
      surgeWindow: '6H',
      volume6h: 1_640_000,
      prevVolume5m: null,
    }));
    assert.equal(surge.body, '+123.46% · MCAP $250K->$1.25M · VOL 6H $1.64M · So11...1112');
  });

  it('labels Robinhood custom FDV alerts without calling them market cap', () => {
    const service = loadBrowserNotificationModule();
    const content = service.formatBrowserNotificationContent(buildAlert({
      id: 'rh-fdv-1',
      chain: 'robinhood',
      kind: 'custom-alert',
      address: '0xabcdef0123456789abcdef0123456789abcdef01',
      symbol: 'rhfdv',
      customTitle: 'FDV breakout',
      customMetric: 'fdv',
      customCurrentValue: 2_500_000,
      customTarget: 3_000_000,
    }));

    assert.equal(content.title, 'FDV breakout: RHFDV');
    assert.equal(content.body, 'FDV $2.50M / target $3.00M · 0xab...ef01');
    assert.doesNotMatch(content.body, /MCAP/);
    assert.equal(content.data.chain, 'robinhood');
    assert.equal(content.data.navigationTarget, '/alerts/robinhood/0xabcdef0123456789abcdef0123456789abcdef01');
  });

  it('renders standard Robinhood FDV notifications with the FDV anchor', () => {
    const service = loadBrowserNotificationModule();
    const content = service.formatBrowserNotificationContent(buildAlert({
      id: 'rh-fdv-standard-1', chain: 'robinhood', kind: 'monitored-fdv',
      ruleKey: 'monitored-fdv', address: '0xabcdef0123456789abcdef0123456789abcdef01',
      symbol: 'rhfdv', valuationType: 'fdv', mcap: null, prevMcap: null,
      fdv: 1_250_000, prevFdv: 250_000,
    }));

    assert.equal(content.title, 'FDV alert: RHFDV');
    assert.match(content.body, /FDV \$250K->\$1\.25M/);
    assert.doesNotMatch(content.body, /MCAP/);
  });

  it('creates notifications only when eligible and avoids duplicates', () => {
    const Notification = createNotificationMock('granted');
    const documentState = { hidden: true };
    let focusCount = 0;
    const navigationTargets = [];
    const service = loadBrowserNotificationModule({
      window: {
        isSecureContext: true,
        localStorage: createLocalStorage(),
        Notification,
        location: {
          assign(target) {
            navigationTargets.push(target);
          },
        },
        focus() {
          focusCount += 1;
        },
      },
      document: documentState,
    });

    assert.equal(service.maybeNotifyAlert(buildAlert(), { enabled: true }), true);
    assert.equal(service.maybeNotifyAlert(buildAlert(), { enabled: true }), false);
    assert.equal(Notification.instances.length, 1);
    assert.equal(Notification.instances[0].title, 'VOL alert: SOL');

    Notification.instances[0].onclick();
    assert.equal(focusCount, 1);
    assert.deepEqual(navigationTargets, ['/alerts/So11111111111111111111111111111111111111112']);

    service.resetBrowserNotificationSession();
    assert.equal(service.maybeNotifyAlert(buildAlert({ id: 'alert-2' }), {
      enabled: true,
      configs: { 'alert-vol-enabled': 'off' },
    }), false);
    assert.equal(Notification.instances.length, 1);

    service.resetBrowserNotificationSession();
    documentState.hidden = false;
    assert.equal(service.maybeNotifyAlert(buildAlert({ id: 'visible-1' }), { enabled: true }), false);
    assert.equal(service.maybeNotifyAlert(buildAlert({ id: 'visible-2' }), {
      enabled: true,
      notifyWhenVisible: true,
    }), true);
  });
});

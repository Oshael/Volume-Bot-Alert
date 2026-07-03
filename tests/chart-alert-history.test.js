const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SERVICE_PATH = path.join(__dirname, '..', 'frontend/src/services/charts/chart-alert-history.ts');

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
    Date,
    Map,
    Set,
  }, { filename: SERVICE_PATH });
  return module.exports;
}

const history = loadModule();

describe('chart alert history cache', () => {
  beforeEach(() => history.clearChartAlertHistory());

  it('normalizes only user-configurable alert rules', () => {
    const base = {
      id: 1,
      address: 'So11111111111111111111111111111111111111112',
      triggeredAt: '2026-07-03T05:47:42.000Z',
      mcap: '100000',
      pct: '25',
    };

    assert.equal(history.normalizeChartAlertEvent({ ...base, ruleKey: 'monitored-mcap' }).mcap, 100000);
    assert.equal(history.normalizeChartAlertEvent({ ...base, ruleKey: 'monitored-mcap', mcap: null }).mcap, null);
    assert.equal(history.normalizeChartAlertEvent({ ...base, ruleKey: 'gmgn-claim-signal' }), null);
    assert.equal(history.normalizeChartAlertEvent({ ...base, ruleKey: 'gmgn-vol-1m' }), null);
  });

  it('merges fetch and realtime events without duplicates and keeps chronological order', () => {
    const address = 'So11111111111111111111111111111111111111112';
    const generatedAt = '2026-07-03T06:00:00.000Z';
    const first = { id: 7, ruleKey: 'monitored-vol', kind: 'monitored-vol', address, triggeredAt: '2026-07-03T05:40:00.000Z', mcap: 90000 };
    const second = { id: 8, ruleKey: 'hvnc', kind: 'hvnc', address, triggeredAt: '2026-07-03T05:50:00.000Z', mcap: 100000 };

    history.upsertRealtimeChartAlert(second, Date.parse(generatedAt));
    history.mergeChartAlertHistory({ generatedAt, windowHours: 24, address, count: 1, truncated: false, events: [first, second] }, Date.parse(generatedAt));

    const result = history.readChartAlertHistory(address, Date.parse(generatedAt));
    assert.equal(result.events.map((event) => event.id).join(','), '7,8');
  });

  it('expires events using the server clock offset', () => {
    const address = 'So11111111111111111111111111111111111111112';
    const clientNow = Date.parse('2026-07-03T05:55:00.000Z');
    history.mergeChartAlertHistory({
      generatedAt: '2026-07-03T06:00:00.000Z',
      windowHours: 24,
      address,
      count: 2,
      truncated: false,
      events: [
        { id: 1, ruleKey: 'monitored-vol', kind: 'monitored-vol', address, triggeredAt: '2026-07-02T05:59:59.999Z', mcap: 80000 },
        { id: 2, ruleKey: 'monitored-vol', kind: 'monitored-vol', address, triggeredAt: '2026-07-02T06:00:00.000Z', mcap: 90000 },
      ],
    }, clientNow);

    const result = history.readChartAlertHistory(address, clientNow);
    assert.equal(result.events.map((event) => event.id).join(','), '2');
    assert.equal(result.nextExpiryAt, clientNow);
  });
});

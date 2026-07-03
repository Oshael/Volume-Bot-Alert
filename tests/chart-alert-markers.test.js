const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SERVICE_PATH = path.join(__dirname, '..', 'frontend/src/services/charts/chart-alert-markers.ts');

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
    Math,
    Number,
  }, { filename: SERVICE_PATH });
  return module.exports;
}

const markers = loadModule();

const candles = [
  { time: Date.parse('2026-07-03T03:45:00.000Z') / 1000, high: 110_000, close: 100_000 },
  { time: Date.parse('2026-07-03T03:50:00.000Z') / 1000, high: 125_000, close: 120_000 },
];

function event(overrides = {}) {
  return {
    id: 1,
    ruleKey: 'monitored-vol',
    kind: 'monitored-vol',
    address: 'So11111111111111111111111111111111111111112',
    triggeredAt: '2026-07-03T03:47:30.000Z',
    mcap: 100_000,
    pct: 50,
    label: null,
    ...overrides,
  };
}

function scale() {
  return {
    logicalToCoordinate: (logical) => logical * 100,
    priceToCoordinate: (price) => 500 - (price / 1000),
  };
}

describe('chart alert marker projection', () => {
  it('projects an alert to a fractional position inside the candle bucket', () => {
    const [marker] = markers.projectChartAlertMarkers([event()], candles, scale(), 5);

    assert.equal(marker.code, 'V');
    assert.equal(marker.x, 50);
    assert.equal(marker.y, 400);
    assert.equal(marker.mcapAvailable, true);
    assert.match(marker.summary, /\$100\.0K/);
  });

  it('uses a visible candle fallback when event market cap is unavailable', () => {
    const [marker] = markers.projectChartAlertMarkers([event({ mcap: null, ruleKey: 'monitored-mcap' })], candles, scale(), 5);

    assert.equal(marker.code, '$');
    assert.equal(marker.mcapAvailable, false);
    assert.equal(marker.y, 376);
    assert.match(marker.summary, /unavailable/);
  });

  it('drops events without supported rule, valid time, or projectable candle range', () => {
    const result = markers.projectChartAlertMarkers([
      event({ id: 2, ruleKey: 'gmgn-claim-signal' }),
      event({ id: 3, triggeredAt: 'invalid' }),
      event({ id: 4, triggeredAt: '2026-07-03T03:40:00.000Z' }),
      event({ id: 5 }),
    ], candles, scale(), 5);

    assert.equal(result.map((marker) => marker.event.id).join(','), '5');
  });

  it('clusters visually colliding markers and keeps the highest-priority representative', () => {
    const projected = markers.projectChartAlertMarkers([
      event({ id: 1, ruleKey: 'monitored-vol', triggeredAt: '2026-07-03T03:47:30.000Z', mcap: 100_000 }),
      event({ id: 2, ruleKey: 'hvnc', triggeredAt: '2026-07-03T03:47:32.000Z', mcap: 101_000 }),
      event({ id: 3, ruleKey: 'meteora-surge', triggeredAt: '2026-07-03T03:50:00.000Z', mcap: 120_000 }),
    ], candles, scale(), 5);

    const clustered = markers.clusterChartAlertMarkers(projected, { hitWidth: 28, hitHeight: 28 });

    assert.equal(clustered.length, 2);
    assert.equal(clustered[0].code, 'H');
    assert.equal(clustered[0].overflow, 1);
    assert.equal(clustered[0].markers.map((marker) => marker.event.id).join(','), '2,1');
    assert.equal(clustered[1].code, 'L');
    assert.equal(clustered[1].overflow, 0);
  });
});

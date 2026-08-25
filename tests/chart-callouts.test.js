const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SERVICE_PATH = path.join(__dirname, '..', 'frontend/src/services/charts/chart-callouts.ts');

function loadModule(apiFetch = async () => ({})) {
  const compiled = ts.transpileModule(fs.readFileSync(SERVICE_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    require: (specifier) => (specifier === '../api/base' ? { apiFetch } : require(specifier)),
    console,
    Date,
    Map,
    Math,
    Number,
    URLSearchParams,
  }, { filename: SERVICE_PATH });
  return module.exports;
}

const callouts = loadModule();
const candles = [
  { time: Date.parse('2026-08-25T10:00:00Z') / 1000, high: 100 },
  { time: Date.parse('2026-08-25T10:05:00Z') / 1000, high: 120 },
];
const scale = {
  timeToCoordinate: (time) => (time - candles[0].time) / 3,
  priceToCoordinate: (price) => 500 - price,
};

function event(id, occurredAt, platform = 'fomo') {
  return {
    id,
    platform,
    occurredAt,
    thesis: `thesis-${id}`,
    profile: { username: id, displayName: null, profilePictureUrl: null },
    source: { links: [] },
  };
}

describe('chart callout grouping', () => {
  it('loads every backend page with one stable range and the returned cursor', async () => {
    const paths = [];
    const service = loadModule(async (requestPath) => {
      paths.push(requestPath);
      return paths.length === 1
        ? { events: [event('first', '2026-08-25T10:01:00Z')], hasMore: true, nextCursor: 'next-page' }
        : { events: [event('second', '2026-08-25T10:02:00Z')], hasMore: false, nextCursor: null };
    });
    const result = await service.fetchChartCallouts('solana', 'PagedToken11111111111111111111111111111111');

    assert.equal(result.map((item) => item.id).join(','), 'first,second');
    assert.equal(paths.length, 2);
    assert.match(paths[1], /cursor=next-page/);
    assert.equal(new URL(`https://example.test${paths[0]}`).searchParams.get('from'),
      new URL(`https://example.test${paths[1]}`).searchParams.get('from'));
  });

  it('groups every thesis in its active five-minute candle newest first', () => {
    const groups = callouts.groupChartCallouts([
      event('older', '2026-08-25T10:01:00Z'),
      event('newer', '2026-08-25T10:04:00Z', 'pump'),
      event('next', '2026-08-25T10:06:00Z'),
    ], candles, scale, 5);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].events.map((item) => item.id).join(','), 'newer,older');
    assert.equal(groups[0].events.map((item) => item.platform).join(','), 'pump,fomo');
    assert.equal(groups[1].events[0].id, 'next');
    assert.equal(groups[0].y, 376);
  });

  it('regroups events when the chart changes to one-hour candles', () => {
    const groups = callouts.groupChartCallouts([
      event('first', '2026-08-25T10:01:00Z'),
      event('second', '2026-08-25T10:50:00Z'),
    ], [{ time: candles[0].time, high: 100 }], scale, 60);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].events.length, 2);
  });

  it('drops invalid timestamps and buckets without a real candle', () => {
    const groups = callouts.groupChartCallouts([
      event('invalid', 'not-a-date'),
      event('gap', '2026-08-25T10:12:00Z'),
    ], candles, scale, 5);
    assert.equal(groups.length, 0);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SERVICE_PATH = path.join(__dirname, '..', 'frontend/src/utils/live-panel-layout.ts');

function loadTypeScriptModule(filePath, cache = new Map()) {
  const resolvedPath = path.resolve(filePath);
  if (cache.has(resolvedPath)) return cache.get(resolvedPath).exports;
  const compiled = ts.transpileModule(fs.readFileSync(resolvedPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  cache.set(resolvedPath, module);
  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) return require(specifier);
    const dependency = path.resolve(path.dirname(resolvedPath), specifier);
    return loadTypeScriptModule(dependency.endsWith('.ts') ? dependency : `${dependency}.ts`, cache);
  };
  vm.runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    require: localRequire,
    Array,
    Math,
    Number,
    Object,
    Set,
    String,
  }, { filename: resolvedPath });
  return module.exports;
}

const layout = loadTypeScriptModule(SERVICE_PATH);
const plain = (value) => JSON.parse(JSON.stringify(value));

describe('frontend fixed live-panel layout resolver', () => {
  it('defines the five approved preset geometries', () => {
    assert.deepEqual(Object.keys(layout.LIVE_PANEL_PRESETS), [
      'discovery_alerts',
      'compare',
      'alerts_focus',
      'token_focus',
      'command_center',
    ]);
    assert.deepEqual(plain(layout.LIVE_PANEL_PRESETS.compare.regions), [
      { pane: 'primary', span: 1 },
      { pane: 'secondary', span: 1 },
    ]);
    assert.deepEqual(plain(layout.LIVE_PANEL_PRESETS.command_center.regions), [
      { pane: 'primary', span: 1 },
      { pane: 'secondary', span: 1 },
      { pane: 'alerts', span: 1 },
    ]);
  });

  it('normalizes canonical preferences and preserves pane order', () => {
    const result = layout.resolveLivePanelLayoutPreference({
      preset: 'compare',
      order: ['secondary', 'primary', 'secondary'],
      panes: { primaryView: 'migrated', secondaryView: 'pre_bonded' },
      heights: { primary: 780.4, secondary: 900, alerts: 700 },
    });

    assert.deepEqual(plain(result), {
      preset: 'compare',
      order: ['secondary', 'primary', 'alerts'],
      panes: { primaryView: 'migrated', secondaryView: 'pre_bonded' },
      heights: { primary: 780, secondary: 900, alerts: 700 },
    });
  });

  it('repairs duplicate pane views to Trending plus Watchlist', () => {
    const result = layout.resolveLivePanelLayoutPreference({
      preset: 'command_center',
      panes: { primaryView: 'migrated', secondaryView: 'migrated' },
    });

    assert.deepEqual(plain(result.panes), {
      primaryView: 'trending',
      secondaryView: 'watchlist',
    });
  });

  it('migrates legacy layouts without carrying PumpFun into the new contract', () => {
    const result = layout.resolveLivePanelLayoutPreference({
      order: ['alerts', 'monitored', 'pumpfun'],
      spans: { monitored: 2, pumpfun: 1, alerts: 1 },
      heights: { monitored: 840, alerts: 960 },
    });

    assert.deepEqual(plain(result), {
      preset: 'discovery_alerts',
      order: ['alerts', 'primary', 'secondary'],
      panes: { primaryView: 'trending', secondaryView: 'watchlist' },
      heights: { primary: 840, secondary: 840, alerts: 960 },
    });
  });

  it('maps a collapsed legacy Monitored panel with wide Alerts to Alerts Focus', () => {
    const result = layout.resolveLivePanelLayoutPreference({
      spans: { monitored: 1, pumpfun: 1, alerts: 2 },
    }, { legacyMonitoredCollapsed: true });

    assert.equal(result.preset, 'alerts_focus');
  });

  it('orders only regions visible in the selected preset', () => {
    const preference = layout.resolveLivePanelLayoutPreference({
      preset: 'discovery_alerts',
      order: ['alerts', 'secondary', 'primary'],
      panes: { primaryView: 'trending', secondaryView: 'watchlist' },
    });

    assert.deepEqual(plain(layout.getOrderedVisibleLivePanelRegions(preference)), [
      { pane: 'alerts', span: 1 },
      { pane: 'primary', span: 2 },
    ]);
  });

  it('guards Command Center below its supported viewport width', () => {
    assert.deepEqual(plain(layout.getLivePanelPresetAvailability('command_center', 1439)), {
      available: false,
      reason: 'Requires a viewport at least 1440px wide.',
    });
    assert.deepEqual(plain(layout.getLivePanelPresetAvailability('command_center', 1440)), {
      available: true,
      reason: null,
    });
  });

  it('swaps a hidden conflicting view but rejects duplicates between visible panes', () => {
    const single = layout.resolveLivePanelLayoutPreference(null);
    assert.deepEqual(plain(layout.resolveMonitoredPaneSelection(single, 'primary', 'watchlist')), {
      primaryView: 'watchlist', secondaryView: 'trending',
    });
    const compare = { ...single, preset: 'compare' };
    assert.equal(layout.resolveMonitoredPaneSelection(compare, 'primary', 'watchlist'), null);
    assert.equal(layout.resolveMonitoredPaneSelection(compare, 'secondary', 'trending'), null);
  });
});

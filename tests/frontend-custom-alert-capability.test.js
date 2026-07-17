const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SERVICE_PATH = path.join(
  __dirname,
  '..',
  'frontend/src/services/alerts/custom-alert-capability.ts',
);

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
    const typeScriptPath = dependency.endsWith('.ts') ? dependency : `${dependency}.ts`;
    return loadTypeScriptModule(typeScriptPath, cache);
  };
  vm.runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    require: localRequire,
    Error,
    Object,
    Set,
    String,
  }, { filename: resolvedPath });
  return module.exports;
}

const {
  normalizeCustomAlertCapabilities,
  requireCustomAlertCapability,
} = loadTypeScriptModule(SERVICE_PATH);

const capabilities = normalizeCustomAlertCapabilities({
  solana: {
    chain: 'solana', supported: true, ready: true,
    metrics: ['price', 'mcap', 'fdv'], windows: ['spot', '5m'], reason: null,
  },
  robinhood: {
    chain: 'robinhood', supported: true, ready: false,
    metrics: ['price', 'fdv'], windows: ['spot'], reason: 'rollout_not_publishable',
  },
});

describe('frontend custom-alert capability guard', () => {
  it('never expands the backend capability response', () => {
    assert.deepEqual([...capabilities.solana.metrics], ['price', 'mcap', 'fdv']);
    assert.deepEqual([...capabilities.solana.windows], ['spot']);
  });

  it('normalizes a supported Solana selection', () => {
    const result = requireCustomAlertCapability(capabilities, {
      chain: 'solana', metric: 'Market Cap', window: 'spot',
    });
    assert.equal(result.metric, 'mcap');
    assert.equal(result.window, 'spot');
  });

  it('rejects mismatched metrics before submission', () => {
    assert.throws(() => requireCustomAlertCapability(capabilities, {
      chain: 'robinhood', metric: 'Market Cap', window: 'spot',
    }), /metric is unsupported/);
  });

  it('distinguishes temporarily unavailable capability from unsupported input', () => {
    assert.throws(() => requireCustomAlertCapability(capabilities, {
      chain: 'robinhood', metric: 'FDV', window: 'spot',
    }), /temporarily unavailable.*rollout_not_publishable/);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SOUND_PATH = path.join(__dirname, '..', 'frontend/src/services/alerts/sound.ts');

function loadTypeScriptModule(filePath, sandboxOverrides = {}, cache = new Map()) {
  const resolvedPath = path.resolve(filePath);
  if (cache.has(resolvedPath)) return cache.get(resolvedPath).exports;
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
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
  const sandbox = { module, exports: module.exports, require: localRequire, ...sandboxOverrides };
  vm.runInNewContext(compiled.outputText, sandbox, { filename: resolvedPath });
  return module.exports;
}

function alert(overrides = {}) {
  return {
    id: 'alert-1', chain: 'solana', kind: 'hvnc', ruleKey: 'hvnc',
    address: 'So11111111111111111111111111111111111111112',
    createdAt: Date.now(), pct: 0, label: 'HVNC',
    ...overrides,
  };
}

describe('alert sound service', () => {
  it('skips retired standard alerts before creating audio and preserves HVNC audio', async () => {
    let audioContexts = 0;
    let oscillatorStarts = 0;
    class FakeAudioContext {
      constructor() {
        audioContexts += 1;
        this.currentTime = 0;
        this.destination = {};
        this.state = 'running';
      }

      createOscillator() {
        return {
          connect() {}, frequency: { setValueAtTime() {} },
          start() { oscillatorStarts += 1; }, stop() {}, type: 'sine',
        };
      }

      createGain() {
        return {
          connect() {},
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        };
      }
    }
    const service = loadTypeScriptModule(SOUND_PATH, {
      window: {
        AudioContext: FakeAudioContext,
        localStorage: { getItem() { return null; } },
      },
    });
    const retired = [
      alert({ kind: 'monitored-vol', ruleKey: 'monitored-vol' }),
      alert({ kind: 'monitored-vol', ruleKey: 'gmgn-vol-1m' }),
      alert({ kind: 'monitored-mcap', ruleKey: 'monitored-mcap' }),
      alert({ kind: 'monitored-fdv', ruleKey: 'monitored-fdv' }),
    ];

    for (const entry of retired) {
      assert.equal(await service.playAlertSound(entry, { enabled: true }), 'skipped');
    }
    assert.equal(audioContexts, 0);
    assert.equal(await service.playAlertSound(alert(), { enabled: true }), 'played');
    assert.equal(audioContexts, 1);
    assert.equal(oscillatorStarts, 3);
  });
});

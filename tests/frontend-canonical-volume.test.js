const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');
const esbuild = require('../frontend/node_modules/esbuild');

let canonicalVolume;

before(async () => {
  const result = await esbuild.build({
    entryPoints: ['frontend/src/utils/canonical-volume.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  canonicalVolume = await import(`data:text/javascript;base64,${source}`);
});

describe('frontend canonical VOL 5M delta', () => {
  it('renders only complete positive-baseline windows', () => {
    const calculate = canonicalVolume.calculateCanonicalVolume5mDelta;
    assert.equal(calculate(180, 100, 'complete'), 80);
    assert.equal(calculate(50, 100, 'complete'), -50);
    assert.equal(calculate(100, 0, 'complete'), null);
    assert.equal(calculate(100, 80, 'partial'), null);
    assert.equal(calculate(100, 80, 'unavailable'), null);
    assert.equal(calculate(null, 80, 'complete'), null);
  });
});

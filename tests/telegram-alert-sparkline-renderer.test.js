const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const sharp = require('sharp');

const {
  createTelegramAlertSparklineRenderer,
} = require('../src/services/telegram-alert-sparkline-renderer');

const INPUT = Object.freeze({
  chain: 'solana',
  symbol: 'TREND',
  hours: 24,
  triggeredAt: '2026-07-29T15:02:45.000Z',
  series: [90_000, 94_000, 91_500, 103_000, 110_000],
});

describe('Telegram alert sparkline renderer', () => {
  it('renders a deterministic 960x420 PNG', async () => {
    const renderer = createTelegramAlertSparklineRenderer();
    const first = await renderer.render(INPUT);
    const second = await renderer.render(INPUT);
    const metadata = await sharp(first.photo.data).metadata();

    assert.equal(first.kind, 'image');
    assert.equal(first.photo.contentType, 'image/png');
    assert.equal(first.photo.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(metadata.width, 960);
    assert.equal(metadata.height, 420);
    assert.deepEqual(first.photo.data, second.photo.data);
  });

  it('normalizes non-finite gaps and escapes labels before rasterization', async () => {
    let capturedSvg = null;
    const renderer = createTelegramAlertSparklineRenderer({
      async rasterize(svg) {
        capturedSvg = svg;
        return Buffer.from([1, 2, 3]);
      },
    });

    const result = await renderer.render({
      ...INPUT,
      chain: 'robinhood',
      symbol: 'A&B<TEST>',
      series: [null, 100, Number.NaN, 200, Number.POSITIVE_INFINITY],
    });

    assert.equal(result.pointCount, 5);
    assert.match(capturedSvg, /A&amp;B&lt;TEST&gt;/);
    assert.match(capturedSvg, /ROBINHOOD · FDV · 1D/);
    assert.doesNotMatch(capturedSvg, /NaN|Infinity/);
  });

  it('returns an explicit fallback reason without calling the rasterizer', async () => {
    let rasterizations = 0;
    const renderer = createTelegramAlertSparklineRenderer({
      async rasterize() {
        rasterizations += 1;
        return Buffer.from([1]);
      },
    });

    const result = await renderer.render({ ...INPUT, series: [null, 100, Number.NaN] });

    assert.deepEqual(result, { kind: 'unavailable', reason: 'insufficient_points' });
    assert.equal(rasterizations, 0);
  });

  it('rejects unsupported chains and invalid timestamps', async () => {
    const renderer = createTelegramAlertSparklineRenderer();
    await assert.rejects(renderer.render({ ...INPUT, chain: 'base' }), /Unsupported/);
    await assert.rejects(renderer.render({ ...INPUT, triggeredAt: 'invalid' }), /triggeredAt/);
    await assert.rejects(renderer.render({
      ...INPUT,
      series: Array.from({ length: 501 }, () => 100),
    }), /cannot exceed 500 points/);
  });
});

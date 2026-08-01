const sharp = require('sharp');

const WIDTH = 960;
const HEIGHT = 420;
const MAX_POINTS = 180;
const MAX_INPUT_POINTS = 500;
const CHART = Object.freeze({ left: 54, right: 906, top: 126, bottom: 350 });
const SUPPORTED_CHAINS = new Set(['solana', 'robinhood']);

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function timestamp(value) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError('Sparkline triggeredAt must be a valid timestamp');
  }
  return parsed;
}

function normalizeSeries(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('Sparkline series must be an array');
  }
  if (values.length > MAX_INPUT_POINTS) {
    throw new TypeError(`Sparkline series cannot exceed ${MAX_INPUT_POINTS} points`);
  }
  const series = values.map((value) => {
    const parsed = value === null || value === undefined || value === ''
      ? Number.NaN
      : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  });
  const finiteIndexes = series
    .map((value, index) => (value == null ? null : index))
    .filter((value) => value != null);
  if (finiteIndexes.length < 2) return null;

  for (let index = 0; index < series.length; index += 1) {
    if (series[index] != null) continue;
    const previousIndex = [...finiteIndexes].reverse().find((value) => value < index);
    const nextIndex = finiteIndexes.find((value) => value > index);
    if (previousIndex == null) series[index] = series[nextIndex];
    else if (nextIndex == null) series[index] = series[previousIndex];
    else {
      const ratio = (index - previousIndex) / (nextIndex - previousIndex);
      series[index] = series[previousIndex]
        + ((series[nextIndex] - series[previousIndex]) * ratio);
    }
  }

  if (series.length <= MAX_POINTS) return series;
  const step = (series.length - 1) / (MAX_POINTS - 1);
  return Array.from({ length: MAX_POINTS }, (_, index) => (
    series[Math.round(index * step)]
  ));
}

function normalizeInput(input = {}) {
  const chain = String(input.chain || '').trim().toLowerCase();
  if (!SUPPORTED_CHAINS.has(chain)) {
    throw new TypeError(`Unsupported sparkline chain: ${chain || 'missing'}`);
  }
  const symbol = String(input.symbol || '').trim().slice(0, 24) || 'TOKEN';
  const hours = Number(input.hours);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 30) {
    throw new TypeError('Sparkline hours must be an integer between 1 and 720');
  }
  return {
    chain,
    symbol,
    hours,
    triggeredAt: timestamp(input.triggeredAt),
    series: normalizeSeries(input.series),
  };
}

function formatUsd(value) {
  const absolute = Math.abs(value);
  const units = [
    [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K'],
  ];
  const unit = units.find(([threshold]) => absolute >= threshold);
  if (!unit) return `$${value.toFixed(2)}`;
  const scaled = value / unit[0];
  return `$${scaled.toFixed(Math.abs(scaled) >= 100 ? 0 : 2)}${unit[1]}`;
}

function formatWindow(hours) {
  if (hours % 24 === 0) return `${hours / 24}D`;
  return `${hours}H`;
}

function buildPoints(series) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const padding = max === min ? Math.max(Math.abs(max) * 0.01, 1) : 0;
  const lower = min - padding;
  const upper = max + padding;
  const range = upper - lower;
  const chartWidth = CHART.right - CHART.left;
  const chartHeight = CHART.bottom - CHART.top;
  const points = series.map((value, index) => ({
    value,
    x: CHART.left + ((index / (series.length - 1)) * chartWidth),
    y: CHART.bottom - (((value - lower) / range) * chartHeight),
  }));
  return { min, max, points };
}

function buildSvg(input) {
  const { min, max, points } = buildPoints(input.series);
  const first = input.series[0];
  const last = input.series[input.series.length - 1];
  const changePct = first > 0 ? ((last - first) / first) * 100 : null;
  const direction = changePct == null || Math.abs(changePct) < 0.005
    ? 'flat' : (changePct > 0 ? 'up' : 'down');
  const color = { up: '#38e8b0', down: '#ff718d', flat: '#8ca7be' }[direction];
  const line = points.map((point, index) => (
    `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
  )).join(' ');
  const area = `${line} L ${CHART.right} ${CHART.bottom} L ${CHART.left} ${CHART.bottom} Z`;
  const metric = input.chain === 'robinhood' ? 'FDV' : 'MCAP';
  const change = changePct == null ? 'N/A' : `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`;
  const chainLabel = input.chain === 'robinhood' ? 'ROBINHOOD' : 'SOLANA';
  const alertTime = input.triggeredAt.toISOString().slice(0, 16).replace('T', ' ');
  const grid = [0, 1, 2, 3].map((index) => {
    const y = CHART.top + (index * ((CHART.bottom - CHART.top) / 3));
    return `<line x1="${CHART.left}" y1="${y.toFixed(2)}" x2="${CHART.right}" y2="${y.toFixed(2)}" class="grid"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#07131f"/><stop offset="1" stop-color="#0d2232"/></linearGradient>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${color}" stop-opacity="0.34"/><stop offset="1" stop-color="${color}" stop-opacity="0.02"/></linearGradient>
  </defs>
  <style>.text{font-family:Arial,sans-serif;fill:#eaf4fb}.muted{font-family:Arial,sans-serif;fill:#7891a7}.grid{stroke:#294052;stroke-width:1;opacity:.55}</style>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="24" fill="url(#bg)"/>
  <text x="${CHART.left}" y="54" class="text" font-size="28" font-weight="700">${escapeXml(input.symbol)}</text>
  <text x="${CHART.left}" y="82" class="muted" font-size="15">${chainLabel} · ${metric} · ${formatWindow(input.hours)}</text>
  <text x="${CHART.right}" y="54" class="text" font-size="25" font-weight="700" text-anchor="end">${formatUsd(last)}</text>
  <text x="${CHART.right}" y="82" fill="${color}" font-family="Arial,sans-serif" font-size="16" text-anchor="end">${change}</text>
  ${grid}
  <path d="${area}" fill="url(#fill)"/>
  <path d="${line}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="${CHART.right}" y1="${CHART.top}" x2="${CHART.right}" y2="${CHART.bottom}" stroke="#d9f7ff" stroke-width="2" stroke-dasharray="5 7" opacity=".8"/>
  <circle cx="${points.at(-1).x.toFixed(2)}" cy="${points.at(-1).y.toFixed(2)}" r="6" fill="${color}" stroke="#eaf4fb" stroke-width="2"/>
  <text x="${CHART.left}" y="388" class="muted" font-size="14">MIN ${formatUsd(min)} · MAX ${formatUsd(max)}</text>
  <text x="${CHART.right}" y="388" class="muted" font-size="14" text-anchor="end">ALERT ${alertTime} UTC</text>
</svg>`;
}

async function rasterizeSvg(svg) {
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

function createTelegramAlertSparklineRenderer(options = {}) {
  const rasterize = options.rasterize || rasterizeSvg;
  if (typeof rasterize !== 'function') {
    throw new TypeError('Sparkline rasterizer port is required');
  }

  async function render(input = {}) {
    const value = normalizeInput(input);
    if (!value.series) {
      return Object.freeze({ kind: 'unavailable', reason: 'insufficient_points' });
    }
    const svg = buildSvg(value);
    const rendered = await rasterize(svg, { width: WIDTH, height: HEIGHT });
    if (!(Buffer.isBuffer(rendered) || rendered instanceof Uint8Array) || rendered.length === 0) {
      throw new TypeError('Sparkline rasterizer must return image bytes');
    }
    return Object.freeze({
      kind: 'image',
      width: WIDTH,
      height: HEIGHT,
      pointCount: value.series.length,
      photo: Object.freeze({
        data: Buffer.from(rendered),
        contentType: 'image/png',
        filename: 'trendscope-sparkline.png',
      }),
    });
  }

  return Object.freeze({ render });
}

const renderer = createTelegramAlertSparklineRenderer();

module.exports = {
  renderTelegramAlertSparkline: (...args) => renderer.render(...args),
  createTelegramAlertSparklineRenderer,
};

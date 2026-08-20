import {
  fetchRobinhoodHolderCountSeries,
  type RobinhoodHolderCountSeries,
  type RobinhoodHolderInterval,
} from '../services/api/robinhood-holders';
import { escapeHtml } from './sections/html-safety';

const INTERVALS: readonly RobinhoodHolderInterval[] = ['1h', '4h', '12h', '24h'];
const BAR_LIMITS: Record<RobinhoodHolderInterval, number> = {
  '1h': 720, '4h': 180, '12h': 60, '24h': 30,
};
const DELTAS = [
  ['4h', '4 Hours'], ['12h', '12 Hours'], ['1d', '1 Day'], ['7d', '7 Days'],
] as const;
const CACHE_TTL_MS = 20_000;
const VIEWPORT_MARGIN = 12;
const CARD_GAP = 10;

const cache = new Map<string, { history: RobinhoodHolderCountSeries; cachedAt: number }>();
const requests = new Map<string, Promise<RobinhoodHolderCountSeries>>();
let activeTarget: HTMLElement | null = null;
let activeHistory: RobinhoodHolderCountSeries | null = null;
let activeAddress: string | null = null;
let activeAuthToken: string | null | undefined;
let interval: RobinhoodHolderInterval = '4h';
let hideTimer = 0;
let requestVersion = 0;

function formatCount(value: number | null | undefined, signed = false) {
  if (value == null) return '—';
  return `${signed && value > 0 ? '+' : ''}${value.toLocaleString('en-US')}`;
}

function formatPercent(history: RobinhoodHolderCountSeries, delta: number | null) {
  if (delta == null || !history.current) return '—';
  const baseline = history.current.holderCount - delta;
  if (baseline <= 0) return '—';
  const percent = (delta / baseline) * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

function renderBars(history: RobinhoodHolderCountSeries) {
  const bars = history.series[interval]
    .slice(-BAR_LIMITS[interval])
    .filter((bar) => bar.holderCount != null);
  if (!bars.length) return '<p class="rh-holder-hover-state">No holder history collected yet.</p>';
  const counts = bars.map((bar) => bar.holderCount!);
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  const countRange = maxCount - minCount;
  const slotWidth = 1000 / bars.length;
  const barWidth = Math.max(0.35, slotWidth * 0.82);
  const rectangles = bars.map((bar, index) => {
    const height = countRange === 0
      ? 62
      : 24 + (((bar.holderCount! - minCount) / countRange) * 70);
    const title = `${new Date(bar.start).toLocaleString()} · total ${formatCount(bar.holderCount)} · change ${formatCount(bar.delta, true)}`;
    return `<rect data-holder-hover-bar class="${bar.status === 'open' ? 'is-open' : ''}" x="${(index * slotWidth).toFixed(3)}" y="${(96 - height).toFixed(3)}" width="${barWidth.toFixed(3)}" height="${height.toFixed(3)}"><title>${escapeHtml(title)}</title></rect>`;
  }).join('');
  return `<svg class="rh-holder-hover-bars" viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="Holder totals for up to the last 30 days">
      <line x1="0" y1="96" x2="1000" y2="96"></line>${rectangles}
    </svg>`;
}

function renderHistory(history: RobinhoodHolderCountSeries) {
  const deltaRows = DELTAS.map(([key, label]) => {
    const delta = history.deltas[key].delta;
    const tone = delta == null ? 'is-unavailable' : delta > 0 ? 'is-positive' : delta < 0 ? 'is-negative' : 'is-flat';
    return `<div class="rh-holder-hover-delta ${tone}"><span>${label}</span><strong>${formatCount(delta, true)} / ${formatPercent(history, delta)}</strong></div>`;
  }).join('');
  const buttons = INTERVALS.map((value) => `<button type="button" data-holder-hover-interval="${value}" aria-pressed="${value === interval}">${value.toUpperCase()}</button>`).join('');
  return `<header><span>Holders</span><strong data-holder-hover-count>${formatCount(history.current?.holderCount)}</strong></header>
    <div class="rh-holder-hover-deltas">${deltaRows}</div>
    <div class="rh-holder-hover-controls"><span>Bar interval</span><div role="group" aria-label="Holder hover chart interval">${buttons}</div></div>
    <div class="rh-holder-hover-plot">${renderBars(history)}</div>
    <footer>Showing up to 30 days · hourly history is retained</footer>`;
}

function getCard() {
  let card = document.querySelector<HTMLElement>('[data-holder-hover-card]');
  if (card) return card;
  card = document.createElement('aside');
  card.className = 'robinhood-holder-hover-card';
  card.dataset.holderHoverCard = 'true';
  card.id = 'robinhood-holder-hover-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Holder history');
  card.hidden = true;
  card.addEventListener('pointerenter', () => window.clearTimeout(hideTimer));
  card.addEventListener('pointerleave', scheduleHide);
  card.addEventListener('focusin', () => window.clearTimeout(hideTimer));
  card.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node && card?.contains(event.relatedTarget))) scheduleHide();
  });
  card.addEventListener('click', onCardClick);
  document.body.append(card);
  return card;
}

function positionCard() {
  const card = getCard();
  if (!activeTarget || card.hidden) return;
  const target = activeTarget.getBoundingClientRect();
  const width = card.offsetWidth || 330;
  const height = card.offsetHeight || 360;
  const left = Math.min(
    window.innerWidth - width - VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, target.left + (target.width / 2) - (width / 2)),
  );
  const below = target.bottom + CARD_GAP;
  const top = below + height <= window.innerHeight - VIEWPORT_MARGIN
    ? below
    : Math.max(VIEWPORT_MARGIN, target.top - height - CARD_GAP);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function hideCard() {
  window.clearTimeout(hideTimer);
  requestVersion += 1;
  activeTarget = null;
  activeHistory = null;
  activeAddress = null;
  getCard().hidden = true;
}

function scheduleHide() {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideCard, 120);
}

async function loadHistory(address: string, version: number) {
  const cached = cache.get(address);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.history;
  let request = requests.get(address);
  if (!request) {
    request = fetchRobinhoodHolderCountSeries(address, activeAuthToken)
      .then((history) => {
        cache.set(address, { history, cachedAt: Date.now() });
        return history;
      })
      .finally(() => requests.delete(address));
    requests.set(address, request);
  }
  const history = await request;
  return version === requestVersion ? history : Promise.reject(new Error('holder_hover_superseded'));
}

function showCard(target: HTMLElement, authToken?: string | null) {
  window.clearTimeout(hideTimer);
  const address = String(target.dataset.holderHoverAddress);
  const card = getCard();
  if (activeAddress === address && !card.hidden) {
    activeTarget = target;
    activeAuthToken = authToken;
    positionCard();
    return;
  }
  activeTarget = target;
  activeAddress = address;
  activeAuthToken = authToken;
  activeHistory = null;
  interval = '4h';
  card.innerHTML = '<p class="rh-holder-hover-state">Loading holder history…</p>';
  card.hidden = false;
  positionCard();
  const version = ++requestVersion;
  void loadHistory(address, version).then((history) => {
    if (version !== requestVersion || activeTarget !== target) return;
    activeHistory = history;
    card.innerHTML = renderHistory(history);
    positionCard();
  }).catch((error) => {
    if (version !== requestVersion || error?.message === 'holder_hover_superseded') return;
    card.innerHTML = '<p class="rh-holder-hover-state">Failed to load holder history. <button type="button" data-holder-hover-retry>Retry</button></p>';
    positionCard();
  });
}

function onCardClick(event: Event) {
  const target = event.target as Element | null;
  if (target?.closest('[data-holder-hover-retry]') && activeTarget) {
    cache.delete(String(activeTarget.dataset.holderHoverAddress));
    showCard(activeTarget, activeAuthToken);
    return;
  }
  const next = target?.closest<HTMLButtonElement>('[data-holder-hover-interval]')?.dataset.holderHoverInterval as RobinhoodHolderInterval | undefined;
  if (!next || !INTERVALS.includes(next) || !activeHistory) return;
  interval = next;
  const card = getCard();
  card.querySelectorAll<HTMLButtonElement>('[data-holder-hover-interval]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.holderHoverInterval === interval));
  });
  const plot = card.querySelector<HTMLElement>('.rh-holder-hover-plot');
  if (plot) plot.innerHTML = renderBars(activeHistory);
  window.clearTimeout(hideTimer);
}

export function bindRobinhoodHolderHover(section: ParentNode, authToken?: string | null) {
  if (!(section instanceof HTMLElement) || section.dataset.holderHoverBound === 'true') return;
  section.dataset.holderHoverBound = 'true';
  const resolveTarget = (event: Event) => (event.target as Element | null)
    ?.closest<HTMLElement>('[data-holder-hover-address]');
  section.addEventListener('pointerover', (event) => {
    const target = resolveTarget(event);
    if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) {
      showCard(target, authToken);
    }
  });
  section.addEventListener('pointerout', (event) => {
    const target = resolveTarget(event);
    if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) scheduleHide();
  });
  section.addEventListener('focusin', (event) => {
    const target = resolveTarget(event);
    if (target) showCard(target, authToken);
  });
  section.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node && getCard().contains(event.relatedTarget))) scheduleHide();
  });
}

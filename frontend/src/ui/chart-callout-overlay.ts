import type { CandlestickData, UTCTimestamp } from 'lightweight-charts';
import {
  fetchChartCallouts,
  groupChartCallouts,
  type ChartCalloutEvent,
  type ChartCalloutGroup,
} from '../services/charts/chart-callouts';
import type { TokenChain } from '../utils/token-chain';
import { escapeHtml, sanitizeOptionalHttpUrl } from './sections/html-safety';

type CalloutChart = {
  timeScale(): {
    timeToCoordinate(time: UTCTimestamp): number | null;
    subscribeVisibleLogicalRangeChange(handler: () => void): void;
    unsubscribeVisibleLogicalRangeChange(handler: () => void): void;
    subscribeSizeChange(handler: () => void): void;
    unsubscribeSizeChange(handler: () => void): void;
  };
};

type CalloutSeries = { priceToCoordinate(price: number): number | null };

function profileName(event: ChartCalloutEvent) {
  return event.profile.displayName || event.profile.username || 'Unknown caller';
}

function renderAvatar(event: ChartCalloutEvent, className: string) {
  const url = sanitizeOptionalHttpUrl(event.profile.profilePictureUrl);
  if (url) return `<img class="${className}" src="${escapeHtml(url)}" alt="" />`;
  return `<span class="${className} is-fallback">${escapeHtml(profileName(event).slice(0, 1).toUpperCase())}</span>`;
}

function renderLinks(event: ChartCalloutEvent) {
  return (event.source?.links || []).map((source, index) => {
    const url = sanitizeOptionalHttpUrl(source.link);
    if (!url) return '';
    const label = source.provider || source.text || `Source ${index + 1}`;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }).join('');
}

function renderTooltip(group: ChartCalloutGroup) {
  return `<div class="expanded-chart-callout-tooltip-head"><strong>${group.events.length} ${group.events.length === 1 ? 'callout' : 'callouts'}</strong></div>
    <div class="expanded-chart-callout-list">${group.events.map((event) => `
      <article class="expanded-chart-callout-item">
        <header>${renderAvatar(event, 'expanded-chart-callout-item-avatar')}<strong>${escapeHtml(profileName(event))}</strong><span data-platform="${event.platform}">${escapeHtml(event.platform.toUpperCase())}</span><time>${escapeHtml(new Date(event.occurredAt).toLocaleString())}</time></header>
        <p>${escapeHtml(event.thesis || 'No thesis text available.')}</p>
        <footer>${renderLinks(event)}</footer>
      </article>`).join('')}</div>`;
}

export function mountExpandedChartCalloutOverlay(options: {
  container: HTMLElement;
  chart: CalloutChart;
  series: CalloutSeries;
  candles: CandlestickData<UTCTimestamp>[];
  granularityMinutes: number;
  chain: TokenChain;
  address: string;
  token?: string | null;
}) {
  const layer = document.createElement('div');
  layer.className = 'expanded-chart-callout-overlay';
  layer.setAttribute('aria-label', 'Callout markers');
  const tooltip = document.createElement('div');
  tooltip.className = 'expanded-chart-callout-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  options.container.append(layer, tooltip);

  let events: ChartCalloutEvent[] = [];
  let groups: ChartCalloutGroup[] = [];
  let activeId: string | null = null;
  let pinned = false;
  let disposed = false;
  let raf = 0;
  let hideTimer = 0;

  const hide = () => {
    if (pinned) return;
    activeId = null;
    tooltip.removeAttribute('data-visible');
    tooltip.replaceChildren();
  };
  const scheduleHide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 120);
  };
  const show = (group: ChartCalloutGroup) => {
    window.clearTimeout(hideTimer);
    activeId = group.id;
    tooltip.innerHTML = renderTooltip(group);
    tooltip.dataset.visible = 'true';
    const width = Math.min(380, Math.max(260, options.container.clientWidth - 24));
    const left = Math.max(12, Math.min(options.container.clientWidth - width - 12, group.x - (width / 2)));
    const top = group.y + 32 + 300 < options.container.clientHeight
      ? group.y + 32 : Math.max(12, group.y - 312);
    tooltip.style.width = `${width}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const render = () => {
    raf = 0;
    if (disposed) return;
    groups = groupChartCallouts(
      events,
      options.candles.map((candle) => ({ time: Number(candle.time), high: candle.high })),
      {
        timeToCoordinate: (time) => options.chart.timeScale().timeToCoordinate(time as UTCTimestamp),
        priceToCoordinate: (price) => options.series.priceToCoordinate(price),
      },
      options.granularityMinutes,
    );
    const fragment = document.createDocumentFragment();
    for (const group of groups) {
      if (group.x < -24 || group.x > options.container.clientWidth + 24) continue;
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'expanded-chart-callout-marker';
      marker.style.left = `${group.x}px`;
      marker.style.top = `${group.y}px`;
      marker.setAttribute('aria-label', `${group.events.length} callout${group.events.length === 1 ? '' : 's'}`);
      marker.innerHTML = `${group.events.slice(0, 3).map((event) => renderAvatar(event, 'expanded-chart-callout-avatar')).join('')}${group.events.length > 3 ? `<em>+${group.events.length - 3}</em>` : ''}`;
      marker.addEventListener('mouseenter', () => { if (!pinned) show(group); });
      marker.addEventListener('mouseleave', scheduleHide);
      marker.addEventListener('focus', () => { if (!pinned) show(group); });
      marker.addEventListener('blur', scheduleHide);
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        pinned = activeId !== group.id || !pinned;
        if (pinned) show(group); else hide();
      });
      fragment.append(marker);
    }
    layer.replaceChildren(fragment);
    if (activeId) {
      const active = groups.find((group) => group.id === activeId);
      if (active) show(active); else hide();
    }
  };
  const scheduleRender = () => {
    if (!disposed && !raf) raf = window.requestAnimationFrame(render);
  };
  const onDocumentPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (layer.contains(target) || tooltip.contains(target))) return;
    pinned = false;
    hide();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { pinned = false; hide(); }
  };

  tooltip.addEventListener('mouseenter', () => window.clearTimeout(hideTimer));
  tooltip.addEventListener('mouseleave', scheduleHide);
  options.chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleRender);
  options.chart.timeScale().subscribeSizeChange(scheduleRender);
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleRender) : null;
  resizeObserver?.observe(options.container);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onKeydown);
  fetchChartCallouts(options.chain, options.address, options.token).then((value) => {
    if (!disposed) { events = value; scheduleRender(); }
  }).catch((error) => console.warn('[ExpandedChart] Failed to load callouts:', error instanceof Error ? error.message : error));

  return {
    scheduleRender,
    cleanup() {
      disposed = true;
      window.cancelAnimationFrame(raf);
      window.clearTimeout(hideTimer);
      options.chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleRender);
      options.chart.timeScale().unsubscribeSizeChange(scheduleRender);
      resizeObserver?.disconnect();
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('keydown', onKeydown);
      layer.remove();
      tooltip.remove();
    },
  };
}

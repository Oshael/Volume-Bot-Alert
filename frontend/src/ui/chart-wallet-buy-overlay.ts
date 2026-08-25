import type { CandlestickData, UTCTimestamp } from 'lightweight-charts';
import {
  fetchChartWalletBuys,
  groupChartWalletBuys,
  type ChartWalletBuy,
  type ChartWalletBuyGroup,
} from '../services/charts/chart-wallet-buys';
import { escapeHtml, sanitizeOptionalHttpUrl } from './sections/html-safety';

type WalletBuyChart = {
  timeScale(): {
    timeToCoordinate(time: UTCTimestamp): number | null;
    subscribeVisibleLogicalRangeChange(handler: () => void): void;
    unsubscribeVisibleLogicalRangeChange(handler: () => void): void;
    subscribeSizeChange(handler: () => void): void;
    unsubscribeSizeChange(handler: () => void): void;
  };
};
type WalletBuySeries = { priceToCoordinate(price: number): number | null };

function profileName(item: ChartWalletBuy) {
  return item.profile.displayName || item.profile.username || 'Unknown profile';
}

function avatar(item: ChartWalletBuy, className: string) {
  const url = sanitizeOptionalHttpUrl(item.profile.profilePictureUrl);
  if (url) return `<img class="${className}" src="${escapeHtml(url)}" alt="" />`;
  return `<span class="${className} is-fallback">${escapeHtml(profileName(item).slice(0, 1).toUpperCase())}</span>`;
}

function compactWallet(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function money(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'Amount unavailable';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function uniqueProfiles(actions: ChartWalletBuy[]) {
  const seen = new Set<string>();
  return actions.filter((item) => {
    const key = `${item.profile.platform}:${item.profile.platformUserId}:${item.walletBinding.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tooltipMarkup(group: ChartWalletBuyGroup, truncated: boolean) {
  return `<div class="expanded-chart-wallet-tooltip-head"><strong>${group.actions.length} on-chain ${group.actions.length === 1 ? 'buy' : 'buys'}</strong>${truncated ? '<small>Latest 200 actions only</small>' : ''}</div>
    <div class="expanded-chart-wallet-list">${group.actions.map((item) => `
      <article class="expanded-chart-wallet-item">
        <header>${avatar(item, 'expanded-chart-wallet-item-avatar')}<strong>${escapeHtml(profileName(item))}</strong><span data-platform="${item.profile.platform}">${escapeHtml(item.profile.platform.toUpperCase())}</span><time>${escapeHtml(new Date(item.action.blockTime).toLocaleString())}</time></header>
        <div><b>ON-CHAIN BUY</b><strong>${escapeHtml(money(item.action.amountUsd))}</strong></div>
        <p title="${escapeHtml(item.walletBinding.address)}">Observed wallet ${escapeHtml(compactWallet(item.walletBinding.address))} · ${item.walletBinding.networkScope === 'exact_chain' ? 'Robinhood binding' : 'EVM address candidate'}</p>
        <footer>Not linked to a callout · ${escapeHtml(item.walletBinding.sourceType)}</footer>
      </article>`).join('')}</div>`;
}

export function mountExpandedChartWalletBuyOverlay(options: {
  container: HTMLElement;
  chart: WalletBuyChart;
  series: WalletBuySeries;
  candles: CandlestickData<UTCTimestamp>[];
  granularityMinutes: number;
  address: string;
  token?: string | null;
}) {
  const layer = document.createElement('div');
  layer.className = 'expanded-chart-wallet-overlay';
  layer.setAttribute('aria-label', 'Profile wallet buy markers');
  const tooltip = document.createElement('div');
  tooltip.className = 'expanded-chart-wallet-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  options.container.append(layer, tooltip);

  let actions: ChartWalletBuy[] = [];
  let groups: ChartWalletBuyGroup[] = [];
  let truncated = false;
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
  const show = (group: ChartWalletBuyGroup) => {
    window.clearTimeout(hideTimer);
    activeId = group.id;
    tooltip.innerHTML = tooltipMarkup(group, truncated);
    tooltip.dataset.visible = 'true';
    const width = Math.min(400, Math.max(280, options.container.clientWidth - 24));
    tooltip.style.width = `${width}px`;
    tooltip.style.left = `${Math.max(12, Math.min(options.container.clientWidth - width - 12, group.x - (width / 2)))}px`;
    tooltip.style.top = `${group.y + 32 + 300 < options.container.clientHeight ? group.y + 32 : Math.max(12, group.y - 312)}px`;
  };
  const render = () => {
    raf = 0;
    if (disposed) return;
    groups = groupChartWalletBuys(actions, options.candles.map((candle) => ({
      time: Number(candle.time), low: candle.low,
    })), {
      timeToCoordinate: (time) => options.chart.timeScale().timeToCoordinate(time as UTCTimestamp),
      priceToCoordinate: (price) => options.series.priceToCoordinate(price),
    }, options.granularityMinutes);
    const fragment = document.createDocumentFragment();
    for (const group of groups) {
      if (group.x < -24 || group.y < -24 || group.x > options.container.clientWidth + 24 || group.y > options.container.clientHeight + 24) continue;
      const profiles = uniqueProfiles(group.actions);
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'expanded-chart-wallet-marker';
      marker.style.left = `${group.x}px`;
      marker.style.top = `${group.y}px`;
      marker.setAttribute('aria-label', `${group.actions.length} proven Robinhood wallet ${group.actions.length === 1 ? 'buy' : 'buys'}`);
      marker.innerHTML = `${profiles.slice(0, 3).map((item) => avatar(item, 'expanded-chart-wallet-avatar')).join('')}${profiles.length > 3 ? `<em>+${profiles.length - 3}</em>` : ''}`;
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
    const active = activeId ? groups.find((group) => group.id === activeId) : null;
    if (active) show(active); else if (activeId) hide();
  };
  const scheduleRender = () => { if (!disposed && !raf) raf = window.requestAnimationFrame(render); };
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && (layer.contains(target) || tooltip.contains(target))) return;
    pinned = false; hide();
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
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown);
  fetchChartWalletBuys(options.address, options.token).then((result) => {
    if (!disposed) { actions = result.actions; truncated = result.truncated; scheduleRender(); }
  }).catch((error) => console.warn('[ExpandedChart] Failed to load profile wallet buys:', error instanceof Error ? error.message : error));

  return { scheduleRender, cleanup() {
    disposed = true;
    window.cancelAnimationFrame(raf);
    window.clearTimeout(hideTimer);
    options.chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleRender);
    options.chart.timeScale().unsubscribeSizeChange(scheduleRender);
    resizeObserver?.disconnect();
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeydown);
    layer.remove(); tooltip.remove();
  } };
}

import type { AppController } from '../../state/app-controller';
import type { AppState, BucketSortCriterion, BucketSortMode, BucketSortWindow, ManualTokenEntry, MeteoraEntry, MockTradingPositionEntry, MockTradingTradeEntry, MonitoredSortMode, MonitoredSortWindow, TokenSparklineEntry, TradeTerminalKey } from '../../state/app-state';
import { getAuthFeedbackKind, getAuthFlashBadge } from './auth-feedback';
import { escapeHtml, sanitizeAssetUrl, sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';
import { sortBucketTokens } from '../../utils/token-table';
import { fmtMockSol, fmtMockSolAmount, resolveMockTradeSolUsdcRate, resolveMockTradingPositionPnl } from '../../utils/mock-trading-display';

const DEFAULT_TRADE_TERMINALS: TradeTerminalKey[] = ['axiom', 'photon', 'bullx', 'gmgn', 'padre'];
const TRADE_TERMINAL_ICON_URLS: Record<TradeTerminalKey, string> = {
  axiom: new URL('../../../terminal-axiom.ico', import.meta.url).href,
  photon: new URL('../../../terminal-photon.svg', import.meta.url).href,
  bullx: new URL('../../../terminal-bullx.png', import.meta.url).href,
  gmgn: new URL('../../../terminal-gmgn.svg', import.meta.url).href,
  padre: new URL('../../../terminal-padre.svg', import.meta.url).href,
};

type TradeTerminalLink = {
  key: TradeTerminalKey;
  label: string;
  href: string;
  cls: TradeTerminalKey;
  iconHref: string;
};

const SPARKLINE_SVG_WIDTH = 144;
const SPARKLINE_SVG_HEIGHT = 56;
const SPARKLINE_PADDING_X = 3;
const SPARKLINE_PADDING_Y = 5;
const ALERT_SPARKLINE_SVG_WIDTH = 220;
const ALERT_SPARKLINE_SVG_HEIGHT = 76;
const ALERT_SPARKLINE_PADDING_X = 5;
const ALERT_SPARKLINE_PADDING_Y = 6;
const EXPANDED_SPARKLINE_SVG_WIDTH = 720;
const EXPANDED_SPARKLINE_SVG_HEIGHT = 260;
const EXPANDED_SPARKLINE_PADDING_X = 12;
const EXPANDED_SPARKLINE_PADDING_Y = 16;
const TOKEN_IMAGE_PREVIEW_DELAY_MS = 120;
const TOKEN_IMAGE_PREVIEW_OFFSET_PX = 14;
const TOKEN_IMAGE_PREVIEW_MOUSE_SUPPRESSION_MS = 350;
const SPARKLINE_HOVER_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const TOP_EDGE_PAGE_SCROLL_BRIDGE_DELAY_MS = 400;
const sparklineExpandBoundElements = new WeakSet<HTMLElement>();
const sparklineHoverBoundElements = new WeakSet<HTMLElement>();
const tokenImagePreviewBoundRoots = new WeakSet<EventTarget>();
let tokenImagePreviewTarget: HTMLElement | null = null;
let tokenImagePreviewTimer: ReturnType<typeof window.setTimeout> | null = null;
let tokenImagePreviewPosition = { x: 0, y: 0 };
let tokenImagePreviewGlobalBound = false;
let tokenImagePreviewLastPointerAt = 0;

type SparklineRenderOptions = {
  expanded?: boolean;
  expandable?: boolean;
  areaFill?: boolean;
  lookupKey?: string;
  variant?: 'default' | 'alert';
  markers?: MockTradingTradeEntry[];
  mockSolUsdcRate?: number;
  liveMcap?: number | null;
};

export function bindTokenActions(section: ParentNode, controller: AppController) {
  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="remove-manual"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (address) void controller.removeManualToken(address);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="block-token"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      const label = button.dataset.label || null;
      if (address) void controller.addBlockedToken(address, label);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="admin-block-token"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      const label = button.dataset.label || null;
      if (address) void controller.adminBlockToken(address, label);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="mock-buy-token"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    bindPointerSafeButton(button, () => {
      const address = button.dataset.address;
      if (address) void controller.mockBuyToken(address);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="mock-sell-token"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    bindPointerSafeButton(button, () => {
      const address = button.dataset.address;
      const percent = Number(button.dataset.percent || '100');
      if (address) void controller.mockSellToken(address, percent);
    });
  }

  bindMockTradingPnlButtons(section, controller);

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="dismiss-recent"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (address) controller.dismissRecentToken(address);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="dismiss-old-week"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (address) controller.dismissOldWeekToken(address);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="toggle-star"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      if (!address) return;

      const willBeStarred = !button.classList.contains('active');
      const root = button.ownerDocument || document;
      const selector = `[data-action="toggle-star"][data-address="${CSS.escape(address)}"]`;

      for (const starButton of root.querySelectorAll<HTMLButtonElement>(selector)) {
        starButton.classList.toggle('active', willBeStarred);
        starButton.textContent = willBeStarred ? '★' : '☆';

        const tokenRow = starButton.closest('.token-starred, tr, article, .token-row, .alert-row');
        if (tokenRow instanceof HTMLElement) {
          tokenRow.classList.toggle('token-starred', willBeStarred);
        }
      }

      void controller.toggleStarredToken(address);
    });
  }
}

function bindMockTradingPnlButtons(section: ParentNode, controller: AppController) {
  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="open-mock-trading-pnl"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const address = button.dataset.address;
      if (address) controller.openMockTradingPnlResume(address);
    });
  }
}

function bindPointerSafeButton(button: HTMLButtonElement, handler: () => void) {
  let pointerHandled = false;

  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || button.disabled) {
      return;
    }

    pointerHandled = true;
    event.preventDefault();
    event.stopPropagation();
    handler();
    window.setTimeout(() => {
      pointerHandled = false;
    }, 350);
  });

  button.addEventListener('click', (event) => {
    if (pointerHandled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    handler();
  });
}

export function bindCopyButtons(section: ParentNode) {
  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="copy-address"]')) {
    if (button.dataset.copyButtonBound === 'true') continue;
    button.dataset.copyButtonBound = 'true';
    button.addEventListener('click', async () => {
      const address = button.dataset.address;
      if (!address) return;
      const original = button.dataset.copyOriginalLabel ?? button.textContent ?? '';
      button.dataset.copyOriginalLabel = original;
      const keepTextFeedback = button.classList.contains('alert-action-button') || Boolean(button.closest('.alerts-panel'));

      try {
        await navigator.clipboard.writeText(address);
        button.textContent = keepTextFeedback ? 'Copied' : '✓';
        window.setTimeout(() => {
          button.textContent = original;
        }, 1200);
      } catch {
        button.textContent = keepTextFeedback ? 'Copy failed' : '✕';
        window.setTimeout(() => {
          button.textContent = original;
        }, 1200);
      }
    });
  }
}

export function bindTokenImagePreview(section: ParentNode) {
  if (!(section instanceof EventTarget) || tokenImagePreviewBoundRoots.has(section)) {
    return;
  }

  tokenImagePreviewBoundRoots.add(section);
  bindTokenImagePreviewGlobalEvents();
}

function getTokenImagePreviewTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest<HTMLElement>('[data-token-image-preview="true"]');
}

function handleTokenImagePreviewEnter(target: EventTarget | null, clientX: number, clientY: number) {
  const previewTarget = getTokenImagePreviewTarget(target);
  if (!previewTarget) {
    return;
  }

  tokenImagePreviewPosition = { x: clientX, y: clientY };
  scheduleTokenImagePreview(previewTarget);
}

function resolveTokenImagePreviewTargetAtPointer() {
  if (typeof document === 'undefined') {
    return null;
  }

  return getTokenImagePreviewTarget(document.elementFromPoint(
    tokenImagePreviewPosition.x,
    tokenImagePreviewPosition.y,
  ));
}

function handleTokenImagePreviewMove(target: EventTarget | null, clientX: number, clientY: number) {
  tokenImagePreviewPosition = { x: clientX, y: clientY };

  if (!tokenImagePreviewTarget) {
    handleTokenImagePreviewEnter(target, clientX, clientY);
    return;
  }

  positionTokenImagePreview();
}

function handleTokenImagePreviewLeave(target: EventTarget | null, relatedTarget: EventTarget | null) {
  if (!tokenImagePreviewTarget) {
    return;
  }

  if (relatedTarget instanceof Node && tokenImagePreviewTarget === relatedTarget) {
    return;
  }
  if (relatedTarget instanceof Node && tokenImagePreviewTarget.contains(relatedTarget)) {
    return;
  }

  if (getTokenImagePreviewTarget(target) === tokenImagePreviewTarget) {
    hideTokenImagePreview('pointer-left-target');
  }
}

function scheduleTokenImagePreview(target: HTMLElement) {
  const src = getTokenImagePreviewSrc(target);
  if (!src) {
    return;
  }

  if (tokenImagePreviewTarget === target && getTokenImagePreviewElement()?.classList.contains('is-visible')) {
    positionTokenImagePreview();
    return;
  }

  clearTokenImagePreviewTimer();
  tokenImagePreviewTarget = target;
  tokenImagePreviewTimer = window.setTimeout(() => {
    const currentTarget = target.isConnected ? target : resolveTokenImagePreviewTargetAtPointer();
    if (!currentTarget || tokenImagePreviewTarget !== target) {
      return;
    }

    const currentSrc = getTokenImagePreviewSrc(currentTarget);
    if (!currentSrc) {
      return;
    }

    tokenImagePreviewTarget = currentTarget;
    showTokenImagePreview(currentTarget, currentSrc);
  }, TOKEN_IMAGE_PREVIEW_DELAY_MS);
}

function showTokenImagePreview(target: HTMLElement, src: string) {
  const preview = getOrCreateTokenImagePreviewElement();
  const image = preview.querySelector<HTMLImageElement>('img');
  if (!image) {
    return;
  }

  image.src = src;
  image.alt = target.getAttribute('alt') || '';
  preview.classList.add('is-visible');
  positionTokenImagePreview();
}

function hideTokenImagePreview(reason = 'hide') {
  if (shouldKeepPendingTokenImagePreviewOnScroll(reason)) {
    return;
  }

  clearTokenImagePreviewTimer();
  tokenImagePreviewTarget = null;
  getTokenImagePreviewElement()?.classList.remove('is-visible');
}

function shouldKeepPendingTokenImagePreviewOnScroll(reason: string) {
  if (reason !== 'scroll' && reason !== 'document-scroll') {
    return false;
  }

  if (!tokenImagePreviewTimer || !tokenImagePreviewTarget) {
    return false;
  }

  if (getTokenImagePreviewElement()?.classList.contains('is-visible')) {
    return false;
  }

  const currentTarget = resolveTokenImagePreviewTargetAtPointer();
  if (!currentTarget) {
    return false;
  }

  return currentTarget === tokenImagePreviewTarget
    || getTokenImagePreviewSrc(currentTarget) === getTokenImagePreviewSrc(tokenImagePreviewTarget);
}

function shouldIgnoreUnrelatedTokenImagePreviewScroll(target: EventTarget | null) {
  if (!tokenImagePreviewTarget || target === document) {
    return false;
  }

  if (!(target instanceof Node)) {
    return false;
  }

  return !target.contains(tokenImagePreviewTarget);
}

function clearTokenImagePreviewTimer() {
  if (!tokenImagePreviewTimer) {
    return;
  }

  window.clearTimeout(tokenImagePreviewTimer);
  tokenImagePreviewTimer = null;
}

function getTokenImagePreviewSrc(target: HTMLElement) {
  if (target instanceof HTMLImageElement) {
    return target.currentSrc || target.src || target.dataset.tokenImagePreviewSrc || '';
  }

  return target.dataset.tokenImagePreviewSrc || '';
}

function getTokenImagePreviewElement() {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.body.querySelector<HTMLElement>('.token-image-preview-popover');
}

function getOrCreateTokenImagePreviewElement() {
  const existing = getTokenImagePreviewElement();
  if (existing) {
    return existing;
  }

  const preview = document.createElement('div');
  preview.className = 'token-image-preview-popover';
  preview.setAttribute('aria-hidden', 'true');

  const image = document.createElement('img');
  image.decoding = 'async';
  preview.append(image);
  document.body.append(preview);
  return preview;
}

function positionTokenImagePreview() {
  const preview = getTokenImagePreviewElement();
  if (!preview?.classList.contains('is-visible')) {
    return;
  }

  if (tokenImagePreviewTarget && !tokenImagePreviewTarget.isConnected) {
    const currentTarget = resolveTokenImagePreviewTargetAtPointer();
    if (!currentTarget) {
      hideTokenImagePreview('position-target-disconnected');
      return;
    }
    tokenImagePreviewTarget = currentTarget;
  }

  const width = preview.offsetWidth || 340;
  const height = preview.offsetHeight || 340;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  let left = tokenImagePreviewPosition.x + TOKEN_IMAGE_PREVIEW_OFFSET_PX;
  let top = tokenImagePreviewPosition.y + TOKEN_IMAGE_PREVIEW_OFFSET_PX;

  if (left + width + TOKEN_IMAGE_PREVIEW_OFFSET_PX > viewportWidth) {
    left = tokenImagePreviewPosition.x - width - TOKEN_IMAGE_PREVIEW_OFFSET_PX;
  }
  if (top + height + TOKEN_IMAGE_PREVIEW_OFFSET_PX > viewportHeight) {
    top = viewportHeight - height - TOKEN_IMAGE_PREVIEW_OFFSET_PX;
  }

  preview.style.left = `${Math.max(TOKEN_IMAGE_PREVIEW_OFFSET_PX, left)}px`;
  preview.style.top = `${Math.max(TOKEN_IMAGE_PREVIEW_OFFSET_PX, top)}px`;
}

export function bindTopEdgePageScrollBridge(
  list: HTMLElement | null,
  options: { delayMs?: number } = {},
) {
  if (!list || list.dataset.topEdgePageScrollBridgeBound === 'true') {
    return;
  }

  list.dataset.topEdgePageScrollBridgeBound = 'true';
  const delayMs = options.delayMs ?? TOP_EDGE_PAGE_SCROLL_BRIDGE_DELAY_MS;
  let lastScrollTop = Math.max(0, list.scrollTop);
  let topEdgeEnteredAt = 0;

  list.addEventListener('scroll', () => {
    const currentScrollTop = Math.max(0, list.scrollTop);
    if (currentScrollTop <= 0 && lastScrollTop > 0) {
      topEdgeEnteredAt = Date.now();
    } else if (currentScrollTop > 0) {
      topEdgeEnteredAt = 0;
    }
    lastScrollTop = currentScrollTop;
  }, { passive: true });

  list.addEventListener('wheel', (event) => {
    if (!(event.deltaY < 0)) {
      if (list.scrollTop > 0) {
        topEdgeEnteredAt = 0;
      }
      return;
    }

    if (list.scrollTop > 0) {
      topEdgeEnteredAt = 0;
      lastScrollTop = Math.max(0, list.scrollTop);
      return;
    }

    const documentScrollElement = list.ownerDocument.scrollingElement;
    if (!(documentScrollElement instanceof HTMLElement) || documentScrollElement.scrollTop <= 0) {
      return;
    }

    const now = Date.now();
    if (topEdgeEnteredAt > 0 && (now - topEdgeEnteredAt) < delayMs) {
      event.preventDefault();
      return;
    }

    topEdgeEnteredAt = 0;
    event.preventDefault();
    documentScrollElement.scrollTop = Math.max(0, documentScrollElement.scrollTop + event.deltaY);
  }, { passive: false });
}

function bindTokenImagePreviewGlobalEvents() {
  if (tokenImagePreviewGlobalBound || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  tokenImagePreviewGlobalBound = true;
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') {
      return;
    }

    tokenImagePreviewLastPointerAt = Date.now();
    handleTokenImagePreviewEnter(event.target, event.clientX, event.clientY);
  });
  document.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') {
      return;
    }

    tokenImagePreviewLastPointerAt = Date.now();
    handleTokenImagePreviewMove(event.target, event.clientX, event.clientY);
  });
  document.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'touch') {
      return;
    }

    tokenImagePreviewLastPointerAt = Date.now();
    handleTokenImagePreviewLeave(event.target, event.relatedTarget);
  });
  document.addEventListener('mouseover', (event) => {
    if (Date.now() - tokenImagePreviewLastPointerAt < TOKEN_IMAGE_PREVIEW_MOUSE_SUPPRESSION_MS) {
      return;
    }

    handleTokenImagePreviewEnter(event.target, event.clientX, event.clientY);
  });
  document.addEventListener('mousemove', (event) => {
    if (Date.now() - tokenImagePreviewLastPointerAt < TOKEN_IMAGE_PREVIEW_MOUSE_SUPPRESSION_MS) {
      return;
    }

    handleTokenImagePreviewMove(event.target, event.clientX, event.clientY);
  });
  document.addEventListener('mouseout', (event) => {
    if (Date.now() - tokenImagePreviewLastPointerAt < TOKEN_IMAGE_PREVIEW_MOUSE_SUPPRESSION_MS) {
      return;
    }

    handleTokenImagePreviewLeave(event.target, event.relatedTarget);
  });
  window.addEventListener('scroll', (event) => {
    if (shouldIgnoreUnrelatedTokenImagePreviewScroll(event.target)) {
      return;
    }

    hideTokenImagePreview(event.target === document ? 'document-scroll' : 'scroll');
  }, true);
  window.addEventListener('resize', () => hideTokenImagePreview('resize'));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideTokenImagePreview('escape');
    }
  });
}

export function bindSparklineHover(
  section: ParentNode,
  sparklineByLookupKey: Record<string, TokenSparklineEntry> = {},
  options: { controller?: AppController } = {},
) {
  for (const wrap of section.querySelectorAll<HTMLElement>('.sparkline-wrap')) {
    const lookupKey = String(wrap.dataset.sparklineKey || wrap.dataset.address || '').trim();
    const address = String(wrap.dataset.address || '').trim();
    const entry = sparklineByLookupKey[lookupKey];
    const series = normalizeSparklineSeries(entry?.series);
    const displaySeries = buildDisplaySparklineSeries(series, {
      expanded: wrap.classList.contains('sparkline-wrap-expanded'),
      variant: wrap.dataset.sparklineVariant === 'alert' ? 'alert' : 'default',
    });
    bindExpandableSparkline(wrap, address, lookupKey, options.controller);
    const hoverParts = resolveBindableSparklineHover(wrap, entry, series, displaySeries);
    if (!hoverParts) {
      continue;
    }

    const { hover, line, dot, tooltip } = hoverParts;

    let activeIndex = -1;

    const hide = () => {
      activeIndex = -1;
      hover.classList.remove('active');
    };

    const update = (clientX: number) => {
      const rect = wrap.getBoundingClientRect();
      if (!(rect.width > 0)) {
        return;
      }

      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const index = Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1))));
      if (index === activeIndex) {
        return;
      }

      activeIndex = index;
      const point = resolveSparklineHoverPoint(displaySeries, index, wrap);
      const tooltipLeft = Math.max(10, Math.min(rect.width - 10, point.x));

      line.style.left = `${point.x}px`;
      dot.style.left = `${point.x}px`;
      dot.style.top = `${point.y}px`;
      tooltip.style.left = `${tooltipLeft}px`;
      tooltip.textContent = `MCAP ${fmtMoney(series[index])} · ~ ${formatApproxSparklineTime(entry, index, series.length)}`;
      hover.classList.add('active');
    };

    wrap.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') {
        return;
      }
      update(event.clientX);
    });
    wrap.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch') {
        return;
      }
      update(event.clientX);
    });
    wrap.addEventListener('pointerleave', hide);
    wrap.addEventListener('pointercancel', hide);
  }
}

function bindExpandableSparkline(
  wrap: HTMLElement,
  address: string,
  lookupKey: string,
  controller?: AppController,
) {
  const expandable = wrap.dataset.sparklineExpandable === 'true';
  const alreadyBound = sparklineExpandBoundElements.has(wrap);
  if (!expandable || !controller || alreadyBound) {
    return;
  }

  sparklineExpandBoundElements.add(wrap);
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'button');
  wrap.setAttribute('aria-label', address ? `Expand chart for ${address}` : 'Expand chart');

  let pointerHandled = false;
  const open = () => {
    if (wrap.dataset.sparklineVariant === 'alert' && lookupKey) {
      controller.openAlertExpandedSparkline(lookupKey, address);
      return;
    }
    controller.openExpandedSparkline(address);
  };

  wrap.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    pointerHandled = true;
    event.preventDefault();
    event.stopPropagation();
    open();
    window.setTimeout(() => {
      pointerHandled = false;
    }, 350);
  });
  wrap.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (pointerHandled) {
      return;
    }
    open();
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    open();
  });
}

function resolveBindableSparklineHover(
  wrap: HTMLElement,
  entry: TokenSparklineEntry | undefined,
  series: number[],
  displaySeries: number[],
) {
  if (!entry || series.length < 2 || displaySeries.length < 2 || sparklineHoverBoundElements.has(wrap)) {
    return null;
  }

  const hover = wrap.querySelector<HTMLElement>('.sparkline-hover');
  const line = wrap.querySelector<HTMLElement>('.sparkline-hover-line');
  const dot = wrap.querySelector<HTMLElement>('.sparkline-hover-dot');
  const tooltip = wrap.querySelector<HTMLElement>('.sparkline-hover-tooltip');
  if (!hover || !line || !dot || !tooltip) {
    return null;
  }

  sparklineHoverBoundElements.add(wrap);
  return { hover, line, dot, tooltip };
}

export function renderTradeTerminalMenu(
  address: string,
  mintAddress?: string | null,
  pairAddress?: string | null,
  options?: { axiomAddress?: string | null; enabledTradeTerminals?: TradeTerminalKey[] },
) {
  const links = getTradeTerminalLinks(address, mintAddress, pairAddress, options);
  if (links.length === 1) {
    const link = links[0];
    return `
      <a class="action-glyph trade-btn trade-btn-direct" href="${sanitizeHttpUrl(link.href)}" target="_blank" rel="noreferrer" title="Open in ${escapeHtml(link.label)}">${renderTradeTerminalButtonIcon(link)}</a>
    `;
  }

  return `
    <div class="trade-wrap" data-trade-wrap>
      <button type="button" class="action-glyph trade-btn" title="Open in trading terminal">&#128279;</button>
      <div class="trade-dd" data-trade-menu>
        ${links.map((link) => `<a class="trade-link ${link.cls}" href="${sanitizeHttpUrl(link.href)}" target="_blank" rel="noreferrer">${renderTradeTerminalLinkInner(link)}</a>`).join('')}
      </div>
    </div>
  `;
}

export function buildTradeTerminalMenuElement(
  address: string,
  mintAddress?: string | null,
  pairAddress?: string | null,
  options?: { axiomAddress?: string | null; enabledTradeTerminals?: TradeTerminalKey[] },
) {
  const links = getTradeTerminalLinks(address, mintAddress, pairAddress, options);
  if (links.length === 1) {
    const link = links[0];
    const anchor = document.createElement('a');
    anchor.className = 'action-glyph trade-btn trade-btn-direct';
    anchor.href = sanitizeHttpUrl(link.href);
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.title = `Open in ${link.label}`;
    anchor.append(buildTradeTerminalIcon(link, 'trade-btn-icon'));
    return anchor;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'trade-wrap';
  wrapper.dataset.tradeWrap = '';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action-glyph trade-btn';
  button.title = 'Open in trading terminal';
  button.textContent = '🔗';

  const menu = document.createElement('div');
  menu.className = 'trade-dd';
  menu.dataset.tradeMenu = '';

  for (const link of links) {
    const anchor = document.createElement('a');
    anchor.className = `trade-link ${link.cls}`;
    anchor.href = sanitizeHttpUrl(link.href);
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    const label = document.createElement('span');
    label.className = 'trade-link-label';
    label.textContent = link.label;
    anchor.append(buildTradeTerminalIcon(link), label);
    menu.append(anchor);
  }

  wrapper.append(button, menu);
  return wrapper;
}

function getTradeTerminalLinks(
  address: string,
  mintAddress?: string | null,
  pairAddress?: string | null,
  options?: { axiomAddress?: string | null; enabledTradeTerminals?: TradeTerminalKey[] },
): TradeTerminalLink[] {
  const tokenAddress = mintAddress || address;
  const terminalAddress = pairAddress || mintAddress || address;
  const axiomAddress = options?.axiomAddress || pairAddress || tokenAddress;
  const enabledTradeTerminals = normalizeEnabledTradeTerminals(options?.enabledTradeTerminals);
  const links: TradeTerminalLink[] = [
    { key: 'axiom', label: 'Axiom', href: `https://axiom.trade/meme/${axiomAddress}?chain=sol`, cls: 'axiom', iconHref: TRADE_TERMINAL_ICON_URLS.axiom },
    { key: 'photon', label: 'Photon', href: `https://photon-sol.tinyastro.io/en/lp/${tokenAddress}`, cls: 'photon', iconHref: TRADE_TERMINAL_ICON_URLS.photon },
    { key: 'bullx', label: 'BullX', href: `https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenAddress}`, cls: 'bullx', iconHref: TRADE_TERMINAL_ICON_URLS.bullx },
    { key: 'gmgn', label: 'GMGN', href: `https://gmgn.ai/sol/token/${tokenAddress}`, cls: 'gmgn', iconHref: TRADE_TERMINAL_ICON_URLS.gmgn },
    { key: 'padre', label: 'Padre', href: `https://trade.padre.gg/trade/solana/${terminalAddress}`, cls: 'padre', iconHref: TRADE_TERMINAL_ICON_URLS.padre },
  ];
  return links.filter((link) => enabledTradeTerminals.includes(link.key));
}

function renderTradeTerminalLinkInner(link: TradeTerminalLink) {
  return `${renderTradeTerminalIconMarkup(link)}<span class="trade-link-label">${escapeHtml(link.label)}</span>`;
}

function renderTradeTerminalButtonIcon(link: TradeTerminalLink) {
  return renderTradeTerminalIconMarkup(link, 'trade-btn-icon');
}

function renderTradeTerminalIconMarkup(link: TradeTerminalLink, className = 'trade-link-icon') {
  const inlineIcon = getInlineTradeTerminalIconMarkup(link, className);
  if (inlineIcon) {
    return inlineIcon;
  }
  return `<img class="${className} terminal-icon terminal-icon-${link.key}" src="${sanitizeAssetUrl(link.iconHref)}" alt="" aria-hidden="true">`;
}

function buildTradeTerminalIcon(link: TradeTerminalLink, className = 'trade-link-icon') {
  const inlineIcon = buildInlineTradeTerminalIcon(link, className);
  if (inlineIcon) {
    return inlineIcon;
  }
  const icon = document.createElement('img');
  icon.className = `${className} terminal-icon terminal-icon-${link.key}`;
  icon.src = sanitizeAssetUrl(link.iconHref);
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function getInlineTradeTerminalIconMarkup(link: TradeTerminalLink, className: string) {
  if (link.key === 'photon') {
    return `
      <svg class="${className} terminal-icon-inline terminal-icon-${link.key}" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="5.75" stroke="#45C7FF" stroke-width="1.8"/>
        <path d="M8 3.2L9.18 5.93L11.9 7.1L9.18 8.27L8 11L6.82 8.27L4.1 7.1L6.82 5.93L8 3.2Z" fill="#7C63FF"/>
        <circle cx="8" cy="8" r="2.15" fill="#0A1220"/>
        <circle cx="8" cy="8" r="1.15" fill="#E8F7FF"/>
      </svg>
    `.trim();
  }

  if (link.key === 'padre') {
    return `
      <svg class="${className} terminal-icon-inline terminal-icon-${link.key}" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <path d="M5.2 10.8L8.9 7.1C10 6 11.7 6 12.8 7.1C13.9 8.2 13.9 9.9 12.8 11L9.1 14.7C8 15.8 6.3 15.8 5.2 14.7C4.1 13.6 4.1 11.9 5.2 10.8Z" stroke="#86EFAC" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M6.6 9.4L9.4 6.6" stroke="#C8FFD8" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `.trim();
  }

  return null;
}

function buildInlineTradeTerminalIcon(link: TradeTerminalLink, className: string) {
  const markup = getInlineTradeTerminalIconMarkup(link, className);
  if (!markup) {
    return null;
  }

  const template = document.createElement('template');
  template.innerHTML = markup;
  const icon = template.content.firstElementChild;
  return icon instanceof SVGElement ? icon : null;
}

function normalizeEnabledTradeTerminals(input?: TradeTerminalKey[] | null) {
  if (!Array.isArray(input)) {
    return [...DEFAULT_TRADE_TERMINALS];
  }

  const next: TradeTerminalKey[] = [];
  const seen = new Set<TradeTerminalKey>();
  for (const item of input) {
    if (item !== 'axiom' && item !== 'photon' && item !== 'bullx' && item !== 'gmgn' && item !== 'padre') {
      continue;
    }
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    next.push(item);
  }

  return next.length > 0 ? next : [...DEFAULT_TRADE_TERMINALS];
}

export function bindBucketSortControls(section: ParentNode, controller: AppController, mode: 'manual' | 'recent' | 'old-week') {
  section.querySelectorAll<HTMLButtonElement>('[data-sort-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const sortMode = button.dataset.sortMode as BucketSortMode | undefined;
      const sortWindow = button.dataset.sortWindow as BucketSortWindow | undefined;
      if (!sortMode) return;

      const wrap = button.closest<HTMLElement>('[data-sort-wrap]');
      if (wrap) {
        wrap.classList.remove('open');
      }

      if (mode === 'manual') controller.setManualSort(sortMode, sortWindow);
      else if (mode === 'recent') controller.setRecentSort(sortMode, sortWindow);
      else controller.setOldWeekSort(sortMode, sortWindow);
    });
  });
}

export function bindCompactSearch(
  section: ParentNode,
  options: { toggleAction: string; inputAction: string },
) {
  const input = section.querySelector<HTMLInputElement>(`[data-action="${options.inputAction}"]`);
  const toggle = section.querySelector<HTMLButtonElement>(`[data-action="${options.toggleAction}"]`);
  const wrap = input?.closest<HTMLElement>('.compact-search');
  if (!input || !toggle || !wrap) {
    return;
  }

  let clearButton = wrap.querySelector<HTMLButtonElement>('.compact-search-clear');
  if (!clearButton) {
    clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'compact-search-clear';
    clearButton.setAttribute('aria-label', 'Clear search');
    clearButton.textContent = '×';
    wrap.append(clearButton);
  }

  const syncHasQuery = () => {
    const hasQuery = Boolean(String(input.value || '').trim());
    wrap.classList.toggle('has-query', hasQuery);
    wrap.classList.toggle('open', hasQuery || document.activeElement === input);
  };

  const open = () => wrap.classList.add('open');
  const closeIfEmpty = () => {
    if (!String(input.value || '').trim()) {
      wrap.classList.remove('open');
    }
  };

  syncHasQuery();

  toggle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    open();
    window.requestAnimationFrame(() => {
      input.focus();
      window.requestAnimationFrame(() => input.focus());
    });
  });

  clearButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    input.value = '';
    syncHasQuery();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    wrap.classList.remove('open');
    input.blur();
  });

  input.addEventListener('focus', open);
  input.addEventListener('blur', () => {
    syncHasQuery();
    closeIfEmpty();
  });
  input.addEventListener('input', syncHasQuery);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
      return;
    }

    if (event.key === 'Escape') {
      if (!String(input.value || '').trim()) {
        wrap.classList.remove('open');
      }
      input.blur();
    }
  });
}

export function bindMonitoredSortControls(section: ParentNode, controller: AppController) {
  section.querySelectorAll<HTMLButtonElement>('[data-monitored-sort-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.monitoredSortMode as MonitoredSortMode | undefined;
      const window = button.dataset.monitoredSortWindow as MonitoredSortWindow | undefined;
      if (!mode) return;

      const wrap = button.closest<HTMLElement>('[data-sort-wrap]');
      if (wrap) {
        wrap.classList.remove('open');
      }

      controller.setMonitoredSort(mode, window);
    });
  });
}

function bindCommittedNumberInput(
  input: HTMLInputElement | null | undefined,
  onCommit: (value: number) => void,
) {
  if (!input) return;

  const commit = () => {
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    onCommit(value);
  };

  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  });
}

export function bindPagedMonitoredControls(section: ParentNode, controller: AppController) {
  section.querySelector<HTMLButtonElement>('[data-action="monitored-prev"]')?.addEventListener('click', () => {
    controller.setMonitoredPage(controller.state.ui.monitoredPage - 1);
  });

  section.querySelector<HTMLButtonElement>('[data-action="monitored-next"]')?.addEventListener('click', () => {
    controller.setMonitoredPage(controller.state.ui.monitoredPage + 1);
  });

  bindCommittedNumberInput(section.querySelector<HTMLInputElement>('[data-action="monitored-per-page"]'), (value) => {
    controller.setMonitoredPerPage(value);
  });

  bindCommittedNumberInput(section.querySelector<HTMLInputElement>('[data-action="monitored-page-jump"]'), (value) => {
    controller.setMonitoredPage(value - 1);
  });
}

export function bindPagedBucketControls(section: ParentNode, controller: AppController, mode: 'recent' | 'old-week') {
  const prevAction = mode === 'recent' ? 'recent-prev' : 'old-week-prev';
  const nextAction = mode === 'recent' ? 'recent-next' : 'old-week-next';
  const perPageAction = mode === 'recent' ? 'recent-per-page' : 'old-week-per-page';
  const pageJumpAction = mode === 'recent' ? 'recent-page-jump' : 'old-week-page-jump';

  section.querySelector<HTMLButtonElement>(`[data-action="${prevAction}"]`)?.addEventListener('click', () => {
    if (mode === 'recent') controller.setRecentPage(controller.state.ui.recentPage - 1);
    else controller.setOldWeekPage(controller.state.ui.oldWeekPage - 1);
  });

  section.querySelector<HTMLButtonElement>(`[data-action="${nextAction}"]`)?.addEventListener('click', () => {
    if (mode === 'recent') controller.setRecentPage(controller.state.ui.recentPage + 1);
    else controller.setOldWeekPage(controller.state.ui.oldWeekPage + 1);
  });

  section.querySelectorAll<HTMLInputElement>(`[data-action="${perPageAction}"]`).forEach((input) => {
    bindCommittedNumberInput(input, (value) => {
      if (mode === 'recent') controller.setRecentPerPage(value);
      else controller.setOldWeekPerPage(value);
    });
  });

  section.querySelectorAll<HTMLInputElement>(`[data-action="${pageJumpAction}"]`).forEach((input) => {
    bindCommittedNumberInput(input, (value) => {
      if (mode === 'recent') controller.setRecentPage(value - 1);
      else controller.setOldWeekPage(value - 1);
    });
  });
}

export function renderFlash(state: AppState) {
  if (!state.ui.error && !state.ui.notice) return '';
  const message = state.ui.error ?? state.ui.notice ?? '';
  const flashKind = getAuthFeedbackKind(state, message);
  const shouldPulse = Boolean(
    state.ui.error
    && state.ui.loginErrorCount > 1
    && state.ui.error.includes('Incorrect email or password'),
  );
  const toneClass = `${state.ui.error ? 'flash error' : 'flash notice'} flash-${flashKind}${shouldPulse ? ' flash-pulse' : ''}`;
  const badge = getAuthFlashBadge(flashKind);
  const liveRole = state.ui.error ? 'alert' : 'status';
  return `<div class="${toneClass}" role="${liveRole}" aria-live="polite"><span class="flash-copy">${badge ? `<strong class="flash-badge">${escapeHtml(badge)}</strong>` : ''}<span>${escapeHtml(message)}</span></span><button type="button" class="flash-dismiss" data-action="dismiss-flash">Close</button></div>`;
}

function getAgeBucketEmptyState(mode: 'recent' | 'old-week') {
  return `<p class="muted-block">No ${mode === 'recent' ? 'recent' : 'old-week'} tokens currently match the routed MCAP and age filters.</p>`;
}

function resolveAgeBucketRows(
  tokens: ManualTokenEntry[],
  sortCriteria: BucketSortCriterion[],
  options?: { skipClientSort?: boolean },
) {
  return options?.skipClientSort ? [...tokens] : sortBucketTokens(tokens, sortCriteria);
}

function paginateAgeBucketRows(
  rows: ManualTokenEntry[],
  page: number,
  perPage: number,
  totalCount: number,
  options?: { skipClientSort?: boolean },
) {
  const safePerPage = Math.max(10, Math.floor(perPage) || 15);
  const resolvedTotalCount = Math.max(rows.length, totalCount);
  const totalPages = Math.max(1, Math.ceil(resolvedTotalCount / safePerPage));
  const safePage = Math.min(Math.max(0, Math.floor(page) || 0), totalPages - 1);
  const pageStart = safePage * safePerPage;
  return {
    totalPages,
    safePage,
    pageStart,
    pageItems: options?.skipClientSort ? rows : rows.slice(pageStart, pageStart + safePerPage),
  };
}

function isAgeBucketEmpty(tokens: ManualTokenEntry[], totalCount: number) {
  return tokens.length === 0 && totalCount === 0;
}

export function renderManualTokenTable(
  tokens: ManualTokenEntry[],
  busy: boolean,
  starredTokens: string[] = [],
  _sortCriteria: BucketSortCriterion[] = [{ mode: 'mcap', window: 'highest' }],
  meteoraByAddress: Record<string, MeteoraEntry> = {},
  meteoraMinPool = 5000,
  isAdmin = false,
  enabledTradeTerminals: TradeTerminalKey[] = DEFAULT_TRADE_TERMINALS,
  options?: {
    showSparkline?: boolean;
    sparklineByAddress?: Record<string, TokenSparklineEntry>;
    mockTradingPositionsByAddress?: Record<string, MockTradingPositionEntry>;
    mockTradingTradesByAddress?: Record<string, MockTradingTradeEntry[]>;
    mockSolUsdcRate?: number;
  },
) {
  if (tokens.length === 0) return '<p class="muted-block">No manual tokens yet.</p>';
  const starredSet = new Set(starredTokens);
  return renderTokenTableShell({
    tone: 'manual',
    mode: 'manual',
    rows: tokens,
    busy,
    starredSet,
    meteoraByAddress,
    meteoraMinPool,
    isAdmin,
    enabledTradeTerminals,
    showSparkline: options?.showSparkline,
    sparklineByAddress: options?.sparklineByAddress,
    mockTradingPositionsByAddress: options?.mockTradingPositionsByAddress,
    mockTradingTradesByAddress: options?.mockTradingTradesByAddress,
    mockSolUsdcRate: options?.mockSolUsdcRate,
  });
}

export function renderPagedAgeBucketList(
  tokens: ManualTokenEntry[],
  busy: boolean,
  mode: 'recent' | 'old-week',
  page: number,
  perPage: number,
  starredTokens: string[] = [],
  sortCriteria: BucketSortCriterion[] = [{ mode: 'vol', window: '24h' }],
  meteoraByAddress: Record<string, MeteoraEntry> = {},
  meteoraMinPool = 5000,
  isAdmin = false,
  enabledTradeTerminals: TradeTerminalKey[] = DEFAULT_TRADE_TERMINALS,
  options?: {
    totalCount?: number;
    skipClientSort?: boolean;
    showSparkline?: boolean;
    sparklineByAddress?: Record<string, TokenSparklineEntry>;
    mockTradingPositionsByAddress?: Record<string, MockTradingPositionEntry>;
    mockTradingTradesByAddress?: Record<string, MockTradingTradeEntry[]>;
    mockSolUsdcRate?: number;
  },
) {
  const totalCount = Math.max(0, Number(options?.totalCount) || 0);
  if (isAgeBucketEmpty(tokens, totalCount)) {
    return getAgeBucketEmptyState(mode);
  }

  const starredSet = new Set(starredTokens);
  const rows = resolveAgeBucketRows(tokens, sortCriteria, options);
  const { totalPages, safePage, pageStart, pageItems } = paginateAgeBucketRows(rows, page, perPage, totalCount, options);

  return `
    ${renderTokenTableShell({
      tone: mode,
      mode,
      rows: pageItems,
      busy,
      starredSet,
      meteoraByAddress,
      meteoraMinPool,
      startRank: pageStart + 1,
      isAdmin,
      enabledTradeTerminals,
      showSparkline: options?.showSparkline,
      sparklineByAddress: options?.sparklineByAddress,
      mockTradingPositionsByAddress: options?.mockTradingPositionsByAddress,
      mockTradingTradesByAddress: options?.mockTradingTradesByAddress,
      mockSolUsdcRate: options?.mockSolUsdcRate,
    })}
    ${renderAgeBucketFooter(mode, totalPages, safePage)}
  `;
}

function renderAgeBucketFooter(mode: 'recent' | 'old-week', totalPages: number, safePage: number) {
  const actionPrefix = mode === 'recent' ? 'recent' : 'old-week';
  return `
    <div class="bucket-footer">
      <div class="bucket-page-controls">
        <label class="legacy-mini-field">PAGE <input type="number" min="1" max="${totalPages}" step="1" data-action="${actionPrefix}-page-jump" /></label>
        <span class="bucket-page-total">${totalPages}</span>
      </div>
      <div class="button-row compact bucket-footer-actions">
        <button type="button" class="action-button small" data-action="${actionPrefix}-prev" ${safePage === 0 ? 'disabled' : ''}>Prev</button>
        <button type="button" class="action-button small" data-action="${actionPrefix}-next" ${safePage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  `;
}

function renderTokenTableShell(options: {
  tone: 'manual' | 'recent' | 'old-week';
  mode: 'manual' | 'recent' | 'old-week';
  rows: ManualTokenEntry[];
  busy: boolean;
  starredSet: Set<string>;
  meteoraByAddress: Record<string, MeteoraEntry>;
  meteoraMinPool: number;
  startRank?: number;
  isAdmin?: boolean;
  enabledTradeTerminals: TradeTerminalKey[];
  showSparkline?: boolean;
  sparklineByAddress?: Record<string, TokenSparklineEntry>;
  mockTradingPositionsByAddress?: Record<string, MockTradingPositionEntry>;
  mockTradingTradesByAddress?: Record<string, MockTradingTradeEntry[]>;
  mockSolUsdcRate?: number;
}) {
  const showSparkline = Boolean(options.showSparkline);
  return `
    <div class="token-table-wrap token-table-${options.tone}">
      <table class="token-table ${options.tone}">
        <thead>
          <tr>
            <th class="rank-col">#</th>
            <th>Token</th>
            ${showSparkline ? '<th class="sparkline-col">Chart</th>' : ''}
            <th class="num-col">Age</th>
            <th class="num-col">MCAP</th>
            <th class="delta-col">D</th>
            ${options.mode === 'manual' ? '<th class="num-col">Vol 5M</th>' : ''}
            <th class="num-col">Vol 1H</th>
            <th class="num-col">Vol 6H</th>
            <th class="num-col">Vol 24H</th>
            <th class="num-col">PChg 1H</th>
            <th class="num-col">PChg 6H</th>
            <th class="num-col">PChg 24H</th>
            <th class="num-col">Meteora</th>
            <th class="action-col"></th>
          </tr>
        </thead>
        <tbody>
          ${options.rows.map((item, index) => renderTokenTableRow(
            item,
            options.mode,
            options.busy,
            options.starredSet.has(item.address),
            options.meteoraByAddress,
            options.meteoraMinPool,
            (options.startRank ?? 1) + index,
            Boolean(options.isAdmin),
            options.enabledTradeTerminals,
            showSparkline ? options.sparklineByAddress?.[item.address] || null : null,
            options.mockTradingPositionsByAddress?.[item.address] || null,
            options.mockTradingTradesByAddress?.[item.address] || [],
            options.mockSolUsdcRate,
          )).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function normalizeSparklineSeries(series: number[] | null | undefined) {
  return Array.isArray(series) ? series.filter((value) => Number.isFinite(value)) : [];
}

function appendLiveSparklineMcap(series: number[], liveMcap?: number | null) {
  const value = Number(liveMcap);
  if (!Number.isFinite(value) || value <= 0 || series.length < 2) {
    return series;
  }

  return [...series, value];
}

function computeMedian(values: number[]) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const sorted = values.slice().sort((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
  }

  return sorted[middleIndex];
}

function isIsolatedSparklineSpike(series: number[], spikeIndex: number) {
  if (!Array.isArray(series) || series.length < 8 || spikeIndex <= 0 || spikeIndex >= series.length - 1) {
    return false;
  }

  const spikeValue = series[spikeIndex];
  const previousValue = series[spikeIndex - 1];
  const nextValue = series[spikeIndex + 1];
  if (!(spikeValue > 0) || !(previousValue > 0) || !(nextValue > 0)) {
    return false;
  }

  const neighborBaseline = (previousValue + nextValue) / 2;
  if (!(neighborBaseline > 0) || spikeValue < neighborBaseline * 4) {
    return false;
  }

  const median = computeMedian(series);
  if (median == null || median <= 0 || spikeValue < median * 5) {
    return false;
  }

  let secondHighest = -Infinity;
  for (let index = 0; index < series.length; index += 1) {
    if (index === spikeIndex) {
      continue;
    }
    secondHighest = Math.max(secondHighest, series[index]);
  }

  return Number.isFinite(secondHighest) && secondHighest < spikeValue * 0.6;
}

function buildDisplaySparklineSeries(series: number[], _options: SparklineRenderOptions = {}) {
  if (!Array.isArray(series) || series.length < 8) {
    return series;
  }

  let spikeIndex = -1;
  let spikeValue = -Infinity;
  for (let index = 0; index < series.length; index += 1) {
    if (series[index] > spikeValue) {
      spikeValue = series[index];
      spikeIndex = index;
    }
  }

  if (!isIsolatedSparklineSpike(series, spikeIndex)) {
    return series;
  }

  const previousValue = series[spikeIndex - 1];
  const nextValue = series[spikeIndex + 1];
  const normalized = series.slice();
  normalized[spikeIndex] = previousValue + ((nextValue - previousValue) / 2);
  return normalized;
}

function resolveSparklineDimensions(options: SparklineRenderOptions = {}) {
  if (options.expanded) {
    return {
      width: EXPANDED_SPARKLINE_SVG_WIDTH,
      height: EXPANDED_SPARKLINE_SVG_HEIGHT,
      paddingX: EXPANDED_SPARKLINE_PADDING_X,
      paddingY: EXPANDED_SPARKLINE_PADDING_Y,
    };
  }

  if (options.variant === 'alert') {
    return {
      width: ALERT_SPARKLINE_SVG_WIDTH,
      height: ALERT_SPARKLINE_SVG_HEIGHT,
      paddingX: ALERT_SPARKLINE_PADDING_X,
      paddingY: ALERT_SPARKLINE_PADDING_Y,
    };
  }

  return {
    width: SPARKLINE_SVG_WIDTH,
    height: SPARKLINE_SVG_HEIGHT,
    paddingX: SPARKLINE_PADDING_X,
    paddingY: SPARKLINE_PADDING_Y,
  };
}

function resolveSparklineHoverPoint(series: number[], index: number, wrap: HTMLElement) {
  const rect = wrap.getBoundingClientRect();
  const dimensions = resolveSparklineDimensions({
    expanded: wrap.classList.contains('sparkline-wrap-expanded'),
    variant: wrap.dataset.sparklineVariant === 'alert' ? 'alert' : 'default',
  });
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;
  const innerWidth = dimensions.width - (dimensions.paddingX * 2);
  const innerHeight = dimensions.height - (dimensions.paddingY * 2);
  const pointRatio = series.length <= 1 ? 1 : index / (series.length - 1);
  const svgX = dimensions.paddingX + ((innerWidth * index) / Math.max(1, series.length - 1));
  const normalized = range > 0 ? (series[index] - min) / range : 0.5;
  const svgY = dimensions.paddingY + innerHeight - (normalized * innerHeight);

  return {
    ratio: pointRatio,
    x: (svgX / dimensions.width) * rect.width,
    y: (svgY / dimensions.height) * rect.height,
  };
}

function buildSparklinePolyline(series: number[], options: SparklineRenderOptions = {}) {
  if (series.length < 2) {
    return '';
  }

  const dimensions = resolveSparklineDimensions(options);
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min;
  const innerWidth = dimensions.width - (dimensions.paddingX * 2);
  const innerHeight = dimensions.height - (dimensions.paddingY * 2);

  return series.map((value, index) => {
    const x = dimensions.paddingX + ((innerWidth * index) / Math.max(1, series.length - 1));
    const normalized = range > 0 ? (value - min) / range : 0.5;
    const y = dimensions.paddingY + innerHeight - (normalized * innerHeight);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function buildSparklineAreaPolyline(series: number[], options: SparklineRenderOptions = {}) {
  if (series.length < 2) {
    return '';
  }

  const dimensions = resolveSparklineDimensions(options);
  const linePoints = buildSparklinePolyline(series, options);
  if (!linePoints) {
    return '';
  }

  const bottomY = dimensions.height - dimensions.paddingY;
  const rightX = dimensions.width - dimensions.paddingX;
  const leftX = dimensions.paddingX;

  return `${leftX.toFixed(2)},${bottomY.toFixed(2)} ${linePoints} ${rightX.toFixed(2)},${bottomY.toFixed(2)}`;
}

function getSparklineTimeWindow(entry: TokenSparklineEntry, totalPoints: number) {
  const latestTsMs = Date.parse(String(entry.latestBucketAt || ''));
  const effectiveHours = Number(entry.effectiveHours ?? entry.hours);
  if (!Number.isFinite(latestTsMs) || !Number.isFinite(effectiveHours) || effectiveHours <= 0 || totalPoints < 2) {
    return null;
  }

  const spanMs = effectiveHours * 60 * 60 * 1000;
  return {
    startMs: latestTsMs - spanMs,
    endMs: latestTsMs,
    spanMs,
  };
}

function resolveSparklineMarkerPoint(
  entry: TokenSparklineEntry,
  marker: MockTradingTradeEntry,
  displaySeries: number[],
  options: SparklineRenderOptions,
) {
  const window = getSparklineTimeWindow(entry, displaySeries.length);
  const executedMs = Date.parse(String(marker.executedAt || ''));
  if (!window || !Number.isFinite(executedMs) || executedMs < window.startMs || executedMs > window.endMs) {
    return null;
  }

  const dimensions = resolveSparklineDimensions(options);
  const innerWidth = dimensions.width - (dimensions.paddingX * 2);
  const innerHeight = dimensions.height - (dimensions.paddingY * 2);
  const min = Math.min(...displaySeries);
  const max = Math.max(...displaySeries);
  const range = max - min;
  const ratio = (executedMs - window.startMs) / window.spanMs;
  const fallbackIndex = Math.max(0, Math.min(displaySeries.length - 1, Math.round(ratio * (displaySeries.length - 1))));
  const markerMcap = Number(marker.marketCapUsd);
  const value = Number.isFinite(markerMcap) && markerMcap > 0 ? markerMcap : displaySeries[fallbackIndex];
  const normalized = range > 0 ? Math.max(0, Math.min(1, (value - min) / range)) : 0.5;

  return {
    x: dimensions.paddingX + (innerWidth * ratio),
    y: dimensions.paddingY + innerHeight - (normalized * innerHeight),
  };
}

function formatPriceUsd(value?: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return '-';
  }
  if (Math.abs(value) >= 1) {
    return fmtMoney(value);
  }
  return `$${value.toPrecision(4)}`;
}

function buildSparklineMarkerTitle(marker: MockTradingTradeEntry) {
  const side = marker.side === 'buy' ? 'Buy' : 'Sell';
  const executedAt = marker.executedAt ? new Date(marker.executedAt).toLocaleString() : 'time unavailable';
  return `${side} ${fmtMockSolAmount(marker.notionalUsd / resolveMockTradeSolUsdcRate(marker))} · priceUSD ${formatPriceUsd(marker.priceUsd)} · MCAP ${fmtMoney(marker.marketCapUsd)} · ${executedAt}`;
}

function renderSparklineTradeMarker(
  entry: TokenSparklineEntry,
  marker: MockTradingTradeEntry,
  displaySeries: number[],
  options: SparklineRenderOptions,
) {
  const point = resolveSparklineMarkerPoint(entry, marker, displaySeries, options);
  if (!point) {
    return '';
  }

  const size = options.expanded ? 7 : 4.5;
  const title = escapeHtml(buildSparklineMarkerTitle(marker));
  const x = point.x.toFixed(2);
  const y = point.y.toFixed(2);
  const cls = `token-sparkline-trade-marker ${marker.side}`;
  if (marker.side === 'sell') {
    const points = `${x},${(point.y - size).toFixed(2)} ${(point.x + size).toFixed(2)},${(point.y + size).toFixed(2)} ${(point.x - size).toFixed(2)},${(point.y + size).toFixed(2)}`;
    return `<polygon class="${cls}" points="${points}"><title>${title}</title></polygon>`;
  }
  return `<circle class="${cls}" cx="${x}" cy="${y}" r="${size.toFixed(2)}"><title>${title}</title></circle>`;
}

function renderSparklineTradeMarkers(entry: TokenSparklineEntry, displaySeries: number[], options: SparklineRenderOptions) {
  const markers = Array.isArray(options.markers) ? options.markers : [];
  if (markers.length === 0 || displaySeries.length < 2) {
    return '';
  }
  return markers
    .map((marker) => renderSparklineTradeMarker(entry, marker, displaySeries, options))
    .join('');
}

function buildSparklineTitle(entry: TokenSparklineEntry, series: number[]) {
  const parts = [`Mini chart`, `${series.length} pts`];
  parts.push(`${formatSparklineSpan(entry.effectiveHours)} span`);
  parts.push(`${formatSparklineGranularity(entry.granularityMinutes)} resolution`);

  if (entry.coverageRatio != null && Number.isFinite(entry.coverageRatio)) {
    parts.push(`${Math.round(entry.coverageRatio * 100)}% cov`);
  }
  if (entry.generatedAt) {
    parts.push(`updated ${new Date(entry.generatedAt).toLocaleString()}`);
  }

  return parts.join(' · ');
}

function formatSparklineSpan(hours?: number | null) {
  const safeHours = Number(hours);
  if (!Number.isFinite(safeHours) || safeHours <= 0) {
    return '14D max';
  }

  if (safeHours >= 24) {
    const days = Math.max(1, Math.round(safeHours / 24));
    return `${days}D of 14D max`;
  }

  return `${Math.max(1, Math.round(safeHours))}H of 14D max`;
}

function formatSparklineGranularity(granularityMinutes?: number | null) {
  const safeGranularity = Number(granularityMinutes);
  if (!Number.isFinite(safeGranularity) || safeGranularity <= 0) {
    return '15m';
  }

  return `${Math.round(safeGranularity)}m`;
}

function formatApproxSparklineTime(entry: TokenSparklineEntry, index: number, totalPoints: number) {
  const latestTsMs = Date.parse(String(entry.latestBucketAt || ''));
  const effectiveHours = Number(entry.effectiveHours ?? entry.hours);
  if (!Number.isFinite(latestTsMs) || !Number.isFinite(effectiveHours) || effectiveHours <= 0) {
    return 'time unavailable';
  }

  const spanMs = effectiveHours * 60 * 60 * 1000;
  const startTsMs = latestTsMs - spanMs;
  const pointRatio = totalPoints <= 1 ? 1 : index / (totalPoints - 1);
  const estimatedTsMs = startTsMs + (spanMs * pointRatio);
  const granularityMinutes = Math.max(1, Math.round(Number(entry.granularityMinutes) || 1));
  const snappedTsMs = Math.round(estimatedTsMs / (granularityMinutes * 60000)) * granularityMinutes * 60000;

  return SPARKLINE_HOVER_TIME_FORMATTER.format(new Date(snappedTsMs));
}

function renderSparklinePlaceholder(entry: TokenSparklineEntry | null) {
  if (!entry) {
    return '<span class="sparkline-empty" title="Chart not loaded for this row">-</span>';
  }

  if (entry.loading) {
    return `
      <span class="sparkline-loading" title="Loading chart for this row">
        <span class="sparkline-loading-spinner" aria-hidden="true"></span>
      </span>
    `;
  }

  return '<span class="sparkline-empty" title="Chart unavailable for this row yet">-</span>';
}

function buildSparklineWrapMeta(
  entry: TokenSparklineEntry,
  address: string | undefined,
  options: SparklineRenderOptions,
  summary: string,
) {
  const safeAddress = escapeHtml(String(address || entry.address || '').trim());
  const safeLookupKey = escapeHtml(String(options.lookupKey || address || entry.address || '').trim());
  const expandedClass = options.expanded ? ' sparkline-wrap-expanded' : '';
  const filledClass = options.areaFill ? ' sparkline-wrap-filled' : '';
  const variantClass = options.variant === 'alert' ? ' sparkline-wrap-alert' : '';
  const expandableAttr = options.expandable ? ' data-sparkline-expandable="true"' : '';
  const variantAttr = options.variant === 'alert' ? ' data-sparkline-variant="alert"' : '';

  return {
    safeAddress,
    safeLookupKey,
    expandedClass,
    filledClass,
    variantClass,
    expandableAttr,
    variantAttr,
    svgExpandedClass: options.expanded ? ' token-sparkline-expanded' : '',
    summaryAttr: escapeHtml(summary),
  };
}

export function renderSparklineFigure(entry: TokenSparklineEntry | null, address?: string, options: SparklineRenderOptions = {}) {
  if (!entry) {
    return renderSparklinePlaceholder(entry);
  }
  const series = appendLiveSparklineMcap(normalizeSparklineSeries(entry.series), options.liveMcap);
  const displaySeries = buildDisplaySparklineSeries(series, options);
  if (series.length < 2 || displaySeries.length < 2) {
    return renderSparklinePlaceholder(entry);
  }

  const dimensions = resolveSparklineDimensions(options);
  const start = displaySeries[0];
  const end = displaySeries[displaySeries.length - 1];
  const trendClass = end > start ? 'up' : end < start ? 'down' : 'flat';
  const polyline = buildSparklinePolyline(displaySeries, options);
  const areaPolyline = options.areaFill ? buildSparklineAreaPolyline(displaySeries, options) : '';
  const tradeMarkers = renderSparklineTradeMarkers(entry, displaySeries, options);
  const wrapMeta = buildSparklineWrapMeta(entry, address, options, buildSparklineTitle(entry, series));

  return `
    <div class="sparkline-wrap ${trendClass}${wrapMeta.expandedClass}${wrapMeta.filledClass}${wrapMeta.variantClass}" data-address="${wrapMeta.safeAddress}" data-sparkline-key="${wrapMeta.safeLookupKey}" data-sparkline-summary="${wrapMeta.summaryAttr}"${wrapMeta.expandableAttr}${wrapMeta.variantAttr}>
      <svg class="token-sparkline${wrapMeta.svgExpandedClass}" viewBox="0 0 ${dimensions.width} ${dimensions.height}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        ${areaPolyline ? `<polygon class="token-sparkline-area" points="${areaPolyline}"></polygon>` : ''}
        <polyline class="token-sparkline-glow" points="${polyline}"></polyline>
        <polyline class="token-sparkline-line" points="${polyline}"></polyline>
        ${tradeMarkers}
      </svg>
      <div class="sparkline-hover" aria-hidden="true">
        <span class="sparkline-hover-line"></span>
        <span class="sparkline-hover-dot"></span>
        <span class="sparkline-hover-tooltip"></span>
      </div>
    </div>
  `;
}

function renderSparklineCell(entry: TokenSparklineEntry | null, address?: string, markers: MockTradingTradeEntry[] = [], mockSolUsdcRate?: number, liveMcap?: number | null) {
  return renderSparklineFigure(entry, address, { expandable: true, areaFill: true, markers, mockSolUsdcRate, liveMcap });
}

function resolveTokenMcapDelta(item: ManualTokenEntry) {
  if (item.mcapDelta != null) {
    return item.mcapDelta;
  }
  if (!(item.prevMcap && item.prevMcap > 0) || item.mcap == null) {
    return null;
  }

  return ((item.mcap - item.prevMcap) / item.prevMcap) * 100;
}

function renderBucketDismissButton(mode: 'manual' | 'recent' | 'old-week', safeAddress: string, busy: boolean) {
  if (mode === 'manual') {
    return `<button type="button" class="inline-icon danger" data-action="remove-manual" data-address="${safeAddress}" ${busy ? 'disabled' : ''}>X</button>`;
  }

  const action = mode === 'recent' ? 'dismiss-recent' : 'dismiss-old-week';
  return `<button type="button" class="inline-icon danger" data-action="${action}" data-address="${safeAddress}" ${busy ? 'disabled' : ''}>X</button>`;
}

function renderTokenSocialActions(twitterUrl: string | null, communityUrl: string | null) {
  const socialLinks = splitTokenSocialUrls(twitterUrl, communityUrl);
  const actions: string[] = [];
  if (!socialLinks.twitterUrl) {
    actions.push('<span class="action-glyph x-profile disabled" title="No X profile">&#128100;</span>');
  } else {
    actions.push(`<a class="action-glyph x-profile" href="${socialLinks.twitterUrl}" target="_blank" rel="noreferrer" title="X profile">&#128100;</a>`);
  }

  if (socialLinks.communityUrl) {
    actions.push(`<a class="action-glyph x-profile" href="${socialLinks.communityUrl}" target="_blank" rel="noreferrer" title="Community">&#128101;</a>`);
  }

  return actions.join('');
}

function isCommunityUrl(url: string | null | undefined) {
  const safeUrl = sanitizeOptionalHttpUrl(url);
  if (!safeUrl) {
    return false;
  }
  try {
    const parsed = new URL(safeUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    return ((host === 'x.com' || host === 'twitter.com') && path.startsWith('/i/communities/'))
      || (host === 'coincommunities.org' && path.startsWith('/communities/'));
  } catch {
    return false;
  }
}

function splitTokenSocialUrls(twitterUrl: string | null, communityUrl: string | null) {
  const safeTwitterUrl = sanitizeOptionalHttpUrl(twitterUrl);
  const safeCommunityUrl = sanitizeOptionalHttpUrl(communityUrl);
  if (isCommunityUrl(safeTwitterUrl)) {
    return {
      twitterUrl: null,
      communityUrl: safeCommunityUrl || safeTwitterUrl,
    };
  }
  return {
    twitterUrl: safeTwitterUrl,
    communityUrl: safeCommunityUrl,
  };
}

function renderTokenAdminAction(isAdmin: boolean, safeAddress: string, safeSymbol: string, busy: boolean) {
  if (!isAdmin) {
    return '';
  }

  return `<button type="button" class="action-glyph danger-glyph" data-action="admin-block-token" data-address="${safeAddress}" data-label="${safeSymbol}" ${busy ? 'disabled' : ''} title="Admin block permanently">&#9760;</button>`;
}

function renderMockTradingActions(isAdmin: boolean, safeAddress: string, position: MockTradingPositionEntry | null, busy: boolean) {
  if (!isAdmin) {
    return '';
  }
  const sell = position
    ? `<button type="button" class="action-glyph" data-action="mock-sell-token" data-address="${safeAddress}" data-percent="100" ${busy ? 'disabled' : ''} title="Mock sell 100%">S</button>`
    : '';
  return `<button type="button" class="action-glyph" data-action="mock-buy-token" data-address="${safeAddress}" ${busy ? 'disabled' : ''} title="Mock buy">B</button>${sell}`;
}

function renderMockTradingLine(position: MockTradingPositionEntry | null, trades: MockTradingTradeEntry[] = [], mockSolUsdcRate?: number) {
  if (!position) {
    return '';
  }
  const { pnlUsd: pnl, pnlPct: pct } = resolveMockTradingPositionPnl(position, trades);
  const tone = pnl != null && pnl < 0 ? 'down' : 'up';
  const takeProfit = position.takeProfitOrders?.length
    ? ` · ${formatMockTradingTakeProfitSummary(position.takeProfitOrders)}`
    : '';
  return `
    <button type="button" class="token-subline mock-trading-line mock-trading-pnl-trigger ${tone}" data-action="open-mock-trading-pnl" data-address="${escapeHtml(position.tokenAddress)}" title="Open PnL resume">
      PnL ${fmtMockSol(pnl, { signed: true, usdcRate: mockSolUsdcRate })} (${fmtPct(pct)})${takeProfit}
    </button>
  `;
}

function formatMockTradingTakeProfitSummary(orders: MockTradingPositionEntry['takeProfitOrders'] = []) {
  const openOrders = Array.isArray(orders) ? orders.filter((order) => order.status === 'open') : [];
  if (openOrders.length === 0) {
    return '';
  }
  const preview = openOrders
    .slice(0, 2)
    .map((order) => `${fmtMoney(order.targetMcapUsd)} / ${fmtPct(order.sellPercent)}`)
    .join(', ');
  const extra = openOrders.length > 2 ? ` +${openOrders.length - 2}` : '';
  return `TP ${preview}${extra}`;
}

function renderBucketVolumeCell(mode: 'manual' | 'recent' | 'old-week', item: ManualTokenEntry) {
  if (mode !== 'manual') {
    return '';
  }

  return `<td class="num-col">${fmtMoney(item.volume5m)}</td>`;
}

function renderBucketSparklineCell(
  mode: 'manual' | 'recent' | 'old-week',
  sparkline: TokenSparklineEntry | null,
  item: ManualTokenEntry,
  markers: MockTradingTradeEntry[] = [],
  mockSolUsdcRate?: number,
) {
  return `<td class="sparkline-col">${renderSparklineCell(sparkline, item.address, markers, mockSolUsdcRate, item.mcap)}</td>`;
}

function renderTokenTableRow(item: ManualTokenEntry, mode: 'manual' | 'recent' | 'old-week', busy: boolean, isStarred: boolean, meteoraByAddress: Record<string, MeteoraEntry>, meteoraMinPool: number, rank: number, isAdmin: boolean, enabledTradeTerminals: TradeTerminalKey[], sparkline: TokenSparklineEntry | null = null, mockTradingPosition: MockTradingPositionEntry | null = null, mockTradingTrades: MockTradingTradeEntry[] = [], mockSolUsdcRate?: number) {
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const safeAddress = escapeHtml(item.address);
  const safeSymbol = escapeHtml(symbol);
  const safeName = escapeHtml(item.name || item.label || item.address);
  const dexUrl = sanitizeHttpUrl(item.pairUrl || `https://dexscreener.com/solana/${item.address}`);
  const xSearch = buildXSearchUrl(symbol, item.address);
  const twitterUrl = sanitizeOptionalHttpUrl(item.twitterUrl);
  const communityUrl = sanitizeOptionalHttpUrl(item.communityUrl);
  const age = item.createdAt ? fmtAge(item.createdAt) : '-';
  const mcapDelta = resolveTokenMcapDelta(item);
  const actionButton = renderBucketDismissButton(mode, safeAddress, busy);

  return `
    <tr class="${isStarred ? 'token-starred' : ''}" data-hover-key="${mode}:${safeAddress}">
      <td class="rank-col">#${rank}</td>
      <td>
        <div class="token-cell">
          ${renderAvatar(item, symbol)}
          <div class="token-main">
            <div class="token-line">
              <a class="token-symbol" href="${dexUrl}" target="_blank" rel="noreferrer">${safeSymbol}</a>
              <div class="token-actions-inline">
                <a class="action-glyph x-search" href="${sanitizeHttpUrl(xSearch)}" target="_blank" rel="noreferrer" title="Search contract or ticker on X">X</a>
                ${renderTokenSocialActions(twitterUrl, communityUrl)}
                <button type="button" class="action-glyph copy-button" data-action="copy-address" data-address="${safeAddress}" title="Copy contract">&#10697;</button>
                ${renderTradeTerminalMenu(item.address, item.mintAddress, item.pairAddress, { enabledTradeTerminals })}
                <button type="button" class="action-glyph starred-button ${isStarred ? 'active' : ''}" data-action="toggle-star" data-address="${safeAddress}" ${busy ? 'disabled' : ''} title="Star token">${isStarred ? '&#9733;' : '&#9734;'}</button>
                ${renderMockTradingActions(isAdmin, safeAddress, mockTradingPosition, busy)}
                ${renderTokenAdminAction(isAdmin, safeAddress, safeSymbol, busy)}
              </div>
            </div>
            <div class="token-subline">${safeName}</div>
            ${renderMockTradingLine(mockTradingPosition, mockTradingTrades, mockSolUsdcRate)}
          </div>
        </div>
      </td>
      ${renderBucketSparklineCell(mode, sparkline, item, mockTradingTrades, mockSolUsdcRate)}
      <td class="num-col">${age}</td>
      <td class="num-col strong">${fmtMoney(item.mcap)}</td>
      <td class="delta-col">${renderPctSpan(mcapDelta)}</td>
      ${renderBucketVolumeCell(mode, item)}
      <td class="num-col">${fmtMoney(item.volume1h)}</td>
      <td class="num-col">${fmtMoney(item.volume6h)}</td>
      <td class="num-col">${fmtMoney(item.volume24h)}</td>
      <td class="num-col">${renderPctSpan(item.priceChange1h)}</td>
      <td class="num-col">${renderPctSpan(item.priceChange6h)}</td>
      <td class="num-col">${renderPctSpan(item.priceChange24h)}</td>
      <td class="num-col meteora-col">${renderMeteoraCell(item.address, meteoraByAddress[item.address], meteoraMinPool)}</td>
      <td class="action-col">${actionButton}</td>
    </tr>
  `;
}

function buildXSearchUrl(symbol: string, address: string) {
  const queryParts = [String(address || '').trim(), `$${String(symbol || '').trim()}`]
    .filter(Boolean);
  return `https://x.com/search?q=${encodeURIComponent(queryParts.join(' OR '))}`;
}

const METEORA_TVL_HISTORY_1H = 3600000;
const METEORA_TVL_HISTORY_6H = 21600000;
const METEORA_TVL_HISTORY_24H = 86400000;

function getMeteoraTvlChange(entry: MeteoraEntry, windowMs: number) {
  if (windowMs === METEORA_TVL_HISTORY_1H && entry.change1h != null) {
    return entry.change1h;
  }
  if (windowMs === METEORA_TVL_HISTORY_6H && entry.change6h != null) {
    return entry.change6h;
  }
  if (windowMs === METEORA_TVL_HISTORY_24H && entry.change24h != null) {
    return entry.change24h;
  }

  const history = entry.history || [];
  if (history.length < 2 || !(entry.tvl > 0)) {
    return null;
  }

  const now = Date.now();
  const targetTs = now - windowMs;
  let baseline: { tvl: number; ts: number } | null = null;

  for (const point of history) {
    if (point.ts <= targetTs) {
      baseline = point;
    } else if (!baseline) {
      baseline = point;
      break;
    } else {
      break;
    }
  }

  if (!baseline || !(baseline.tvl > 0)) {
    return null;
  }

  const pct = ((entry.tvl - baseline.tvl) / baseline.tvl) * 100;
  return Math.abs(pct) < 0.01 ? null : pct;
}

function renderMeteoraDelta(label: string, value: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return `<div class="meteora-tip-line"><span>${escapeHtml(label)}</span><span class="muted">-</span></div>`;
  }

  const cls = value >= 0 ? 'pct-pos' : 'pct-neg';
  return `<div class="meteora-tip-line"><span>${escapeHtml(label)}</span><span class="${cls}">${value >= 0 ? '+' : ''}${value.toFixed(1)}%</span></div>`;
}

function renderMeteoraCell(address: string, entry: MeteoraEntry | undefined, minPool: number) {
  if (!entry || entry.noPool || !(entry.tvl > 0) || (minPool > 0 && entry.tvl < minPool)) {
    return '-';
  }

  const ch1h = getMeteoraTvlChange(entry, METEORA_TVL_HISTORY_1H);
  const ch6h = getMeteoraTvlChange(entry, METEORA_TVL_HISTORY_6H);
  const ch24h = getMeteoraTvlChange(entry, METEORA_TVL_HISTORY_24H);
  const poolLabel = escapeHtml((entry.poolCount || 0) > 1 ? `${entry.poolCount} pools` : '1 pool');

  return `
    <div class="met-tip-wrap">
      <span class="meteora-value">$${fmtCompact(entry.tvl)}</span>
      <div class="met-tip-dd">
        <div class="meteora-tip-head"><span>🌊 Meteora TVL</span><span>${poolLabel}</span></div>
        ${renderMeteoraDelta('1H', ch1h)}
        ${renderMeteoraDelta('6H', ch6h)}
        ${renderMeteoraDelta('24H', ch24h)}
      </div>
    </div>
  `;
}

function renderAvatar(item: ManualTokenEntry, symbol: string) {
  const safeSymbol = escapeHtml(symbol);
  const imageUrl = sanitizeOptionalHttpUrl(item.imageUrl);
  const safeImageUrl = imageUrl ? escapeHtml(imageUrl) : '';
  return imageUrl
    ? `<img src="${safeImageUrl}" alt="${safeSymbol}" class="token-avatar" data-token-image-preview="true" data-token-image-preview-src="${safeImageUrl}" />`
    : `<div class="token-avatar placeholder">${safeSymbol.slice(0, 2).toUpperCase()}</div>`;
}

function renderPctSpan(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '<span class="pct-neutral">-</span>';
  const cls = value >= 0 ? 'pct-pos' : 'pct-neg';
  return `<span class="${cls}">${value >= 0 ? '+' : ''}${value.toFixed(2)}%</span>`;
}

export function fmtMoney(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtCompact(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(0)}K`;
  return value.toFixed(0);
}

export function fmtPct(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function fmtAge(createdAt: number) {
  const ageMs = Math.max(0, Date.now() - createdAt);
  const monthDays = 30;
  const months = Math.floor(ageMs / (monthDays * 86400000));
  if (months >= 12) {
    return `${Math.floor(months / 12)}y`;
  }
  if (months >= 1) {
    return `${months}mo`;
  }

  const days = Math.floor(ageMs / 86400000);
  if (days >= 1) return `${days}d`;

  const hours = Math.floor(ageMs / 3600000);
  if (hours >= 1) return `${hours}h`;

  const minutes = Math.floor(ageMs / 60000);
  if (minutes >= 1) return `${minutes}m`;

  const seconds = Math.floor(ageMs / 1000);
  return `${seconds}s`;
}

export function fmtConfig(state: AppState, key: string, fallback: number) {
  const value = Number(state.data.configs[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function renderTokenCard(item: ManualTokenEntry, busy: boolean, options: { mode: 'manual' | 'monitored' | 'recent' | 'old-week'; isStarred?: boolean; isAdmin?: boolean; enabledTradeTerminals?: TradeTerminalKey[] }) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderManualTokenTable([item], busy, options.isStarred ? [item.address] : [], [{ mode: 'mcap', window: 'highest' }], {}, 5000, Boolean(options.isAdmin), options.enabledTradeTerminals ?? DEFAULT_TRADE_TERMINALS);
  return wrapper.innerHTML;
}

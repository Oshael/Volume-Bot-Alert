import type { AppController } from '../../state/app-controller';
import type { AppState, BucketSortCriterion, BucketSortMode, BucketSortWindow, ManualTokenEntry, MeteoraEntry, MockTradingPositionEntry, MockTradingTradeEntry, MonitoredSortMode, MonitoredSortWindow, SparklineRangePreset, TokenSparklineEntry, TradeTerminalKey } from '../../state/app-state';
import { getAuthFeedbackKind, getAuthFlashBadge } from './auth-feedback';
import { escapeHtml, sanitizeAssetUrl, sanitizeHttpUrl, sanitizeOptionalHttpUrl } from './html-safety';
import { sortBucketTokens } from '../../utils/token-table';
import { fmtMockSol, fmtMockSolAmount, resolveMockTradeSolUsdcRate, resolveMockTradingPositionPnl } from '../../utils/mock-trading-display';
import { resolveApiBase } from '../../services/api/base';
import { buildTokenExplorerUrl, buildTokenIdentityKey, buildTokenMarketUrl, normalizeTokenChain, supportsConfiguredTradeTerminals, type TokenChain } from '../../utils/token-chain';
import { resolveCoveredMetric, resolveTokenValuation, type TokenMetricCoverage } from '../../utils/token-valuation';
import { buildTokenChainBadge } from '../token-chain-badge';
import { getTokenChartValuationLabel } from '../../utils/token-chart';

const DEFAULT_TRADE_TERMINALS: TradeTerminalKey[] = ['axiom', 'photon', 'bullx', 'gmgn', 'padre', 'fomo'];
const TRADE_TERMINAL_ICON_URLS: Record<TradeTerminalKey, string> = {
  axiom: new URL('../../../terminal-axiom.ico', import.meta.url).href,
  photon: new URL('../../../terminal-photon.svg', import.meta.url).href,
  bullx: new URL('../../../terminal-bullx.png', import.meta.url).href,
  gmgn: new URL('../../../terminal-gmgn.svg', import.meta.url).href,
  padre: new URL('../../../terminal-padre.svg', import.meta.url).href,
  fomo: new URL('../../../terminal-fomo.png', import.meta.url).href,
};
const TRADE_TERMINAL_LABELS: Record<TradeTerminalKey, string> = {
  axiom: 'Axiom',
  photon: 'Photon',
  bullx: 'BullX',
  gmgn: 'GMGN',
  padre: 'Pump',
  fomo: 'FOMO',
};

type TokenLaunchpadKey = 'pump' | 'bags' | 'bonk' | 'brrr' | 'meteora'
  | 'pons' | 'bankr-doppler' | 'launchhood' | 'robinpad'
  | 'robinhood-stock' | 'uniswap';

const ROBINHOOD_MARK_PATH = 'M2.84 24h.53c.096 0 .192-.048.224-.128C7.591 13.696 11.94 8.656 14.67 5.638c.112-.128.064-.225-.096-.225h-4.88a.55.55 0 0 0-.45.225L5.746 9.972c-.514.642-.642 1.236-.642 2.086v4.43c-1.14 3.194-1.862 5.361-2.392 7.32-.032.125.016.192.129.192M20.447.646c-.754-.802-4.157-.834-5.73-.224a3 3 0 0 0-.786.465 41 41 0 0 0-3.323 3.178c-.112.113-.064.225.097.225h5.409c.497 0 .786.289.786.786v6.1c0 .16.128.208.225.064l3.258-4.254c.53-.69.69-.898.835-1.861.192-1.413.08-3.58-.77-4.479m-6.982 16.18 2.231-3.676a.7.7 0 0 0 .064-.29V6.73c0-.16-.112-.225-.224-.097-3.355 3.74-5.971 7.672-8.395 12.407-.06.12.016.225.16.177l5.009-1.54c.565-.174.882-.402 1.155-.852';

const TOKEN_LAUNCHPAD_META: Record<TokenLaunchpadKey, {
  label: string; mark: string; svgPath?: string;
}> = {
  pump: { label: 'Pump.fun', mark: 'P' },
  bags: { label: 'Bags', mark: '$' },
  bonk: { label: 'LetsBonk', mark: 'B' },
  brrr: { label: 'Brrr', mark: 'BR' },
  meteora: { label: 'Meteora', mark: 'M' },
  pons: { label: 'pons', mark: 'P' },
  'bankr-doppler': { label: 'Bankr / Doppler', mark: 'B' },
  launchhood: { label: 'LaunchHood', mark: 'LH' },
  robinpad: { label: 'RobinPad', mark: 'RP' },
  'robinhood-stock': {
    label: 'Robinhood Stock Token', mark: 'RH', svgPath: ROBINHOOD_MARK_PATH,
  },
  uniswap: { label: 'Uniswap', mark: '🦄' },
};

const ROBINHOOD_LAUNCHPAD_KEYS = new Set<TokenLaunchpadKey>([
  'pons', 'bankr-doppler', 'launchhood', 'robinpad', 'robinhood-stock',
]);

type TradeTerminalLink = {
  key: TradeTerminalKey;
  label: string;
  href: string;
  cls: TradeTerminalKey;
  iconHref: string;
};

type TradeTerminalOptions = {
  axiomAddress?: string | null;
  chain?: TokenChain;
  enabledTradeTerminals?: TradeTerminalKey[];
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
const SPARKLINE_HOVER_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const TOP_EDGE_PAGE_SCROLL_BRIDGE_DELAY_MS = 400;
const UI_CONTROL_TOOLTIP_DELAY_MS = 500;
const SPARKLINE_RANGE_OPTIONS: Array<{ preset: SparklineRangePreset; label: string; hours: number }> = [
  { preset: '1h', label: '1H', hours: 1 },
  { preset: '4h', label: '4H', hours: 4 },
  { preset: '12h', label: '12H', hours: 12 },
  { preset: '1d', label: '1D', hours: 24 },
  { preset: '3d', label: '3D', hours: 72 },
  { preset: '7d', label: '7D', hours: 168 },
  { preset: '14d', label: '14D', hours: 336 },
  { preset: 'all', label: 'ALL', hours: 0 },
];
const SPARKLINE_RANGE_PRESET_BY_HOURS = new Map(
  SPARKLINE_RANGE_OPTIONS.map((option) => [option.hours, option.preset]),
);
const sparklineExpandBoundElements = new WeakSet<HTMLElement>();
const sparklineHoverBoundElements = new WeakSet<HTMLElement>();
const tokenImagePreviewBoundRoots = new WeakSet<EventTarget>();
let tokenImagePreviewTarget: HTMLElement | null = null;
let tokenImagePreviewTimer: ReturnType<typeof window.setTimeout> | null = null;
let tokenImagePreviewPosition = { x: 0, y: 0 };
let tokenImagePreviewGlobalBound = false;
let tokenImagePreviewLastPointerAt = 0;
let manualQuickAddOpenKey: string | null = null;
let manualQuickAddDocumentCloseBound = false;
let uiControlTooltipTarget: HTMLElement | null = null;
let uiControlTooltipText = '';
let uiControlTooltipStartedAt = 0;
let uiControlTooltipTimer = 0;
let uiControlTooltipVisible = false;
let uiControlTooltipPointer = { x: -1, y: -1 };

type SparklineRangeControlScope = 'monitored' | 'recent' | 'oldWeek';

function clearUiControlTooltip() {
  window.clearTimeout(uiControlTooltipTimer);
  uiControlTooltipTarget?.removeAttribute('data-tooltip-visible');
  uiControlTooltipTarget = null;
  uiControlTooltipText = '';
  uiControlTooltipStartedAt = 0;
  uiControlTooltipVisible = false;
}

function showUiControlTooltip() {
  if (!uiControlTooltipTarget?.isConnected) return;
  uiControlTooltipVisible = true;
  uiControlTooltipTarget.setAttribute('data-tooltip-visible', 'true');
}

function activateUiControlTooltip(target: HTMLElement) {
  const tooltipText = String(target.dataset.tooltip || '');
  const continuesExistingHover = tooltipText === uiControlTooltipText && uiControlTooltipStartedAt > 0;
  uiControlTooltipTarget?.removeAttribute('data-tooltip-visible');
  uiControlTooltipTarget = target;
  if (!continuesExistingHover) {
    window.clearTimeout(uiControlTooltipTimer);
    uiControlTooltipText = tooltipText;
    uiControlTooltipStartedAt = performance.now();
    uiControlTooltipVisible = false;
  }
  if (uiControlTooltipVisible) {
    showUiControlTooltip();
    return;
  }
  const remainingDelay = Math.max(
    0,
    UI_CONTROL_TOOLTIP_DELAY_MS - (performance.now() - uiControlTooltipStartedAt),
  );
  window.clearTimeout(uiControlTooltipTimer);
  uiControlTooltipTimer = window.setTimeout(showUiControlTooltip, remainingDelay);
}

function getPointedUiControlTooltip() {
  const pointed = document.elementFromPoint(uiControlTooltipPointer.x, uiControlTooltipPointer.y);
  return pointed?.closest<HTMLElement>('.ui-control-tooltip[data-tooltip]') ?? null;
}

function reconcileUiControlTooltipAfterLeave(target: HTMLElement) {
  window.setTimeout(() => {
    if (uiControlTooltipTarget !== target) return;
    const replacement = getPointedUiControlTooltip();
    if (replacement?.dataset.tooltip === uiControlTooltipText) {
      activateUiControlTooltip(replacement);
    } else {
      clearUiControlTooltip();
    }
  }, 0);
}

function bindUiControlTooltips(section: ParentNode) {
  section.querySelectorAll<HTMLElement>('.ui-control-tooltip[data-tooltip]').forEach((target) => {
    if (target.dataset.uiTooltipBound === 'true') return;
    target.dataset.uiTooltipBound = 'true';
    target.addEventListener('pointerenter', (event) => {
      uiControlTooltipPointer = { x: event.clientX, y: event.clientY };
      activateUiControlTooltip(target);
    });
    target.addEventListener('pointermove', (event) => {
      uiControlTooltipPointer = { x: event.clientX, y: event.clientY };
    });
    target.addEventListener('pointerleave', (event) => {
      uiControlTooltipPointer = { x: event.clientX, y: event.clientY };
      reconcileUiControlTooltipAfterLeave(target);
    });
    target.addEventListener('focus', () => activateUiControlTooltip(target));
    target.addEventListener('blur', clearUiControlTooltip);
    target.addEventListener('click', clearUiControlTooltip);
    if (target.matches(':hover') && target.dataset.tooltip === uiControlTooltipText) {
      activateUiControlTooltip(target);
    }
  });
  const pointedTarget = getPointedUiControlTooltip();
  if (pointedTarget?.dataset.tooltip === uiControlTooltipText
    && pointedTarget !== uiControlTooltipTarget) {
    activateUiControlTooltip(pointedTarget);
  }
}

export function resolveTokenLaunchpad(
  address: string,
  chainValue: unknown = 'solana',
  launchpadValue: unknown = null,
): TokenLaunchpadKey {
  if (normalizeTokenChain(chainValue) === 'robinhood') {
    const launchpad = String(launchpadValue || '').trim().toLowerCase() as TokenLaunchpadKey;
    return ROBINHOOD_LAUNCHPAD_KEYS.has(launchpad) ? launchpad : 'uniswap';
  }
  const normalized = String(address || '').trim().toLowerCase();
  if (normalized.endsWith('pump')) return 'pump';
  if (normalized.endsWith('bags')) return 'bags';
  if (normalized.endsWith('bonk')) return 'bonk';
  if (normalized.endsWith('brrr')) return 'brrr';
  return 'meteora';
}

export function renderTokenLaunchpadBadge(
  address: string,
  chainValue: unknown = 'solana',
  launchpadValue: unknown = null,
  pairDexValue: unknown = null,
) {
  const key = resolveTokenLaunchpad(address, chainValue, launchpadValue);
  const meta = TOKEN_LAUNCHPAD_META[key];
  const pairDexId = String(pairDexValue || '').trim().toLowerCase();
  const poolLabel = pairDexId === 'uniswap-v2'
    ? 'Uniswap V2'
    : pairDexId === 'uniswap-v3'
      ? 'Uniswap V3'
      : pairDexId === 'uniswap-v4' ? 'Uniswap V4' : null;
  const title = normalizeTokenChain(chainValue) === 'robinhood' && poolLabel
    ? `${meta.label} · Pool: ${poolLabel}`
    : meta.label;
  const mark = meta.svgPath
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${meta.svgPath}"></path></svg>`
    : escapeHtml(meta.mark);
  return `<span class="token-launchpad-badge token-launchpad-${key}" title="${escapeHtml(title)}" aria-label="${escapeHtml(meta.label)}">${mark}</span>`;
}

function getSparklineRangePresetForScope(state: AppState, scope: SparklineRangeControlScope) {
  const range = state.ui.sparklineRange;
  if (scope === 'recent') return range.recentPreset;
  if (scope === 'oldWeek') return range.oldWeekPreset;
  return range.monitoredPreset;
}

function getSparklineRangeTooltip(scope: SparklineRangeControlScope) {
  if (scope === 'monitored') {
    return 'Select the default range used to load sparklines for Monitored and Manual tokens.';
  }
  return `Select the default range used to load sparklines for ${scope === 'recent' ? 'Recent' : 'Old'} tokens.`;
}

export function renderSparklineRangeControl(state: AppState, scope: SparklineRangeControlScope) {
  const activePreset = getSparklineRangePresetForScope(state, scope);
  const activeLabel = SPARKLINE_RANGE_OPTIONS.find((option) => option.preset === activePreset)?.label || '14D';
  return `
    <div class="sparkline-range-control" data-sparkline-range-scope="${scope}">
      <span class="sparkline-range-label">CHART</span>
      <div class="sort-menu-wrap sparkline-range-menu" data-sort-wrap>
        <button type="button" class="old-filter-btn active sparkline-range-button ui-control-tooltip" data-sort-toggle="sparkline-range-${scope}" data-tooltip="${escapeHtml(getSparklineRangeTooltip(scope))}" aria-label="Sparkline range">${activeLabel}</button>
        <div class="sort-menu-dropdown sparkline-range-dropdown">
          ${SPARKLINE_RANGE_OPTIONS.map((option) => (
            `<button type="button" class="sort-menu-item ${option.preset === activePreset ? 'active' : ''}" data-action="set-sparkline-range-preset" data-sparkline-range-scope="${scope}" data-sparkline-range-preset="${option.preset}">${option.label}</button>`
          )).join('')}
        </div>
      </div>
    </div>
  `;
}

function closeSparklineRangeMenu(button: HTMLButtonElement) {
  const wrap = button.closest<HTMLElement>('[data-sort-wrap]');
  wrap?.classList.remove('open');
  button.blur();
}

export function bindSparklineRangeControls(section: ParentNode, controller: AppController) {
  bindUiControlTooltips(section);
  section.querySelectorAll<HTMLButtonElement>('[data-action="set-sparkline-range-preset"]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeSparklineRangeMenu(button);
      const scope = button.dataset.sparklineRangeScope as SparklineRangeControlScope;
      controller.setSparklineRangePreset(scope, button.dataset.sparklineRangePreset as SparklineRangePreset);
    });
  });

}

type SparklineRenderOptions = {
  expanded?: boolean;
  expandable?: boolean;
  areaFill?: boolean;
  lookupKey?: string;
  variant?: 'default' | 'alert';
  markers?: MockTradingTradeEntry[];
  mockSolUsdcRate?: number;
  liveMcap?: number | null;
  preserveTerminalMove?: boolean;
  preserveTerminalScaleShift?: boolean;
  showTokenRangeControl?: boolean;
};

function shouldRenderTokenSparklineRangeControl(address: string, options: SparklineRenderOptions) {
  return Boolean(address && options.showTokenRangeControl !== false && !options.expanded && options.variant !== 'alert');
}

export function bindTokenActions(section: ParentNode, controller: AppController) {
  section.querySelectorAll<HTMLElement>('[data-table-chain-badge]').forEach((placeholder) => {
    const chain = normalizeTokenChain(placeholder.dataset.chain) || 'solana';
    const address = placeholder.dataset.address;
    if (address) {
      placeholder.replaceChildren(buildTokenChainBadge(chain, address));
    }
  });

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="remove-manual"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      const chain = normalizeTokenChain(button.dataset.chain) || 'solana';
      if (address) void controller.removeManualToken(address, chain);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="block-token"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      const label = button.dataset.label || null;
      const chain = normalizeTokenChain(button.dataset.chain) || 'solana';
      if (address) void controller.addBlockedToken(address, label, chain);
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
      const chain = normalizeTokenChain(button.dataset.chain) || 'solana';
      if (address) controller.dismissRecentToken(address, chain);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="dismiss-old-week"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      const chain = normalizeTokenChain(button.dataset.chain) || 'solana';
      if (address) controller.dismissOldWeekToken(address, chain);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="toggle-star"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', () => {
      const address = button.dataset.address;
      const chain = normalizeTokenChain(button.dataset.chain) || 'solana';
      if (!address) return;

      const willBeStarred = !button.classList.contains('active');
      const root = button.ownerDocument || document;
      const selector = `[data-action="toggle-star"][data-chain="${chain}"][data-address="${CSS.escape(address)}"]`;

      for (const starButton of root.querySelectorAll<HTMLButtonElement>(selector)) {
        starButton.classList.toggle('active', willBeStarred);
        starButton.textContent = willBeStarred ? '★' : '☆';

        const tokenRow = starButton.closest('.token-starred, tr, article, .token-row, .alert-row');
        if (tokenRow instanceof HTMLElement) {
          tokenRow.classList.toggle('token-starred', willBeStarred);
        }
      }

      void controller.toggleStarredToken(address, chain);
    });
  }

  bindManualQuickAddControls(section, controller);
}

function bindManualQuickAddControls(section: ParentNode, controller: AppController) {
  const scope = resolveManualQuickAddScope(section);
  const buildOpenKey = (chain: TokenChain, address: string) => `${scope}:${chain}:${address}`;
  const ownerDocument = (section instanceof Node && section.ownerDocument) || document;
  const closeMenus = (except?: HTMLElement | null) => {
    ownerDocument.querySelectorAll<HTMLElement>('.manual-quick-add-wrap.open').forEach((wrap) => {
      if (wrap !== except) {
        wrap.classList.remove('open');
      }
    });
    if (!except) {
      manualQuickAddOpenKey = null;
    }
  };

  section.querySelectorAll<HTMLElement>('.manual-quick-add-wrap').forEach((wrap) => {
    const address = wrap.querySelector<HTMLButtonElement>('[data-action="manual-quick-add"]')?.dataset.address;
    const chain = normalizeTokenChain(wrap.dataset.chain) || 'solana';
    wrap.classList.toggle('open', Boolean(address && buildOpenKey(chain, address) === manualQuickAddOpenKey));
  });

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="manual-quick-add"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const address = button.dataset.address;
      const chain = normalizeTokenChain(button.dataset.chain) || 'solana';
      if (!address) {
        return;
      }

      const wrap = button.closest<HTMLElement>('.manual-quick-add-wrap');
      if (controller.state.data.manualTokenFolders.length === 0 || !wrap) {
        void controller.addManualToken(address, null, chain);
        return;
      }

      const wasOpen = wrap.classList.contains('open');
      closeMenus(wrap);
      manualQuickAddOpenKey = wasOpen ? null : buildOpenKey(chain, address);
      wrap.classList.toggle('open', !wasOpen);
    });
  }

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="manual-quick-add-target"]')) {
    if (button.dataset.tokenActionBound === 'true') continue;
    button.dataset.tokenActionBound = 'true';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const address = button.dataset.address;
      const chain = normalizeTokenChain(button.dataset.chain) || 'solana';
      if (!address) {
        return;
      }

      closeMenus();
      if (button.dataset.target === 'folder') {
        const folderId = Number(button.dataset.folderId);
        if (Number.isInteger(folderId) && folderId > 0) {
          void controller.addManualTokenToFolder(folderId, address, chain);
        }
        return;
      }

      void controller.addManualToken(address, null, chain);
    });
  }

  if (!manualQuickAddDocumentCloseBound) {
    manualQuickAddDocumentCloseBound = true;
    ownerDocument.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('.manual-quick-add-wrap')) {
        return;
      }
      closeMenus();
    });
    ownerDocument.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeMenus();
      }
    });
  }
}

function resolveManualQuickAddScope(section: ParentNode) {
  const root = section instanceof Element ? section.closest<HTMLElement>('section') ?? section : null;
  if (root?.classList.contains('monitored-panel')) return 'monitored';
  if (root?.classList.contains('recent-bar')) return 'recent';
  if (root?.classList.contains('old-week-bar')) return 'old-week';
  return 'shared';
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
      const keepTextFeedback = !button.classList.contains('compact-copy-button')
        && !button.classList.contains('alert-ticker-peers-copy')
        && (button.classList.contains('alert-action-button') || Boolean(button.closest('.alerts-panel')));

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
  if (!(section instanceof EventTarget)) {
    return;
  }

  bindTokenImageLoadState(section);
  recoverMissingPumpTokenImages(section);
  if (tokenImagePreviewBoundRoots.has(section)) {
    return;
  }
  tokenImagePreviewBoundRoots.add(section);
  section.addEventListener('error', handleTokenImageLoadError, true);
  bindTokenImagePreviewGlobalEvents();
}

function bindTokenImageLoadState(section: ParentNode) {
  for (const image of section.querySelectorAll<HTMLImageElement>('img[data-token-image-preview="true"]')) {
    bindTokenImageElementLoadState(image);
  }
}

function bindTokenImageElementLoadState(image: HTMLImageElement) {
  if (image.dataset.tokenImageLoadStateBound === 'true') {
    return;
  }

  image.dataset.tokenImageLoadStateBound = 'true';
  const wrap = image.closest<HTMLElement>('.token-avatar-wrap');
  if (wrap && wrap.dataset.tokenImageState !== 'loaded') {
    wrap.dataset.tokenFallback = wrap.dataset.tokenFallback || getTokenImageFallbackText(image.alt);
    wrap.dataset.tokenImageState = 'pending';
  }
  const markLoaded = () => {
    image.dataset.tokenImageLoaded = 'true';
    wrap?.setAttribute('data-token-image-state', 'loaded');
  };

  const hasRequestedSource = Boolean(image.currentSrc || image.getAttribute('src'));
  if (image.complete && hasRequestedSource) {
    if (image.naturalWidth > 0) {
      markLoaded();
    } else {
      window.setTimeout(() => handleTokenImageFailure(image), 0);
    }
    return;
  }

  image.addEventListener('load', markLoaded, { once: true });
}

function handleTokenImageLoadError(event: Event) {
  if (!(event.target instanceof HTMLImageElement) || event.target.dataset.tokenImagePreview !== 'true') {
    return;
  }

  handleTokenImageFailure(event.target);
}

function handleTokenImageFailure(image: HTMLImageElement) {
  if (!image.isConnected || image.dataset.tokenImagePreview !== 'true') {
    return;
  }

  const failedSrc = image.currentSrc || image.src || image.dataset.tokenImagePreviewSrc || '';
  const wrap = image.closest<HTMLElement>('.token-avatar-wrap');
  const fallback = document.createElement('span');
  const fallbackLabel = wrap?.dataset.tokenFallback || getTokenImageFallbackText(image.alt);
  fallback.className = getTokenImageFallbackClassName(image);
  fallback.textContent = fallbackLabel;
  fallback.setAttribute('aria-label', fallbackLabel);
  fallback.dataset.tokenImageRecoveredPlaceholder = 'true';
  hideTokenImagePreview('image-error');
  image.replaceWith(fallback);
  wrap?.removeAttribute('data-token-image-state');
  void recoverPumpTokenImage(getTokenImageAddress(image), fallback, failedSrc, fallbackLabel);
}

function getTokenImageFallbackClassName(image: HTMLImageElement) {
  if (image.classList.contains('alert-avatar')) {
    return 'alert-avatar-placeholder';
  }
  if (image.classList.contains('tok-avatar')) {
    return 'tok-avatar-placeholder';
  }
  if (image.classList.contains('top-performer-avatar')) {
    return 'top-performer-avatar top-performer-avatar-placeholder';
  }
  return 'token-avatar placeholder';
}

function getTokenImageFallbackText(label: string) {
  const normalized = String(label || '').trim();
  return (normalized.slice(0, 2) || '?').toUpperCase();
}

function getTokenImageAddress(element: HTMLElement) {
  const explicitAddress = String(element.dataset.tokenAddress || '').trim();
  if (explicitAddress) {
    return explicitAddress;
  }

  const addressHost = element.closest<HTMLElement>('[data-token-address], [data-address]');
  return String(addressHost?.dataset.tokenAddress || addressHost?.dataset.address || '').trim();
}

function recoverMissingPumpTokenImages(section: ParentNode) {
  const placeholders = section.querySelectorAll<HTMLElement>(
    '.tok-avatar-placeholder, .alert-avatar-placeholder, .token-avatar.placeholder, .top-performer-avatar-placeholder',
  );

  for (const placeholder of placeholders) {
    if (placeholder.dataset.tokenImageRecoveryRequested === 'true') {
      continue;
    }
    placeholder.dataset.tokenImageRecoveryRequested = 'true';
    void recoverPumpTokenImage(getTokenImageAddress(placeholder), placeholder, '', placeholder.textContent || '');
  }
}

async function recoverPumpTokenImage(address: string, fallback: HTMLElement, failedSrc: string, altText: string) {
  if (!address.toLowerCase().endsWith('pump') || !fallback.isConnected) {
    return;
  }

  try {
    const apiBase = resolveApiBase();
    const response = await fetch(`${apiBase}/api/catalog/pumpfun/${encodeURIComponent(address)}/meta`, {
      cache: 'no-store',
      credentials: 'include',
    });
    if (!response.ok || !fallback.isConnected) {
      return;
    }

    const body = await response.json() as { imageUrl?: string | null };
    const recoveredSrc = sanitizeOptionalHttpUrl(body.imageUrl);
    if (!recoveredSrc || recoveredSrc === failedSrc || !fallback.isConnected) {
      return;
    }

    const recovered = document.createElement('img');
    recovered.alt = '';
    recovered.className = getRecoveredTokenImageClassName(fallback);
    recovered.dataset.tokenImagePreview = 'true';
    recovered.dataset.tokenImagePreviewSrc = recoveredSrc;
    recovered.dataset.tokenAddress = address;
    const wrap = fallback.closest<HTMLElement>('.token-avatar-wrap');
    if (wrap) {
      wrap.dataset.tokenFallback = getTokenImageFallbackText(altText);
      wrap.dataset.tokenImageState = 'pending';
    }
    bindTokenImageElementLoadState(recovered);
    fallback.replaceWith(recovered);
    recovered.src = recoveredSrc;
  } catch (_) {
    // Keep the placeholder when metadata recovery is unavailable.
  }
}

function getRecoveredTokenImageClassName(fallback: HTMLElement) {
  if (fallback.classList.contains('alert-avatar-placeholder')) {
    return 'alert-avatar';
  }
  if (fallback.classList.contains('tok-avatar-placeholder')) {
    return 'tok-avatar';
  }
  if (fallback.classList.contains('top-performer-avatar-placeholder')) {
    return 'top-performer-avatar';
  }
  return 'token-avatar';
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
  bindUiControlTooltips(section);
  for (const wrap of section.querySelectorAll<HTMLElement>('.sparkline-wrap')) {
    const lookupKey = String(wrap.dataset.sparklineKey || wrap.dataset.address || '').trim();
    const address = String(wrap.dataset.address || '').trim();
    const entry = sparklineByLookupKey[lookupKey];
    const chain = normalizeTokenChain(wrap.dataset.chain) || entry?.chain || 'solana';
    const series = normalizeSparklineSeries(entry?.series);
    const displaySeries = buildDisplaySparklineSeries(series, {
      expanded: wrap.classList.contains('sparkline-wrap-expanded'),
      variant: wrap.dataset.sparklineVariant === 'alert' ? 'alert' : 'default',
      preserveTerminalScaleShift: isFreshSparklineTerminal(entry),
    });
    bindExpandableSparkline(
      wrap,
      address,
      lookupKey,
      chain,
      options.controller,
    );
    bindTokenSparklineRangeControls(wrap, address, chain, options.controller);
    const hoverParts = resolveBindableSparklineHover(wrap, entry, series, displaySeries);
    if (!hoverParts) {
      continue;
    }

    const { hover, line, dot, tooltip } = hoverParts;

    let activeIndex = -1;

    const hide = () => {
      activeIndex = -1;
      closeTokenSparklineRangeMenu(wrap);
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
      const hoverValue = displaySeries[index] ?? series[index];
      tooltip.textContent = `${getTokenChartValuationLabel(entry)} ${fmtMoney(hoverValue)} · ~ ${formatApproxSparklineTime(entry, index, series.length)}`;
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

function updateTokenSparklineRangeMenuState(
  wrap: HTMLElement,
  address: string,
  chain: TokenChain,
  controller: AppController,
) {
  const identityKey = buildTokenIdentityKey(chain, address);
  const quickRangeHours = controller.state.ui.monitoredSparklineHoursByAddress[identityKey];
  const tokenPreset = controller.state.ui.sparklineRange.tokenPresetByAddress[identityKey]
    ?? (chain === 'solana' ? controller.state.ui.sparklineRange.tokenPresetByAddress[address] : null);
  const legacyDays = controller.state.ui.sparklineRange.tokenDaysByAddress[identityKey]
    ?? (chain === 'solana' ? controller.state.ui.sparklineRange.tokenDaysByAddress[address] : null);
  const overridePreset = quickRangeHours != null
    ? SPARKLINE_RANGE_PRESET_BY_HOURS.get(quickRangeHours)
    : tokenPreset ?? (legacyDays != null ? `${legacyDays}d` as SparklineRangePreset : null);
  const hasOverride = quickRangeHours != null || tokenPreset != null || legacyDays != null;
  wrap.querySelectorAll<HTMLButtonElement>('[data-action="reset-token-sparkline-range"]').forEach((button) => {
    button.classList.toggle('active', !hasOverride);
  });
  wrap.querySelectorAll<HTMLButtonElement>('[data-action="set-token-sparkline-range-preset"]').forEach((button) => {
    button.classList.toggle('active', button.dataset.sparklineRangePreset === overridePreset);
  });
}

function closeTokenSparklineRangeMenu(wrap: HTMLElement) {
  wrap.querySelector<HTMLElement>('[data-sparkline-token-range]')?.classList.remove('open');
}

function bindTokenSparklineRangeControls(
  wrap: HTMLElement,
  address: string,
  chain: TokenChain,
  controller?: AppController,
) {
  const menu = wrap.querySelector<HTMLElement>('[data-sparkline-token-range]');
  if (!menu || !controller || !address || menu.dataset.sparklineTokenRangeBound === 'true') {
    return;
  }

  menu.dataset.sparklineTokenRangeBound = 'true';
  updateTokenSparklineRangeMenuState(wrap, address, chain, controller);
  menu.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  menu.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target as HTMLElement | null;
    const trigger = target?.closest<HTMLButtonElement>('[data-action="toggle-token-sparkline-range"]');
    if (trigger) {
      menu.classList.toggle('open');
      return;
    }

    const resetButton = target?.closest<HTMLButtonElement>('[data-action="reset-token-sparkline-range"]');
    if (resetButton) {
      closeTokenSparklineRangeMenu(wrap);
      controller.resetTokenSparklineRangeDays(address, chain);
      return;
    }

    const presetButton = target?.closest<HTMLButtonElement>('[data-action="set-token-sparkline-range-preset"]');
    if (presetButton) {
      closeTokenSparklineRangeMenu(wrap);
      controller.setTokenSparklineRangePreset(
        address,
        presetButton.dataset.sparklineRangePreset as SparklineRangePreset,
        chain,
      );
    }
  });
}

function bindExpandableSparkline(
  wrap: HTMLElement,
  address: string,
  lookupKey: string,
  chain: TokenChain,
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
    controller.openExpandedSparkline(address, chain);
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
  options?: TradeTerminalOptions,
) {
  const links = getTradeTerminalLinks(address, mintAddress, pairAddress, options);
  if (links.length === 0) {
    return '';
  }
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
  options?: TradeTerminalOptions,
) {
  const links = getTradeTerminalLinks(address, mintAddress, pairAddress, options);
  if (links.length === 0) {
    return document.createDocumentFragment();
  }
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
  options?: TradeTerminalOptions,
): TradeTerminalLink[] {
  if (!supportsConfiguredTradeTerminals(options?.chain || 'solana')) {
    return [];
  }
  const tokenAddress = mintAddress || address;
  const terminalAddress = pairAddress || mintAddress || address;
  const axiomAddress = options?.axiomAddress || pairAddress || tokenAddress;
  const enabledTradeTerminals = normalizeEnabledTradeTerminals(options?.enabledTradeTerminals);
  const links: TradeTerminalLink[] = [
    { key: 'axiom', label: getTradeTerminalLabel('axiom'), href: `https://axiom.trade/meme/${axiomAddress}?chain=sol`, cls: 'axiom', iconHref: TRADE_TERMINAL_ICON_URLS.axiom },
    { key: 'photon', label: getTradeTerminalLabel('photon'), href: `https://photon-sol.tinyastro.io/en/lp/${tokenAddress}`, cls: 'photon', iconHref: TRADE_TERMINAL_ICON_URLS.photon },
    { key: 'bullx', label: getTradeTerminalLabel('bullx'), href: `https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenAddress}`, cls: 'bullx', iconHref: TRADE_TERMINAL_ICON_URLS.bullx },
    { key: 'gmgn', label: getTradeTerminalLabel('gmgn'), href: `https://gmgn.ai/sol/token/${tokenAddress}`, cls: 'gmgn', iconHref: TRADE_TERMINAL_ICON_URLS.gmgn },
    { key: 'padre', label: getTradeTerminalLabel('padre'), href: `https://trade.padre.gg/trade/solana/${terminalAddress}`, cls: 'padre', iconHref: TRADE_TERMINAL_ICON_URLS.padre },
    { key: 'fomo', label: getTradeTerminalLabel('fomo'), href: `https://fomo.family/tokens/solana/${tokenAddress}`, cls: 'fomo', iconHref: TRADE_TERMINAL_ICON_URLS.fomo },
  ];
  return links.filter((link) => enabledTradeTerminals.includes(link.key));
}

export function getTradeTerminalLabel(key: TradeTerminalKey) {
  return TRADE_TERMINAL_LABELS[key];
}

export function renderTradeTerminalIconForKey(key: TradeTerminalKey, className: string) {
  return renderTradeTerminalIconMarkup({
    key,
    label: getTradeTerminalLabel(key),
    href: '',
    cls: key,
    iconHref: TRADE_TERMINAL_ICON_URLS[key],
  }, className);
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
    if (item !== 'axiom' && item !== 'photon' && item !== 'bullx' && item !== 'gmgn' && item !== 'padre' && item !== 'fomo') {
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
  return `<p class="muted-block">No ${mode === 'recent' ? 'recent' : 'old-week'} tokens currently match the routed valuation and age filters.</p>`;
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
    manualTokenFolders?: AppState['data']['manualTokenFolders'];
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
      manualTokenFolders: options?.manualTokenFolders,
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

interface TokenTableShellOptions {
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
  manualTokenFolders?: AppState['data']['manualTokenFolders'];
  showSparkline?: boolean;
  sparklineByAddress?: Record<string, TokenSparklineEntry>;
  mockTradingPositionsByAddress?: Record<string, MockTradingPositionEntry>;
  mockTradingTradesByAddress?: Record<string, MockTradingTradeEntry[]>;
  mockSolUsdcRate?: number;
}

function resolveShellRowSparkline(options: TokenTableShellOptions, item: ManualTokenEntry) {
  if (!options.showSparkline) {
    return null;
  }
  const identityKey = buildTokenIdentityKey(item.chain || 'solana', item.address);
  return options.sparklineByAddress?.[identityKey]
    || ((item.chain || 'solana') === 'solana' ? options.sparklineByAddress?.[item.address] : null)
    || null;
}

function renderTokenTableShell(options: TokenTableShellOptions) {
  const hasFdvOnlyRows = options.rows.some((item) => resolveTokenValuation(item).type === 'fdv');
  return renderRadarTableShell(options, hasFdvOnlyRows);
}

function renderRadarTableShell(options: TokenTableShellOptions, hasFdvOnlyRows: boolean) {
  return `
    <div class="token-table-wrap token-table-${options.tone} radar-table-wrap">
      <table class="token-table ${options.tone} radar-table">
        <colgroup>
          <col class="radar-col-ident" />
          <col class="radar-col-chart" />
          <col class="radar-col-size" />
          <col class="radar-col-trio" />
          <col class="radar-col-trio" />
        </colgroup>
        <thead>
          <tr>
            <th>Token</th>
            <th class="radar-chart-col">Chart</th>
            <th>${hasFdvOnlyRows ? 'MCAP / FDV' : 'MCAP'} / Size</th>
            <th class="metric-group-start">Volume&nbsp;&nbsp;1H / 6H / 24H</th>
            <th class="metric-group-start">Change&nbsp;&nbsp;1H / 6H / 24H</th>
          </tr>
        </thead>
        <tbody>
          ${options.rows.map((item, index) => renderRadarTokenTableRow({
            busy: options.busy,
            enabledTradeTerminals: options.enabledTradeTerminals,
            isAdmin: Boolean(options.isAdmin),
            isStarred: options.starredSet.has(buildTokenIdentityKey(item.chain || 'solana', item.address)),
            item,
            mode: options.mode,
            manualTokenFolders: options.manualTokenFolders ?? [],
            meteoraByAddress: options.meteoraByAddress,
            meteoraMinPool: options.meteoraMinPool,
            mockSolUsdcRate: options.mockSolUsdcRate,
            mockTradingPosition: options.mockTradingPositionsByAddress?.[item.address] || null,
            mockTradingTrades: options.mockTradingTradesByAddress?.[item.address] || [],
            rank: (options.startRank ?? 1) + index,
            sparkline: resolveShellRowSparkline(options, item),
          })).join('')}
        </tbody>
      </table>
    </div>
  `;
}

interface RadarTokenRowOptions {
  busy: boolean;
  enabledTradeTerminals: TradeTerminalKey[];
  isAdmin: boolean;
  isStarred: boolean;
  item: ManualTokenEntry;
  mode: 'manual' | 'recent' | 'old-week';
  manualTokenFolders: AppState['data']['manualTokenFolders'];
  meteoraByAddress: Record<string, MeteoraEntry>;
  meteoraMinPool: number;
  mockSolUsdcRate?: number;
  mockTradingPosition: MockTradingPositionEntry | null;
  mockTradingTrades: MockTradingTradeEntry[];
  rank: number;
  sparkline: TokenSparklineEntry | null;
}

function renderRadarTokenTableRow(options: RadarTokenRowOptions) {
  const { item, mode } = options;
  const chain = normalizeTokenChain(item.chain) || 'solana';
  const isSolana = chain === 'solana';
  const symbol = item.symbol || item.label || item.address.slice(0, 6);
  const safeAddress = escapeHtml(item.address);
  const safeSymbol = escapeHtml(symbol);
  const safeName = escapeHtml(item.name || item.label || item.address);
  const safeIdentity = escapeHtml(buildTokenIdentityKey(chain, item.address));
  const dexUrl = sanitizeHttpUrl(resolveTokenTablePrimaryUrl(item, chain));
  const meteora = isSolana ? options.meteoraByAddress[item.address] : undefined;
  const mockTradingLine = isSolana
    ? renderMockTradingLine(options.mockTradingPosition, options.mockTradingTrades, options.mockSolUsdcRate)
    : '';

  return `
    <tr class="radar-row ${buildTokenTableRowClass(mode, item, options.isStarred)}" data-hover-key="${mode}:${safeIdentity}" data-token-identity="${safeIdentity}">
      <td class="radar-ident-col">
        <div class="token-cell radar-ident">
          <span class="radar-rank">#${options.rank}</span>
          ${renderAvatar(item, symbol)}
          <div class="token-main radar-ident-main">
            <div class="token-line radar-name-line">
              <a class="token-symbol" href="${dexUrl}" target="_blank" rel="noreferrer">${safeSymbol}</a>
              <span class="token-subline radar-subname">${safeName}</span>
              <span data-radar-identity-badges data-chain="${chain}" data-address="${safeAddress}"></span>
              ${renderRadarDataState(mode, item)}
            </div>
            <div class="token-actions-inline radar-actions">
              ${renderRadarRowGlyphs(options, chain, safeAddress, safeSymbol, symbol)}
            </div>
            ${mockTradingLine}
          </div>
        </div>
      </td>
      <td class="sparkline-col radar-chart-col">${renderSparklineCell(options.sparkline, item, isSolana ? options.mockTradingTrades : [], options.mockSolUsdcRate)}</td>
      <td class="radar-size-col">${renderRadarSizeBlock(item, meteora, options.meteoraMinPool)}</td>
      <td class="radar-trio-col metric-group-start">${renderRadarVolumeTrio(item, mode)}</td>
      <td class="radar-trio-col metric-group-start">${renderRadarChangeTrio(item, mode)}</td>
    </tr>
  `;
}

function renderRadarRowGlyphs(
  options: RadarTokenRowOptions,
  chain: TokenChain,
  safeAddress: string,
  safeSymbol: string,
  symbol: string,
) {
  const { item, mode } = options;
  const xSearch = buildXSearchUrl(symbol, item.address, resolveTokenAgeMs(item.createdAt));
  const twitterUrl = sanitizeOptionalHttpUrl(item.twitterUrl);
  const communityUrl = sanitizeOptionalHttpUrl(item.communityUrl);
  return `
    <a class="action-glyph x-search" href="${sanitizeHttpUrl(xSearch)}" target="_blank" rel="noreferrer" title="Search contract or ticker on X">X</a>
    ${renderTokenSocialActions(twitterUrl, communityUrl)}
    <button type="button" class="action-glyph copy-button" data-action="copy-address" data-address="${safeAddress}" title="Copy contract">&#10697;</button>
    ${renderTradeTerminalMenu(item.address, item.mintAddress, item.pairAddress, { chain: item.chain, enabledTradeTerminals: options.enabledTradeTerminals })}
    ${renderTokenTableActions({
      busy: options.busy,
      chain,
      isAdmin: options.isAdmin,
      isStarred: options.isStarred,
      manualTokenFolders: options.manualTokenFolders,
      mockTradingPosition: options.mockTradingPosition,
      mode,
      safeAddress,
      safeSymbol,
    })}
    ${renderRadarRemoveManualGlyph(mode, chain, safeAddress, options.busy)}
  `;
}

function renderRadarRemoveManualGlyph(
  mode: 'manual' | 'recent' | 'old-week',
  chain: TokenChain,
  safeAddress: string,
  busy: boolean,
) {
  if (mode !== 'manual') {
    return '';
  }

  return `<button type="button" class="action-glyph danger-glyph radar-remove-manual" data-action="remove-manual" data-chain="${chain}" data-address="${safeAddress}" ${busy ? 'disabled' : ''} title="Remove from manual tokens">X</button>`;
}

function renderRadarSizeBlock(item: ManualTokenEntry, meteora: MeteoraEntry | undefined, meteoraMinPool: number) {
  return `
    <dl class="radar-size">
      <div class="radar-size-item"><dt>MC</dt><dd>${renderTokenTableValuation(item)}</dd></div>
      <div class="radar-size-item"><dt>LQ</dt><dd>${renderTotalLiquidityCell(item, meteora, meteoraMinPool)}</dd></div>
      <div class="radar-size-item"><dt>AGE</dt><dd class="radar-size-age ${getAgeToneClassFromCreatedAt(item.createdAt)}">${item.createdAt ? fmtAge(item.createdAt) : '-'}</dd></div>
      <div class="radar-size-item"><dt>HLD</dt><dd class="radar-size-empty" title="Holders data is not tracked yet">-</dd></div>
    </dl>
  `;
}

const RADAR_TRIO_WINDOWS = [
  { key: '1h', label: '1H' },
  { key: '6h', label: '6H' },
  { key: '24h', label: '24H' },
] as const;

function renderRadarVolumeTrio(item: ManualTokenEntry, mode: 'manual' | 'recent' | 'old-week') {
  const coverage = { ...item.coverage };
  const values: Record<string, number | null | undefined> = {
    '1h': item.volume1h,
    '6h': item.volume6h,
    '24h': item.volume24h,
  };
  const cells = RADAR_TRIO_WINDOWS.map(({ key, label }) => `
    <div class="radar-cell">
      <small>${label}</small>
      <b>${renderBucketMoneyMetric(mode, values[key], coverage[key])}</b>
    </div>
  `).join('');
  return `<div class="radar-trio">${cells}</div>`;
}

/**
 * Manual rows carry no rolling-window coverage, so the tint has to come from the
 * raw value there; radar rows only tint when coverage reports the value usable.
 */
function resolveRadarChangeTone(
  mode: 'manual' | 'recent' | 'old-week',
  value: number | null | undefined,
  coverage: TokenMetricCoverage | undefined,
) {
  if (mode === 'manual') {
    return value != null && Number.isFinite(value) ? (value >= 0 ? ' up' : ' down') : '';
  }

  const metric = resolveCoveredMetric(value, coverage);
  return metric.available ? (Number(metric.value) >= 0 ? ' up' : ' down') : '';
}

function renderRadarChangeTrio(item: ManualTokenEntry, mode: 'manual' | 'recent' | 'old-week') {
  const coverage = { ...item.priceChangeCoverage };
  const values: Record<string, number | null | undefined> = {
    '1h': item.priceChange1h,
    '6h': item.priceChange6h,
    '24h': item.priceChange24h,
  };
  const cells = RADAR_TRIO_WINDOWS.map(({ key, label }) => `
    <div class="radar-cell radar-cell-pchg${resolveRadarChangeTone(mode, values[key], coverage[key])}">
      <small>${label}</small>
      <b>${renderBucketPriceChangeMetric(mode, values[key], coverage[key])}</b>
    </div>
  `).join('');
  return `<div class="radar-trio">${cells}</div>`;
}

function normalizeSparklineSeries(series: number[] | null | undefined) {
  return Array.isArray(series) ? series.filter((value) => Number.isFinite(value)) : [];
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

function buildDisplaySparklineSeries(series: number[], options: SparklineRenderOptions = {}) {
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

  if (options.preserveTerminalMove && spikeIndex >= series.length - 3) {
    return series;
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

function isFreshSparklineTerminal(entry?: TokenSparklineEntry | null, now = Date.now()) {
  const latestTsMs = Date.parse(String(entry?.latestBucketAt || ''));
  if (!Number.isFinite(latestTsMs)) {
    return false;
  }

  const granularityMinutes = Math.max(1, Math.round(Number(entry?.granularityMinutes) || 1));
  const freshnessMs = Math.max(3 * 60 * 1000, granularityMinutes * 3 * 60 * 1000);
  return now - latestTsMs >= 0 && now - latestTsMs <= freshnessMs;
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

export function formatPriceUsd(value?: number | null) {
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
  const parts = [`Mini ${getTokenChartValuationLabel(entry)} chart`, `${series.length} pts`];
  parts.push(`${formatSparklineSpan(entry.effectiveHours, entry.hours)} span`);
  parts.push(`${formatSparklineGranularity(entry.granularityMinutes)} resolution`);

  if (entry.coverageRatio != null && Number.isFinite(entry.coverageRatio)) {
    parts.push(`${Math.round(entry.coverageRatio * 100)}% cov`);
  }
  if (entry.generatedAt) {
    parts.push(`updated ${new Date(entry.generatedAt).toLocaleString()}`);
  }

  return parts.join(' · ');
}

function formatSparklineSpan(hours?: number | null, maxHours?: number | null) {
  const safeHours = Number(hours);
  const safeMaxHours = Number(maxHours);
  const maxLabel = Number.isFinite(safeMaxHours) && safeMaxHours > 0
    ? `${Math.max(1, Math.round(safeMaxHours / 24))}D max`
    : '14D max';
  if (!Number.isFinite(safeHours) || safeHours <= 0) {
    return maxLabel;
  }

  if (safeHours >= 24) {
    const days = Math.max(1, Math.round(safeHours / 24));
    return `${days}D of ${maxLabel}`;
  }

  return `${Math.max(1, Math.round(safeHours))}H of ${maxLabel}`;
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

function renderTokenSparklineRangeHoverControl(address: string, entry: TokenSparklineEntry, options: SparklineRenderOptions) {
  if (!shouldRenderTokenSparklineRangeControl(address, options)) {
    return '';
  }

  const safeAddress = escapeHtml(address);
  const requestedHours = Number(entry.hours);
  const activeLabel = entry.allAvailable || requestedHours === 0
    ? 'ALL'
    : SPARKLINE_RANGE_OPTIONS.find((option) => option.hours === requestedHours)?.label || '14D';
  return `
    <span class="sparkline-token-range" data-sparkline-token-range>
      <button type="button" class="sparkline-token-range-trigger ui-control-tooltip" data-action="toggle-token-sparkline-range" data-address="${safeAddress}" data-tooltip="Choose a custom range for this token's sparkline." aria-label="Token chart range">${activeLabel}</button>
      <span class="sparkline-token-range-menu" role="menu">
        <button type="button" class="sparkline-token-range-item" data-action="reset-token-sparkline-range" data-address="${safeAddress}" role="menuitem">AUTO</button>
        ${SPARKLINE_RANGE_OPTIONS.map((option) => (
          `<button type="button" class="sparkline-token-range-item" data-action="set-token-sparkline-range-preset" data-address="${safeAddress}" data-sparkline-range-preset="${option.preset}" role="menuitem">${option.label}</button>`
        )).join('')}
      </span>
    </span>
  `;
}

export function renderSparklineFigure(entry: TokenSparklineEntry | null, address?: string, options: SparklineRenderOptions = {}) {
  if (!entry) {
    return renderSparklinePlaceholder(entry);
  }
  const series = normalizeSparklineSeries(entry.series);
  const displaySeries = buildDisplaySparklineSeries(series, {
    ...options,
    preserveTerminalScaleShift: options.preserveTerminalScaleShift || isFreshSparklineTerminal(entry),
  });
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
  const rangeControl = renderTokenSparklineRangeHoverControl(wrapMeta.safeAddress, entry, options);

  return `
    <div class="sparkline-wrap ${trendClass}${wrapMeta.expandedClass}${wrapMeta.filledClass}${wrapMeta.variantClass}" data-chain="${entry.chain || 'solana'}" data-address="${wrapMeta.safeAddress}" data-sparkline-key="${wrapMeta.safeLookupKey}" data-sparkline-summary="${wrapMeta.summaryAttr}"${wrapMeta.expandableAttr}${wrapMeta.variantAttr}>
      <svg class="token-sparkline${wrapMeta.svgExpandedClass}" viewBox="0 0 ${dimensions.width} ${dimensions.height}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        ${areaPolyline ? `<polygon class="token-sparkline-area" points="${areaPolyline}"></polygon>` : ''}
        <polyline class="token-sparkline-glow" points="${polyline}"></polyline>
        <polyline class="token-sparkline-line" points="${polyline}"></polyline>
        ${tradeMarkers}
      </svg>
      <div class="sparkline-hover">
        <span class="sparkline-hover-line" aria-hidden="true"></span>
        <span class="sparkline-hover-dot" aria-hidden="true"></span>
        <span class="sparkline-hover-tooltip"></span>
        ${rangeControl}
      </div>
    </div>
  `;
}

function renderSparklineCell(entry: TokenSparklineEntry | null, item: ManualTokenEntry, markers: MockTradingTradeEntry[] = [], mockSolUsdcRate?: number) {
  const chain = normalizeTokenChain(item.chain) || 'solana';
  return renderSparklineFigure(entry, item.address, {
    expandable: true,
    areaFill: true,
    lookupKey: buildTokenIdentityKey(chain, item.address),
    markers,
    mockSolUsdcRate,
    liveMcap: resolveTokenValuation(item).value,
  });
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

export function renderManualQuickAddAction(
  safeAddress: string,
  busy: boolean,
  folders: AppState['data']['manualTokenFolders'] = [],
  chain: TokenChain = 'solana',
) {
  const menu = folders.length > 0
    ? `
      <span class="manual-quick-add-menu" role="menu">
        <button type="button" class="manual-quick-add-option" data-action="manual-quick-add-target" data-target="all" data-chain="${chain}" data-address="${safeAddress}" role="menuitem">All</button>
        ${folders.map((folder) => `
          <button type="button" class="manual-quick-add-option" data-action="manual-quick-add-target" data-target="folder" data-folder-id="${folder.id}" data-chain="${chain}" data-address="${safeAddress}" role="menuitem">${escapeHtml(folder.name)}</button>
        `).join('')}
      </span>
    `
    : '';

  return `
    <span class="manual-quick-add-wrap" data-chain="${chain}">
      <button type="button" class="action-glyph manual-quick-add-button" data-action="manual-quick-add" data-chain="${chain}" data-address="${safeAddress}" ${busy ? 'disabled' : ''} title="Add to manual tokens">+</button>
      ${menu}
    </span>
  `;
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

function renderBucketMoneyMetric(
  mode: 'manual' | 'recent' | 'old-week',
  value: number | null | undefined,
  coverage?: TokenMetricCoverage,
) {
  if (mode === 'manual') return fmtMoney(value);
  const metric = resolveCoveredMetric(value, coverage);
  const state = metric.available ? metric.coverage : 'unavailable';
  const title = state === 'complete'
    ? 'Complete rolling-window coverage'
    : state === 'partial' ? 'Partial rolling-window coverage' : 'Rolling-window value unavailable';
  const formatted = metric.available ? `${metric.isPartial ? '~' : ''}${fmtMoney(metric.value)}` : '-';
  return `<span class="radar-coverage radar-coverage-${state}" title="${title}">${formatted}</span>`;
}

function renderBucketPriceChangeMetric(
  mode: 'manual' | 'recent' | 'old-week',
  value: number | null | undefined,
  coverage?: TokenMetricCoverage,
) {
  if (mode === 'manual') return renderPctSpan(value);
  const metric = resolveCoveredMetric(value, coverage);
  if (!metric.available) {
    return '<span class="pct-neutral radar-coverage radar-coverage-unavailable" title="Rolling-window value unavailable">-</span>';
  }
  const cls = Number(metric.value) >= 0 ? 'pct-pos' : 'pct-neg';
  const title = metric.isPartial ? 'Partial rolling-window coverage' : 'Complete rolling-window coverage';
  const prefix = `${metric.isPartial ? '~' : ''}${Number(metric.value) >= 0 ? '+' : ''}`;
  return `<span class="${cls} radar-coverage radar-coverage-${metric.coverage}" title="${title}">${prefix}${Number(metric.value).toFixed(2)}%</span>`;
}

function renderRadarDataState(mode: 'manual' | 'recent' | 'old-week', item: ManualTokenEntry) {
  if (mode === 'manual') return '';
  const valuation = resolveTokenValuation(item);
  const valuationBadge = valuation.freshness === 'stale'
    ? `<span class="radar-data-state radar-data-state-stale" title="Valuation observed at ${escapeHtml(valuation.observedAt || 'an earlier snapshot')}">STALE VALUATION</span>`
    : '';
  const activityBadge = item.activityState === 'stale'
    ? '<span class="radar-data-state radar-activity-state" title="Token remains in Radar; no recent accepted activity was observed">NO RECENT ACTIVITY</span>'
    : '';
  return `${valuationBadge}${activityBadge}`;
}

function buildTokenTableRowClass(
  mode: 'manual' | 'recent' | 'old-week',
  item: ManualTokenEntry,
  isStarred: boolean,
) {
  const activityClass = mode !== 'manual' && item.activityState === 'stale' ? ' radar-activity-stale' : '';
  return `${isStarred ? 'token-starred' : ''}${activityClass}`.trim();
}

function resolveTokenTablePrimaryUrl(item: ManualTokenEntry, chain: TokenChain) {
  return buildTokenMarketUrl(chain, item.address, item.pairUrl)
    || buildTokenExplorerUrl(chain, item.address)
    || '';
}

function renderTokenTableActions(options: {
  busy: boolean;
  chain: TokenChain;
  isAdmin: boolean;
  isStarred: boolean;
  manualTokenFolders: AppState['data']['manualTokenFolders'];
  mockTradingPosition: MockTradingPositionEntry | null;
  mode: 'manual' | 'recent' | 'old-week';
  safeAddress: string;
  safeSymbol: string;
}) {
  const quickAdd = options.mode === 'manual'
    ? ''
    : renderManualQuickAddAction(
      options.safeAddress, options.busy, options.manualTokenFolders, options.chain,
    );
  const star = `<button type="button" class="action-glyph starred-button ${options.isStarred ? 'active' : ''}" data-action="toggle-star" data-chain="${options.chain}" data-address="${options.safeAddress}" ${options.busy ? 'disabled' : ''} title="Star token">${options.isStarred ? '&#9733;' : '&#9734;'}</button>`;
  const block = `<button type="button" class="action-glyph danger-glyph" data-action="block-token" data-chain="${options.chain}" data-address="${options.safeAddress}" data-label="${options.safeSymbol}" ${options.busy ? 'disabled' : ''} title="Block token">&#8855;</button>`;
  const solanaOnly = options.chain === 'solana'
    ? `${renderMockTradingActions(
      options.isAdmin,
      options.safeAddress,
      options.mockTradingPosition,
      options.busy,
    )}${renderTokenAdminAction(options.isAdmin, options.safeAddress, options.safeSymbol, options.busy)}`
    : '';
  return `${quickAdd}${star}${block}${solanaOnly}`;
}

function renderTokenTableValuation(item: ManualTokenEntry) {
  const valuation = resolveTokenValuation(item);
  const prefix = valuation.type === 'fdv' ? 'FDV ' : '';
  const freshnessClass = valuation.freshness === 'stale' ? ' radar-valuation-stale' : '';
  const title = valuation.observedAt ? ` title="Observed at ${escapeHtml(valuation.observedAt)}"` : '';
  return `<span class="radar-valuation${freshnessClass}"${title}>${prefix}${fmtMoney(valuation.value)}</span>`;
}

const X_SEARCH_MIN_FAVES = 1;
const X_SEARCH_YOUNG_TOKEN_MS = 12 * 3600000;

export function resolveTokenAgeMs(createdAt?: number | null) {
  const created = Number(createdAt);
  if (!Number.isFinite(created) || created <= 0) {
    return null;
  }
  return Math.max(0, Date.now() - created);
}

export function buildXSearchUrl(symbol: string, address: string, ageMs?: number | null) {
  const safeAddress = String(address || '').replace(/"/g, '').trim();
  const safeSymbol = String(symbol || '').replace(/"/g, '').trim();
  const terms = [
    safeAddress ? `"${safeAddress}"` : '',
    safeSymbol ? `$${safeSymbol}` : '',
  ].filter(Boolean);
  if (!terms.length) {
    return 'https://x.com/search';
  }
  const grouped = terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0];
  const age = Number(ageMs);
  const isYoungToken = !Number.isFinite(age) || age < X_SEARCH_YOUNG_TOKEN_MS;
  const query = isYoungToken ? grouped : `${grouped} min_faves:${X_SEARCH_MIN_FAVES}`;
  return `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
}

const METEORA_TVL_HISTORY_1H = 3600000;
const METEORA_TVL_HISTORY_4H = 14400000;
const METEORA_TVL_HISTORY_24H = 86400000;

function getMeteoraTvlChange(entry: MeteoraEntry, windowMs: number) {
  if (windowMs === METEORA_TVL_HISTORY_1H && entry.change1h != null) {
    return entry.change1h;
  }
  if (windowMs === METEORA_TVL_HISTORY_4H && entry.change4h != null) {
    return entry.change4h;
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

export function renderMeteoraCell(address: string, entry: MeteoraEntry | undefined, minPool: number) {
  if (!entry || entry.noPool || !(entry.tvl > 0) || (minPool > 0 && entry.tvl < minPool)) {
    return '-';
  }

  const ch1h = getMeteoraTvlChange(entry, METEORA_TVL_HISTORY_1H);
  const ch4h = getMeteoraTvlChange(entry, METEORA_TVL_HISTORY_4H);
  const ch24h = getMeteoraTvlChange(entry, METEORA_TVL_HISTORY_24H);
  const poolLabel = escapeHtml((entry.poolCount || 0) > 1 ? `${entry.poolCount} pools` : '1 pool');

  return `
    <div class="met-tip-wrap">
      <span class="meteora-value">$${fmtCompact(entry.tvl)}</span>
      <div class="met-tip-dd">
        <div class="meteora-tip-head"><span>🌊 Meteora TVL</span><span>${poolLabel}</span></div>
        ${renderMeteoraDelta('1H', ch1h)}
        ${renderMeteoraDelta('4H', ch4h)}
        ${renderMeteoraDelta('24H', ch24h)}
      </div>
    </div>
  `;
}

function normalizePoolAddress(value?: string | null) {
  return String(value || '').trim().toLowerCase();
}

function getPositiveNumber(value?: number | null) {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function getNonNegativeNumber(value?: number | null) {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function hasVisibleMeteoraPool(entry: MeteoraEntry | undefined, minPool: number) {
  return Boolean(entry && !entry.noPool && getPositiveNumber(entry.tvl) != null && !(minPool > 0 && Number(entry.tvl) < minPool));
}

function getVisibleMeteoraTvl(entry: MeteoraEntry | undefined, minPool: number) {
  if (!hasVisibleMeteoraPool(entry, minPool)) {
    return null;
  }
  return getPositiveNumber(entry?.tvl);
}

function getTotalLiquidityValue(item: ManualTokenEntry, entry: MeteoraEntry | undefined, minPool: number) {
  const dexLiquidity = getPositiveNumber(item.liquidityUsd);
  const meteoraTvl = getVisibleMeteoraTvl(entry, minPool);

  if (dexLiquidity != null && meteoraTvl != null) {
    const dexPairAddress = normalizePoolAddress(item.pairAddress);
    const meteoraPoolAddress = normalizePoolAddress(entry?.poolAddress);
    return dexPairAddress && dexPairAddress === meteoraPoolAddress
      ? Math.max(dexLiquidity, meteoraTvl)
      : dexLiquidity + meteoraTvl;
  }

  return dexLiquidity ?? meteoraTvl;
}

function renderLiquidityTipLine(label: string, value: string, valueClass = '') {
  const classAttr = valueClass ? ` class="${escapeHtml(valueClass)}"` : '';
  return `<div class="meteora-tip-line"><span>${escapeHtml(label)}</span><span${classAttr}>${escapeHtml(value)}</span></div>`;
}

function renderMeteoraChangeValue(value?: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return '<span class="muted">-</span>';
  }
  const cls = value >= 0 ? 'pct-pos' : 'pct-neg';
  return `<span class="${cls}">${value >= 0 ? '+' : ''}${value.toFixed(1)}%</span>`;
}

function renderMeteoraVolumeValue(value?: number | null) {
  const volume = getNonNegativeNumber(value);
  return volume != null ? escapeHtml(fmtMoney(volume)) : '<span class="muted">-</span>';
}

function renderMoneyTipLine(label: string, value?: number | null, valueClass = '') {
  return renderLiquidityTipLine(label, value != null ? fmtMoney(value) : '-', valueClass);
}

function getMeteoraPoolLabel(entry: MeteoraEntry | undefined, hasMeteora: boolean) {
  if (!hasMeteora) return 'no Meteora pool';
  const poolCount = Number(entry?.poolCount) || 0;
  return poolCount > 1 ? `${poolCount} pools` : '1 pool';
}

function getMeteoraTooltipDelta(entry: MeteoraEntry | undefined, hasMeteora: boolean, windowMs: number) {
  if (!hasMeteora || !entry) return null;
  return getMeteoraTvlChange(entry, windowMs);
}

function getMeteoraTooltipVolume(
  entry: MeteoraEntry | undefined,
  hasMeteora: boolean,
  key: 'volume1h' | 'volume4h' | 'volume24h',
) {
  if (!hasMeteora || !entry) return null;
  return entry[key];
}

function renderMeteoraMetricHeader() {
  return `
    <div class="meteora-tip-metric-head">
      <span></span>
      <span>Pool Chg</span>
      <span>Vol</span>
    </div>
  `;
}

function renderMeteoraMetricLine(label: string, change?: number | null, volume?: number | null) {
  return `
    <div class="meteora-tip-metric-line">
      <span>${escapeHtml(label)}</span>
      <span>${renderMeteoraChangeValue(change)}</span>
      <span>${renderMeteoraVolumeValue(volume)}</span>
    </div>
  `;
}

function formatPairDexSource(value?: string | null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'DEX pair';
  if (normalized === 'pumpswap') return 'PumpSwap';
  if (normalized === 'pumpfun') return 'Pump.fun';
  if (normalized === 'raydium') return 'Raydium';
  if (normalized === 'meteora') return 'Meteora';
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function renderTotalLiquidityTooltip(
  item: ManualTokenEntry,
  entry: MeteoraEntry | undefined,
  hasMeteora: boolean,
  dexLiquidity?: number | null,
  meteoraTvl?: number | null,
) {
  const tvlClass = meteoraTvl != null ? 'meteora-liq-tip-value' : '';
  const coverageLabel = item.liquidityIsLowerBound
    ? `${Number(item.valuedLiquidityMarketCount) || 0}/${Number(item.liquidityMarketCount) || 0} pools valued`
    : getMeteoraPoolLabel(entry, hasMeteora);
  return `
    <div class="meteora-tip-head"><span>${item.liquidityIsLowerBound ? 'Known Liq Min' : 'Total Liq'}</span><span>${escapeHtml(coverageLabel)}</span></div>
    ${renderMoneyTipLine(formatPairDexSource(item.pairDexId), dexLiquidity)}
    ${renderMoneyTipLine('Meteora TVL', meteoraTvl, tvlClass)}
    ${renderMeteoraMetricHeader()}
    ${renderMeteoraMetricLine('MET 1H', getMeteoraTooltipDelta(entry, hasMeteora, METEORA_TVL_HISTORY_1H), getMeteoraTooltipVolume(entry, hasMeteora, 'volume1h'))}
    ${renderMeteoraMetricLine('MET 4H', getMeteoraTooltipDelta(entry, hasMeteora, METEORA_TVL_HISTORY_4H), getMeteoraTooltipVolume(entry, hasMeteora, 'volume4h'))}
    ${renderMeteoraMetricLine('MET 24H', getMeteoraTooltipDelta(entry, hasMeteora, METEORA_TVL_HISTORY_24H), getMeteoraTooltipVolume(entry, hasMeteora, 'volume24h'))}
  `;
}

export function renderTotalLiquidityCell(item: ManualTokenEntry, entry: MeteoraEntry | undefined, minPool: number) {
  const totalLiquidity = getTotalLiquidityValue(item, entry, minPool);
  if (totalLiquidity == null) {
    return '-';
  }

  const dexLiquidity = getPositiveNumber(item.liquidityUsd);
  const hasMeteora = hasVisibleMeteoraPool(entry, minPool);
  const meteoraTvl = getVisibleMeteoraTvl(entry, minPool);
  const hasCombinedSources = dexLiquidity != null && meteoraTvl != null;
  const valueClass = hasCombinedSources ? 'total-liq-value has-meteora' : 'total-liq-value';

  return `
    <div class="met-tip-wrap total-liq-tip-wrap">
      <span class="${valueClass}">${escapeHtml(`${fmtMoney(totalLiquidity)}${item.liquidityIsLowerBound ? '+' : ''}`)}</span>
      <div class="met-tip-dd total-liq-tip-dd">
        ${renderTotalLiquidityTooltip(item, entry, hasMeteora, dexLiquidity, meteoraTvl)}
      </div>
    </div>
  `;
}

function renderAvatar(item: ManualTokenEntry, symbol: string) {
  const safeSymbol = escapeHtml(symbol);
  const safeAddress = escapeHtml(item.address);
  const fallback = escapeHtml(symbol.slice(0, 2).toUpperCase());
  const imageUrl = sanitizeOptionalHttpUrl(item.imageUrl);
  const safeImageUrl = imageUrl ? escapeHtml(imageUrl) : '';
  const avatar = imageUrl
    ? `<img src="${safeImageUrl}" alt="" aria-label="${safeSymbol}" class="token-avatar" data-token-image-preview="true" data-token-image-preview-src="${safeImageUrl}" data-token-address="${safeAddress}" />`
    : `<div class="token-avatar placeholder" data-token-address="${safeAddress}">${fallback}</div>`;
  return `<span class="token-avatar-wrap" data-token-address="${safeAddress}" data-token-fallback="${fallback}"${imageUrl ? ' data-token-image-state="pending"' : ''}>${avatar}${renderTokenLaunchpadBadge(item.address, item.chain, item.launchpadId, item.pairDexId)}</span>`;
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

/**
 * Market cap cell of a ticker peer row, shared by the monitored and alert panels.
 * A peer the catalog stopped refreshing keeps showing its last known value, so it
 * is marked instead of hidden: that value is also why the peer cannot hold `#1`.
 */
export function buildTickerPeerMcapLabel(peer: { mcap?: number | null; mcapStale?: boolean; mcapAgeMs?: number | null }) {
  const label = document.createElement('span');
  label.className = 'alert-ticker-peers-mcap';
  if (!peer.mcapStale) {
    label.textContent = fmtMoney(peer.mcap);
    return label;
  }

  const ageMs = Number(peer.mcapAgeMs);
  const staleFor = Number.isFinite(ageMs) && ageMs > 0
    ? ` for ${fmtAgeFromDurationMs(ageMs)}`
    : '';
  label.dataset.mcapStale = 'true';
  label.title = `Market cap not refreshed${staleFor} — cannot hold the #1 badge`;

  const mark = document.createElement('span');
  mark.className = 'alert-ticker-peers-stale-mark';
  mark.textContent = '⧗';
  const value = document.createElement('span');
  value.textContent = fmtMoney(peer.mcap);
  label.append(mark, value);
  return label;
}

export function fmtAgeFromDurationMs(ageMs: number | null | undefined) {
  if (ageMs == null) {
    return '-';
  }

  const duration = Number(ageMs);
  if (!Number.isFinite(duration) || duration < 0) {
    return '-';
  }

  const monthDays = 30;
  const months = Math.floor(duration / (monthDays * 86400000));
  if (months >= 12) {
    return `${Math.floor(months / 12)}y`;
  }
  if (months >= 1) {
    return `${months}mo`;
  }

  const days = Math.floor(duration / 86400000);
  if (days >= 1) {
    return `${days}d`;
  }
  const hours = Math.floor(duration / 3600000);
  if (hours >= 1) {
    return `${hours}h`;
  }
  const minutes = Math.floor(duration / 60000);
  if (minutes >= 1) {
    return `${minutes}m`;
  }
  return '0m';
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

export function getAgeToneClassFromAgeMs(ageMs: number | null | undefined) {
  if (!(Number(ageMs) >= 0)) {
    return 'white';
  }

  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  const oneMonthMs = 30 * 24 * 60 * 60 * 1000;
  const normalizedAgeMs = Number(ageMs);
  if (normalizedAgeMs <= oneWeekMs) {
    return 'up';
  }
  if (normalizedAgeMs < oneMonthMs) {
    return 'warn';
  }
  return 'down';
}

export function getAgeToneClassFromCreatedAt(createdAt: number | null | undefined) {
  const createdAtMs = Number(createdAt);
  if (!(createdAtMs > 0)) {
    return 'white';
  }

  return getAgeToneClassFromAgeMs(Math.max(0, Date.now() - createdAtMs));
}

export function fmtConfig(state: AppState, key: string, fallback: number) {
  const value = Number(state.data.configs[key]);
  return Number.isFinite(value) ? value : fallback;
}

export function renderTokenCard(item: ManualTokenEntry, busy: boolean, options: { mode: 'manual' | 'monitored' | 'recent' | 'old-week'; isStarred?: boolean; isAdmin?: boolean; enabledTradeTerminals?: TradeTerminalKey[] }) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderManualTokenTable(
    [item], busy,
    options.isStarred ? [buildTokenIdentityKey(item.chain || 'solana', item.address)] : [],
    [{ mode: 'mcap', window: 'highest' }], {}, 5000, Boolean(options.isAdmin),
    options.enabledTradeTerminals ?? DEFAULT_TRADE_TERMINALS,
  );
  return wrapper.innerHTML;
}

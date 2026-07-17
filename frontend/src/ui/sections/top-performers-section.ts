import type { AppController } from '../../state/app-controller';
import { getChainCapabilityNotice, getTokenSparkline, getTopPerformerTokens, type AppState, type ManualTokenEntry } from '../../state/app-state';
import { bindCopyButtons, bindSparklineHover, bindTokenActions, bindTokenImagePreview, fmtAge, fmtMoney, fmtPct, renderSparklineFigure } from './shared';
import { escapeHtml, sanitizeOptionalHttpUrl } from './html-safety';
import { resolveTokenValuation } from '../../utils/token-valuation';
import { buildTokenIdentityBadgeGroup } from '../token-chain-badge';
import { buildTokenExplorerUrl, buildTokenIdentityKey, buildTokenMarketUrl } from '../../utils/token-chain';

function renderTokenAvatar(token: ManualTokenEntry) {
  const symbol = String(token.symbol || token.label || token.address.slice(0, 4)).trim();
  const imageUrl = sanitizeOptionalHttpUrl(token.imageUrl);
  const safeAddress = escapeHtml(token.address);
  const fallback = escapeHtml(symbol.slice(0, 2).toUpperCase());
  const stateAttr = imageUrl ? ' data-token-image-state="pending"' : '';
  const avatar = imageUrl
    ? `<img class="top-performer-avatar" src="${escapeHtml(imageUrl)}" alt="" aria-label="${escapeHtml(symbol)}" data-token-image-preview="true" data-token-image-preview-src="${escapeHtml(imageUrl)}" data-token-address="${safeAddress}" />`
    : `<span class="top-performer-avatar top-performer-avatar-placeholder" data-token-address="${safeAddress}">${fallback}</span>`;
  return `<span class="token-avatar-wrap top-performer-avatar-wrap" data-token-address="${safeAddress}" data-token-fallback="${fallback}"${stateAttr}>${avatar}</span>`;
}

const TOP_PERFORMERS_MANUAL_PAUSE_MS = 4000;
const TOP_PERFORMERS_INITIAL_AUTO_SCROLL_MS = 1800;
const TOP_PERFORMERS_AUTO_SCROLL_PX_PER_SEC = 32;
const TOP_PERFORMERS_OLD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function resolveTopPerformerPrimaryLink(chain: ManualTokenEntry['chain'], address: string, pairUrl: string | null | undefined) {
  const marketUrl = buildTokenMarketUrl(chain || 'solana', address, pairUrl);
  if (marketUrl) return { url: marketUrl, label: 'pair' };
  const explorerUrl = buildTokenExplorerUrl(chain || 'solana', address);
  return explorerUrl ? { url: explorerUrl, label: 'explorer' } : null;
}

let topPerformersManualPauseUntil = 0;
let topPerformersProgrammaticScrollUntil = 0;

type TopPerformersLayoutMetrics = {
  clientWidth: number;
  loopWidth: number;
  maxScrollLeft: number;
  scrollWidth: number;
};

type TopPerformersDebugEvent = {
  event: string;
  t: number;
  details: Record<string, unknown>;
};

type TopPerformersDebugWindow = Window & {
  __topPerformersDebugCopy?: () => Promise<string | undefined>;
  __topPerformersDebugDump?: () => TopPerformersDebugEvent[];
  __topPerformersDebugEvents?: TopPerformersDebugEvent[];
  __topPerformersDebugNoticeShown?: boolean;
  __topPerformersDebugText?: () => string;
};

export function isTopPerformersDebugEnabled() {
  try {
    return window.localStorage.getItem('topPerformersDebug') === '1'
      || new URLSearchParams(window.location.search).has('topDebug');
  } catch (_) {
    return false;
  }
}

export function logTopPerformersDebug(event: string, details: Record<string, unknown> = {}) {
  if (!isTopPerformersDebugEnabled()) return;
  const debugWindow = window as TopPerformersDebugWindow;
  const events = debugWindow.__topPerformersDebugEvents ?? [];
  const entry = {
    event,
    t: Math.round(performance.now()),
    details,
  };

  events.push(entry);
  if (events.length > 250) {
    events.splice(0, events.length - 250);
  }

  debugWindow.__topPerformersDebugEvents = events;
  debugWindow.__topPerformersDebugDump = () => [...events];
  debugWindow.__topPerformersDebugText = () => JSON.stringify(events, null, 2);
  debugWindow.__topPerformersDebugCopy = async () => {
    const text = debugWindow.__topPerformersDebugText?.() || '[]';
    try {
      await navigator.clipboard.writeText(text);
      console.info(`[top-performers] copied ${events.length} debug events`);
    } catch (err) {
      console.info('[top-performers] clipboard copy failed; returning debug text instead', err);
      console.log(text);
      return text;
    }
  };

  if (!debugWindow.__topPerformersDebugNoticeShown) {
    debugWindow.__topPerformersDebugNoticeShown = true;
    console.info('[top-performers] debug buffering enabled. Run await window.__topPerformersDebugCopy() or window.__topPerformersDebugText() after reproducing.');
  }

  if (window.localStorage.getItem('topPerformersDebugConsole') === '1') {
    console.debug('[top-performers]', event, entry);
  }
}

function renderTopPerformerCard(state: AppState, token: ManualTokenEntry, options: { duplicate?: boolean } = {}) {
  const address = token.address;
  const symbol = String(token.symbol || token.label || address.slice(0, 8)).trim();
  const chain = token.chain || 'solana';
  const rank = token.performanceRank ?? 0;
  const valuation = resolveTokenValuation(token);
  const chartEnabled = state.data.chainReadiness[chain]?.capabilities.charts === true;
  const sparkline = chartEnabled ? getTokenSparkline(state, address, chain) : null;
  const primaryLink = resolveTopPerformerPrimaryLink(chain, address, token.pairUrl);
  const duplicateAttrs = options.duplicate ? ' aria-hidden="true"' : '';
  const duplicateActionAttrs = options.duplicate ? ' tabindex="-1"' : '';
  const adminAction = state.session.role === 'admin' && chain === 'solana'
    ? `<button type="button" class="inline-icon top-performer-admin-block" data-action="admin-block-token" data-address="${escapeHtml(address)}" data-label="${escapeHtml(symbol)}" title="Admin block permanently" aria-label="Admin block ${escapeHtml(symbol)} permanently"${duplicateActionAttrs}>☠</button>`
    : '';
  const age = token.createdAt ? fmtAge(token.createdAt) : '-';
  const ageToneClass = getTopPerformerAgeToneClass(token.createdAt);

  return `
    <article class="top-performer-card${options.duplicate ? ' is-duplicate' : ''}" data-address="${escapeHtml(address)}"${duplicateAttrs}>
      <div class="top-performer-header">
        ${renderTokenAvatar(token)}
        <strong class="top-performer-symbol">${escapeHtml(symbol)}</strong>
        ${buildTokenIdentityBadgeGroup(null, chain, address).outerHTML}
        <span class="top-performer-rank">#${rank || '-'}</span>
      </div>
      <div class="top-performer-metrics">
        <div class="top-performer-change">${escapeHtml(fmtPct(token.priceChange24h))}<span class="top-performer-change-window">24h</span></div>
        <div class="top-performer-stats">
          <span class="top-performer-stat"><span class="top-performer-stat-label">${escapeHtml(valuation.label)}</span><span class="top-performer-stat-value">${escapeHtml(fmtMoney(valuation.value))}</span></span>
          <span class="top-performer-stat"><span class="top-performer-stat-label">VOL 24H</span><span class="top-performer-stat-value">${escapeHtml(fmtMoney(token.volume24h))}</span></span>
          <span class="top-performer-stat"><span class="top-performer-stat-label">AGE</span><span class="top-performer-stat-value ${ageToneClass}">${escapeHtml(age)}</span></span>
        </div>
      </div>
      <div class="top-performer-chart">
        ${chartEnabled ? renderSparklineFigure(sparkline, address, {
          areaFill: true,
          lookupKey: buildTokenIdentityKey(chain, address),
          liveMcap: valuation.value,
        }) : ''}
      </div>
      <div class="top-performer-actions">
        <button type="button" class="inline-icon copy-button" data-action="copy-address" data-address="${escapeHtml(address)}" title="Copy contract" aria-label="Copy ${escapeHtml(symbol)} contract"${duplicateActionAttrs}>⧉</button>
        ${primaryLink ? `<a class="inline-icon top-performer-open" href="${escapeHtml(primaryLink.url)}" target="_blank" rel="noreferrer" title="Open ${primaryLink.label}" aria-label="Open ${escapeHtml(symbol)} ${primaryLink.label}"${duplicateActionAttrs}>↗</a>` : ''}
        ${adminAction}
      </div>
    </article>
  `;
}

function getTopPerformerAgeToneClass(createdAt?: number | null) {
  const createdAtMs = Number(createdAt);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    return '';
  }
  return Date.now() - createdAtMs >= TOP_PERFORMERS_OLD_AGE_MS
    ? 'top-performer-age-old'
    : 'top-performer-age-new';
}

function renderTopPerformerCards(state: AppState, tokens: ManualTokenEntry[], options: { duplicate?: boolean } = {}) {
  return tokens.map((token) => renderTopPerformerCard(state, token, options)).join('');
}

type TopPerformersRenderOptions = {
  autoScrollStartDelayMs?: number;
};

function bindTopPerformersAutoScroll(section: HTMLElement, options: TopPerformersRenderOptions = {}) {
  const viewport = section.querySelector<HTMLElement>('.top-performers-viewport');
  if (!viewport || viewport.dataset.autoScrollBound === 'true') return;
  viewport.dataset.autoScrollBound = 'true';

  const cards = viewport.querySelectorAll('.top-performer-card:not(.is-duplicate)');
  logTopPerformersDebug('bind', {
    cards: cards.length,
    scrollLeft: Math.round(viewport.scrollLeft),
    scrollWidth: Math.round(viewport.scrollWidth),
    clientWidth: Math.round(viewport.clientWidth),
  });
  if (cards.length <= 1) {
    logTopPerformersDebug('auto-scroll-disabled', { reason: 'not-enough-cards', cards: cards.length });
    return;
  }

  let initialTimeoutId = 0;
  let layoutRetryId = 0;
  let animationFrameId = 0;
  let resumeTimeoutId = 0;
  let lastFrameAt = 0;
  let lastLoggedScrollLeft = -1;
  let autoScrollLeft = viewport.scrollLeft;
  let layoutMetrics: TopPerformersLayoutMetrics = {
    clientWidth: 0,
    loopWidth: 0,
    maxScrollLeft: 0,
    scrollWidth: 0,
  };
  let resizeObserver: ResizeObserver | null = null;

  const refreshLayoutMetrics = () => {
    const track = viewport.querySelector<HTMLElement>('.top-performers-track:not(.top-performers-track-clone)');
    const gap = Number.parseFloat(getComputedStyle(viewport).columnGap || getComputedStyle(viewport).gap || '0') || 0;
    const scrollWidth = viewport.scrollWidth;
    const clientWidth = viewport.clientWidth;
    layoutMetrics = {
      clientWidth,
      loopWidth: track ? track.offsetWidth + gap : 0,
      maxScrollLeft: Math.max(0, scrollWidth - clientWidth),
      scrollWidth,
    };
    return layoutMetrics;
  };

  const pauseForManualInput = (reason: string) => {
    topPerformersManualPauseUntil = Date.now() + TOP_PERFORMERS_MANUAL_PAUSE_MS;
    logTopPerformersDebug('manual-pause', {
      reason,
      untilMs: TOP_PERFORMERS_MANUAL_PAUSE_MS,
      scrollLeft: Math.round(viewport.scrollLeft),
    });
  };

  const clearTimers = () => {
    window.clearTimeout(initialTimeoutId);
    window.clearTimeout(layoutRetryId);
    window.clearTimeout(resumeTimeoutId);
    if (animationFrameId) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = 0;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
  };

  const scheduleResume = (delayMs: number) => {
    window.clearTimeout(resumeTimeoutId);
    resumeTimeoutId = window.setTimeout(() => {
      lastFrameAt = 0;
      animationFrameId = window.requestAnimationFrame(tick);
    }, Math.max(120, delayMs));
  };

  const tick = (frameAt: number) => {
    if (!viewport.isConnected) {
      logTopPerformersDebug('auto-scroll-stop', { reason: 'viewport-disconnected' });
      clearTimers();
      return;
    }

    const now = Date.now();
    const { clientWidth, loopWidth, maxScrollLeft, scrollWidth } = layoutMetrics;
    if (maxScrollLeft <= 4 || loopWidth <= 4) {
      logTopPerformersDebug('auto-scroll-skip', {
        reason: 'no-overflow',
        remainingPauseMs: 0,
        scrollLeft: Math.round(viewport.scrollLeft),
        scrollWidth: Math.round(scrollWidth),
        clientWidth: Math.round(clientWidth),
      });
      scheduleResume(1000);
      return;
    }

    if (now < topPerformersManualPauseUntil) {
      const remainingPauseMs = Math.max(0, topPerformersManualPauseUntil - now);
      logTopPerformersDebug('auto-scroll-skip', {
        reason: 'manual-pause-active',
        remainingPauseMs: Number.isFinite(remainingPauseMs) ? remainingPauseMs : 'hover',
        scrollLeft: Math.round(viewport.scrollLeft),
        scrollWidth: Math.round(scrollWidth),
        clientWidth: Math.round(clientWidth),
      });
      if (Number.isFinite(remainingPauseMs)) {
        scheduleResume(remainingPauseMs);
      }
      return;
    }

    const deltaSeconds = lastFrameAt > 0 ? Math.min(0.08, (frameAt - lastFrameAt) / 1000) : 0;
    lastFrameAt = frameAt;
    if (deltaSeconds > 0) {
      if (Date.now() > topPerformersProgrammaticScrollUntil && Math.abs(viewport.scrollLeft - autoScrollLeft) > 2) {
        autoScrollLeft = viewport.scrollLeft;
      }
      let targetLeft = autoScrollLeft + (TOP_PERFORMERS_AUTO_SCROLL_PX_PER_SEC * deltaSeconds);
      if (targetLeft >= maxScrollLeft) {
        targetLeft = 0;
        logTopPerformersDebug('auto-scroll-wrap', {
          maxScrollLeft: Math.round(maxScrollLeft),
        });
      }
      autoScrollLeft = targetLeft;
      topPerformersProgrammaticScrollUntil = Date.now() + 120;
      viewport.scrollLeft = targetLeft;
    }

    animationFrameId = window.requestAnimationFrame(tick);
  };

  const startAutoScroll = (attempt = 0) => {
    if (!viewport.isConnected) {
      logTopPerformersDebug('auto-scroll-stop', { reason: 'viewport-disconnected-before-start' });
      return;
    }

    const metrics = refreshLayoutMetrics();
    const hasOverflow = metrics.maxScrollLeft > 4;
    if (!hasOverflow && attempt < 20) {
      layoutRetryId = window.setTimeout(() => startAutoScroll(attempt + 1), 100);
      return;
    }

    logTopPerformersDebug('auto-scroll-start', {
      attempt,
      hasOverflow,
      loopWidth: Math.round(metrics.loopWidth),
      scrollLeft: Math.round(viewport.scrollLeft),
      scrollWidth: Math.round(metrics.scrollWidth),
      clientWidth: Math.round(metrics.clientWidth),
    });

    const startDelayMs = Math.max(0, options.autoScrollStartDelayMs ?? TOP_PERFORMERS_INITIAL_AUTO_SCROLL_MS);
    initialTimeoutId = window.setTimeout(() => {
      lastFrameAt = 0;
      autoScrollLeft = viewport.scrollLeft;
      logTopPerformersDebug('auto-scroll-continuous-start', {
        speedPxPerSec: TOP_PERFORMERS_AUTO_SCROLL_PX_PER_SEC,
        startDelayMs,
      });
      animationFrameId = window.requestAnimationFrame(tick);
    }, startDelayMs);
  };

  refreshLayoutMetrics();
  const observedTrack = viewport.querySelector<HTMLElement>('.top-performers-track:not(.top-performers-track-clone)');
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      refreshLayoutMetrics();
      autoScrollLeft = Math.min(viewport.scrollLeft, layoutMetrics.maxScrollLeft);
    });
    resizeObserver.observe(viewport);
    if (observedTrack) {
      resizeObserver.observe(observedTrack);
    }
  }

  window.requestAnimationFrame(() => startAutoScroll());

  viewport.addEventListener('focusin', () => {
    pauseForManualInput('focusin');
  });
  viewport.addEventListener('focusout', () => {
    topPerformersManualPauseUntil = Math.min(topPerformersManualPauseUntil, Date.now() + 1000);
  });
  viewport.addEventListener('pointerenter', () => {
    topPerformersManualPauseUntil = Number.POSITIVE_INFINITY;
    logTopPerformersDebug('manual-pause', {
      reason: 'pointerenter',
      untilMs: 'hover',
      scrollLeft: Math.round(viewport.scrollLeft),
    });
  });
  viewport.addEventListener('pointerleave', () => {
    topPerformersManualPauseUntil = Date.now() + 500;
    scheduleResume(500);
    logTopPerformersDebug('manual-pause-end', {
      reason: 'pointerleave',
      resumeInMs: 500,
      scrollLeft: Math.round(viewport.scrollLeft),
    });
  });
  viewport.addEventListener('pointerdown', () => pauseForManualInput('pointerdown'));
  viewport.addEventListener('wheel', () => pauseForManualInput('wheel'), { passive: true });
  viewport.addEventListener('keydown', () => pauseForManualInput('keydown'));
  viewport.addEventListener('scroll', () => {
    if (Date.now() > topPerformersProgrammaticScrollUntil) {
      autoScrollLeft = viewport.scrollLeft;
    }
    if (Math.abs(viewport.scrollLeft - lastLoggedScrollLeft) >= 4) {
      const programmatic = Date.now() <= topPerformersProgrammaticScrollUntil;
      logTopPerformersDebug('scroll', {
        scrollLeft: Math.round(viewport.scrollLeft),
        programmatic,
        scrollWidth: Math.round(viewport.scrollWidth),
        clientWidth: Math.round(viewport.clientWidth),
      });
      lastLoggedScrollLeft = viewport.scrollLeft;
    }
  }, { passive: true });
}

export function renderTopPerformersSection(state: AppState, controller: AppController, options: TopPerformersRenderOptions = {}) {
  const section = document.createElement('section');
  section.id = 'top-performers-section';
  section.className = 'legacy-token-bar top-performers-bar';
  const capabilityNotice = getChainCapabilityNotice(state, 'topPerformers');

  const tokens = getTopPerformerTokens(state)
    .slice()
    .sort((a, b) => (a.performanceRank ?? 999) - (b.performanceRank ?? 999));
  logTopPerformersDebug('render', {
    generatedAt: state.data.topPerformersGeneratedAt,
    tokens: tokens.map((token) => `${token.performanceRank ?? '-'}:${token.address.slice(0, 6)}`),
    sparklineCount: tokens.filter((token) => getTokenSparkline(state, token.address, token.chain || 'solana')).length,
  });

  section.innerHTML = `
    <div class="legacy-bar-head top-performers-head">
      <span class="legacy-bar-title top-performers">Best Perfomance Coins</span>
    </div>
    ${
      capabilityNotice
        ? `<div class="chain-readiness-empty" data-chain-readiness-surface="top-performers">${escapeHtml(capabilityNotice)}</div>`
        : tokens.length > 0
        ? `<div class="top-performers-viewport">
            <div class="top-performers-track">${renderTopPerformerCards(state, tokens)}</div>
          </div>`
        : '<div class="top-performers-empty">Waiting for eligible performers...</div>'
    }
  `;

  bindCopyButtons(section);
  bindTokenActions(section, controller);
  bindSparklineHover(section, state.data.sparklineByAddress, { controller });
  bindTokenImagePreview(section);
  bindTopPerformersAutoScroll(section, options);
  return section;
}

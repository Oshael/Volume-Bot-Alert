import type { AppController } from '../../state/app-controller';
import type { AppState, PumpMigrationEntry, PumpTokenEntry } from '../../state/app-state';
import { bindCopyButtons, bindTokenActions, fmtAge, fmtConfig, fmtMoney, renderTradeTerminalMenu } from './shared';
import { escapeHtml, sanitizeOptionalHttpUrl } from './html-safety';

export function renderPumpfunSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'panel legacy-panel pump-panel';
  const visibleTokens = getVisiblePumpTokens(state);
  section.innerHTML = `
    <div class="panel-header" style="border-color:rgba(176,106,255,0.2)">
      <span style="color:var(--pump-color)">&#9889; PUMPFUN - LIVE</span>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:9px;color:var(--muted)">ENTRY ($)</span>
        <input class="panel-mini-input" name="pump-entry-vol" type="number" value="${fmtConfig(state, 'pump-entry-vol', 3000)}">
        <span style="font-size:9px;color:var(--muted)">ALERT ($)</span>
        <input class="panel-mini-input" name="pump-min-vol" type="number" value="${fmtConfig(state, 'pump-min-vol', 100000)}">
        <span class="count" style="background:rgba(176,106,255,0.15);color:var(--pump-color)">${visibleTokens.length}</span>
      </div>
    </div>
    <div class="panel-toolbar panel-toolbar-between">
      <div class="panel-status">${state.pumpfun.connected ? 'Connected via server' : state.pumpfun.statusLabel}</div>
    </div>
    <div class="pump-list">${visibleTokens.length ? visibleTokens.map((item) => renderPumpRow(item, state.ui.busy, state)).join('') : '<div class="empty-state"><div class="empty-text">Waiting for PumpFun rows...</div></div>'}</div>
    <div class="pump-migration-footer">${renderPumpMigrationStrip(state.data.recentPumpMigrations)}</div>
  `;

  section.querySelectorAll<HTMLInputElement>('.panel-mini-input').forEach((input) => {
    input.addEventListener('change', () => {
      void controller.saveMonitoringConfig({
        'pump-entry-vol': Number((section.querySelector('input[name="pump-entry-vol"]') as HTMLInputElement)?.value || 3000),
        'pump-min-vol': Number((section.querySelector('input[name="pump-min-vol"]') as HTMLInputElement)?.value || 100000),
      });
    });
  });

  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-action="remove-pump"]')) {
    button.addEventListener('click', () => {
      const mint = button.dataset.mint;
      if (mint) controller.removePumpToken(mint);
    });
  }

  bindTokenActions(section, controller);
  bindCopyButtons(section);
  return section;
}

function getVisiblePumpTokens(state: AppState) {
  const entryVol = fmtConfig(state, 'pump-entry-vol', 3000);
  const maxAgeMin = fmtConfig(state, 'pump-max-age-min', 0);
  const now = Date.now();
  return [...state.data.pumpTokens]
    .filter((item) => {
      if (item._migrated || item.hidden || state.data.dismissedPump.includes(item.mint) || getPumpVolume5m(item) < entryVol) return false;
      if (maxAgeMin > 0 && item.createdAt) {
        const ageMinutes = (now - item.createdAt) / 60000;
        if (ageMinutes > maxAgeMin) return false;
      }
      return true;
    })
    .sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
}

function renderPumpRow(token: PumpTokenEntry, busy: boolean, state: AppState) {
  const symbol = token.symbol || token.mint.slice(0, 6);
  const subtitle = token.name || 'PumpFun token';
  const safeMint = escapeHtml(token.mint);
  const safeSymbol = escapeHtml(symbol);
  const safeSubtitle = escapeHtml(subtitle);
  const age = token.createdAt ? fmtAge(token.createdAt) : '-';
  const vol5m = getPumpVolume5m(token);
  const bondPct = Math.min(100, Math.max(0, ((token.mcap || 0) / Math.max(1, state.pumpfun.bondTargetMcap || 35000)) * 100));
  const showBond = state.pumpfun.migrationCount >= 1;
  const bondTone = bondPct > 60 ? 'bond-hot' : bondPct > 30 ? 'bond-warm' : 'bond-cool';
  const mcapTone = showBond ? `pump-mcap-tone ${bondTone}` : 'pump-mcap-tone bond-cool';
  const imageUrl = sanitizeOptionalHttpUrl(token.imageUrl);
  const avatar = imageUrl ? `<img src="${imageUrl}" alt="${safeSymbol}" class="tok-avatar" />` : `<div class="tok-avatar-placeholder">${safeSymbol.slice(0, 2).toUpperCase()}</div>`;

  return `
    <article class="pump-token-row" data-mint="${safeMint}" data-hover-key="pump:${safeMint}">
      ${avatar}
      <div class="pump-row-main">
        <div class="panel-row-title"><span class="token-name">${safeSymbol}</span> <span class="token-addr">${safeSubtitle}</span></div>
        <div class="panel-row-meta pump-meta-line"><span class="meta-white">VOL 5M ${fmtMoney(vol5m)}</span> <span class="pump-inline-mcap ${mcapTone}">MCAP ${fmtMoney(token.mcap)}</span> <span class="meta-white">AGE ${age}</span></div>
        ${showBond ? `<div class="pump-bond-shell compact"><div class="pump-bond-fill ${bondTone}" style="width:${bondPct.toFixed(0)}%"></div></div>` : ''}
      </div>
      <div class="pump-side-metrics"><div class="pump-mcap ${mcapTone}">MC ${fmtMoney(token.mcap)}</div><div class="pump-vol">V ${fmtMoney(token.volTotal)}</div></div>
      <div class="pump-inline-actions"><button type="button" class="action-glyph copy-button" data-action="copy-address" data-address="${safeMint}" title="Copy contract">&#10697;</button>${renderTradeTerminalMenu(token.mint, token.mintAddress || token.mint, token.pairAddress)}<button type="button" class="action-glyph danger-glyph" data-action="remove-pump" data-mint="${safeMint}" ${busy ? 'disabled' : ''} title="Remove row">X</button></div>
    </article>
  `;
}

function renderPumpMigrationStrip(entries: PumpMigrationEntry[]) {
  if (entries.length === 0) {
    return '<div class="empty-state compact">No PumpFun migrations captured in this session yet.</div>';
  }

  return `<div class="pump-migration-strip">${entries.slice(0, 3).map((entry) => `<div class="panel-chip">${escapeHtml(entry.symbol)} ${escapeHtml(fmtMoney(entry.mcap))}</div>`).join('')}</div>`;
}

function getPumpVolume5m(token: PumpTokenEntry) {
  return (token.vol5m || []).reduce((sum, point) => sum + point.usd, 0);
}

import type { AppController } from '../../state/app-controller';
import type { AppState, PumpMigrationEntry, PumpTokenEntry } from '../../state/app-state';
import { bindCopyButtons, bindTokenActions, buildTradeTerminalMenuElement, fmtAge, fmtConfig, fmtMoney } from './shared';
import { sanitizeOptionalHttpUrl } from './html-safety';

export function renderPumpfunSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  const isCollapsed = state.ui.collapsed.pumpfun;
  section.className = `panel legacy-panel pump-panel${isCollapsed ? ' panel-collapsed' : ''}`;
  const visibleTokens = getVisiblePumpTokens(state);
  if (isCollapsed) {
    section.innerHTML = `
      <div class="panel-header" style="border-color:rgba(176,106,255,0.2)">
        <span style="color:var(--pump-color)">&#9889; PUMPFUN - LIVE</span>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="count" style="background:rgba(176,106,255,0.15);color:var(--pump-color)">${visibleTokens.length}</span>
          <button type="button" class="compact-icon-toggle section-collapse-toggle panel-collapse-toggle" data-action="toggle-section-collapse" data-section="pumpfun" aria-label="Expand pumpfun panel"><span class="compact-icon-glyph">+</span></button>
        </div>
      </div>
    `;
  } else {
    section.innerHTML = `
      <div class="panel-header" style="border-color:rgba(176,106,255,0.2)">
        <span style="color:var(--pump-color)">&#9889; PUMPFUN - LIVE</span>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button type="button" class="compact-icon-toggle section-collapse-toggle panel-collapse-toggle" data-action="toggle-section-collapse" data-section="pumpfun" aria-label="Collapse pumpfun panel"><span class="compact-icon-glyph">−</span></button>
          <span style="font-size:9px;color:var(--muted)">ENTRY ($)</span>
          <input class="panel-mini-input" name="pump-entry-vol" type="number">
          <span style="font-size:9px;color:var(--muted)">ALERT ($)</span>
          <input class="panel-mini-input" name="pump-min-vol" type="number">
          <span class="count" style="background:rgba(176,106,255,0.15);color:var(--pump-color)">${visibleTokens.length}</span>
        </div>
      </div>
      <div class="panel-toolbar panel-toolbar-between">
        <div class="panel-status">${state.pumpfun.connected ? 'Connected via server' : state.pumpfun.statusLabel}</div>
      </div>
      <div class="pump-list"></div>
      <div class="pump-migration-footer"></div>
    `;
  }

  section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
    controller.toggleSectionCollapsed('pumpfun');
  });

  if (isCollapsed) {
    return section;
  }

  const pumpList = section.querySelector<HTMLElement>('.pump-list');
  if (pumpList) {
    if (visibleTokens.length) {
      for (const item of visibleTokens) {
        pumpList.append(buildPumpRow(item, state.ui.busy, state));
      }
    } else {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      const emptyText = document.createElement('div');
      emptyText.className = 'empty-text';
      emptyText.textContent = 'Waiting for PumpFun rows...';
      emptyState.append(emptyText);
      pumpList.append(emptyState);
    }
  }
  section.querySelector<HTMLElement>('.pump-migration-footer')?.append(buildPumpMigrationStrip(state.data.recentPumpMigrations));
  const entryInput = section.querySelector<HTMLInputElement>('input[name="pump-entry-vol"]');
  if (entryInput) {
    entryInput.value = String(fmtConfig(state, 'pump-entry-vol', 3000));
  }
  const minVolInput = section.querySelector<HTMLInputElement>('input[name="pump-min-vol"]');
  if (minVolInput) {
    minVolInput.value = String(fmtConfig(state, 'pump-min-vol', 100000));
  }

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

function buildPumpRow(token: PumpTokenEntry, busy: boolean, state: AppState) {
  const symbol = token.symbol || token.mint.slice(0, 6);
  const subtitle = token.name || 'PumpFun token';
  const age = token.createdAt ? fmtAge(token.createdAt) : '-';
  const vol5m = getPumpVolume5m(token);
  const bondPct = Math.min(100, Math.max(0, ((token.mcap || 0) / Math.max(1, state.pumpfun.bondTargetMcap || 35000)) * 100));
  const showBond = state.pumpfun.migrationCount >= 1;
  const bondTone = bondPct > 60 ? 'bond-hot' : bondPct > 30 ? 'bond-warm' : 'bond-cool';
  const mcapTone = showBond ? `pump-mcap-tone ${bondTone}` : 'pump-mcap-tone bond-cool';
  const imageUrl = sanitizeOptionalHttpUrl(token.imageUrl);
  const article = document.createElement('article');
  article.className = 'pump-token-row';
  article.dataset.mint = token.mint;
  article.dataset.hoverKey = `pump:${token.mint}`;
  article.append(buildPumpAvatar(symbol, imageUrl));

  const main = document.createElement('div');
  main.className = 'pump-row-main';
  const title = document.createElement('div');
  title.className = 'panel-row-title';
  const tokenName = document.createElement('span');
  tokenName.className = 'token-name';
  tokenName.textContent = symbol;
  const tokenAddr = document.createElement('span');
  tokenAddr.className = 'token-addr';
  tokenAddr.textContent = subtitle;
  title.append(tokenName, ' ', tokenAddr);

  const meta = document.createElement('div');
  meta.className = 'panel-row-meta pump-meta-line';
  meta.append(
    buildPumpMeta('meta-white', `VOL 5M ${fmtMoney(vol5m)}`),
    buildPumpMeta(`pump-inline-mcap ${mcapTone}`, `MCAP ${fmtMoney(token.mcap)}`),
    buildPumpMeta('meta-white', `AGE ${age}`),
  );
  main.append(title, meta);

  if (showBond) {
    const bondShell = document.createElement('div');
    bondShell.className = 'pump-bond-shell compact';
    const bondFill = document.createElement('div');
    bondFill.className = `pump-bond-fill ${bondTone}`;
    bondFill.style.width = `${bondPct.toFixed(0)}%`;
    bondShell.append(bondFill);
    main.append(bondShell);
  }

  const side = document.createElement('div');
  side.className = 'pump-side-metrics';
  side.append(
    buildPumpMeta(`pump-mcap ${mcapTone}`, `MC ${fmtMoney(token.mcap)}`),
    buildPumpMeta('pump-vol', `V ${fmtMoney(token.volTotal)}`),
  );

  const actions = document.createElement('div');
  actions.className = 'pump-inline-actions';
  actions.append(
    buildPumpActionButton('⧉', 'action-glyph copy-button', 'copy-address', token.mint, null, false, 'Copy contract'),
    buildTradeTerminalMenuElement(token.mint, token.mintAddress || token.mint, token.pairAddress, {
      axiomAddress: token.bondingCurveKey || token.pairAddress || token.mintAddress || token.mint,
    }),
    buildPumpRemoveButton(token.mint, busy),
  );

  article.append(main, side, actions);
  return article;
}

function buildPumpMigrationStrip(entries: PumpMigrationEntry[]) {
  if (entries.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state compact';
    emptyState.textContent = 'No PumpFun migrations captured in this session yet.';
    return emptyState;
  }

  const strip = document.createElement('div');
  strip.className = 'pump-migration-strip';
  for (const entry of entries.slice(0, 3)) {
    const chip = document.createElement('div');
    chip.className = 'panel-chip';
    chip.textContent = `${entry.symbol} ${fmtMoney(entry.mcap)}`;
    strip.append(chip);
  }
  return strip;
}

function getPumpVolume5m(token: PumpTokenEntry) {
  return (token.vol5m || []).reduce((sum, point) => sum + point.usd, 0);
}

function buildPumpAvatar(symbol: string, imageUrl: string | null) {
  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = symbol;
    image.className = 'tok-avatar';
    return image;
  }

  const placeholder = document.createElement('div');
  placeholder.className = 'tok-avatar-placeholder';
  placeholder.textContent = symbol.slice(0, 2).toUpperCase();
  return placeholder;
}

function buildPumpMeta(className: string, text: string) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function buildPumpActionButton(
  label: string,
  className: string,
  action: string,
  address: string,
  dataMint?: string | null,
  disabled = false,
  title?: string,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.action = action;
  button.dataset.address = address;
  if (dataMint) {
    button.dataset.mint = dataMint;
  }
  if (title) {
    button.title = title;
  }
  button.disabled = disabled;
  button.textContent = label;
  return button;
}

function buildPumpRemoveButton(mint: string, disabled: boolean) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action-glyph danger-glyph';
  button.dataset.action = 'remove-pump';
  button.dataset.mint = mint;
  button.disabled = disabled;
  button.title = 'Remove row';
  button.textContent = 'X';
  return button;
}

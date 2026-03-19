import type { AppState, PumpToastEntry } from '../../state/app-state';
import { fmtAge, fmtMoney } from './shared';
import { escapeHtml, sanitizeOptionalHttpUrl } from './html-safety';

export function renderPumpToasts(state: AppState) {
  const container = document.createElement('div');
  container.className = 'pump-toast-container';

  for (const toast of state.data.pumpToasts) {
    container.append(renderPumpToast(toast));
  }

  for (const button of container.querySelectorAll<HTMLButtonElement>('[data-action="copy-address"]')) {
    button.addEventListener('click', async () => {
      const address = button.dataset.address;
      if (!address) return;
      try {
        await navigator.clipboard.writeText(address);
        const original = button.textContent;
        button.textContent = 'Copied';
        window.setTimeout(() => {
          button.textContent = original;
        }, 1200);
      } catch {
        button.textContent = 'Copy failed';
      }
    });
  }

  return container;
}

function renderPumpToast(toast: PumpToastEntry) {
  const article = document.createElement('article');
  article.className = 'pump-toast';
  const safeMint = escapeHtml(toast.mint);
  const safeSymbol = escapeHtml(toast.symbol);
  const imageUrl = sanitizeOptionalHttpUrl(toast.imageUrl);
  article.innerHTML = `
    <div class="pump-toast-head">
      ${imageUrl ? `<img src="${imageUrl}" alt="${safeSymbol}" class="pump-toast-img" />` : `<div class="pump-toast-placeholder">${safeSymbol.slice(0, 2).toUpperCase()}</div>`}
      <div class="pump-toast-body">
        <div class="pump-toast-label">TOKEN MIGRATED</div>
        <div class="pump-toast-ticker">${safeSymbol}</div>
        <div class="pump-toast-meta">AGE <span>${toast.createdAt ? fmtAge(toast.createdAt) : '-'}</span>&nbsp;&nbsp;VOL <span>${fmtMoney(toast.vol5m)}</span>&nbsp;&nbsp;MCAP <span>${fmtMoney(toast.mcap)}</span></div>
      </div>
      <button type="button" class="action-button small" data-action="copy-address" data-address="${safeMint}">Copy CA</button>
    </div>
  `;
  return article;
}

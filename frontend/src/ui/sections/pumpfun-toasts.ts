import type { AppState, PumpToastEntry } from '../../state/app-state';
import { fmtAge, fmtMoney } from './shared';

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
  article.innerHTML = `
    <div class="pump-toast-head">
      ${toast.imageUrl ? `<img src="${toast.imageUrl}" alt="${toast.symbol}" class="pump-toast-img" />` : `<div class="pump-toast-placeholder">${toast.symbol.slice(0, 2).toUpperCase()}</div>`}
      <div class="pump-toast-body">
        <div class="pump-toast-label">TOKEN MIGRATED</div>
        <div class="pump-toast-ticker">${toast.symbol}</div>
        <div class="pump-toast-meta">AGE <span>${toast.createdAt ? fmtAge(toast.createdAt) : '-'}</span>&nbsp;&nbsp;VOL <span>${fmtMoney(toast.vol5m)}</span>&nbsp;&nbsp;MCAP <span>${fmtMoney(toast.mcap)}</span></div>
      </div>
      <button type="button" class="action-button small" data-action="copy-address" data-address="${toast.mint}">Copy CA</button>
    </div>
  `;
  return article;
}

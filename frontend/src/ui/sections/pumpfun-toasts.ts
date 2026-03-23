import type { AppState, PumpToastEntry } from '../../state/app-state';
import { fmtAge, fmtMoney } from './shared';
import { sanitizeOptionalHttpUrl } from './html-safety';

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
  const imageUrl = sanitizeOptionalHttpUrl(toast.imageUrl);
  const head = document.createElement('div');
  head.className = 'pump-toast-head';

  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = toast.symbol;
    img.className = 'pump-toast-img';
    head.append(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'pump-toast-placeholder';
    placeholder.textContent = toast.symbol.slice(0, 2).toUpperCase();
    head.append(placeholder);
  }

  const body = document.createElement('div');
  body.className = 'pump-toast-body';

  const label = document.createElement('div');
  label.className = 'pump-toast-label';
  label.textContent = 'TOKEN MIGRATED';

  const ticker = document.createElement('div');
  ticker.className = 'pump-toast-ticker';
  ticker.textContent = toast.symbol;

  const meta = document.createElement('div');
  meta.className = 'pump-toast-meta';
  meta.textContent = `AGE ${toast.createdAt ? fmtAge(toast.createdAt) : '-'}  VOL ${fmtMoney(toast.vol5m)}  MCAP ${fmtMoney(toast.mcap)}`;

  body.append(label, ticker, meta);

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'action-button small';
  copyButton.dataset.action = 'copy-address';
  copyButton.dataset.address = toast.mint;
  copyButton.textContent = 'Copy CA';

  head.append(body, copyButton);
  article.append(head);
  return article;
}

import type { AppState, PumpToastEntry } from '../../state/app-state';
import { bindCopyButtons, fmtAge, fmtMoney } from './shared';
import { buildPumpImageWithFallback } from './pumpfun-image';

export function renderPumpToasts(state: AppState) {
  const container = document.createElement('div');
  container.className = 'pump-toast-container';

  for (const toast of state.data.pumpToasts) {
    container.append(renderPumpToast(toast));
  }
  bindCopyButtons(container);

  return container;
}

function renderPumpToast(toast: PumpToastEntry) {
  const article = document.createElement('article');
  article.className = 'pump-toast';
  const head = document.createElement('div');
  head.className = 'pump-toast-head';
  head.append(buildPumpImageWithFallback(toast.symbol, toast.imageUrl, 'pump-toast-img', 'pump-toast-placeholder'));

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
  meta.innerHTML = `AGE <span>${toast.createdAt ? fmtAge(toast.createdAt) : '-'}</span>  VOL <span>${fmtMoney(toast.volTotal ?? toast.vol5m)}</span>  MCAP <span>${fmtMoney(toast.mcap)}</span>`;

  body.append(label, ticker, meta);

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'action-glyph copy-button pump-toast-copy';
  copyButton.dataset.action = 'copy-address';
  copyButton.dataset.address = toast.mint;
  copyButton.title = 'Copy contract';
  copyButton.textContent = '⧉';

  head.append(body, copyButton);
  article.append(head);
  return article;
}

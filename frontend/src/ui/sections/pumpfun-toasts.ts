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

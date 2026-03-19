import { escapeHtml } from '../sections/html-safety';

export type BarTone = 'manual' | 'recent' | 'old-week' | 'blocklist';

const TONE_LABEL: Record<BarTone, string> = {
  manual: 'tone-manual',
  recent: 'tone-recent',
  'old-week': 'tone-old-week',
  blocklist: 'tone-blocklist',
};

export function renderBarCard(input: {
  title: string;
  description: string;
  count: number;
  tone: BarTone;
}) {
  const article = document.createElement('article');
  article.className = `surface-card feature-card ${TONE_LABEL[input.tone]}`;
  const safeTitle = escapeHtml(input.title);
  const safeDescription = escapeHtml(input.description);
  article.innerHTML = `
    <div class="card-topline">
      <span class="section-tag">BAR</span>
      <span class="count-pill">${input.count}</span>
    </div>
    <h2>${safeTitle}</h2>
    <p>${safeDescription}</p>
    <div class="card-footer">Migration slice pending</div>
  `;
  return article;
}

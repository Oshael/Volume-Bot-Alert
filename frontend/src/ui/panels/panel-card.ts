import { escapeHtml } from '../sections/html-safety';

export function renderPanelCard(input: {
  title: string;
  description: string;
  count: number;
}) {
  const article = document.createElement('article');
  article.className = 'surface-card feature-card tone-panel';
  const safeTitle = escapeHtml(input.title);
  const safeDescription = escapeHtml(input.description);
  article.innerHTML = `
    <div class="card-topline">
      <span class="section-tag">PANEL</span>
      <span class="count-pill">${input.count}</span>
    </div>
    <h2>${safeTitle}</h2>
    <p>${safeDescription}</p>
    <div class="card-footer">Logic port not started</div>
  `;
  return article;
}

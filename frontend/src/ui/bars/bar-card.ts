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
  article.innerHTML = `
    <div class="card-topline">
      <span class="section-tag">BAR</span>
      <span class="count-pill">${input.count}</span>
    </div>
    <h2>${input.title}</h2>
    <p>${input.description}</p>
    <div class="card-footer">Migration slice pending</div>
  `;
  return article;
}

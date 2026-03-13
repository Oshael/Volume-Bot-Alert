export function renderPanelCard(input: {
  title: string;
  description: string;
  count: number;
}) {
  const article = document.createElement('article');
  article.className = 'surface-card feature-card tone-panel';
  article.innerHTML = `
    <div class="card-topline">
      <span class="section-tag">PANEL</span>
      <span class="count-pill">${input.count}</span>
    </div>
    <h2>${input.title}</h2>
    <p>${input.description}</p>
    <div class="card-footer">Logic port not started</div>
  `;
  return article;
}

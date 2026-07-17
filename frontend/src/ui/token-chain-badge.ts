import {
  buildTokenExplorerUrl,
  normalizeTokenChain,
  type TokenChain,
} from '../utils/token-chain';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const TOKEN_CHAIN_BADGE_META: Record<TokenChain, { path: string | null; title: string }> = {
  solana: {
    title: 'Solana',
    path: 'm23.8764 18.0313-3.962 4.1393a.9201.9201 0 0 1-.306.2106.9407.9407 0 0 1-.367.0742H.4599a.4689.4689 0 0 1-.2522-.0733.4513.4513 0 0 1-.1696-.1962.4375.4375 0 0 1-.0314-.2545.4438.4438 0 0 1 .117-.2298l3.9649-4.1393a.92.92 0 0 1 .3052-.2102.9407.9407 0 0 1 .3658-.0746H23.54a.4692.4692 0 0 1 .2523.0734.4531.4531 0 0 1 .1697.196.438.438 0 0 1 .0313.2547.4442.4442 0 0 1-.1169.2297zm-3.962-8.3355a.9202.9202 0 0 0-.306-.2106.941.941 0 0 0-.367-.0742H.4599a.4687.4687 0 0 0-.2522.0734.4513.4513 0 0 0-.1696.1961.4376.4376 0 0 0-.0314.2546.444.444 0 0 0 .117.2297l3.9649 4.1394a.9204.9204 0 0 0 .3052.2102c.1154.049.24.0744.3658.0746H23.54a.469.469 0 0 0 .2523-.0734.453.453 0 0 0 .1697-.1961.4382.4382 0 0 0 .0313-.2546.4444.4444 0 0 0-.1169-.2297zM.46 6.7225h18.7815a.9411.9411 0 0 0 .367-.0742.9202.9202 0 0 0 .306-.2106l3.962-4.1394a.4442.4442 0 0 0 .117-.2297.4378.4378 0 0 0-.0314-.2546.453.453 0 0 0-.1697-.196.469.469 0 0 0-.2523-.0734H4.7596a.941.941 0 0 0-.3658.0745.9203.9203 0 0 0-.3052.2102L.1246 5.9687a.4438.4438 0 0 0-.1169.2295.4375.4375 0 0 0 .0312.2544.4512.4512 0 0 0 .1692.196.4689.4689 0 0 0 .2518.0739z',
  },
  ethereum: {
    title: 'Ethereum',
    path: 'M11.944 17.97 4.58 13.62 11.943 24l7.37-10.38-7.372 4.35h.003zM12.056 0 4.69 12.223l7.365 4.354 7.365-4.35L12.056 0z',
  },
  bsc: {
    title: 'BNB Smart Chain',
    path: 'm16.624 13.9202 2.7175 2.7154-7.353 7.353-7.353-7.352 2.7175-2.7164 4.6355 4.6595 4.6356-4.6595zm4.6366-4.6366L24 12l-2.7154 2.7164L18.5682 12l2.6924-2.7164zm-9.272.001 2.7163 2.6914-2.7164 2.7174v-.001L9.2721 12l2.7164-2.7154zm-9.2722-.001L5.4088 12l-2.6914 2.6924L0 12l2.7164-2.7164zM11.9885.0115l7.353 7.329-2.7174 2.7154-4.6356-4.6356-4.6355 4.6595-2.7174-2.7154 7.353-7.353z',
  },
  base: { title: 'Base', path: null },
  robinhood: {
    title: 'Robinhood Chain',
    path: 'M2.84 24h.53c.096 0 .192-.048.224-.128C7.591 13.696 11.94 8.656 14.67 5.638c.112-.128.064-.225-.096-.225h-4.88a.55.55 0 0 0-.45.225L5.746 9.972c-.514.642-.642 1.236-.642 2.086v4.43c-1.14 3.194-1.862 5.361-2.392 7.32-.032.125.016.192.129.192M20.447.646c-.754-.802-4.157-.834-5.73-.224a3 3 0 0 0-.786.465 41 41 0 0 0-3.323 3.178c-.112.113-.064.225.097.225h5.409c.497 0 .786.289.786.786v6.1c0 .16.128.208.225.064l3.258-4.254c.53-.69.69-.898.835-1.861.192-1.413.08-3.58-.77-4.479m-6.982 16.18 2.231-3.676a.7.7 0 0 0 .064-.29V6.73c0-.16-.112-.225-.224-.097-3.355 3.74-5.971 7.672-8.395 12.407-.06.12.016.225.16.177l5.009-1.54c.565-.174.882-.402 1.155-.852',
  },
};

export function getTokenChainTitle(chain: TokenChain) {
  return TOKEN_CHAIN_BADGE_META[chain].title;
}

export function buildTokenChainIcon(chain: TokenChain) {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.classList.add('token-chain-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');

  const pathData = TOKEN_CHAIN_BADGE_META[chain].path;
  const shape = document.createElementNS(SVG_NAMESPACE, pathData ? 'path' : 'rect');
  if (pathData) {
    shape.setAttribute('d', pathData);
  } else {
    shape.setAttribute('x', '2');
    shape.setAttribute('y', '2');
    shape.setAttribute('width', '20');
    shape.setAttribute('height', '20');
    shape.setAttribute('rx', '1.2');
  }
  icon.append(shape);
  return icon;
}

export function buildTokenChainBadge(chainValue: unknown, address: string) {
  const chain = normalizeTokenChain(chainValue) || 'solana';
  const meta = TOKEN_CHAIN_BADGE_META[chain];
  const explorerUrl = buildTokenExplorerUrl(chain, address);
  const badge = explorerUrl
    ? document.createElement('a')
    : document.createElement('span');

  badge.className = 'token-chain-badge';
  badge.dataset.chain = chain;
  badge.setAttribute('aria-label', meta.title);
  badge.title = explorerUrl ? `Open ${meta.title} explorer` : meta.title;
  badge.append(buildTokenChainIcon(chain));

  if (badge instanceof HTMLAnchorElement && explorerUrl) {
    badge.href = explorerUrl;
    badge.target = '_blank';
    badge.rel = 'noreferrer';
  }
  return badge;
}

export function buildTokenIdentityBadgeGroup(
  peerBadge: HTMLElement | null,
  chainValue: unknown,
  address: string,
) {
  const group = document.createElement('span');
  group.className = 'token-identity-badges';
  if (peerBadge) {
    group.append(peerBadge);
    const separator = document.createElement('span');
    separator.className = 'token-identity-badge-separator';
    separator.textContent = '/';
    group.append(separator);
  }
  group.append(buildTokenChainBadge(chainValue, address));
  return group;
}

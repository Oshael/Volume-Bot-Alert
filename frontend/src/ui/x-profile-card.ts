import { fetchXProfile, type XProfile } from '../services/api/x-profile';

const HOVER_DELAY_MS = 160;
const HIDE_DELAY_MS = 140;
const OFFSET_PX = 10;
const CARD_WIDTH_PX = 320;
const VIEWPORT_MARGIN_PX = 12;

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const X_HOSTS = new Set(['x.com', 'twitter.com']);
const RESERVED_SEGMENTS = new Set([
  'i', 'home', 'explore', 'search', 'settings', 'notifications', 'messages',
  'compose', 'intent', 'share', 'hashtag', 'login', 'signup', 'about',
]);

// Session-scoped memo on top of the server cache: re-hovering the same glyph
// must not produce another round trip.
const profileCache = new Map<string, XProfile>();

let popover: HTMLElement | null = null;
let activeHandle: string | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let bound = false;

export function extractXHandleFromHref(href: string | null | undefined) {
  if (!href) {
    return null;
  }
  try {
    const url = new URL(href, window.location.origin);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!X_HOSTS.has(host)) {
      return null;
    }
    const [segment] = url.pathname.split('/').filter(Boolean);
    if (!segment || !HANDLE_RE.test(segment) || RESERVED_SEGMENTS.has(segment.toLowerCase())) {
      return null;
    }
    return segment;
  } catch {
    return null;
  }
}

function formatCompactCount(value: number | null) {
  if (value == null) {
    return '—';
  }
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatJoined(joinedAt: string | null) {
  if (!joinedAt) {
    return null;
  }
  const date = new Date(joinedAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return `Joined ${date.toLocaleDateString('en', { month: 'short', year: 'numeric' })}`;
}

// X's verified rosette, drawn instead of a text glyph so the badge reads as a
// badge at 12px instead of looking like a stray check mark.
const VERIFIED_BADGE_PATH = 'M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z';
const VERIFIED_TYPES = new Set(['business', 'government']);

function renderVerifiedBadge(verifiedType: string | null) {
  const variant = VERIFIED_TYPES.has(String(verifiedType || '').toLowerCase())
    ? String(verifiedType).toLowerCase()
    : 'individual';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `xpc-verified xpc-verified-${variant}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Verified account');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', VERIFIED_BADGE_PATH);
  svg.append(path);
  return svg;
}

function element(tag: string, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) {
    // Every profile field is third-party text: never assign it as markup.
    node.textContent = text;
  }
  return node;
}

function getOrCreatePopover() {
  if (popover?.isConnected) {
    return popover;
  }
  popover = element('div', 'x-profile-popover');
  popover.setAttribute('role', 'dialog');
  popover.addEventListener('pointerenter', cancelHide);
  popover.addEventListener('pointerleave', scheduleHide);
  document.body.append(popover);
  return popover;
}

function renderMessage(text: string) {
  const card = getOrCreatePopover();
  card.replaceChildren(element('div', 'xpc-message', text));
}

function renderStat(value: number | null, label: string) {
  const stat = element('span', 'xpc-stat');
  stat.append(element('b', 'xpc-stat-value', formatCompactCount(value)));
  stat.append(element('span', 'xpc-stat-label', label));
  return stat;
}

function renderHeader(profile: XProfile) {
  const head = element('div', 'xpc-head');

  if (profile.avatarUrl) {
    const avatar = document.createElement('img');
    avatar.className = 'xpc-avatar';
    avatar.src = profile.avatarUrl;
    avatar.alt = '';
    avatar.decoding = 'async';
    avatar.loading = 'lazy';
    head.append(avatar);
  } else {
    head.append(element('div', 'xpc-avatar xpc-avatar-empty'));
  }

  const identity = element('div', 'xpc-identity');
  const nameRow = element('div', 'xpc-name-row');
  nameRow.append(element('span', 'xpc-name', profile.name));
  if (profile.verified) {
    nameRow.append(renderVerifiedBadge(profile.verifiedType));
  }
  identity.append(nameRow);
  identity.append(element('span', 'xpc-handle', `@${profile.handle}`));
  head.append(identity);

  return head;
}

function renderMeta(profile: XProfile) {
  const joined = formatJoined(profile.joinedAt);
  if (!profile.location && !joined) {
    return null;
  }
  const meta = element('div', 'xpc-meta');
  if (profile.location) {
    meta.append(element('span', 'xpc-meta-item', `📍 ${profile.location}`));
  }
  if (joined) {
    meta.append(element('span', 'xpc-meta-item', `📅 ${joined}`));
  }
  return meta;
}

function renderProfile(profile: XProfile, stale: boolean) {
  const card = getOrCreatePopover();
  const parts: HTMLElement[] = [];

  if (profile.bannerUrl) {
    const banner = element('div', 'xpc-banner');
    const image = document.createElement('img');
    image.src = profile.bannerUrl;
    image.alt = '';
    image.decoding = 'async';
    image.loading = 'lazy';
    banner.append(image);
    parts.push(banner);
  }

  const body = element('div', 'xpc-body');
  body.append(renderHeader(profile));

  if (profile.description) {
    body.append(element('p', 'xpc-bio', profile.description));
  }

  const meta = renderMeta(profile);
  if (meta) {
    body.append(meta);
  }

  const stats = element('div', 'xpc-stats');
  stats.append(renderStat(profile.following, 'Following'));
  stats.append(renderStat(profile.followers, 'Followers'));
  body.append(stats);

  const cta = document.createElement('a');
  cta.className = 'xpc-cta';
  cta.href = profile.profileUrl;
  cta.target = '_blank';
  cta.rel = 'noreferrer noopener';
  cta.textContent = 'See Profile on X';
  body.append(cta);

  if (stale) {
    body.append(element('div', 'xpc-stale', 'Showing last known data'));
  }

  parts.push(body);
  card.replaceChildren(...parts);
}

function position(anchor: HTMLElement) {
  const card = getOrCreatePopover();
  const rect = anchor.getBoundingClientRect();
  const cardHeight = card.offsetHeight || 240;

  let left = rect.left;
  if (left + CARD_WIDTH_PX > window.innerWidth - VIEWPORT_MARGIN_PX) {
    left = window.innerWidth - CARD_WIDTH_PX - VIEWPORT_MARGIN_PX;
  }

  let top = rect.bottom + OFFSET_PX;
  if (top + cardHeight > window.innerHeight - VIEWPORT_MARGIN_PX) {
    top = Math.max(VIEWPORT_MARGIN_PX, rect.top - cardHeight - OFFSET_PX);
  }

  card.style.left = `${Math.max(VIEWPORT_MARGIN_PX, left)}px`;
  card.style.top = `${top}px`;
}

async function load(handle: string, anchor: HTMLElement) {
  const cached = profileCache.get(handle);
  if (cached) {
    renderProfile(cached, false);
    position(anchor);
    return;
  }

  renderMessage('Loading…');
  position(anchor);

  try {
    const result = await fetchXProfile(handle);
    if (activeHandle !== handle) {
      return;
    }
    if (!result.stale) {
      profileCache.set(handle, result.profile);
    }
    renderProfile(result.profile, result.stale);
    position(anchor);
  } catch {
    if (activeHandle === handle) {
      renderMessage('X profile unavailable');
      position(anchor);
    }
  }
}

function show(anchor: HTMLElement, handle: string) {
  activeHandle = handle;
  const card = getOrCreatePopover();
  card.classList.add('is-visible');
  void load(handle, anchor);
}

function hide() {
  activeHandle = null;
  popover?.classList.remove('is-visible');
}

function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function scheduleHide() {
  cancelHide();
  hideTimer = setTimeout(hide, HIDE_DELAY_MS);
}

function cancelShow() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

function resolveAnchor(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest<HTMLElement>('a.action-glyph.x-profile[href]');
}

export function bindXProfileCards() {
  if (bound || typeof document === 'undefined') {
    return;
  }
  bound = true;

  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') {
      return;
    }
    const anchor = resolveAnchor(event.target);
    if (!anchor) {
      return;
    }
    const handle = extractXHandleFromHref(anchor.getAttribute('href'));
    if (!handle) {
      return;
    }

    cancelHide();
    if (activeHandle === handle) {
      return;
    }
    cancelShow();
    showTimer = setTimeout(() => show(anchor, handle), HOVER_DELAY_MS);
  });

  document.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'touch' || !resolveAnchor(event.target)) {
      return;
    }
    cancelShow();
    scheduleHide();
  });

  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hide();
    }
  });
}

import { sanitizeOptionalHttpUrl } from './html-safety';

function buildAvatarPlaceholder(symbol: string, className: string) {
  const placeholder = document.createElement('div');
  placeholder.className = className;
  placeholder.textContent = symbol.slice(0, 2).toUpperCase();
  return placeholder;
}

export function buildPumpImageWithFallback(
  symbol: string,
  imageUrl: string | null | undefined,
  imageClassName: string,
  placeholderClassName: string,
) {
  const safeUrl = sanitizeOptionalHttpUrl(imageUrl);
  if (!safeUrl) {
    return buildAvatarPlaceholder(symbol, placeholderClassName);
  }

  const image = document.createElement('img');
  image.src = safeUrl;
  image.alt = symbol;
  image.className = imageClassName;
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => {
    image.replaceWith(buildAvatarPlaceholder(symbol, placeholderClassName));
  }, { once: true });
  return image;
}

import { stripeCreditPacks } from './stripe-catalog.mjs';

// Development always uses test links. Missing configuration must never fall
// back to a live purchase. Production always uses the reviewed live catalog.
export function checkoutLink(credits, development, testLinks = {}) {
  if (!development) return stripeCreditPacks[credits]?.paymentLink || null;
  const link = testLinks[credits];
  try {
    const url = new URL(link);
    return url.origin === 'https://buy.stripe.com' && /^\/test_[A-Za-z0-9]+$/.test(url.pathname)
      && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export function isLocalApi(apiUrl) {
  try {
    const url = new URL(apiUrl);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

// Live Stripe catalog and Payment Links, verified through 2026-10-05.
// These are public identifiers and URLs, not keys. Each link sells one fixed pack.
// Future server checkout must authorize the manager and select prices here;
// never accept an amount or credit award supplied by the browser.
export const stripeAccountId = 'acct_1TCoUJLFTZ7EIElE';
export const stripeCreditPacks = {
  192: { productId: 'prod_VO7QXks4tnCDzO', priceId: 'price_1UNLBhLFTZ7EIElEdqGTdU4g', paymentLink: 'https://buy.stripe.com/dRmcN62M24cueqkeU8eME04' },
  8: { productId: 'prod_VNhw5zC9hVJCCq', priceId: 'price_1UMwWOLFTZ7EIElEDFa4vwju', paymentLink: 'https://buy.stripe.com/7sYbJ24UadN4gysbHWeME03' },
  16: { productId: 'prod_VMLeykPaE6wsA9', priceId: 'price_1ULcxaLFTZ7EIElEjpwI2Kxh', paymentLink: 'https://buy.stripe.com/fZu8wQeuKdN4cic13ieME00' },
  // Retained for previously issued checkout links and delayed webhook delivery.
  32: { productId: 'prod_VMLfShsZFGq9nw', priceId: 'price_1ULcyNLFTZ7EIElExdam4Y02', paymentLink: 'https://buy.stripe.com/6oU8wQfyO8sK3LG8vKeME01' },
  64: { productId: 'prod_VMLglFzmbQStNo', priceId: 'price_1ULcz7LFTZ7EIElEEsCk0cas', paymentLink: 'https://buy.stripe.com/aFabJ2dqG6kC5TO7rGeME02' },
};

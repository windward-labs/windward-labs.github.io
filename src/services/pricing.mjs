export const currency = 'USD';
export const creditPriceCents = 7500;
export const creditPacks = [16, 32, 64].map((credits) => ({
  credits,
  hours: credits / 4,
  amountCents: credits * creditPriceCents,
}));

export function formatPrice(amountCents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(amountCents / 100);
}

export const currency = 'USD';
export const creditPriceCents = 7500;
export const normalCreditsPerHour = 4;
export const creditPacks = [
  { credits: 8, name: 'Quick task', description: 'For a quick review, design update, or small fix.' },
  { credits: 16, name: 'Focused work', description: 'For focused reviews or a small design or engineering task.' },
  { credits: 32, name: 'Project work', description: 'For a larger design or engineering task, or several focused requests.' },
  { credits: 64, name: 'Ongoing support', description: 'For multiple tasks and continued iteration on a project.' },
].map((pack) => ({
  ...pack,
  hours: pack.credits / normalCreditsPerHour,
  amountCents: pack.credits * creditPriceCents,
}));

export function formatPrice(amountCents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(amountCents / 100);
}

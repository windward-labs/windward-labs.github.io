export const currency = 'USD';
export const creditPriceCents = 7500;
export const normalCreditsPerHour = 4;
export const creditPacks = [
  { credits: 8, name: 'Quick Ask', description: 'Small website updates, tweaks, and other straightforward requests.' },
  { credits: 16, name: 'Focused Project', description: 'A defined deliverable, like an invitation, a physical product, or a set of assets.' },
  { credits: 32, name: 'Collaborative Project', description: 'New features and projects from scratch, shaped through exploration, feedback, and iteration.' },
  { credits: 64, name: 'Embedded Design', description: 'Ongoing design support for larger initiatives, working as an extension of your team.' },
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

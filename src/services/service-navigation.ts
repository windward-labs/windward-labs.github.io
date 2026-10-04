// Swap only the account's lower region. Both panels stay mounted so drafts,
// selected files, credit choices, and the sample ledger survive the transition.
export function setupServiceNavigation(canPurchase: () => boolean) {
  const content = document.getElementById('account-content')!;
  const panels = {
    requests: document.getElementById('requests-panel')!,
    checkout: document.getElementById('checkout-panel')!,
  };
  const open = document.getElementById('open-checkout') as HTMLAnchorElement;
  type View = keyof typeof panels;
  let current: View = 'requests';
  let desired: View = 'requests';
  let running = false;

  async function transition() {
    if (running) return;
    running = true;
    try {
      while (current !== desired) {
        const next = desired;
        const outgoing = panels[current];
        const incoming = panels[next];
        const startHeight = content.getBoundingClientRect().height;
        content.style.height = `${startHeight}px`;
        content.setAttribute('aria-busy', 'true');
        outgoing.inert = true;
        outgoing.style.position = 'absolute';
        outgoing.style.inset = '0';
        incoming.hidden = false;
        incoming.inert = true;
        const endHeight = incoming.getBoundingClientRect().height;

        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          const easing = 'cubic-bezier(.22, 1, .36, 1)';
          const animations = [
            outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' }),
            incoming.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 320, delay: 60, easing, fill: 'both' }),
            content.animate([{ height: `${startHeight}px` }, { height: `${endHeight}px` }], { duration: 380, easing, fill: 'forwards' }),
          ];
          await Promise.allSettled(animations.map((animation) => animation.finished));
          outgoing.hidden = true;
          animations.forEach((animation) => animation.cancel());
        } else outgoing.hidden = true;

        outgoing.style.removeProperty('position');
        outgoing.style.removeProperty('inset');
        incoming.inert = false;
        content.style.removeProperty('height');
        content.removeAttribute('aria-busy');
        current = next;
      }
      if (content.contains(document.activeElement) || document.activeElement === open) {
        document.getElementById(current === 'checkout' ? 'checkout-title' : 'requests-title')?.focus({ preventScroll: true });
      }
    } finally { running = false; }
  }

  function setView(view: View) {
    desired = view === 'checkout' && canPurchase() ? 'checkout' : 'requests';
    open.textContent = desired === 'checkout' ? 'Back to requests' : 'Add credits';
    open.href = desired === 'checkout' ? '/service/' : '/service/checkout/';
    open.setAttribute('aria-expanded', String(desired === 'checkout'));
    void transition();
  }
  function showRequests() {
    if (location.hash === '#checkout') history.replaceState(null, '', location.pathname + location.search);
    setView('requests');
  }
  open.addEventListener('click', (event) => {
    if (event instanceof MouseEvent && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return;
    event.preventDefault();
    if (desired === 'checkout') {
      if (history.state?.serviceCheckout) history.back();
      else showRequests();
      return;
    }
    if (!canPurchase()) return;
    if (location.hash !== '#checkout') history.pushState({ serviceCheckout: true }, '', '#checkout');
    setView('checkout');
  });
  const syncLocation = () => {
    if (location.hash === '#checkout' && !canPurchase()) showRequests();
    else setView(location.hash === '#checkout' ? 'checkout' : 'requests');
  };
  window.addEventListener('popstate', syncLocation);
  window.addEventListener('hashchange', syncLocation);
  syncLocation();
  return { showRequests };
}

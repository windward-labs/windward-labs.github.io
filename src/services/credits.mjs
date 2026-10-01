// In-memory interaction model only. Production authorization and ledger writes
// must run on a server against a verified identity and transactional database.
export const thinkingLevels = [
  { name: 'Quick review', time: '30 minutes', normal: 2, fast: 3 },
  { name: 'Focused task', time: '1 hour', normal: 4, fast: 6 },
  { name: 'Deep dive', time: '2 hours', normal: 8, fast: 12 },
  { name: 'Half-day session', time: '4 hours', normal: 16, fast: null },
  { name: 'Full-day session', time: '8 hours', normal: 32, fast: null },
];
export function quoteRequest(normalCredits, speed = 'normal') {
  const level = thinkingLevels.find((level) => level.normal === normalCredits);
  if (!level || !['normal', 'fast'].includes(speed)) throw new Error('Choose a valid thinking level and delivery speed.');
  const credits = level[speed];
  if (credits === null) throw new Error('Fast delivery is available for sessions of up to 2 hours only.');
  return { level: level.name, time: level.time, speed, deliveryHours: speed === 'fast' ? 24 : 48, credits };
}
export function createDemoAccount() {
  return {
    name: 'Example Studio',
    purchased: 32,
    members: [
      { id: 'alex', email: 'alex@example.com', role: 'manager', active: true },
      { id: 'sam', email: 'sam@example.com', role: 'member', active: true },
      { id: 'studio', email: 'studio@example.com', role: 'studio', active: true },
    ],
    requests: [
      { id: 'request-2', brief: 'Review the onboarding flow', ...quoteRequest(4), memberId: 'sam', status: 'reserved' },
      { id: 'request-1', brief: 'Landing page design review', ...quoteRequest(4), memberId: 'alex', status: 'completed' },
    ],
    events: [
      { requestId: 'request-1', actorId: 'alex', action: 'reserved', at: '2026-09-28T16:00:00.000Z' },
      { requestId: 'request-1', actorId: 'studio', action: 'accepted', at: '2026-09-28T17:00:00.000Z' },
      { requestId: 'request-1', actorId: 'studio', action: 'completed', at: '2026-09-29T16:00:00.000Z' },
      { requestId: 'request-2', actorId: 'sam', action: 'reserved', at: '2026-09-30T16:00:00.000Z' },
    ],
  };
}
function identity(state, id) {
  const member = state.members.find((member) => member.id === id && member.active);
  if (!member) throw new Error('This email no longer has access.');
  return member;
}
function studioOnly(state, actorId) {
  if (identity(state, actorId).role !== 'studio') throw new Error('Only Windward can change client access or accept work.');
}
function record(state, actorId, action, requestId) {
  state.events.push({ actorId, action, requestId, at: new Date().toISOString() });
}
export function usage(state, memberId) {
  const requests = state.requests.filter((request) => !memberId || request.memberId === memberId);
  return {
    used: requests.filter((request) => ['accepted', 'completed'].includes(request.status)).reduce((sum, request) => sum + request.credits, 0),
    reserved: requests.filter((request) => request.status === 'reserved').reduce((sum, request) => sum + request.credits, 0),
  };
}
export function totals(state) { const counts = usage(state); return { ...counts, available: state.purchased - counts.used - counts.reserved }; }
export function submitRequest(state, actorId, memberId, brief, normalCredits, speed = 'normal') {
  const actor = identity(state, actorId);
  const member = identity(state, memberId);
  if (member.role === 'studio' || (actorId !== memberId && actor.role !== 'studio')) throw new Error('Requests must be attributed to your own account.');
  if (typeof brief !== 'string' || !brief.trim() || brief.trim().length > 2000) throw new Error('Enter a brief of 1–2,000 characters.');
  const quote = quoteRequest(normalCredits, speed);
  if (totals(state).available < quote.credits) throw new Error('Not enough available credits. Ask your account manager to top up.');
  const request = { id: `request-${state.requests.length + 1}`, brief: brief.trim(), ...quote, memberId, status: 'reserved' };
  state.requests.unshift(request); record(state, actorId, 'reserved', request.id); return request;
}
export function transitionRequest(state, actorId, requestId, status) {
  const actor = identity(state, actorId);
  const request = state.requests.find((request) => request.id === requestId);
  if (!request) throw new Error('Request not found.');
  if (status === 'cancelled') {
    if (actor.role !== 'manager' && actorId !== request.memberId) throw new Error('You can only cancel your own requests.');
  } else studioOnly(state, actorId);
  const valid = request.status === 'reserved' ? ['accepted', 'declined', 'cancelled'] : request.status === 'accepted' ? ['completed'] : [];
  if (!valid.includes(status)) throw new Error('This request has already changed.');
  request.status = status; record(state, actorId, status, request.id);
}
export function allowMember(state, actorId, email, role) {
  studioOnly(state, actorId);
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email.');
  if (!['manager', 'member'].includes(role)) throw new Error('Choose a client role.');
  const existing = state.members.find((member) => member.email === email);
  if (existing?.active) throw new Error('That email already has access.');
  if (existing) { existing.active = true; existing.role = role; }
  else state.members.push({ id: `member-${state.members.length + 1}`, email, role, active: true });
  record(state, actorId, `allowed ${email} as ${role}`);
}
export function revokeMember(state, actorId, memberId) {
  studioOnly(state, actorId);
  const member = identity(state, memberId);
  if (member.role === 'studio') throw new Error('Client access only.');
  if (member.role === 'manager' && state.members.filter((item) => item.active && item.role === 'manager').length === 1) throw new Error('Add another account manager before removing the last one.');
  member.active = false; record(state, actorId, `revoked ${member.email}`);
}

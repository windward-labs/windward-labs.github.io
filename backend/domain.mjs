export class PortalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireStaff(actor) {
  if (!actor.staff) throw new PortalError(403, 'Only Windward staff can make this change.');
}
export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new PortalError(400, 'Enter a valid email address.');
  return email;
}
export function text(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new PortalError(400, `${label} must contain 1–${max} characters.`);
  return value.trim();
}
export function id(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new PortalError(400, 'Invalid record ID.');
  return value;
}
export function workInput(body) {
  const credits = body.credits;
  if (!Number.isSafeInteger(credits) || credits <= 0 || credits > 10000) throw new PortalError(400, 'Use a whole credit amount between 1 and 10,000.');
  if (!['email','text','call','meeting','other'].includes(body.source)) throw new PortalError(400, 'Choose a source channel.');
  if (!['queued','in_progress','completed'].includes(body.status)) throw new PortalError(400, 'Choose a work status.');
  return { id: id(body.id), title: text(body.title,'Title',160), description: text(body.description,'Work description'), requestedBy: text(body.requestedBy,'Requested by',254), source: body.source, credits, status: body.status };
}
export function statusInput(body) {
  if (!['queued','in_progress','completed','cancelled'].includes(body.status)) throw new PortalError(400, 'Choose a valid status.');
  return { id: id(body.id), status: body.status, note: text(body.note,'Progress note') };
}
export function isStaffEmail(email) {
  // Called with a server-verified Privy email or a provisioned agent identity.
  return normalizeEmail(email).split('@')[1] === 'windwardlabs.xyz';
}

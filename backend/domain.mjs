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
  const pricingModel=body.pricingModel ?? 'hourly';
  if(!['fixed','hourly'].includes(pricingModel))throw new PortalError(400,'Choose fixed or hourly pricing.');
  const fixedCredits=body.fixedCredits ?? null,budgetCredits=body.budgetCredits ?? null;
  for(const value of [fixedCredits,budgetCredits])if(value!==null && (!Number.isSafeInteger(value) || value<1 || value>10000))throw new PortalError(400,'Agreement credits must be a whole number from 1 to 10,000.');
  if(pricingModel==='fixed' ? fixedCredits===null || budgetCredits!==null || (body.credits ?? 0)!==0 : fixedCredits!==null || (budgetCredits!==null && (body.credits ?? 0)>budgetCredits))throw new PortalError(400,'Fixed projects require fixedCredits and separate charges; hourly projects may have budgetCredits.');
  const credits = body.credits ?? 0;
  if (!Number.isSafeInteger(credits) || credits < 0 || credits > 10000) throw new PortalError(400, 'Use a whole credit amount between 0 and 10,000. Omit credits to charge only dated work entries.');
  if (!['email','text','call','meeting','other'].includes(body.source)) throw new PortalError(400, 'Choose a source channel.');
  if (!['queued','in_progress','completed'].includes(body.status)) throw new PortalError(400, 'Choose a work status.');
  if(['billingDate','startedAt','billingPeriod','createdAt','date'].some(key=>body[key]!==undefined))throw new PortalError(400,'Use occurredAt for the work date.');
  const occurredAt=body.occurredAt===undefined ? null : workTimestamp(body.occurredAt);
  const emailMessageId=body.emailMessageId===undefined ? null : text(body.emailMessageId,'Email message ID',500);
  if(emailMessageId && !occurredAt)throw new PortalError(400,'Send occurredAt with the email message ID.');
  return { id: id(body.id), title: text(body.title,'Title',160), description: text(body.description,'Work description'), requestedBy: text(body.requestedBy,'Requested by',254), source: body.source, credits,pricingModel,fixedCredits,budgetCredits, status: body.status,occurredAt,emailMessageId };
}
export function statusInput(body) {
  if (!['queued','in_progress','completed','cancelled'].includes(body.status)) throw new PortalError(400, 'Choose a valid status.');
  return { id: id(body.id), status: body.status, note: text(body.note,'Progress note') };
}
export function eventTimestamp(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))throw new PortalError(400,'Use an ISO 8601 occurredAt timestamp with a timezone.');
  const [year,month,day,hour,minute,second]=value.slice(0,19).split(/[-T:]/).map(Number);
  const milliseconds=Date.parse(value);
  if(year<1000 || month<1 || month>12 || day<1 || day>new Date(Date.UTC(year,month,0)).getUTCDate() || hour>23 || minute>59 || second>59 || !Number.isFinite(milliseconds))throw new PortalError(400,'Use a valid occurredAt timestamp.');
  return new Date(milliseconds).toISOString();
}
export function workTimestamp(value) {
  const timestamp=eventTimestamp(value);
  if(timestamp<'2020-01-01T00:00:00.000Z' || Date.parse(timestamp)>Date.now())throw new PortalError(400,'Work dates must be from 2020 onward and cannot be in the future.');
  return timestamp;
}
export function isStaffEmail(email) {
  // Called with a server-verified Privy email or a provisioned agent identity.
  return normalizeEmail(email).split('@')[1] === 'windwardlabs.xyz';
}

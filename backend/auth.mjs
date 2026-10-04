import { PrivyClient } from '@privy-io/node';
import { PortalError, normalizeEmail, isStaffEmail } from './domain.mjs';

let cached;
export function actorFromPrivyUser(user) {
  const accounts = user.linked_accounts?.filter(account => account.type === 'email' && Number.isFinite(account.latest_verified_at) && account.latest_verified_at > 0) ?? [];
  const account = accounts.find(account=>isStaffEmail(account.address)) || accounts[0];
  if (!account) throw new PortalError(403,'Sign in with a verified email address.');
  const email = normalizeEmail(account.address);
  return { id:user.id, email, staff:isStaffEmail(email) };
}
export async function authenticate(request,env) {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) throw new PortalError(503,'Portal sign-in is not configured yet.');
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new PortalError(401,'Sign in to access this account.');
  if (!cached || cached.id !== env.PRIVY_APP_ID || cached.secret !== env.PRIVY_APP_SECRET) cached={id:env.PRIVY_APP_ID,secret:env.PRIVY_APP_SECRET,client:new PrivyClient({appId:env.PRIVY_APP_ID,appSecret:env.PRIVY_APP_SECRET})};
  let claims;
  try { claims = await cached.client.utils().auth().verifyAccessToken(token); }
  catch { throw new PortalError(401,'Your session is invalid or expired. Please sign in again.'); }
  // Never authorize a domain or membership using a browser-supplied email.
  let user;
  try { user = await cached.client.users()._get(claims.user_id); }
  catch { throw new PortalError(503,'Unable to check account access. Please try again.'); }
  if (user.id !== claims.user_id) throw new PortalError(401,'Unable to verify your account.');
  return actorFromPrivyUser(user);
}

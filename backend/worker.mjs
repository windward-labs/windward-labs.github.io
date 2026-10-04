import { authenticate } from './auth.mjs';
import { handleApi } from './api.mjs';
import { handleStripeWebhook } from './stripe.mjs';

export default {
  async fetch(request,env) {
    if (new URL(request.url).pathname === '/v1/stripe/webhook') {
      if (!env.DB) return Response.json({error:'Portal storage is not configured.'},{status:503});
      return handleStripeWebhook(request,env);
    }
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(value=>value.trim()).filter(Boolean);
    if (origin && !allowed.includes(origin)) return new Response('Origin not allowed',{status:403,headers:{'Cache-Control':'no-store'}});
    const headers = { 'Vary':'Origin', 'Cache-Control':'no-store', ...(origin ? {'Access-Control-Allow-Origin':origin} : {}), 'Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers':'Authorization, Content-Type' };
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
    if (!env.DB) return Response.json({error:'Portal storage is not configured yet.'},{status:503,headers});
    const response = await handleApi(request,env,authenticate);
    for (const [key,value] of Object.entries(headers)) response.headers.set(key,value);
    return response;
  },
};

# Windward service portal

The Astro site stays on GitHub Pages. A Cloudflare Worker verifies Privy access
tokens, fetches the verified email from Privy, and authorizes each request. D1
stores clients, approved email addresses, work, progress updates, and credits.
The public pages contain only the application shell; client records are never
embedded in generated HTML.

## Local setup

1. In Privy, enable email login and allow `http://localhost:4321` and
   `https://windwardlabs.xyz` as login origins. Embedded wallets are not needed.
2. Set these public values in the repository root's `.env.local`:

   ```env
   PUBLIC_PRIVY_APP_ID=your-app-id
   PUBLIC_SERVICE_API_URL=http://localhost:8787
   # Optional, if using a Privy app client:
   PUBLIC_PRIVY_CLIENT_ID=your-client-id
   ```

3. Set backend credentials in `backend/.dev.vars`:

   ```env
   PRIVY_APP_ID=your-app-id
   PRIVY_APP_SECRET=your-app-secret
   ```

   Both files are ignored by Git. Never put the app secret in a `PUBLIC_` variable.
4. Run `npm run db:migrate:local`, then `npm run dev:api` in one terminal and
   `npm run dev` in another. Open `/service/`.

## Testing credit purchases without real money

The Astro dev server uses only Stripe test Payment Links. Missing or invalid
test links disable checkout rather than falling back to live payments. The dev
portal also requires a loopback API URL so test credits stay in local D1.
Production builds always use the live catalog.

Set these public URLs in `.env.local` and restart the Astro dev server:

```env
PUBLIC_STRIPE_TEST_LINK_16=https://buy.stripe.com/test_fZu8wQeuKdN4cic13ieME00
PUBLIC_STRIPE_TEST_LINK_32=https://buy.stripe.com/test_6oU8wQfyO8sK3LG8vKeME01
PUBLIC_STRIPE_TEST_LINK_64=https://buy.stripe.com/test_aFabJ2dqG6kC5TO7rGeME02
```

1. Open a local client account and select Add credits. Check the test-mode notice
   and the pack's credit quantity and subtotal.
2. Continue to Stripe and check that checkout says Sandbox. Pay with test card
   `4242 4242 4242 4242`, any future expiry (for example `12/34`), and any
   three-digit CVC. No real money moves.
3. After payment, Stripe returns to the same client account. The backend verifies
   the session directly with Stripe, automatically adds the purchased credits,
   and shows Payment successful with the updated balance.
4. Reload the return page: it must not add credits again. A declined test card
   (`4000 0000 0000 0002`) must not add credits.

Backend `.dev.vars` also needs `STRIPE_MODE=test` and `STRIPE_SECRET_KEY=sk_test_…`.
Run `npm run dev:stripe` in another terminal. It forwards Stripe test webhooks
and saves its signing secret into `.dev.vars` (never into Git). Restart
`npm run dev:api` after the signing secret is saved. Keep this listener
running to fulfill payments even when the buyer closes the checkout tab.

The return-page verification and webhook share one fulfillment operation. It
checks the successful payment, environment, client reference, fixed price,
quantity, currency, and undiscounted subtotal. A unique PaymentIntent reference
makes concurrent retries safe. The browser never supplies a credit award.

Stripe Tax is not configured in Test mode, so these test links do not cover tax
calculation. Tax charged in production does not change the number of credits.
Stripe's test card reference: https://docs.stripe.com/testing

For production, set Cloudflare secrets `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`, and the variable `STRIPE_MODE=live`. Configure a Stripe
live webhook for `checkout.session.completed` and
`checkout.session.async_payment_succeeded` at
`https://windward-service-api.windwardlabs.workers.dev/v1/stripe/webhook`.
After deploying the updated frontend/backend, change each live Payment Link's
After payment redirect to
`https://windwardlabs.xyz/service/?payment=returned&session_id={CHECKOUT_SESSION_ID}`.
Test keys and local webhooks must never be attached to the production database.
Until production Stripe credentials are configured, the portal preserves the
staff purchase-confirmation form. It disappears when the backend reports that
automatic payment confirmation is configured.

## Product flow

- A verified `@windwardlabs.xyz` email sees all clients and can create accounts,
  approve client emails, record work, and update progress.
- Staff copy an account's client link and send it through their existing channel.
  Copying the link does not send an invitation. The link itself grants no access;
  the signed-in email must be approved for that account.
- Clients see their assigned accounts, work descriptions and progress notes,
  credit activity, and Stripe checkout. Only staff can change records.
- Checkout adds a client reference and prefills the signed-in email. These are
  reconciliation hints, not proof of payment or authorization.
- After a successful payment, Stripe verification automatically records its
  canonical PaymentIntent ID (`pi_...`). The ID is unique across all
  clients. The webhook and authenticated return page share this idempotent
  operation; neither can credit the same PaymentIntent twice.
- A work record deducts its credits immediately, including queued work. Updating
  progress never deducts again. Cancellation returns the charge once and closes
  the record. The database rejects overdrafts and keeps immutable ledger entries.
- Descriptions, progress notes, and payment verification notes are visible to
  clients. Keep internal discussion outside these fields.

## Production setup

The production backend was provisioned on 2026-10-03:

- Worker: `https://windward-service-api.windwardlabs.workers.dev`
- D1: `windward-service`, ID `d537de2a-33a0-4e54-b222-b93b9da1b0ef`
- Initial schema applied; `PRIVY_APP_SECRET` stored as a Worker secret.
- GitHub Actions variables `PUBLIC_PRIVY_APP_ID` and `PUBLIC_SERVICE_API_URL` set.
- The published API rejects unauthenticated requests with HTTP 401.

For production Stripe provisioning, save only the live key in the ignored file
`backend/.dev.vars.production` as `STRIPE_SECRET_KEY=sk_live_…`. Run
`node backend/provision-stripe-live.mjs` to verify the Stripe account, create the
live webhook, save its signing secret in that file, and upload both secrets to
Cloudflare. Deploy the Worker, merge and deploy the frontend, then run
`node backend/provision-stripe-live.mjs --redirects` to switch the live links to
the deployed return page. This order avoids redirecting buyers to an unfinished
page.

The website changes still need to be deployed, followed by live staff/client
sign-in verification. The database starts empty; create clients through the staff
dashboard after signing in. No R2 bucket or attachment endpoints are configured yet.

For a new environment, provision a separate database instead of recreating the
existing production database:

```sh
npx wrangler login
npx wrangler d1 create windward-service --config backend/wrangler.jsonc
```

Replace `database_id` in that environment's Wrangler configuration with the returned
ID. Set `PRIVY_APP_ID` to the same public ID used by the frontend. Review
`ALLOWED_ORIGINS`; remove localhost for production and include only the site's
actual origins.

```sh
npx wrangler secret put PRIVY_APP_SECRET --config backend/wrangler.jsonc
npx wrangler d1 migrations apply windward-service --remote --config backend/wrangler.jsonc
npx wrangler deploy --config backend/wrangler.jsonc
```

Set GitHub repository Actions **variables** (not browser secrets):
`PUBLIC_PRIVY_APP_ID`, optional `PUBLIC_PRIVY_CLIENT_ID`, and
`PUBLIC_SERVICE_API_URL` with the deployed Worker URL. The Pages workflow passes
them into the Astro build. The app secret exists only in Cloudflare Worker secrets.
Avoid publishing a build that uses the local `.env.local` API URL.

## Verification

`npm test` uses Node 22's SQLite engine to exercise the same migration, database
triggers, and API handlers as D1. Tests cover account isolation, staff-only writes,
revoked access, purchase and work retries, duplicate references, overdrafts,
progress updates, and refunds. `npm run typecheck` checks the frontend, and
`npm run build` verifies the static site.

Before launch, sign in once with a Windward email and once with an approved client
email against the deployed Worker. Verify checkout pack amounts in Stripe without
submitting a payment. A successful build does not verify email delivery or Privy's
origin settings.

References: [Privy React setup](https://docs.privy.io/basics/react/setup),
[Privy access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens),
[Cloudflare D1 transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

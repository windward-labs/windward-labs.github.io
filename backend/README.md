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
PUBLIC_STRIPE_TEST_LINK_8=https://buy.stripe.com/test_7sYbJ24UadN4gysbHWeME03
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
`checkout.session.async_payment_succeeded`, plus `invoice.paid` and
`invoice.voided`, at
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
  the record. Work can exceed prepaid credits; the portal shows credits owed
  and the form warns staff before submission. Ledger entries remain immutable.
- Descriptions, progress notes, and payment verification notes are visible to
  clients. Keep internal discussion outside these fields.

## Production setup

The production backend was provisioned on 2026-10-03:

- Worker: `https://windward-service-api.windwardlabs.workers.dev`
- D1: `windward-service`, ID `d537de2a-33a0-4e54-b222-b93b9da1b0ef`
- Initial schema applied; `PRIVY_APP_SECRET` stored as a Worker secret.
- GitHub Actions variables `PUBLIC_PRIVY_APP_ID` and `PUBLIC_SERVICE_API_URL` set.
- The published API rejects unauthenticated requests with HTTP 401.
- Private R2 bucket `windward-service-attachments` and the attachment metadata
  migration were provisioned on 2026-10-04. Public `r2.dev` access is disabled.

For production Stripe provisioning, save only the live key in the ignored file
`backend/.dev.vars.production` as `STRIPE_SECRET_KEY=sk_live_…`. Run
`node backend/provision-stripe-live.mjs` to verify the Stripe account, create the
live webhook, save its signing secret in that file, and upload both secrets to
Cloudflare. Deploy the Worker, merge and deploy the frontend, then run
`node backend/provision-stripe-live.mjs --redirects` to switch the live links to
the deployed return page. This order avoids redirecting buyers to an unfinished
page.

The website and live Stripe integration are deployed. Create clients through the
staff dashboard after signing in.

## Staff-reviewed month-end billing

The account balance can go negative. `credits owed` combines unbilled negative
credits and unpaid issued invoices. Staff use **Month-end billing** to select a
completed month (UTC), review its remaining overage at $75 per credit, enter a
billing email, and create a draft. Only staff can create, approve, or void bills.
Drafts are visible only to staff and do not change credits or contact Stripe.

**Approve & issue invoice** reserves the reviewed debt atomically, transfers it
from the prepaid balance into an unpaid invoice, and creates a Stripe invoice
with a 30-day payment term. Automatic collection and email are disabled. Staff
copy the hosted payment link and share it through their existing channel; clients
can also pay issued invoices from the portal. There is no scheduled invoice job.

Before an invoice is issued, top-ups cover unbilled overages. After issuing, its
debt is separate: top-ups buy credits and the invoice is paid through its own
link. Payment verification marks the invoice paid without crediting the account
again. Signed `invoice.paid`/`invoice.voided` webhooks and the portal refresh
button verify the current Stripe invoice against the recorded amount, client,
invoice ID, and test/live environment. Returning to the portal tab refreshes
open invoice statuses as well.

A unique active invoice per client/month prevents duplicate billing. Billing
uses the highest running credit balance since the selected month ended, so
later work cannot revive old debt cleared by a top-up. The approval step rejects
a draft whose credits have already been covered. If Stripe fails, the bill stays
in **Preparing invoice**; **Retry issuing invoice** resumes its stored Stripe IDs
and idempotency keys without moving credits twice. Voiding an unpaid bill returns
its credits to the unbilled balance; paid invoices cannot be voided here.

Invoices currently use a fixed USD total at $75/credit without automatic Stripe
Tax; review billing details before issuing. Existing Payment Link purchases keep
their tax configuration.

Deploy `0003_overage_billing.sql` before the Worker update, then run
`node backend/provision-stripe-live.mjs --events-only` to add the invoice webhook events.
Restart `npm run dev:stripe` locally to forward those events. To verify Stripe
integration without real payments or emails, run:

```sh
node backend/verify-test-billing.mjs
```

The verification requires `STRIPE_MODE=test` and a test key in `.dev.vars`. It
creates an isolated test invoice with an in-memory database and simulates a
full test settlement. It never modifies the local or production D1 database.

## Work hours and attachments

Staff enter work time in 15-minute increments. The form shows the deduction at
the normal rate of 4 credits per hour before submitting; the API retains its
whole-credit ledger and idempotent work charges.

Attachments use the private `windward-service-attachments` R2 bucket bound as
`ATTACHMENTS`. Enable R2 in the Cloudflare account first, then provision and deploy:

```sh
npx wrangler r2 bucket create windward-service-attachments --config backend/wrangler.jsonc
npx wrangler d1 migrations apply windward-service --remote --config backend/wrangler.jsonc
npx wrangler deploy --config backend/wrangler.jsonc
```

Deploy the backend before publishing the frontend. For local development, apply
the migrations with `npm run db:migrate:local`; Wrangler uses local R2 storage
without connecting to the production bucket.

Staff can attach up to five nonempty files of up to 10 MiB each when recording
work and separately on each progress update. Files appear under the description
or update they belong to. D1 stores file metadata and R2 stores the bytes. Uploads and downloads use
`/v1/clients/:clientId/tasks/:taskId/attachments/:attachmentId`, authenticated
through Privy. Downloads recheck current client membership and force files to
download instead of serving executable content inline. Do not enable public
bucket access.

Work is saved before its attachments. If an upload fails, the form retains its
record and file IDs so submitting again resumes the uploads without another
credit deduction. Only completed uploads appear in the work detail. Reserved
file IDs cannot be reused with different contents.
Progress uploads add `?update=:updateId` to the upload endpoint. The server
requires that update to belong to the same task and client. Failed uploads can
be retried even on a cancellation update without duplicating its refund.

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

`npm test` uses Node 22's SQLite engine to exercise the same migrations, database
triggers, and API handlers as D1. Tests cover account isolation, staff-only writes,
revoked access, purchase and work retries, duplicate references, overages,
progress updates, refunds, private attachment access, file limits, and failed
upload retries, month-end bill review, duplicate invoice prevention, and invoice
settlement/voiding. `npm run typecheck` checks the frontend, and
`npm run build` verifies the static site.

Before launch, sign in once with a Windward email and once with an approved client
email against the deployed Worker. Verify checkout pack amounts in Stripe without
submitting a payment. A successful build does not verify email delivery or Privy's
origin settings.

References: [Privy React setup](https://docs.privy.io/basics/react/setup),
[Privy access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens),
[Cloudflare D1 transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

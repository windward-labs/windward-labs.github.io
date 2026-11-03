# Historical project attribution correction — pending source verification

Status: historical correction approval is pending. The feature was implemented
and validated locally before release. Deployment of the feature and migration
is authorized separately; historical corrections remain unexecuted. This
document does not constitute approval to execute corrections.

## Evidence and existing model

The service uses Cloudflare D1, not Supabase. No database snapshot or historical
export exists in this checkout. No actual client, project, work-entry or invoice
IDs, invoice statuses or balances have been verified. The requester confirmed
the year as 2026 for both July and September.
`tests/portal.test.mjs` contains synthetic Career Tab / Site Updates examples
using randomly generated UUIDs. They are not evidence of current records.

`tasks` stores project metadata and charged credits. `work_entries` stores dated
work, hours, whole credits, author, private source references and an optimistic
version. A debit entry charges the immutable ledger once; legacy allocations
represent previously charged work. `billable_work` drives month-end billing.
Invoices store fixed period, credit and currency totals, status and Stripe IDs;
they do not contain an entry-to-invoice junction or per-project invoice snapshot.
Locks are inferred by client, date, period and invoice attribution mode.
Ledger billing transfers change the prepaid balance; settlement does not award
credits again. Fixed-price charges and private time are separate tables.

The least risky design keeps all these tables and their triggers intact. New
append-only adjustment headers and per-entry revisions produce a reporting-only
allocation view. Financial history continues to use the original records. A
single INSERT applies the entire adjustment through database triggers, with
entry-version and attribution-revision checks, exact totals, same-client target
validation, and rollback on any conflict. Admin authorization is checked before
writing; the existing verified staff role is the service's human admin role.
Agent keys require the explicit `admin` scope.

## Intended changes (business instructions, not verified database totals)

| Period / source work | Current attribution reported by requester | Intended attribution |
| --- | --- | --- |
| July, Qian, 15 hours / 60 credits | Ribbit Site Updates | Site Updates 5 hours / 20 credits; Annual Meeting Invite 10 hours / 40 credits |
| July, Jeff, 0.5 hours / 2 credits | Site Updates | Retain 0.5 hours / 2 credits; exclude from correction request |
| September, 7.25 hours / 29 credits | Site Updates | Career Tab 7.25 hours / 29 credits |

For only the named July work, resulting totals are Site Updates **5.5 hours /
22 credits** and Annual Meeting Invite **10 hours / 40 credits**, combined
**15.5 hours / 62 credits**. Other work on these projects must be included in
full-period totals after discovery. For September, Site Updates decreases by
7.25 hours / 29 credits and Career Tab increases by the same amount. Their
absolute project totals are unknown until all entries and current overlays are
examined. Do not assume September is one source entry or that July is one entry.

## Read-only discovery on a sanitized local snapshot

An authorized data custodian must supply an approved, sanitized D1 snapshot;
use the confirmed year 2026 and verify client and author identities independently. Do not
retrieve production credentials as part of this review. On the local copy,
inspect the original records before constructing a request:

```sql
-- Discovery only: names narrow candidates, never authorize mutation by title.
SELECT c.id AS client_id,c.name,t.id AS project_id,t.title,t.billing_mode,
       t.status,t.credits,t.original_credits,t.pricing_model
FROM clients c JOIN tasks t ON t.client_id=c.id
WHERE lower(c.name) LIKE '%ribbit%' OR lower(t.title) LIKE '%ribbit%'
   OR lower(t.title) LIKE '%site updates%'
   OR lower(t.title) LIKE '%annual meeting%' OR lower(t.title) LIKE '%career%'
ORDER BY c.id,t.id;

-- Bind verified client UUID and year; show ALL July/September entries, not just
-- a guessed note, actor name, amount or project spelling.
SELECT e.*,t.client_id,t.title,t.status AS original_project_status
FROM work_entries e JOIN tasks t ON t.id=e.task_id
WHERE t.client_id=:client_id
  AND substr(e.occurred_at,1,7) IN (:year||'-07',:year||'-09')
ORDER BY e.occurred_at,e.id;

SELECT * FROM invoices WHERE client_id=:client_id ORDER BY period,id;
SELECT * FROM ledger WHERE client_id=:client_id ORDER BY created_at,id;
SELECT id,name,balance FROM clients WHERE id=:client_id;
```

If migration 0012 is missing, apply it **only to a disposable local copy** after
recording original financial rows. It creates empty audit tables and a view; it
does not insert historical corrections or update existing records. Then inspect:

```sql
SELECT a.* FROM current_work_allocations a JOIN tasks t ON t.id=a.original_task_id
WHERE t.client_id=:client_id ORDER BY a.entry_id,a.task_id;
SELECT a.*,r.* FROM attribution_adjustments a
JOIN attribution_revisions r ON r.adjustment_id=a.id
WHERE a.client_id=:client_id ORDER BY a.created_at,a.id,r.entry_id;
```

Match Qian and Jeff using verified author identities and supporting source
references, not fuzzy names alone. Preserve notes and dates exactly. Confirm
whether source entries are legacy allocations or debits. If work is still a
legacy task charge without existing work-entry IDs, stop: this feature cannot
invent entries or convert locked charges. Resolve that scope separately.

## Build the review artifact

Create a request JSON using only observed UUIDs and versions, with one complete
allocation array per affected source entry. Use a new UUID as the adjustment
`id`, a specific review reason, each observed `expectedVersion`, and the current
`expectedRevision` (zero only when confirmed uncorrected). Each row's allocations
must sum to that original row's hours and credits at its existing 4:1 rate.
Do not include Jeff's entry. If July or September span multiple source rows,
review how each source row maps to the required totals before specifying splits.

Run the offline command (Node 22+):

```sh
node backend/preview-project-attribution.mjs SANITIZED_LOCAL.sqlite CLIENT_UUID REQUEST.json > REVIEW.json
```

The command opens SQLite read-only, loads no environment files or credentials,
and performs no network calls. The report contains exact source entry IDs,
dates, notes, hours, credits, actor, current/revised allocations, monthly project
totals, invoice rows and balance. Treat the report as private client data.
The feature also offers an admin-only `POST .../project-attribution/preview`
with the identical request body for an authorized non-production environment.

Approval is pending: actual source records, exact request JSON, absolute monthly
project totals and invoice evidence are unavailable in this checkout. Do not
substitute synthetic UUIDs or execute the business instructions in production.

## Admin review and subsequent execution (outside this task)

Review the generated report, verify all source records and allocations, and
record approval of the exact JSON. Before any later authorized production use,
re-read entry versions/revisions and financial history; regenerate the report
if anything changed. Keep the approved JSON and key for retries. Submit only
`POST /v1/clients/{client}/project-attribution`, never a work, purchase, invoice,
payment, refund, reallocation or cancellation request. A preview does not reserve
state: commit rejects conflicts transactionally. A lost response must be retried
with the exact same key, body and actor, even after a subsequent correction.

Verify source work, tasks, ledger, invoices, payment references, client balance
and billing previews are unchanged; verify corrected monthly project reports
and immutable audit history. Corrections to an adjustment require a new reason,
key and revision, never audit edits or deletion. Invoice snapshots/documents
are never regenerated, voided or resent by this feature.

## Files and validation

Implementation: `backend/migrations/0012_project_attribution.sql`,
`backend/project-attribution.mjs`, `backend/preview-project-attribution.mjs`,
`backend/api.mjs`, `backend/agent-auth.mjs`, `backend/work-entries.mjs`.
Project views and reports: `src/services/portal/Portal.tsx`,
`src/services/portal/types.ts`, `src/services/portal/log-hours.mjs`,
`src/services/portal/time-activity.mjs`.
Tests: `tests/portal.test.mjs`, `tests/time-activity.test.mjs`.
Documentation: `backend/AGENT_API.md`, `backend/README.md`, this review plan.

Validation commands: `npm test`, `npm run typecheck`, `npm run build`.
Tests use SQLite with the actual migrations, handlers and triggers. They cover
locked and unlocked periods, splits, exact retries, conflicting retries,
concurrent revisions, audit immutability and history, admin permissions,
client isolation, invalid totals/fields/projects, dry-run purity, and unchanged
source records, billing previews, invoice rows and client balances.
No deployed Cloudflare or Stripe integration test was run for this change.

Local validation result: **103 tests passed**, TypeScript check passed, static
production build passed. Build reports the existing empty `writing` collection
warning. Validation did not use production credentials. The offline snapshot test compares
the complete snapshot file bytes before/after preview to verify no modification.
Cloudflare's current [D1 SQL documentation](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
confirms SQLite SQL and JSON support; deployed runtime validation remains pending.

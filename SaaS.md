# Towncenter hosted service

## Product model

Towncenter ships one public AGPL binary. Self-hosted and hosted deployments run
the same code and schema. Billing, paid quotas, and hosted onboarding become
active only when their environment variables are present.

The hosted v1 is deliberately single-user: one `users` row is one tenant. Its
territory, events, price grid, settings, and subscription are isolated by
`owner_id`. There are no organizations, memberships, invitations, teams, or
shared territories in v1.

This is a shared Postgres deployment, not a dedicated application or database
per customer. Marketing and legal copy must not call it a dedicated instance.

Self-hosting remains a first-class path. With no Mollie key, billing is inert
and quotas are unlimited.

## Schema

The hosted layer adds two tables to the six core tables:

```text
subscriptions
  owner_id                  text primary key references users on delete cascade
  mollie_customer_id        text
  mollie_subscription_id    text
  plan_id                   text not null default 'pro'
  status                    text not null default 'pending'
  current_period_start      timestamptz
  current_period_end        timestamptz
  trial_ends_at             timestamptz
  trial_reminder_sent_at    timestamptz
  created_at                timestamptz not null default now()
  updated_at                timestamptz not null default now()

password_reset_tokens
  id                        text primary key
  user_id                   text not null references users on delete cascade
  token_hash                text not null unique
  expires_at                timestamptz not null
  created_at                timestamptz not null default now()
```

`users.sessions_invalidated_at` invalidates sessions created before a completed
password reset. Quota usage is derived from existing target and zone rows; no
usage-counter table exists.

## Signup and authentication

When `NEXT_PUBLIC_SAAS=true`, signups stay open automatically. A new account
signs in immediately and enters SaaS onboarding: price grid, plan explanation,
then the first sector. The platform supplies the Google Places key.

Without SaaS mode, the first self-hosted account owns the instance and closes
registration. `ALLOW_SIGNUPS=true` reopens additional self-hosted accounts.

The session identifies a user account. Every exported read receives that
account first, and every owned query filters by `owner_id`.
`scripts/verify-tenancy.mts` is the executable isolation contract.

## Billing

There is one Pro plan at €10 per month with no free trial.

1. Checkout creates a Mollie customer and charges €10 for the first month.
2. Mollie captures the reusable card or PayPal mandate with that payment.
3. The payment webhook opens the paid period and creates the monthly
   subscription for later renewals.
4. Renewal payment webhooks advance the paid period each month.

Canceling keeps access through the paid period. Existing data stays readable
after expiry; costly surveying actions stop. Legacy trial columns and states
remain readable until every account created under the retired trial has
drained.

## Monthly quotas

| Resource | Limit | Source |
|---|---:|---|
| Businesses harvested | 2,500 | `targets.harvested_at` |
| Google Places enrichments | 300 | `targets.google_fetched_at` |
| Site audits | 100 | `targets.audited_at` |
| Total area surveyed | 50 km² | Sum of zone bounding-box areas |
| Area per zone | 12 km² | Geometry guard before insertion |

Counts start at the current paid-period boundary, or the legacy trial boundary
for an account that still has one. The cumulative-area
check and zone insertion run in one transaction under an account-scoped
Postgres advisory lock, so concurrent requests cannot cross the limit.

## Email

Resend sends welcome, password-reset, subscription-activated, suspended, and
canceled messages. Legacy trial reminders remain until old trials drain.
Password-reset tokens are SHA-256 hashes, expire after 30 minutes, are
single-use, and are limited to three requests per hour per account.

Without `RESEND_API_KEY` and `EMAIL_FROM`, messages are logged instead of sent.
Email failure never fails signup, password reset, or a Mollie webhook.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Shared Postgres connection |
| `AUTH_SECRET` | Session signing and account API-key encryption secret |
| `APP_URL` | Canonical hosted origin and callback base |
| `NEXT_PUBLIC_SAAS=true` | SaaS onboarding and permanently open signup |
| `MOLLIE_API_KEY` | Billing and quota enforcement |
| `GOOGLE_PLACES_API_KEY` | Platform enrichment key |
| `RESEND_API_KEY` | Transactional email provider |
| `EMAIL_FROM` | Verified sender identity |
| `ALLOW_SIGNUPS` | Additional self-hosted accounts only |

## Deployment contract

The application service runs `npm start`, which applies committed Drizzle
migrations before starting Next.js. Mollie calls `/api/mollie/webhook`. A
The legacy trial-reminder job can be removed once no trial rows remain.

Before opening traffic, verify:

- `npm run lint`, `npm run typecheck`, `npm run verify`, and `npm run build`;
- signup, onboarding, first charge, mandate capture, renewal, cancellation,
  expiry, and re-subscription against Mollie test mode;
- welcome and password-reset delivery from the verified Resend domain;
- database backup and restore, application health checks, and error alerts;
- account data-access and deletion requests through the published contact channel;
- self-hosted startup with all SaaS environment variables absent.

## Outside this repository

Infrastructure credentials, database backups, monitoring, alerts, and any
internal administrative dashboard remain private operational concerns. An
admin tool may inspect or suspend an account, but it must not introduce teams,
roles, sales pipelines, or cross-account access into the product.

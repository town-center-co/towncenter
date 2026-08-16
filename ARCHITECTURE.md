# Architecture and conventions

The constraints a contributor would otherwise break. Most are invisible to
`tsc` and to `next build`: the code compiles, the build passes, the product is
quietly wrong. Read this before changing anything under `lib/`, `app/` or
`components/`. Setup and pull requests: [`README.md`](README.md),
[`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## What the product does

You draw a sector on a map; it fills with the businesses registered there,
from the French national company register. Each becomes a **target** with two
numbers: the **loot** (what you would earn if it signed) and the **resistance**
(what stands between you and the signature).

The map is the product, and everything on it is backed by a measured fact:
loot from a price grid the operator actually charges, resistance from the state
of the website, the footfall and the ability to pay. Nothing climbs to look
busy — a number with no fact behind it does not belong here.

---

## Where the product is going, and what that repeals

**Since 2026-08-04: a target you take becomes a project that holds its
documents** — the quote, the mockup, the deliverables. A hosted service now
runs the same AGPL binary; self-hosting stays a first-class path permanently.

> [!WARNING]
> The previous rule said the exact opposite and is **repealed**: "a target once
> taken leaves the game; what happens afterwards is handled elsewhere." Do not
> reinstate it believing you are correcting a scope drift — it is a decision,
> and it is dated.

**The project and document layer is not built.** The hosted service adds
subscriptions and password-reset tokens, but still stores zero document bytes:
no object storage, no blob column, no multipart handler. Until a table exists,
the docs say "to be built", not "coming soon".

Three things do not move with the widening:

- **Still not a CRM.** No sales cycles, teams, roles, sales email sending, or
  imported lists. The line is sharp: a quote attached to a project is a
  **document**; a configurable pipeline with stages is a CRM.
- **The map stays the product.** Projects are reached **from** a target you
  took, never a parallel tab.
- **Any new table carrying `owner_id` joins `scripts/verify-tenancy.mts` in the
  same pull request that creates it.**

---

## Stack and layout

Next.js 16 (App Router, React 19, Server Components), TypeScript, Drizzle ORM
on Postgres 16, MapLibre GL 5 with OpenFreeMap tiles, Tailwind 4 plus CSS
modules. Node 22+. No test framework: three executable benches under
`scripts/`.

| Path | What lives there |
|---|---|
| `app/` | Routes, Server Actions (`actions.ts`), all reads (`queries.ts`) |
| `components/map/` | Map, target sheet, sector panel, field and fact inventories |
| `components/ui/` | Shared primitives, including the provenance registry `Source.tsx` |
| `lib/scoring.ts` | Price and probability. Pure. |
| `lib/priceGrid.ts` | `DEFAULT_PRICE_GRID`, its validation schema, `standardDealCents(grid)` |
| `lib/sources/` | SIRENE, IGN geocoder, Google Places, in-repo site audit |
| `lib/db/schema.ts` | The eight tables and their indexes |
| `scripts/verify-*.mts` | The benches |

---

## Numbers

**Money is whole cents, everywhere** — database, types, intermediate
computations; never a float. Ratings are whole tenths (`46` is 4.6).

**A Postgres `integer` is 32 bits**, and register revenues exceed it by an
order of magnitude on real data: `revenue_cents` and `net_income_cents` are
`bigint`, and any new money column is `bigint` until proven otherwise.

**Percentages never render with a decimal.** They round to a step of 5
(`PERCENT_ROUNDING_STEP` in `lib/scoring.ts`) and carry
`Estimate not calibrated (n = X)` until `CALIBRATION_MIN_OUTCOMES` (30, in
`lib/types.ts`) real outcomes are recorded.

In the target sheet header the percentage is also the button that opens the
factor-by-factor breakdown in the **Facts** tab — never put the calculation
out of reach of the number that came from it.

---

## Scoring

**`lib/scoring.ts` is pure**: no network, no database, no React, no clock.
Everything that varies arrives through `ScoringContext` — outcome count, price
grid, reference date, recalibrated base probability. That purity keeps
`scripts/verify-scoring.mts` runnable with no database.

**Scores are recomputed on read, never stored.** Facts are stored, scores
derived — that is what lets the model be recalibrated without a migration.

**The price grid is data, not a constant, and each account has its own.** Type
`PriceGrid` (`lib/types.ts`), documented default `DEFAULT_PRICE_GRID`
(`lib/priceGrid.ts`), per-account row in `price_grids` (primary key
`owner_id`, one row per account), reaching scoring through
`ScoringContext.grid`. A missing row is the normal state of a fresh account,
which plays on the default; `/pricing` writes the row on first save.

**An off-grid target is not a €0 target.** Online sales detected, or more than
five establishments: the price stops being derivable from the grid and the
reason is written out in full. Those are often the best deals in the file —
never sink them to the bottom of a sort, never replace the written reason with
a zero.

---

## Interface conventions

**Interface in English, amounts and dates French-formatted.** Screens,
buttons, price reasons, error messages and the prompt template are English.
`lib/format.ts` is pinned to `fr-FR` / `Europe/Paris` and does not move — the
locale is frozen so server and client renders produce the same string;
changing it reopens a hydration mismatch on every amount. The only visible
French words are proper nouns: streets, towns, trade names.

**Keys are ASCII, labels are visible text, and the two never mix.** A key is a
short, lowercase, space-free string: URL value, storage key, `data-*`
attribute, MapLibre layer id, GeoJSON property, `TargetState`, `FactKey`,
`SourceKey`. Keys are never translated, never accented — an accented key
raises no error, it stops working, and a renamed key orphans every row already
written.

**Every displayed datum states where it came from, and "computed" counts.**
The registry is `components/ui/Source.tsx`: five ASCII keys — `sirene`,
`google`, `audit`, `log`, `computed` — each with its pictogram and legend
entry. `TargetFact.sources` is an **array of keys**, never free text.
`computed` is deliberately in the list even though it is not a source: loot
and resistance are measured nowhere, and leaving them bare would make them
look measured. **The badge shows even when the statistic is empty.**
Pictograms are told apart by **shape**, not colour — the palette has a single
blue, and a coloured mark would pull the eye to the provenance instead of the
figure.

**An empty field is the action that fills it, never a dead row** — the cell
reads `Set the website…` or `No accounts filed`. `components/map/fields.ts`
holds the inventory: every field yields a `FieldAction` — `api` (enrichment
would fill it), `input` (only you can), `resurvey` (a re-harvest might), or
`none` with its reason written out in full. A "nothing to do" is not clickable
and must not look like it.

The target sheet has a fixed header and three tabs — Approach, Facts, Log.

**UI components come from shadcn/ui, customized in place, never invented.**
`components.json` (registry `radix-nova`) and `cn()` in `lib/utils.ts` are the
entry points; a component the registry does not have is a component to do
without, not one to write. Their tokens are REFERENCES to the system tokens in
`globals.css` — `--primary` is the cobalt, shadcn's `bg-accent` is wired to
`--surface-2` — so they switch on `data-theme` with no palette and no `.dark`
block of their own; never give them one. Beware the case collision: the legacy
primitive `components/ui/Button.tsx` and shadcn's `button.tsx` are the SAME
file on a case-insensitive disk — adding the shadcn `button` replaces the
legacy `Button` and its call sites in the same move.

---

## Manual entry versus Google fields

**Hand-typed values never live in `phone` and `website_url`.** Those columns
are purged at 30 days by `purgeStaleGoogleFacts()`: a hand-typed value would
vanish silently a month later, destroyed under Google's terms for data Google
never supplied.

Manual values live in `manual_website_url` / `manual_phone`, never expire, and
**win over Google on read**. Writing a website resets `auditedAt` and
`siteAudit` to `null`, otherwise the audit would never rerun on the new
address.

---

## Data model, database and tenancy

Eight tables: `users`, `targets`, `zones`, `events`, `price_grids`,
`account_settings`, `subscriptions`, `password_reset_tokens`.

**The hosted v1 tenant is one user account.** Every owned row carries
`owner_id`; a subscription and a price grid are each keyed by that same user.
There are no organizations, memberships, invitations, or shared territories in
v1. Adding them is a later schema change, not an assumption callers may make.

**`rowid` does not exist in Postgres.** Two reads relied on it to break ties
between facts written in the same second; without a tiebreak, "roll back"
deletes the site audit instead of the phone call and nothing signals it. Hence
the `seq` column and `LEDGER_ORDER_DESC`, **defined once in the schema**: the
ledger displays what the rollback deletes, and two copies of the ordering
would diverge.

**Isolation runs through `owner_id`, never a role.** Every exported read in
`app/queries.ts` takes its owner as its **first parameter** — a call that
forgets it does not compile. The `where` clause is checked by no compiler;
that is what `scripts/verify-tenancy.mts` is for, the only bench whose failure
is a data leak. Any new table carrying `owner_id` joins it in the same pull
request.

---

## Server Actions and routing

**Mutations go through Server Actions, never API routes.** Every action calls
`requireUser()` on its **first line**: a Server Action is an HTTP entry point
reachable directly, its identifier readable in the client bundle; the check
the page performed does not protect it.

**The Next 16 convention here is `proxy.ts`, not `middleware.ts`** — do not
recreate one.

The first account created owns the instance and closes signups; only
`ALLOW_SIGNUPS` reopens them.

---

## Five traps that pass `tsc` and pass the build

**1. A `@container` never styles its own container**, only its descendants.
`container-type` on the reacting element gives a rule that never applies — no
error, no warning. Two elements: one measures, the other reacts.

**2. `maplibre-gl` stays on 5.x.** Version 6 emits its worker as a separate
file Turbopack does not bundle. The map loads the style, the TileJSON and the
sprite, then goes quiet: no tiles, no fonts, **no error** — the only signal is
the absence of `.pbf` requests. Any version bump is reviewed with that check.
API corollary: `setData` is synchronous in 5, returns a promise in 6.

**3. In a `"use server"` module, `export type { X }` on an imported type**
emits a runtime re-export of an identifier erased at compile time. `tsc`
passes, the build passes, the page dies on the first click. Form state types
live in their own files: `app/actionState.ts`, `app/login/state.ts`,
`app/pricing/state.ts`.

**4. A media query measures the window, not the container.** A 400 px panel on
a 1440 px screen still receives the "wide" layout. Container queries, or
explicit widths.

**5. A CSS token read back by `components/map/colors.ts` must be a literal hex
or `rgb()`.** `readPalette()` reads thirteen tokens with `getComputedStyle`
and passes them as they are to MapLibre. An unregistered custom property comes
back verbatim — `oklch(…)` or `color-mix(…)` — and MapLibre's parser knows
neither: the layer is ignored, no exception, no warning. Keep the original
OKLCH value in a comment and give the token the hex.

---

## Data sources, and what may not be done with them

Primary source: **`recherche-entreprises.api.gouv.fr`** — free, no key. Four
traps handled in `lib/sources/sirene.ts`, each verified against real calls:

- `near_point` returns a company as soon as *any* establishment touches the
  radius: filter on `matching_etablissements`, **never** on `siege`.
- Latitude and longitude come back as **strings**.
- `dirigeants[]` includes statutory auditors, not only directors.
- `statut_diffusion` other than `"O"` means the right to object was exercised.

**A non-diffusible establishment is neither stored nor displayed. No personal
contact details of a director are stored** — name and role only; you call the
establishment's own line.

**Google Places is required by enrichment, and by nothing else.** Without
`GOOGLE_PLACES_API_KEY` the two enrichment actions refuse to run and say what
to do; everything else stays free and key-less. There is no working key-less
mode: `targets.website_url` is written in exactly one place, from Google
Places' `websiteUri`. Measured on a real 331-business frame:
`0 enriched · 0 remaining · 772 with nothing to query`. Restoring one needs a
free source of URLs first — OpenStreetMap via Overpass carries one for ~21 %
of shops in a frame (103/488, measured in Puteaux).

**Google's terms allow only `place_id` to be kept indefinitely.** Rating,
review count, opening hours and price level expire at 30 days: fetch
timestamp, hidden on read past the window, then purged (`lib/retention.ts`).
Contractual, not a setting.

**Tile attribution is a licensing obligation, not decoration**: never
`attributionControl: false`, never a panel over the attribution.

---

## Benches

```bash
npm run lint         # eslint, zero errors required
npm run verify       # scoring, tenancy
npm run typecheck    # next typegen && tsc --noEmit
npm run build
```

| Bench | What it proves |
|---|---|
| `verify:scoring` | Lands on **five deals actually worked** — two signed, one refused, two off-grid — then two orderings and eleven invariants. |
| `verify:tenancy` | Every exported read returns only its owner's rows. **The only bench whose failure is a data leak.** |

`verify:tenancy` needs a real Postgres: a stub returning empty arrays would
pass every assertion. **If a scoring change breaks `verify:scoring`, the
scoring is wrong, never the bench.**

---

## Deployment notes

Any Node 22 host with Postgres. `npm start` runs the migrations
(`scripts/migrate.mjs`) **before** booting and exits on failure.

> **The database connection accessor stays lazy.** Postgres says nothing when
> a build-time pool takes connections and never returns them: on a managed
> instance capped at 20 connections, a few builds in a row hand
> `FATAL: too many clients already` to real users.

Required: `AUTH_SECRET` (32 characters minimum; it also encrypts stored account
API keys), `DATABASE_URL`,
`GOOGLE_PLACES_API_KEY`. Optional: `ALLOW_SIGNUPS`. See
[`.env.example`](.env.example). **No secret is ever copied into a tracked
file.**

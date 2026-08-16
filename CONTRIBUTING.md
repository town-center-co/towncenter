# Contributing to Towncenter

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the source of truth for conventions —
most are invisible to `tsc` and to `next build`, and each cost a real bug. This
file covers setup, benches and pull request rules.

---

## Where the product is going

Since 2026-08-04 the scope reaches past the signature: **a target you take
becomes a project that holds its documents** — quote, mockup, deliverables.
The hosted service runs the same binary; self-hosting stays a first-class path
under AGPL permanently.

**The project and document layer does not exist yet** — there are no uploaded
bytes. That is the open ground for contributions, with two boundaries that hold
regardless: it is still not a CRM (no sales cycles, teams, roles, or sales email
sending), and the map cannot become one view among several.

---

## Getting set up

```bash
npm install
cp .env.example .env.local     # fill AUTH_SECRET
docker compose up -d           # Postgres on port 5455
npm run db:push
npm run dev
```

---

## Running the benches

No test framework; three executable benches under `scripts/`:

```bash
npm run verify         # all three, in order
npm run verify:scoring # pure, no database needed
npm run verify:tenancy # needs a real Postgres
npm run verify:actions # needs a real Postgres
npm run lint           # eslint, zero errors required
npm run typecheck      # next typegen && tsc --noEmit
npm run build
```

`lint`, `typecheck`, `verify` and `build` must all be green before a pull
request. **CI only enforces the first one**: `.github/workflows/pull-request.yml`
runs `npm run lint` and holds the commits and the title to Conventional
Commits — `typecheck`, `verify` and `build` are yours to run locally until they
are wired in. `verify:tenancy` runs on a real database on purpose — a stub
client returning empty arrays would pass every assertion.

Two rules about the benches:

- **New table with `owner_id`: extend `scripts/verify-tenancy.mts` in the same
  pull request.** Isolation runs through `owner_id`, never a role, and that
  bench is the only check whose failure is a data leak.
- **A scoring change that breaks `verify:scoring` is wrong; the bench is not.**
  It holds five deals actually worked — two signed, one refused, two off-grid —
  and adjusting its expected values to match new code defeats the point.

---

## Code style

- TypeScript, no `any`; narrow unions over wide types; keys are string literal
  unions, never bare `string`.
- Identifiers, filenames and comments in English.
- Comments say what the code cannot: a trap, a measured fact, a reason — never
  narrate the line below.
- Server Components by default; `"use client"` only where an interaction needs
  it.
- Mutations go through Server Actions, never API routes; every action calls
  `requireUser()` on its first line.
- Money is whole cents, ratings whole tenths — never a float for money.
- Scores are recomputed on read, never stored.
- `lib/scoring.ts` stays pure: no network, no database, no React, no clock;
  anything that varies goes in `ScoringContext`.
- Tailwind for layout, CSS modules for components; any CSS token read back by
  `components/map/colors.ts` must be a literal hex or `rgb()`.

---

## Linting

```bash
npm run lint
```

ESLint 9 flat config (`eslint.config.mjs`) with `eslint-config-next`. Must pass
with zero errors before a pull request; warnings are acceptable for known
patterns (e.g. `setState` in `useEffect` for DOM reads after mount).

---

## Naming and imports

| Element | Convention |
|---|---|
| React components | `PascalCase.tsx` |
| Lib / utility files | `camelCase.ts` |
| Variables, functions | `camelCase` |
| Constants | `UPPER_SNAKE_CASE` |
| Types, interfaces | `PascalCase` |

**Imports**: absolute paths (`@/lib/scoring`) across directories, relative
(`./types`) within the same directory. No barrel files (`index.ts`) except
`lib/db/index.ts`.

---

## Commit messages

Enforced by [commitlint](commitlint.config.js) + [Husky](.husky/commit-msg):
[Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`,
`docs:`, `refactor:`, `chore:`, etc.

---

## Interface English, numbers French

Screens, buttons, error messages and price reasons are English. `lib/format.ts`
is pinned to `fr-FR` / `Europe/Paris` and does not move — changing it reopens a
hydration mismatch on every amount. Keys are short, lowercase, ASCII and
space-free; labels are visible text; the two never mix, and a renamed key
orphans every row already written. Details in
[`ARCHITECTURE.md`](ARCHITECTURE.md#interface-conventions).

---

## Traps that pass `tsc` and the build

Each cost a real bug; all are documented at length in
[`ARCHITECTURE.md`](ARCHITECTURE.md#five-traps-that-pass-tsc-and-pass-the-build):

1. A `@container` never styles its own container — one element measures, the
   other reacts.
2. `maplibre-gl` stays on 5.x — version 6 loses its worker under Turbopack: no
   tiles, no error.
3. In a `"use server"` module, never `export type { X }` on an imported type —
   form state types live in their own files.
4. A media query measures the window, not the container — use container queries
   or explicit widths.
5. A CSS token read by `readPalette()` must be a literal hex or `rgb()` —
   `oklch(…)` comes back verbatim and MapLibre ignores the layer.
6. A Postgres `integer` is 32 bits and `rowid` does not exist — hence `bigint`
   on money columns and the `seq` tiebreak.

---

## Pull requests

- One subject per pull request.
- Report what you **measured**, not what you expect.
- `lint`, `typecheck`, `verify` and `build` must all be green.
- Scoring change: `verify:scoring` must still land on the five real deals.
- New table with `owner_id`: extend `verify-tenancy.mts` in the same pull
  request.
- Schema change: run `npm run db:generate` and commit the SQL under `drizzle/`
  — `db:push` is a local convenience, `npm start` applies the committed
  migrations.
- Bugs and features through issues; security through
  [private vulnerability reporting](https://github.com/fberrez/towncenter/security/advisories/new),
  never a public issue.

By contributing you agree your changes are licensed under the
[GNU AGPL v3](LICENSE).

---

## What will be turned down

- A counter that climbs without a fact behind it.
- A director's personal contact details.
- Storing or displaying a non-diffusible establishment.
- Keeping Google Places fields past 30 days.
- `attributionControl: false`, or a panel over the map attribution.
- Anything that makes one account's data visible to another.
- A percentage with a decimal, or one that drops the "not calibrated" mention
  below 30 recorded outcomes.
- Treating an off-grid target as €0 instead of showing its written reason.
- Documentation that describes the projects/documents layer as shipped.
- Anything that degrades self-hosting to make a hosted plan look better.
- Sales-cycle stages, teams, roles or email sending — those make it a CRM.

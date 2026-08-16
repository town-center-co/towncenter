# Towncenter

**Neighbourhood-business prospecting on a map.**

Draw a sector on a map; it fills with every business registered there, from the
French national company register — free and key-less. Each becomes a **target**
with two numbers: the **loot** (what you earn if it signs) and the
**resistance** (what stands between you and the signature). Approach, engage,
take — street by street. Every number is backed by a measured fact; nothing
climbs to look busy.

![The map screen: a drawn sector on the left, a target sheet open on the right](docs/screenshot.png)

<sub>Every business name, address and amount in that screenshot is fabricated.</sub>

Today the product stops at the signature. The direction — a taken target
becoming a project that holds its documents — is described in
[ARCHITECTURE.md](ARCHITECTURE.md#where-the-product-is-going-and-what-that-repeals);
none of it is built yet.

---

## Stack

Next.js 16 (App Router, React 19, Server Components) · TypeScript ·
Postgres 16 / Drizzle ORM · MapLibre GL 5 / OpenFreeMap tiles · Tailwind 4.
Node 22+, Docker for the local database.

---

## Quick start

```bash
git clone https://github.com/fberrez/towncenter.git
cd towncenter
npm install

cp .env.example .env.local     # then fill AUTH_SECRET
docker compose up -d           # Postgres on port 5455
npm run db:push                # apply the schema
npm run dev
```

Generate `AUTH_SECRET` with `openssl rand -base64 48` (32 characters minimum,
enforced at boot). Open <http://localhost:3000>: **the first account owns the
instance and closes signups** — the Miniflux, Gitea, Vaultwarden and Plausible
pattern.

> [!WARNING]
> Until that first signup the instance is up for grabs. Sign up before pointing
> a public hostname at it.

---

## Environment variables

| Variable | Required | What it is |
|---|---|---|
| `AUTH_SECRET` | yes | Signs sessions and encrypts account API keys. 32 characters minimum. Rotating it logs everyone out and requires saved account keys to be entered again. |
| `DATABASE_URL` | yes | Postgres 14+. `.env.example` matches the bundled compose file. |
| `GOOGLE_PLACES_API_KEY` | for enrichment | Places API (New). Server-side only. An account key set on Setup wins over it. |
| `ALLOW_SIGNUPS` | no | Reopens signups after the first account. |

Full descriptions in [`.env.example`](.env.example).

---

## What needs a Google key, and what does not

| Source | Key | What it gives |
|---|---|---|
| `recherche-entreprises.api.gouv.fr` | no | SIREN, SIRET, trade name, address, coordinates, headcount, revenue, directors |
| `data.geopf.fr` (IGN geocoder) | no | Address to point |
| Site audit (in-repo) | no | Stack, HTTPS, sitemap, online sales, booking, agency detected |
| OpenFreeMap tiles | no | The map |
| **Google Places (New)** | **yes** | Rating, review count, price level, phone, opening hours |

Everything else — harvesting, scoring, map, ledger — is free and
key-less. **Enrichment has no working key-less mode**: `targets.website_url`
only comes from Google Places, so without a key the site audit never runs.

---

## Price grid

Every amount on the map comes from your grid, editable on `/pricing`. Scores
are recomputed on read, so a change applies everywhere; each account has its
own grid. The shipped grid is one freelancer's real rates — a starting point,
not a recommendation.

---

## Data rules

Enforced in code, not negotiable:

- Non-diffusible establishments are never stored, never shown.
- Directors: name and role only — no personal contact details.
- Google fields expire at 30 days; only `place_id` is kept indefinitely.
- Tile attribution is a licensing obligation: never `attributionControl: false`,
  never a panel over it.

---

## Development

```bash
npm run lint        # eslint, zero errors required
npm run verify      # scoring, tenant isolation (needs the database)
npm run typecheck   # next typegen && tsc --noEmit
npm run build
```

Benches and pull request rules: [`CONTRIBUTING.md`](CONTRIBUTING.md).
Conventions invisible to `tsc` and the build:
[`ARCHITECTURE.md`](ARCHITECTURE.md). Security reports:
[private vulnerability reporting](https://github.com/fberrez/towncenter/security/advisories/new),
never a public issue.

---

## Deploying

Any Node 22 host with Postgres. `npm start` runs migrations before booting and
exits on failure.

---

## Licence

[GNU AGPL v3](LICENSE). Self-host it, fork it, change it; a modified version
run as a network service must publish its source.

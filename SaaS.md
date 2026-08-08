# Towncenter → SaaS — Architecture

## Principe

Un seul repo (`towncenter`, public, AGPL), shared database, billing dans le
repo (inactif sans clés Mollie). Exactement le modèle Plausible.

```
towncenter/
├── src/                  # AGPL — tout le code
│   ├── app/              # Pages, Server Actions, API routes
│   ├── lib/              # Scoring, DB, auth, sources, billing
│   ├── components/       # UI, map
│   └── ...
├── scripts/              # Benches, migrations
├── LICENSE               # AGPL v3
└── ...
```

Le code billing est dans le repo, compilé partout, inopérant sans
`MOLLIE_API_KEY`. Self-hosted = même binaire, billing caché, quotas off.

---

## Base de données : shared database

Une seule DB Postgres. `organization_id` sur chaque table comme nouvelle
colonne d'isolation. `owner_id` reste (qui a fait l'action ≠ à qui
appartient la donnée).

### Nouvelles tables

```sql
organizations
  id         text PRIMARY KEY
  name       text NOT NULL
  slug       text NOT NULL UNIQUE
  created_at timestamptz NOT NULL DEFAULT now()

subscriptions            -- gated by MOLLIE_API_KEY
  organization_id        text PRIMARY KEY REFERENCES organizations
  mollie_customer_id     text
  mollie_subscription_id text
  plan_id                text NOT NULL DEFAULT 'pro'
  status                 text NOT NULL DEFAULT 'active'
  current_period_start   timestamptz NOT NULL
  current_period_end     timestamptz
  created_at             timestamptz NOT NULL DEFAULT now()
  updated_at             timestamptz NOT NULL DEFAULT now()
```

### Colonnes ajoutées aux tables existantes

Chaque table existante gagne `organization_id text NOT NULL REFERENCES
organizations(id)`. `price_grids` et `account_settings` passent en clé
composite `(organization_id)` au lieu de `(owner_id)`.

```sql
users              + organization_id
targets            + organization_id
zones              + organization_id, + area_km2 double precision
events             + organization_id
price_grids        + organization_id  (PK composite)
account_settings   + organization_id  (PK composite)
```

---

## Authentification

### Signup (mode SaaS, `NEXT_PUBLIC_SAAS=true`)

1. User remplit email + mot de passe + nom d'org + slug
2. `signUpAction` crée l'utilisateur ET l'organisation
3. L'utilisateur devient admin de son org
4. Redirection vers `/onboarding` (price grid uniquement, plus de Google key)

### Signup (mode self-hosted, `NEXT_PUBLIC_SAAS` absent)

1. Comportement actuel inchangé
2. Premier user → owner de l'instance, signups fermées
3. Une org implicite créée automatiquement (transparent pour l'utilisateur)

### Session

Le cookie JWT porte `organizationId`. `requireUser()` devient
`requireMembership()` et retourne `{ user, organization }`.

### `proxy.ts`

Ajoute la vérification que l'user appartient bien à l'org. Le cookie sans
`organizationId` = redirect login.

---

## Queries : isolation par `organization_id`

Chaque query exportée dans `app/queries.ts` ajoute
`eq(table.organizationId, organization.id)` à sa clause `WHERE`.

`scripts/verify-tenancy.mts` est étendu : il vérifie que chaque query ne
retourne que les lignes du bon `organization_id`. **Le seul bench dont
l'échec est une fuite de données.**

---

## Billing (Mollie)

### Plan unique

Un seul plan, intentionnellement bas. Pas de free tier, pas de segmentation
artificielle. €10/mois pour l'accès à la plateforme.

| Plan | Prix/mois |
|---|---|
| Pro | 10 € |

Tout le monde a le même plan. Les quotas ci-dessous sont des hard limits,
pas des leviers d'upsell. Si le produit marche, le prix monte pour tout le
monde — pas de grille à étages.

### Quotas mensuels (par organisation)

Tous dérivés de la donnée existante, pas de table `usage_counters`. Le
`checkQuota()` fait un `SELECT COUNT` / `SELECT SUM` sur la période de
billing en cours.

| Ressource | Limite/mois | Source |
|---|---|---|
| Targets harvestés | 2 500 | `COUNT targets WHERE harvested_at > period_start` |
| Google Places enrichments | 300 | `COUNT targets WHERE google_fetched_at > period_start` |
| Site audits | 100 | `COUNT targets WHERE audited_at > period_start` |
| Surface totale prospectée | 50 km² | `SUM zones.area_km2 WHERE started_at > period_start` |
| Surface max par zone | 12 km² | Hard limit (existant, `MAX_ZONE_AREA_KM2`) |

La limite de surface totale est le vrai garde-fou : elle empêche de
cartographier la France entière pour 10 €. Chaque zone complétée stocke son
`area_km2` (calculé depuis le bbox par `lib/geo.ts`). Le cumul mensuel est
comparé au plafond avant d'ouvrir une nouvelle zone.

### Colonne ajoutée à `zones`

```sql
zones + area_km2 double precision  -- calculé à la complétion de la zone
```

### Fichiers

```
src/lib/billing/
├── plans.ts         # Plan unique et ses limites
├── mollie.ts        # Client Mollie (gated by MOLLIE_API_KEY)
├── quotas.ts        # checkQuota(kind, organizationId)
└── subscriptions.ts # CRUD subscriptions

src/app/(app)/billing/
├── page.tsx         # Plan actuel, usage, bouton subscribe/manage
└── actions.ts       # createCheckoutSession, createPortalSession

src/app/api/mollie/webhook/route.ts  # Webhook handler (gated by env)
```

### Gate : env vars

| Env var | Absent (self-hosted) | Présent (SaaS) |
|---|---|---|
| `MOLLIE_API_KEY` | Pages billing → "Self-hosted", quotas → ∞ | Billing actif, quotas enforced |
| `NEXT_PUBLIC_SAAS` | Signup classique, pas de slug | Signup avec org |

### Flow de souscription

1. User sur `/billing` → `createCheckoutSession`
2. Server Action crée une checkout session Mollie → retourne l'URL
3. Redirection vers la page hosted Mollie
4. Paiement effectué → Mollie appelle le webhook
5. Webhook met à jour `subscriptions` → statut `active`
6. User redirigé vers `/billing?success=true`

### Quotas

```typescript
// lib/billing/quotas.ts
type QuotaKind = 'harvest' | 'enrich' | 'audit' | 'area';

interface QuotaStatus {
  allowed: boolean;
  used: number;
  limit: number;
}

export async function checkQuota(
  kind: QuotaKind,
  organizationId: string
): Promise<QuotaStatus> {
  if (!process.env.MOLLIE_API_KEY) {
    return { allowed: true, used: 0, limit: Infinity };
  }

  const sub = await getSubscription(organizationId);
  const periodStart = sub.currentPeriodStart;
  const limits = PLANS[sub.planId].limits;
  const used = await getUsage(kind, organizationId, periodStart);

  return {
    allowed: used < limits[kind],
    used,
    limit: limits[kind],
  };
}
```

Appelé en première ligne des actions `harvestZoneAction`,
`enrichZoneAction`, `enrichTargetAction`, et avant l'ouverture d'une
nouvelle zone (`harvestZoneAction` vérifie le cumul `area`). Si quota
dépassé → toast + lien vers `/billing`.

---

## Suppression du setup Google Places Key

En mode SaaS, `GOOGLE_PLACES_API_KEY` est une env var d'instance (fournie
par la plateforme). Les actions `testPlacesKeyAction`,
`savePlacesKeyAction`, `removePlacesKeyAction` sont gardées pour le mode
self-hosted mais cachées en SaaS. La page `/onboarding` saute l'étape
Google key quand `NEXT_PUBLIC_SAAS=true`.

---

## Ce qui reste dans `account_settings`

Le champ `google_places_key` reste pour le self-hosted. En SaaS, il n'est
jamais écrit. La table garde sa structure.

---

## Ce qui n'est PAS dans le repo

Infrastructure SaaS privée, hors repo public :

- **Admin dashboard** — lit la DB partagée en read-only. Outil interne
  (Retool, Grafana, ou une mini app Next.js séparée). Liste les orgs, leur
  plan, leur usage, permet de suspendre/réactiver.
- **Reverse proxy** — Caddy/Traefik, routing `towncenter.fr`.
- **Email templates** — welcome, reset password, invoice.
- **Monitoring** — health checks, alerts.

---

## Plan d'implémentation — 8 phases

### Phase 1 : Organizations & schema (~1 semaine)

- Créer `organizations`, `subscriptions` dans `lib/db/schema.ts`
- Ajouter `organization_id` à toutes les tables existantes
- Ajouter `area_km2` à `zones` (calculé à la complétion depuis le bbox)
- Migration + backfill (une org par `owner_id` existant)
- `requireUser()` → `requireMembership()`
- Signup crée une org automatiquement (SaaS et self-hosted)
- Étendre `verify-tenancy.mts` avec `organization_id`
- Tous les tests passent : `npm run verify && npm run typecheck && npm run lint`

### Phase 2 : Auth & routing (~3 jours)

- Cookie JWT porte `organizationId`
- `proxy.ts` vérifie l'appartenance à l'org
- Self-hosted : une org implicite, transparente
- Login/signup pages adaptées au mode SaaS (champ org name + slug)

### Phase 3 : Mollie billing (~1.5 semaines)

- `lib/billing/` : plans, client Mollie, quotas, subscriptions
- `app/(app)/billing/` : page plan actuel, subscribe/manage
- `app/api/mollie/webhook/` : handler webhook
- Gate : tout est inactif sans `MOLLIE_API_KEY`
- Tests en mode test Mollie

### Phase 4 : Quotas (~3 jours)

- `checkQuota()` dans `lib/billing/quotas.ts` (harvest, enrich, audit, area)
- Intégration dans `harvestZoneAction`, `enrichZoneAction`, `enrichTargetAction`
- `harvestZoneAction` vérifie le cumul `area` avant d'ouvrir une zone
- `UsageBar` dans le header (targets, enrichments, surface)
- Toast + lien `/billing` si quota dépassé

### Phase 5 : Landing & onboarding SaaS (~3 jours)

- `app/(marketing)/` : landing page, pricing page
- `/onboarding` simplifié (plus de Google key en SaaS)
- `NEXT_PUBLIC_SAAS` gate sur les pages marketing vs app

### Phase 6 : Password reset (~2 jours)

- SMTP : `app/api/auth/reset/`
- Pages `/forgot-password`, `/reset-password`
- Token store dans une nouvelle table `reset_tokens`
- Bénéficie au self-hosted et au SaaS

### Phase 7 : Admin dashboard (hors repo, ~3 jours)

- Mini app Next.js privée ou dashboard Retool
- Lecture read-only de la DB partagée
- Liste des orgs, plan, usage, statut
- Actions : suspendre, réactiver

### Phase 8 : Polish & self-hosted parity (~2 jours)

- Vérifier le flow self-hosted de bout en bout
- `NEXT_PUBLIC_SAAS` absent → tout fonctionne comme avant
- Docs self-hosted mises à jour (password reset, billing absent)
- Tests de non-régression

**Total : ~5 semaines**

---

## Décisions clés

1. **Shared database, pas database-per-tenant.** Une seule DB, isolation par
   `organization_id`. `verify-tenancy.mts` garantit l'absence de fuite.
   C'est le modèle Plausible.

2. **Billing dans le repo public, inactif sans clés.** Transparence totale.
   Self-hosters lisent le code, ne peuvent pas l'utiliser. Aucun build
   flag nécessaire pour le billing — juste des env vars.

3. **`organization_id` ET `owner_id` sur chaque table.** Le premier répond
   à "à qui appartient la donnée", le second à "qui a fait l'action". Les
   deux colonnes, toujours.

4. **Single user par org en v1.** La première personne qui signe up dans
   une org en est l'admin. La table `users` supporte déjà plusieurs
   utilisateurs — les invitations viendront plus tard.

5. **Pas de Google Places Key par compte en SaaS.** La plateforme fournit
   la clé via `GOOGLE_PLACES_API_KEY`. Le self-hosted garde sa clé par
   compte. Les deux modes cohabitent dans le même code.

6. **Mollie pour le paiement.** Provider européen, API propre, subscriptions
   natives. Le code billing est une couche fine (~400 lignes).

7. **Pas de `saas/` directory.** Le code SaaS (billing, landing, admin API)
   vit dans `src/` avec le reste. Pas de build multi-target. Tout est
   compilé, rien n'est caché. Les features SaaS sont gated par env vars,
   pas par compilation.

8. **Le bench `verify-tenancy.mts` est non-négociable.** Chaque nouvelle
   query, chaque nouvelle table avec `organization_id` doit y être
   vérifiée. Même sanction : un échec = une fuite de données.

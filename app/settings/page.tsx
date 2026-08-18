import type { Route } from "next";
import Link from "next/link";

import { Badge, Button, Card, CardHeader, CardTitle } from "@/components/ui";
import { requireUser } from "@/lib/accounts";
import { getAccountPlacesKey, getPlacesKeySource, maskKey } from "@/lib/settings";
import type { ScoringFacts } from "@/lib/types";

import { getPriceGrid } from "../queries";
import { PlacesKeyForm } from "./PlacesKeyForm";
import { removePlacesKeyAction } from "./actions";
import { PriceGridForm } from "./PriceGridForm";
import { ResetGrid } from "./ResetGrid";

import "./pricing.css";
import styles from "./settings.module.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings · Towncenter",
};

// Invented businesses, and they must stay invented: this screen has to give the
// SAME result for everyone, otherwise two people comparing grids would in fact
// be comparing two businesses. One per step, each chosen so it triggers the
// offer that step sets — a witness the step cannot move is a dead number.
const COMMON = {
  companyCreatedAt: null,
  revenueCents: null,
  financesYear: null,
  employeeRange: null,
  companyCategory: null,
  priceLevel: null,
  hasPhone: true,
  hasContactForm: false,
  directorCount: 1,
  proximity: "in-zone" as const,
  isOpen: true,
  isDiffusible: true,
  isFranchiseGroupSite: false,
};

const WITNESSES: Record<string, { who: string; facts: ScoringFacts }> = {
  baseCents: {
    who: "A young shop · 12 reviews · no website · no usable photo",
    facts: {
      ...COMMON,
      openEstablishmentCount: 1,
      ratingTenths: 44,
      reviewCount: 12,
      site: { issue: "no_known_site", usablePhotos: false },
    },
  },
  fullSiteCents: {
    who: "A typical shop · one address · 235 reviews · no website",
    facts: {
      ...COMMON,
      openEstablishmentCount: 1,
      ratingTenths: 49,
      reviewCount: 235,
      site: { issue: "no_known_site" },
    },
  },
  multiPageCents: {
    who: "A restaurant · a nine-page site, unreachable · 180 reviews",
    facts: {
      ...COMMON,
      openEstablishmentCount: 1,
      ratingTenths: 47,
      reviewCount: 180,
      site: { issue: "site_unreachable", sitemapUrlCount: 9 },
    },
  },
  multiAddressCents: {
    who: "A three-shop chain · one owner · no website",
    facts: {
      ...COMMON,
      openEstablishmentCount: 3,
      ratingTenths: 46,
      reviewCount: 410,
      site: { issue: "no_known_site" },
    },
  },
  recurringBaseCents: {
    who: "A typical shop · one address · 235 reviews · no website",
    facts: {
      ...COMMON,
      openEstablishmentCount: 1,
      ratingTenths: 49,
      reviewCount: 235,
      site: { issue: "no_known_site" },
    },
  },
};

async function ApiKeySection({ ownerId }: { ownerId: string }) {
  const [source, key] = await Promise.all([
    getPlacesKeySource(ownerId),
    getAccountPlacesKey(ownerId),
  ]);

  if (source === "env") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Google Places</CardTitle>
        </CardHeader>
        <p className="t-body">
          The key is provided by the server environment
          (<code>GOOGLE_PLACES_API_KEY</code>). Nothing to do here.
        </p>
      </Card>
    );
  }

  if (source === "account" && key) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Google Places</CardTitle>
        </CardHeader>
        <p className="t-body">
          Your key is configured: <code>{maskKey(key)}</code>.
        </p>
        <form action={removePlacesKeyAction} className={styles.removeForm}>
          <Button type="submit" variant="quiet" size="compact">
            Remove the key
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Places</CardTitle>
      </CardHeader>
      <p className="t-body">
        Enrichment needs a Google Places API key. Without it, the map still
        works — surveying, scoring and the ledger need no key at all — but no
        business will ever get a website address, and the in-house site audit
        has nothing to read.
      </p>
      <PlacesKeyForm />
      <p className="t-body-s tone-3">
        Stored on this instance, used server-side only. One billed request is
        made when you click &ldquo;Check the key&rdquo;.
      </p>
    </Card>
  );
}

export default async function SettingsPage() {
  const owner = await requireUser();
  const grid = await getPriceGrid(owner);

  return (
    <main className="pricing">
      <header className="pricing__head">
        <Badge asChild><h2>Settings</h2></Badge>
        <div className="pricing__head-act">
          <Link className="t-body-s pricing__back" href={"/" as Route}>
            {"Back to the map"}
          </Link>
        </div>
      </header>

      <div className={styles.section}>
        <ApiKeySection ownerId={owner.id} />
      </div>

      {/* The price grid drives every amount on the map, but changes far less
          often than the account's key — its own header keeps the two from
          reading as one form. */}
      <header className="pricing__head">
        <Badge asChild><h2>Deal value grid</h2></Badge>
        <div className="pricing__head-act">
          <ResetGrid />
        </div>
      </header>

      <PriceGridForm grid={grid} witnesses={WITNESSES} />
    </main>
  );
}

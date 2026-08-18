import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Badge, Button, Card, CardHeader, CardTitle } from "@/components/ui";
import { requireUser } from "@/lib/accounts";
import {
  getAccountLocale,
  getAccountPlacesKey,
  getPlacesKeySource,
  maskKey,
} from "@/lib/settings";
import type { ScoringFacts } from "@/lib/types";

import { getPriceGrid } from "../queries";
import { LocaleSwitcher } from "./LocaleSwitcher";
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
  const t = await getTranslations("ApiKeySection");
  const [source, key] = await Promise.all([
    getPlacesKeySource(ownerId),
    getAccountPlacesKey(ownerId),
  ]);

  if (source === "env") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <p className="t-body">
          {t.rich("envKey", { code: (chunks) => <code>{chunks}</code> })}
        </p>
      </Card>
    );
  }

  if (source === "account" && key) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <p className="t-body">
          {t.rich("configured", {
            key: maskKey(key),
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        <form action={removePlacesKeyAction} className={styles.removeForm}>
          <Button type="submit" variant="quiet" size="compact">
            {t("remove")}
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <p className="t-body">{t("needsKey")}</p>
      <PlacesKeyForm />
      <p className="t-body-s tone-3">{t("stored")}</p>
    </Card>
  );
}

export default async function SettingsPage() {
  const owner = await requireUser();
  const [grid, t] = await Promise.all([
    getPriceGrid(owner),
    getTranslations("SettingsPage"),
  ]);
  const locale = await getAccountLocale(owner.id);

  return (
    <main className="pricing">
      <header className="pricing__head">
        <Badge asChild><h2>{t("title")}</h2></Badge>
        <div className="pricing__head-act">
          <LocaleSwitcher value={locale} />
          <Link className="t-body-s pricing__back" href={"/" as Route}>
            {t("backToMap")}
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
        <Badge asChild><h2>{t("grid")}</h2></Badge>
        <div className="pricing__head-act">
          <ResetGrid />
        </div>
      </header>

      <PriceGridForm grid={grid} witnesses={WITNESSES} />
    </main>
  );
}

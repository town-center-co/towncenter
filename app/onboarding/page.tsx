import Link from "next/link";
import type { Metadata } from "next";
import type { Route } from "next";
import { getTranslations } from "next-intl/server";

import { requireUser } from "@/lib/accounts";
import { PRO_PLAN } from "@/lib/billing/plans";
import { MAX_ZONE_AREA_KM2 } from "@/lib/limits";
import { getOnboardingFacts, type OnboardingFacts } from "@/app/queries";
import { ConsumeBillingStarted } from "@/components/billing/ConsumeBillingStarted";
import { Button, Badge, Card, CardHeader, CardTitle } from "@/components/ui";
import { WorldMap } from "@/components/gate/WorldMap";
import townCentre from "@/components/gate/towncenter.png";
import Image from "next/image";

import { PlacesKeyForm } from "./PlacesKeyForm";
import {
  finishOnboardingAction,
  removePlacesKeyAction,
} from "./actions";

import styles from "./onboarding.module.css";

export const metadata: Metadata = {
  title: "Setup — Towncenter",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type T = Awaited<ReturnType<typeof getTranslations>>;

const SELF_HOSTED_STEPS = ["key", "grid", "sector"] as const;
const SAAS_STEPS = ["upgrade", "grid", "sector"] as const;

function firstIncomplete(facts: OnboardingFacts): string {
  if (!facts.isSaaS && facts.placesKeySource === null) return "key";
  if (facts.isSaaS && !facts.planChosen) return "upgrade";
  if (!facts.hasCustomGrid) return "grid";
  if (facts.sectorCount === 0) return "sector";
  return "sector";
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function OnboardingPage(props: PageProps<"/onboarding">) {
  const owner = await requireUser();
  const facts = await getOnboardingFacts(owner);
  const steps = facts.isSaaS ? SAAS_STEPS : SELF_HOSTED_STEPS;

  const params = await props.searchParams;
  const requested = first(params.step);
  const step =
    requested && (steps as readonly string[]).includes(requested)
      ? requested
      : firstIncomplete(facts);

  const t = await getTranslations("OnboardingPage");
  const gate = await getTranslations("Gate");
  const shared = await getTranslations();
  const billingStarted = first(params.billing) === "started";

  return (
    <main className={styles.frame}>
      <div className={styles.gate}>
        <div className={styles.column}>
          <Link href="/" className={styles.brand} aria-label="Towncenter">
            <Image
              className={styles.brandMark}
              src={townCentre}
              alt=""
              priority
              placeholder="blur"
            />
            Towncenter
          </Link>

          <div className={styles.center}>
            <h1 className={styles.title}>{t("title")}</h1>
            <p className={styles.subtitle}>
              {facts.isSaaS ? t("subtitleSaas") : t("subtitleSelfHosted")}
            </p>

            {billingStarted ? (
              <>
                <ConsumeBillingStarted />
                <p className={styles.notice} role="status">
                  {t("paymentConfirmed")}
                </p>
              </>
            ) : null}

            <StepRail facts={facts} current={step} t={t} />

            <div key={step} className={styles.stepContent}>
              {step === "key" ? (
                <KeyStep facts={facts} t={t} shared={shared} />
              ) : step === "grid" ? (
                <GridStep facts={facts} t={t} />
              ) : step === "upgrade" ? (
                <UpgradeStep facts={facts} t={t} />
              ) : (
                <SectorStep facts={facts} t={t} shared={shared} />
              )}
            </div>
          </div>

          <div className={styles.footerRule}>
            <span>{gate("tagline")}</span>
          </div>
        </div>

        <div className={styles.plan} aria-hidden="true">
          <div className={styles.planFrame}>
            <WorldMap />
          </div>
        </div>
      </div>
    </main>
  );
}

type StepMeta = {
  key: string;
  label: string;
  done: boolean;
};

function stepsFor(facts: OnboardingFacts, t: T): StepMeta[] {
  const items: StepMeta[] = [];
  if (!facts.isSaaS) {
    items.push({ key: "key", label: t("stepConnectPlaces"), done: facts.placesKeySource !== null });
  }
  if (facts.isSaaS) {
    items.push({
      key: "upgrade",
      label: facts.planChosen ? t("stepPlanActive") : t("stepChoosePlan"),
      done: facts.planChosen,
    });
  }
  items.push({ key: "grid", label: t("stepReviewGrid"), done: facts.hasCustomGrid });
  items.push({ key: "sector", label: t("stepSurveySector"), done: facts.sectorCount > 0 });
  return items;
}

function StepRail({ facts, current, t }: { facts: OnboardingFacts; current: string; t: T }) {
  const steps = stepsFor(facts, t);
  return (
    <ol className={styles.rail}>
      {steps.map((s, i) => {
        const isCurrent = s.key === current;
        return (
          <li
            key={s.key}
            className={styles.railItem}
            data-done={s.done ? "" : undefined}
            data-current={isCurrent ? "" : undefined}
          >
            <Link
              href={`/onboarding?step=${s.key}` as Route}
              className={styles.railLink}
              aria-current={isCurrent ? "step" : undefined}
            >
              <span className={styles.railNumber}>
                {s.done ? <Check /> : i + 1}
              </span>
              <span className={styles.railLabel}>{s.label}</span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4" />
    </svg>
  );
}

function KeyStep({ facts, t, shared }: { facts: OnboardingFacts; t: T; shared: T }) {
  if (facts.placesKeySource === "env") {
    return (
      <>
        <Badge asChild><h2>Google Places</h2></Badge>
        <p className="t-body">
          {shared.rich("ApiKeySection.envKey", { code: (chunks) => <code>{chunks}</code> })}
        </p>
        <Link href="/onboarding?step=grid" className={styles.stepLink}>
          {t("continue")}
        </Link>
      </>
    );
  }

  if (facts.placesKeySource === "account") {
    return (
      <>
        <Badge asChild><h2>Google Places</h2></Badge>
        <p className="t-body">
          {shared.rich("ApiKeySection.configured", {
            key: facts.placesKeyMask ?? "",
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        <form action={removePlacesKeyAction} className={styles.removeForm}>
          <Button type="submit" variant="quiet" size="compact">
            {shared("ApiKeySection.remove")}
          </Button>
        </form>
        <Link href="/onboarding?step=grid" className={styles.stepLink}>
          {t("continue")}
        </Link>
      </>
    );
  }

  return (
    <>
      <Badge asChild><h2>Google Places</h2></Badge>
      <p className="t-body">{shared("ApiKeySection.needsKey")}</p>
      <Card>
        <CardHeader>
          <CardTitle>{t("yourKey")}</CardTitle>
        </CardHeader>
        <PlacesKeyForm />
        <p className="t-body-s tone-3">{shared("ApiKeySection.stored")}</p>
      </Card>
      <Link href="/onboarding?step=grid" className={styles.stepLink}>
        {t("skipForNow")}
      </Link>
    </>
  );
}

function GridStep({ facts, t }: { facts: OnboardingFacts; t: T }) {
  return (
    <>
      <Badge asChild><h2>{t("gridTitle")}</h2></Badge>
      <p className="t-body">{t("gridBody")}</p>
      {facts.hasCustomGrid ? (
        <p className="t-body-s tone-2">{t("gridCustomSaved")}</p>
      ) : (
        <p className="t-body-s tone-2">{t("gridDefaultNotice")}</p>
      )}
      <div className={styles.stepActions}>
        <Link href="/settings?from=onboarding" className={styles.stepLink}>
          {t("openSettings")}
        </Link>
        <Link
          href={
            "/onboarding?step=sector"
          }
          className={styles.stepLink}
        >
          {facts.hasCustomGrid ? t("continue") : t("keepDefaultGrid")}
        </Link>
      </div>
    </>
  );
}

function UpgradeStep({ facts, t }: { facts: OnboardingFacts; t: T }) {
  const price = PRO_PLAN.priceCents / 100;

  if (facts.planChosen) {
    return (
      <>
        <Badge asChild><h2>{t("planTitle")}</h2></Badge>
        <p className="t-body">{t("planRunning")}</p>
        <div className={styles.stepActions}>
          <Link href="/onboarding?step=sector" className={styles.stepLink}>
            {t("continue")}
          </Link>
          <Link href="/billing?from=onboarding" className={styles.stepLink}>
            {t("manageSubscription")}
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <Badge asChild><h2>{t("planTitle")}</h2></Badge>
      <p className="t-body">{t("planBody", { price })}</p>
      <Card className={styles.upgradeCard}>
        <div className={styles.upgradePlan}>
          <span className={styles.upgradePlanName}>{PRO_PLAN.name}</span>
          <span className={styles.upgradePrice}>
            &euro;{price}
            <span className={styles.upgradePeriod}>{t("perMonth")}</span>
          </span>
        </div>
        <ul className={styles.upgradeLimits}>
          <li>{t("limitHarvested", { count: PRO_PLAN.limits.harvestedTargets.toLocaleString("fr-FR") })}</li>
          <li>{t("limitEnrichments", { count: PRO_PLAN.limits.enrichments })}</li>
          <li>{t("limitAudits", { count: PRO_PLAN.limits.siteAudits })}</li>
          <li>{t("limitArea", { count: PRO_PLAN.limits.cumulativeAreaKm2 })}</li>
          <li>{t("limitZoneArea", { count: MAX_ZONE_AREA_KM2 })}</li>
        </ul>
      </Card>
      <p className="t-body-s tone-2">{t("billingNotice")}</p>
      <div className={styles.stepActions}>
        <a className={styles.upgradeCta} href="/billing?from=onboarding">
          {t("subscribe")}
        </a>
      </div>
    </>
  );
}

function SectorStep({ facts, t, shared }: { facts: OnboardingFacts; t: T; shared: T }) {
  return (
    <>
      <Badge asChild><h2>{t("sectorTitle")}</h2></Badge>
      <p className="t-body">{t("sectorBody")}</p>
      {facts.sectorCount > 0 ? (
        <p className="t-body-s tone-2">
          {t("sectorSurveyed", { count: facts.sectorCount })}
        </p>
      ) : null}
      <form action={finishOnboardingAction}>
        <Button type="submit" variant="primary" fullWidth>
          {facts.sectorCount > 0 ? shared("SettingsPage.backToMap") : t("enterMap")}
        </Button>
      </form>
    </>
  );
}

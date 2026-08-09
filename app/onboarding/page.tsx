import Link from "next/link";
import type { Metadata } from "next";
import type { Route } from "next";

import { requireUser } from "@/lib/accounts";
import { getOnboardingFacts, type OnboardingFacts } from "@/app/queries";
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

const SELF_HOSTED_STEPS = ["key", "grid", "sector"] as const;
const SAAS_STEPS = ["grid", "upgrade", "sector"] as const;

function firstIncomplete(facts: OnboardingFacts): string {
  if (!facts.isSaaS && facts.placesKeySource === null) return "key";
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
            <h1 className={styles.title}>Set up your territory</h1>
            <p className={styles.subtitle}>
              {facts.isSaaS
                ? "Two things to do before the map becomes useful, and a plan to pick. Each step is backed by a measured fact — skip any and come back to it."
                : "Three things to do before the map becomes useful. Each one is backed by a measured fact — skip any step and come back to it."}
            </p>

            <StepRail facts={facts} current={step} />

            <div key={step} className={styles.stepContent}>
              {step === "key" ? (
                <KeyStep facts={facts} />
              ) : step === "grid" ? (
                <GridStep facts={facts} />
              ) : step === "upgrade" ? (
                <UpgradeStep />
              ) : (
                <SectorStep facts={facts} />
              )}
            </div>
          </div>

          <div className={styles.footerRule}>
            <span>Neighbourhood prospecting, street by street.</span>
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

function stepsFor(facts: OnboardingFacts): StepMeta[] {
  const items: StepMeta[] = [];
  if (!facts.isSaaS) {
    items.push({ key: "key", label: "Connect Google Places", done: facts.placesKeySource !== null });
  }
  items.push({ key: "grid", label: "Review your price grid", done: facts.hasCustomGrid });
  if (facts.isSaaS) {
    items.push({ key: "upgrade", label: "Choose a plan", done: false });
  }
  items.push({ key: "sector", label: "Survey your first sector", done: facts.sectorCount > 0 });
  return items;
}

function StepRail({ facts, current }: { facts: OnboardingFacts; current: string }) {
  const steps = stepsFor(facts);
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

function KeyStep({ facts }: { facts: OnboardingFacts }) {
  if (facts.placesKeySource === "env") {
    return (
      <>
        <Badge asChild><h2>Google Places</h2></Badge>
        <p className="t-body">
          The key is provided by the server environment
          (<code>GOOGLE_PLACES_API_KEY</code>). Nothing to do here.
        </p>
        <Link href="/onboarding?step=grid" className={styles.stepLink}>
          Continue →
        </Link>
      </>
    );
  }

  if (facts.placesKeySource === "account") {
    return (
      <>
        <Badge asChild><h2>Google Places</h2></Badge>
        <p className="t-body">
          Your key is configured: <code>{facts.placesKeyMask}</code>.
        </p>
        <form action={removePlacesKeyAction} className={styles.removeForm}>
          <Button type="submit" variant="quiet" size="compact">
            Remove the key
          </Button>
        </form>
        <Link href="/onboarding?step=grid" className={styles.stepLink}>
          Continue →
        </Link>
      </>
    );
  }

  return (
    <>
      <Badge asChild><h2>Google Places</h2></Badge>
      <p className="t-body">
        Enrichment needs a Google Places API key. Without it, the map still
        works — surveying, scoring and the ledger need no key at all — but no
        business will ever get a website address, and the in-house site audit
        has nothing to read.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Your key</CardTitle>
        </CardHeader>
        <PlacesKeyForm />
        <p className="t-body-s tone-3">
          Stored on this instance, used server-side only. One billed request is
          made when you click &ldquo;Check the key&rdquo;.
        </p>
      </Card>
      <Link href="/onboarding?step=grid" className={styles.stepLink}>
        Skip for now →
      </Link>
    </>
  );
}

function GridStep({ facts }: { facts: OnboardingFacts }) {
  return (
    <>
      <Badge asChild><h2>Price grid</h2></Badge>
      <p className="t-body">
        Every amount on the map comes from your grid: the loot on a target, the
        treasure of a sector. The default grid ships with the product — one
        freelancer&rsquo;s real rates, a starting point.
      </p>
      {facts.hasCustomGrid ? (
        <p className="t-body-s tone-2">
          You have already saved a custom grid.
        </p>
      ) : (
        <p className="t-body-s tone-2">
          You are on the default grid. Open the pricing screen to change it, or
          keep the default and continue.
        </p>
      )}
      <div className={styles.stepActions}>
        <Link href="/pricing" className={styles.stepLink}>
          Open the pricing screen
        </Link>
        <Link href="/onboarding?step=sector" className={styles.stepLink}>
          {facts.hasCustomGrid ? "Continue →" : "Keep the default grid →"}
        </Link>
      </div>
    </>
  );
}

function UpgradeStep() {
  return (
    <>
      <Badge asChild><h2>Plan</h2></Badge>
      <p className="t-body">
        Towncenter is &euro;10/month, one plan, no tiers. Every feature is
        included; the limits below are per month and per organisation.
      </p>
      <Card className={styles.upgradeCard}>
        <div className={styles.upgradePlan}>
          <span className={styles.upgradePlanName}>Pro</span>
          <span className={styles.upgradePrice}>&euro;10<span className={styles.upgradePeriod}>/month</span></span>
        </div>
        <ul className={styles.upgradeLimits}>
          <li>2 500 businesses harvested</li>
          <li>300 Google Places enrichments</li>
          <li>100 site audits</li>
          <li>50 km&sup2; total surface</li>
          <li>12 km&sup2; per zone</li>
        </ul>
      </Card>
      <p className="t-body-s tone-2">
        Billing is handled by Mollie. Cancel any time — your data is yours to
        export.
      </p>
      <div className={styles.stepActions}>
        <a className={styles.upgradeCta} href="/billing">
          Subscribe
        </a>
        <Link href="/onboarding?step=sector" className={styles.stepLink}>
          I&rsquo;ll subscribe later →
        </Link>
      </div>
    </>
  );
}

function SectorStep({ facts }: { facts: OnboardingFacts }) {
  return (
    <>
      <Badge asChild><h2>First sector</h2></Badge>
      <p className="t-body">
        Draw a sector on the map. It fills with every business actually
        registered there — the French national company register knows them, and
        it is free and key-less. Each one becomes a target carrying two numbers:
        the loot and the resistance.
      </p>
      {facts.sectorCount > 0 ? (
        <p className="t-body-s tone-2">
          You have already surveyed {facts.sectorCount} sector
          {facts.sectorCount === 1 ? "" : "s"}.
        </p>
      ) : null}
      <form action={finishOnboardingAction}>
        <Button type="submit" variant="primary" fullWidth>
          {facts.sectorCount > 0 ? "Back to the map" : "Enter the map"}
        </Button>
      </form>
    </>
  );
}

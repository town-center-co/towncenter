import Link from "next/link";
import type { Metadata } from "next";
import type { Route } from "next";

import { requireUser } from "@/lib/accounts";
import { PRO_PLAN } from "@/lib/billing/plans";
import { MAX_ZONE_AREA_KM2 } from "@/lib/limits";
import { LOCALE, TIME_ZONE } from "@/lib/format";
import { getBillingFacts, type BillingFacts } from "@/app/queries";
import { Badge, Button, Card } from "@/components/ui";

import { cancelSubscriptionAction, subscribeAction } from "./actions";

import styles from "./billing.module.css";

export const metadata: Metadata = {
  title: "Billing · Towncenter",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIME_ZONE,
    dateStyle: "long",
  }).format(new Date(iso));
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const NOTICES: Record<string, { tone: "error" | "ok"; text: string }> = {
  "error:checkout": {
    tone: "error",
    text: "The checkout could not be created. Try again, or come back later.",
  },
  "error:cancel": {
    tone: "error",
    text: "The cancellation did not go through. Try again, or come back later.",
  },
  "canceled:1": {
    tone: "ok",
    text: "Subscription canceled. Access stays open until the paid period ends.",
  },
};

export default async function BillingPage(props: PageProps<"/billing">) {
  const owner = await requireUser();
  const facts = await getBillingFacts(owner);

  const params = await props.searchParams;
  const error = first(params.error);
  const canceled = first(params.canceled);
  const notice = error
    ? NOTICES[`error:${error}`]
    : canceled
      ? NOTICES[`canceled:${canceled}`]
      : undefined;

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <Badge asChild>
          <h2>Billing</h2>
        </Badge>
        <Link className={`t-body-s ${styles.back}`} href={"/" as Route}>
          Back to the map
        </Link>
      </header>

      {notice ? (
        <p className={styles.notice} data-tone={notice.tone}>
          {notice.text}
        </p>
      ) : null}

      {facts.enabled ? <SaasBilling facts={facts} /> : <SelfHosted />}
    </main>
  );
}

function SelfHosted() {
  return (
    <Card className={styles.card}>
      <h3 className={styles.cardTitle}>Self-hosted instance</h3>
      <p className="t-body">
        Billing is not enabled here: no <code>MOLLIE_API_KEY</code>, no
        subscription, and no quota — every limit below is off. This screen only
        does something on the hosted service.
      </p>
    </Card>
  );
}

function statusLine(facts: BillingFacts): string {
  const until = facts.periodEndIso ? formatDay(facts.periodEndIso) : null;
  switch (facts.status) {
    case "none":
      return "No subscription yet.";
    case "pending":
      return "Checkout started but never completed. Subscribe to finish it.";
    case "active":
      return until ? `Active — renews on ${until}.` : "Active.";
    case "canceled":
      return facts.current && until
        ? `Canceled — access stays open until ${until}.`
        : "Canceled. Subscribe again to keep surveying past the trial ceiling.";
    case "suspended":
      return "A renewal payment failed and the subscription is suspended. Subscribe again to set up a new mandate.";
    case "completed":
      return "The subscription ran its course. Subscribe again to continue.";
  }
}

function SaasBilling({ facts }: { facts: BillingFacts }) {
  const canSubscribe = !(facts.current && facts.status !== "canceled");
  const canCancel = facts.status === "active";

  return (
    <>
      {facts.testMode ? (
        <p className={styles.testMode}>
          Test mode: payments go through Mollie&rsquo;s sandbox, no real card is
          charged.
        </p>
      ) : null}

      <Card className={styles.card}>
        <div className={styles.plan}>
          <span className={styles.planName}>{PRO_PLAN.name}</span>
          <span className={styles.price}>
            &euro;{PRO_PLAN.priceCents / 100}
            <span className={styles.period}>/month</span>
          </span>
        </div>
        <ul className={styles.limits}>
          <li>{PRO_PLAN.limits.harvestedTargets.toLocaleString(LOCALE)} businesses harvested</li>
          <li>{PRO_PLAN.limits.enrichments} Google Places enrichments</li>
          <li>{PRO_PLAN.limits.siteAudits} site audits</li>
          <li>{PRO_PLAN.limits.cumulativeAreaKm2} km&sup2; total surface</li>
          <li>{MAX_ZONE_AREA_KM2} km&sup2; per zone</li>
        </ul>
      </Card>

      <Card className={styles.card}>
        <h3 className={styles.cardTitle}>Your subscription</h3>
        <p className="t-body">{statusLine(facts)}</p>
        <p className="t-body-s tone-2">
          {facts.usedKm2.toFixed(1)} of {facts.maxKm2} km&sup2; surveyed{" "}
          {facts.current ? "this period" : "so far"}.
        </p>

        <div className={styles.actions}>
          {canSubscribe ? (
            <form action={subscribeAction}>
              <Button type="submit" variant="primary">
                Subscribe — &euro;{PRO_PLAN.priceCents / 100}/month
              </Button>
            </form>
          ) : null}
          {canCancel ? (
            <form action={cancelSubscriptionAction}>
              <Button type="submit" variant="quiet">
                Cancel the subscription
              </Button>
            </form>
          ) : null}
        </div>

        <p className="t-body-s tone-3">
          Payments are handled by Mollie. Cancel any time — access stays open
          until the end of the paid period, and your data is yours to export.
        </p>
      </Card>
    </>
  );
}

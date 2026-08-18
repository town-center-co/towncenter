import Link from "next/link";
import type { Metadata } from "next";
import type { Route } from "next";
import { getTranslations } from "next-intl/server";

import { requireUser } from "@/lib/accounts";
import { PRO_PLAN, TRIAL_DAYS } from "@/lib/billing/plans";
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

type T = Awaited<ReturnType<typeof getTranslations>>;

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

export default async function BillingPage(props: PageProps<"/billing">) {
  const owner = await requireUser();
  const facts = await getBillingFacts(owner);
  const t = await getTranslations("BillingPage");
  const shared = await getTranslations();

  const NOTICES: Record<string, { tone: "error" | "ok"; text: string }> = {
    "error:checkout": { tone: "error", text: t("noticeCheckoutError") },
    "error:cancel": { tone: "error", text: t("noticeCancelError") },
    "error:terms": { tone: "error", text: t("noticeTermsError") },
    "canceled:1": { tone: "ok", text: t("noticeCanceled") },
  };

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
          <h2>{t("title")}</h2>
        </Badge>
        <Link className={`t-body-s ${styles.back}`} href={"/" as Route}>
          {shared("SettingsPage.backToMap")}
        </Link>
      </header>

      {notice ? (
        <p className={styles.notice} data-tone={notice.tone}>
          {notice.text}
        </p>
      ) : null}

      {facts.enabled ? <SaasBilling facts={facts} t={t} shared={shared} /> : <SelfHosted t={t} />}
    </main>
  );
}

function SelfHosted({ t }: { t: T }) {
  return (
    <Card className={styles.card}>
      <h3 className={styles.cardTitle}>{t("selfHostedTitle")}</h3>
      <p className="t-body">
        {t.rich("selfHostedBody", { code: (chunks) => <code>{chunks}</code> })}
      </p>
    </Card>
  );
}

function statusLine(facts: BillingFacts, t: T): string {
  const until = facts.periodEndIso ? formatDay(facts.periodEndIso) : null;
  const trialEnd = facts.trialEndsAtIso ? formatDay(facts.trialEndsAtIso) : null;
  const price = `€${PRO_PLAN.priceCents / 100}`;

  if (facts.state === "none") {
    return facts.status === "pending" ? t("statusNonePending") : t("statusNoneDefault");
  }

  if (facts.state === "trial") {
    if (facts.status === "canceled") {
      return trialEnd
        ? t("statusTrialCanceledWithDate", { date: trialEnd })
        : t("statusTrialCanceled");
    }
    return trialEnd
      ? t("statusTrialRunningWithDate", { date: trialEnd, price })
      : t("statusTrialRunning");
  }

  if (facts.state === "expired") {
    return t("statusExpired");
  }

  switch (facts.status) {
    case "active":
      return until ? t("statusActiveWithDate", { date: until }) : t("statusActive");
    case "canceled":
      return until ? t("statusCanceledWithDate", { date: until }) : t("statusCanceled");
    case "suspended":
      return t("statusSuspended");
    case "completed":
      return t("statusCompleted");
    default:
      return t("statusActive");
  }
}

function SaasBilling({ facts, t, shared }: { facts: BillingFacts; t: T; shared: T }) {
  const canSubscribe = facts.state === "none" || facts.state === "expired";
  const canCancel =
    facts.status === "active" &&
    (facts.state === "trial" || facts.state === "active");
  // one trial per account: once consumed, the same checkout charges right away
  const trialAvailable = facts.trialEndsAtIso === null;

  return (
    <>
      {facts.testMode ? <p className={styles.testMode}>{t("testMode")}</p> : null}

      <Card className={styles.card}>
        <div className={styles.plan}>
          <span className={styles.planName}>{PRO_PLAN.name}</span>
          <span className={styles.price}>
            &euro;{PRO_PLAN.priceCents / 100}
            <span className={styles.period}>{t("perMonth")}</span>
          </span>
        </div>
        <p className="t-body-s tone-2">{t("trialNotice", { days: TRIAL_DAYS })}</p>
        <ul className={styles.limits}>
          <li>{shared("OnboardingPage.limitHarvested", { count: PRO_PLAN.limits.harvestedTargets.toLocaleString(LOCALE) })}</li>
          <li>{shared("OnboardingPage.limitEnrichments", { count: PRO_PLAN.limits.enrichments })}</li>
          <li>{shared("OnboardingPage.limitAudits", { count: PRO_PLAN.limits.siteAudits })}</li>
          <li>{shared("OnboardingPage.limitArea", { count: PRO_PLAN.limits.cumulativeAreaKm2 })}</li>
          <li>{shared("OnboardingPage.limitZoneArea", { count: MAX_ZONE_AREA_KM2 })}</li>
        </ul>
      </Card>

      <Card className={styles.card}>
        <h3 className={styles.cardTitle}>{t("yourSubscription")}</h3>
        <p className="t-body">{statusLine(facts, t)}</p>
        <p className="t-body-s tone-2">
          {t("usageLine", {
            usedKm2: facts.usedKm2.toFixed(1),
            maxKm2: facts.maxKm2,
            period: facts.current ? t("surveyedThisPeriod") : t("surveyedSoFar"),
            harvestUsed: facts.usage.harvest.used.toLocaleString(LOCALE),
            harvestLimit: facts.usage.harvest.limit.toLocaleString(LOCALE),
            enrichUsed: facts.usage.enrich.used,
            enrichLimit: facts.usage.enrich.limit,
            auditUsed: facts.usage.audit.used,
            auditLimit: facts.usage.audit.limit,
          })}
        </p>

        <div className={styles.actions}>
          {canSubscribe ? (
            <form action={subscribeAction}>
              <label className={styles.acceptance}>
                <input name="terms" type="checkbox" value="accepted" required />
                <span>
                  {t.rich("acceptTerms", {
                    link: (chunks) => (
                      <a href="https://town-center.co/terms" target="_blank">
                        {chunks}
                      </a>
                    ),
                  })}
                </span>
              </label>
              <Button type="submit" variant="primary">
                {trialAvailable
                  ? t("startTrial", { days: TRIAL_DAYS })
                  : t("subscribe", { price: PRO_PLAN.priceCents / 100 })}
              </Button>
            </form>
          ) : null}
          {canCancel ? (
            <form action={cancelSubscriptionAction}>
              <Button type="submit" variant="quiet">
                {facts.state === "trial" ? t("cancelTrial") : t("cancelSubscription")}
              </Button>
            </form>
          ) : null}
        </div>

        <p className="t-body-s tone-3">
          {trialAvailable && canSubscribe ? t("cardRequiredNotice") : ""}
          {t("paymentsNotice")}
        </p>
      </Card>
    </>
  );
}

"use client";

// Waits for Mollie's webhook before sending the browser to its destination.

import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Badge, Card } from "@/components/ui";

import { billingStateAction } from "../actions";
import styles from "../billing.module.css";

const POLL_MS = 2000;
const POLL_FOR_MS = 45_000;

export function FinalizeCheckout({ dest }: { dest: Route }) {
  const t = useTranslations("BillingReturn");
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);
  // Expired means a re-subscription charge is still pending at Mollie.
  const [lastState, setLastState] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      try {
        const state = await billingStateAction();
        if (cancelled) return;
        setLastState(state);
        if (state === "trial" || state === "active") {
          router.replace(dest);
          return;
        }
      } catch {
        // a network hiccup: the next tick retries.
      }
      if (Date.now() - startedAt >= POLL_FOR_MS) {
        setGaveUp(true);
        return;
      }
      window.setTimeout(tick, POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [router, dest]);

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <Badge asChild>
          <h2>{t("title")}</h2>
        </Badge>
        <Link className={`t-body-s ${styles.back}`} href={"/" as Route}>
          {t("backToMap")}
        </Link>
      </header>

      <Card className={styles.card}>
        {!gaveUp ? (
          <>
            <h3 className={styles.cardTitle}>{t("confirmingTitle")}</h3>
            <p className="t-body" role="status" aria-live="polite">
              {t("confirmingBody")}
            </p>
          </>
        ) : lastState === "expired" ? (
          <>
            <h3 className={styles.cardTitle}>{t("cardRegisteredTitle")}</h3>
            <p className="t-body">{t("cardRegisteredBody")}</p>
            <p className="t-body-s tone-2">
              <Link className={styles.back} href={"/billing" as Route}>
                {t("openBilling")}
              </Link>
            </p>
          </>
        ) : (
          <>
            <h3 className={styles.cardTitle}>{t("noConfirmationTitle")}</h3>
            <p className="t-body">{t("noConfirmationBody")}</p>
            <p className="t-body-s tone-2">
              <Link className={styles.back} href={"/billing" as Route}>
                {t("openBilling")}
              </Link>
            </p>
          </>
        )}
      </Card>
    </main>
  );
}

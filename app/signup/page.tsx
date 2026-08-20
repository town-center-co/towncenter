import Link from "next/link";
import type { Metadata } from "next";
import type { Route } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";

import { Gate } from "@/components/gate/Gate";
import { redirect } from "next/navigation";

import { signupState, getUser } from "@/lib/accounts";
import { internalPath } from "@/lib/internal-route";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "@/lib/types";
import enMessages from "@/messages/en.json";
import frMessages from "@/messages/fr.json";

import { SignUp } from "./SignUpForm";

import styles from "@/components/gate/gate.module.css";

export const metadata: Metadata = {
  title: "Create an account — Towncenter",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function requestedLocale(value: string | null, fromFit: boolean): Locale {
  if ((LOCALES as readonly string[]).includes(value ?? "")) return value as Locale;
  return fromFit ? "en" : DEFAULT_LOCALE;
}

export default async function SignUpPage(props: PageProps<"/signup">) {
  const params = await props.searchParams;
  const next = first(params.next);
  const fromFit = first(params.from) === "fit";
  const locale = requestedLocale(first(params.locale), fromFit);
  const sourceMessages = locale === "en" ? enMessages : frMessages;
  const messages = {
    Common: sourceMessages.Common,
    Gate: sourceMessages.Gate,
    Requirements: sourceMessages.Requirements,
    SignUp: sourceMessages.SignUp,
    ThemeToggle: sourceMessages.ThemeToggle,
  };
  if (await getUser()) redirect(internalPath(next));

  const state = await signupState(locale);
  const t = await getTranslations({ locale, namespace: "SignUpPage" });
  const signInHref = (next
    ? `/login?next=${encodeURIComponent(next)}${fromFit ? `&from=fit&locale=${locale}` : ""}`
    : "/login") as Route;

  // Closed, the page still exists and says why. A 404 would be quieter and
  // worse: whoever was given the address would hunt a broken link. This is
  // self-hosted software, and the reader is often the one who can act.
  if (!state.open) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages}>
        <Gate
          locale={locale}
          title={t("closedTitle")}
          subtitle={t("closedSubtitle")}
          toggle={
            <Link href={signInHref} className={styles.link}>
              {t("backToSignIn")}
            </Link>
          }
        >
          <p className={styles.notice}>{state.reason}</p>
        </Gate>
      </NextIntlClientProvider>
    );
  }

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <Gate
        locale={locale}
        title={
          state.isFirstAccount
            ? t("claimTitle")
            : fromFit
              ? t("fitTitle")
              : t("createTitle")
        }
        subtitle={
          state.isFirstAccount
            ? t("claimSubtitle")
            : fromFit
              ? t("fitSubtitle")
              : t("createSubtitle")
        }
        toggle={
          state.isFirstAccount
            ? null
            : t.rich("toggle", {
                link: (chunks) => (
                  <Link href={signInHref} className={styles.link}>
                    {chunks}
                  </Link>
                ),
              })
        }
      >
        <SignUp
          isFirstAccount={state.isFirstAccount}
          next={next}
          fromFit={fromFit}
          locale={locale}
        />
      </Gate>
    </NextIntlClientProvider>
  );
}

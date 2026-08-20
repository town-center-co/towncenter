import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import type { Route } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";

import { Gate } from "@/components/gate/Gate";
import { signupState, getUser } from "@/lib/accounts";
import { internalPath } from "@/lib/internal-route";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "@/lib/types";
import enMessages from "@/messages/en.json";
import frMessages from "@/messages/fr.json";

import { SignIn } from "./SignInForm";

import styles from "@/components/gate/gate.module.css";

export const metadata: Metadata = {
  title: "Sign in — Towncenter",
  // a gate has no business in a search engine index
  robots: { index: false, follow: false },
};

// the gate reads the database to know whether the instance is waiting for its
// owner, so it cannot be prerendered at build time
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function requestedLocale(value: string | null, fromFit: boolean): Locale {
  if ((LOCALES as readonly string[]).includes(value ?? "")) return value as Locale;
  return fromFit ? "en" : DEFAULT_LOCALE;
}

export default async function SignInPage(props: PageProps<"/login">) {
  const params = await props.searchParams;
  const next = first(params.next);
  const fromFit = first(params.from) === "fit";
  const locale = requestedLocale(first(params.locale), fromFit);
  const sourceMessages = locale === "en" ? enMessages : frMessages;
  const messages = {
    Common: sourceMessages.Common,
    Gate: sourceMessages.Gate,
    SignIn: sourceMessages.SignIn,
    ThemeToggle: sourceMessages.ThemeToggle,
  };
  const signupHref = (next
    ? `/signup?next=${encodeURIComponent(next)}${fromFit ? `&from=fit&locale=${locale}` : ""}`
    : "/signup") as Route;
  // "already signed in" is decided HERE, not in the proxy. getUser() re-reads
  // the account from the database, so an orphaned token does not count as a
  // session; the proxy only sees the signature, and relying on it produced an
  // infinite redirect loop in production.
  if (await getUser()) redirect(internalPath(next));

  const signup = await signupState(locale);

  // A blank instance has nobody to sign in: showing a sign-in form would be a
  // gate with no lock and no key. Send straight to sign-up, which says this is
  // the FIRST account.
  if (signup.isFirstAccount) redirect(signupHref);

  const t = await getTranslations({ locale, namespace: "SignInPage" });

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <Gate
        locale={locale}
        title={t("title")}
        subtitle={t("subtitle")}
        toggle={
          signup.open
            ? t.rich("toggle", {
                link: (chunks) => (
                  <Link href={signupHref} className={styles.link}>
                    {chunks}
                  </Link>
                ),
              })
            : null
        }
      >
        {/* useSearchParams forces client rendering: without this boundary the
            page's prerender FAILS the build. The fallback is empty on purpose. */}
        <Suspense fallback={null}>
          <SignIn locale={locale} />
        </Suspense>
      </Gate>
    </NextIntlClientProvider>
  );
}

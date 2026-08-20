import Link from "next/link";
import type { Metadata } from "next";
import type { Route } from "next";
import { getTranslations } from "next-intl/server";

import { Gate } from "@/components/gate/Gate";
import { redirect } from "next/navigation";

import { signupState, getUser } from "@/lib/accounts";
import { internalPath } from "@/lib/internal-route";

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

export default async function SignUpPage(props: PageProps<"/signup">) {
  const params = await props.searchParams;
  const next = first(params.next);
  const fromFit = first(params.from) === "fit";
  if (await getUser()) redirect(internalPath(next));

  const state = await signupState();
  const t = await getTranslations("SignUpPage");
  const signInHref = (next
    ? `/login?next=${encodeURIComponent(next)}`
    : "/login") as Route;

  // Closed, the page still exists and says why. A 404 would be quieter and
  // worse: whoever was given the address would hunt a broken link. This is
  // self-hosted software, and the reader is often the one who can act.
  if (!state.open) {
    return (
      <Gate
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
    );
  }

  return (
    <Gate
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
      />
    </Gate>
  );
}

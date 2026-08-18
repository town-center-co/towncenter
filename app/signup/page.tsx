import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Gate } from "@/components/gate/Gate";
import { redirect } from "next/navigation";

import { signupState, getUser } from "@/lib/accounts";

import { SignUp } from "./SignUpForm";

import styles from "@/components/gate/gate.module.css";

export const metadata: Metadata = {
  title: "Create an account — Towncenter",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  // same rule as /login: the database decides, not the token signature
  if (await getUser()) redirect("/");

  const state = await signupState();
  const t = await getTranslations("SignUpPage");

  // Closed, the page still exists and says why. A 404 would be quieter and
  // worse: whoever was given the address would hunt a broken link. This is
  // self-hosted software, and the reader is often the one who can act.
  if (!state.open) {
    return (
      <Gate
        title={t("closedTitle")}
        subtitle={t("closedSubtitle")}
        toggle={
          <Link href="/login" className={styles.link}>
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
      title={state.isFirstAccount ? t("claimTitle") : t("createTitle")}
      subtitle={state.isFirstAccount ? t("claimSubtitle") : t("createSubtitle")}
      toggle={
        state.isFirstAccount
          ? null
          : t.rich("toggle", {
              link: (chunks) => (
                <Link href="/login" className={styles.link}>
                  {chunks}
                </Link>
              ),
            })
      }
    >
      <SignUp isFirstAccount={state.isFirstAccount} />
    </Gate>
  );
}

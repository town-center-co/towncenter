import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Gate } from "@/components/gate/Gate";

import { ResetPassword } from "./ResetPasswordForm";

import styles from "@/components/gate/gate.module.css";

export const metadata: Metadata = {
  title: "Reset password — Towncenter",
  // a gate has no business in a search engine index
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const t = await getTranslations("ResetPasswordPage");

  // No token, no form: posting without one can only fail, so say it up front.
  if (!token) {
    return (
      <Gate
        title={t("incompleteTitle")}
        subtitle={t("incompleteSubtitle")}
        toggle={t.rich("toggleIncomplete", {
          link: (chunks) => (
            <Link href="/forgot-password" className={styles.link}>
              {chunks}
            </Link>
          ),
        })}
      >
        <p className={styles.notice}>{t("expiredNotice")}</p>
      </Gate>
    );
  }

  return (
    <Gate
      title={t("title")}
      subtitle={t("subtitle")}
      toggle={t.rich("toggle", {
        link: (chunks) => (
          <Link href="/login" className={styles.link}>
            {chunks}
          </Link>
        ),
      })}
    >
      <ResetPassword token={token} />
    </Gate>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Gate } from "@/components/gate/Gate";
import { getUser } from "@/lib/accounts";

import { ForgotPassword } from "./ForgotPasswordForm";

import styles from "@/components/gate/gate.module.css";

export const metadata: Metadata = {
  title: "Forgot password — Towncenter",
  // a gate has no business in a search engine index
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  if (await getUser()) redirect("/");

  const t = await getTranslations("ForgotPasswordPage");

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
      <ForgotPassword />
    </Gate>
  );
}

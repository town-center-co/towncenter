import Link from "next/link";
import type { Metadata } from "next";

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

  // No token, no form: posting without one can only fail, so say it up front.
  if (!token) {
    return (
      <Gate
        title="This link is incomplete"
        subtitle="A reset link carries its own key, and this one arrived without it."
        toggle={
          <>
            Ask for a fresh one on{" "}
            <Link href="/forgot-password" className={styles.link}>
              the reset page
            </Link>
          </>
        }
      >
        <p className={styles.notice}>
          Links only live thirty minutes; the one in your most recent email is
          the only one that counts.
        </p>
      </Gate>
    );
  }

  return (
    <Gate
      title="Choose a new password"
      subtitle="The old one stops working the moment this one is saved."
      toggle={
        <>
          Changed your mind?{" "}
          <Link href="/login" className={styles.link}>
            Back to sign-in
          </Link>
        </>
      }
    >
      <ResetPassword token={token} />
    </Gate>
  );
}

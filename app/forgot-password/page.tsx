import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

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

  return (
    <Gate
      title="Locked out?"
      subtitle="Give the address; if an account uses it, a reset link lands there."
      toggle={
        <>
          Remembered it?{" "}
          <Link href="/login" className={styles.link}>
            Sign in
          </Link>
        </>
      }
    >
      <ForgotPassword />
    </Gate>
  );
}

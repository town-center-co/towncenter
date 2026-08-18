// Absorbs the Mollie redirect/webhook race before returning to the app.

import type { Metadata } from "next";
import type { Route } from "next";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/accounts";
import { mollieEnabled } from "@/lib/billing/mollie";
import { getOnboardingFacts } from "@/app/queries";

import { FinalizeCheckout } from "./FinalizeCheckout";

export const metadata: Metadata = {
  title: "Payment · Towncenter",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function BillingReturnPage() {
  const owner = await requireUser();
  if (!mollieEnabled()) redirect("/billing");

  const facts = await getOnboardingFacts(owner);

  // Incomplete setup returns to onboarding; completed setup returns to the map.
  const dest = (
    facts.onboardedAt === null ? "/onboarding?billing=started" : "/?billing=started"
  ) as Route;

  // The webhook already landed — the usual case on a slow redirect.
  if (facts.planChosen) redirect(dest);

  return <FinalizeCheckout dest={dest} />;
}

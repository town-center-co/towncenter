import { NextIntlClientProvider } from "next-intl";
import { redirect } from "next/navigation";

import { MAX_ZONE_AREA_KM2 } from "@/lib/limits";
import { PRO_PLAN } from "@/lib/billing/plans";
import { getUser } from "@/lib/accounts";
import enMessages from "@/messages/en.json";

import { FitFunnel } from "./FitFunnel";

const fitMessages = {
  FitFunnel: enMessages.FitFunnel,
  ThemeToggle: enMessages.ThemeToggle,
};

export async function FitPageContent({ initialStep }: { initialStep?: string }) {
  if (await getUser()) redirect("/");

  return (
    <NextIntlClientProvider locale="en" messages={fitMessages}>
      <FitFunnel
        initialStep={initialStep}
        price={PRO_PLAN.priceCents / 100}
        harvestedTargets={PRO_PLAN.limits.harvestedTargets}
        enrichments={PRO_PLAN.limits.enrichments}
        siteAudits={PRO_PLAN.limits.siteAudits}
        areaKm2={PRO_PLAN.limits.cumulativeAreaKm2}
        zoneAreaKm2={MAX_ZONE_AREA_KM2}
      />
    </NextIntlClientProvider>
  );
}

"use server";

// Billing writes. Same contract as app/actions.ts: requireUser() on the first
// line, nothing but async function exports. Failures land back on /billing
// with an ASCII error key — never a thrown error, which would 500 the form.

import { redirect } from "next/navigation";
import type { Route } from "next";

import { requireUser } from "@/lib/accounts";
import {
  MollieError,
  cancelSubscriptionAtMollie,
  createFirstPayment,
  mollieEnabled,
} from "@/lib/billing/mollie";
import { PRO_PLAN } from "@/lib/billing/plans";
import {
  ensureMollieCustomer,
  getSubscriptionRow,
  markSubscriptionCanceled,
  markSubscriptionPending,
  mollieWebhookUrl,
} from "@/lib/billing/subscriptions";

export async function subscribeAction(): Promise<void> {
  const owner = await requireUser();
  if (!mollieEnabled()) redirect("/billing");

  let checkoutUrl: string;
  try {
    const customerId = await ensureMollieCustomer(owner);
    const appUrl = process.env.APP_URL?.trim();
    if (!appUrl) throw new MollieError("APP_URL is not set.", 0);

    const payment = await createFirstPayment({
      customerId,
      ownerId: owner.id,
      priceCents: PRO_PLAN.priceCents,
      description: `Towncenter ${PRO_PLAN.name} — first month`,
      redirectUrl: new URL("/billing", appUrl).toString(),
      webhookUrl: mollieWebhookUrl(),
    });

    await markSubscriptionPending(owner.id);
    checkoutUrl = payment.checkoutUrl;
  } catch (error) {
    console.error(
      "[billing] checkout failed:",
      error instanceof Error ? error.message : error,
    );
    redirect("/billing?error=checkout");
  }

  // External URL: typed routes only know the app's own paths.
  redirect(checkoutUrl as Route);
}

export async function cancelSubscriptionAction(): Promise<void> {
  const owner = await requireUser();
  if (!mollieEnabled()) redirect("/billing");

  try {
    const row = await getSubscriptionRow(owner.id);
    if (row?.mollieCustomerId && row.mollieSubscriptionId) {
      await cancelSubscriptionAtMollie(
        row.mollieCustomerId,
        row.mollieSubscriptionId,
      );
    }
    await markSubscriptionCanceled(owner.id);
  } catch (error) {
    console.error(
      "[billing] cancel failed:",
      error instanceof Error ? error.message : error,
    );
    redirect("/billing?error=cancel");
  }

  redirect("/billing?canceled=1");
}

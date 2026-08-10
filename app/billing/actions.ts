"use server";

// Billing writes. Same contract as app/actions.ts: requireUser() on the first
// line, nothing but async function exports. Failures land back on /billing
// with an ASCII error key — never a thrown error, which would 500 the form.

import { redirect } from "next/navigation";
import { after } from "next/server";
import type { Route } from "next";

import { requireUser } from "@/lib/accounts";
import {
  MollieError,
  ZERO_AMOUNT_METHODS,
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
import { sendEmail } from "@/lib/email/resend";
import { subscriptionCanceledEmail } from "@/lib/email/templates";

// One action for the trial and for every later re-subscription: the checkout
// is always a €0.00 mandate capture, and the WEBHOOK decides what it opens —
// a 14-day trial for a first-timer, an immediately-charging subscription for
// an account whose trial is already consumed.
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
      amountCents: 0,
      description: `Towncenter ${PRO_PLAN.name} — card setup`,
      redirectUrl: new URL("/billing", appUrl).toString(),
      webhookUrl: mollieWebhookUrl(),
      methods: ZERO_AMOUNT_METHODS,
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

    // guarded on the previous status so a double submit sends one email, and
    // registered before the redirect throw. sendEmail never throws.
    if (row && row.status !== "canceled") {
      const accessUntil = row.currentPeriodEnd;
      after(() =>
        sendEmail(
          owner.email,
          subscriptionCanceledEmail({
            name: owner.displayName,
            accessUntil,
          }),
        ),
      );
    }
  } catch (error) {
    console.error(
      "[billing] cancel failed:",
      error instanceof Error ? error.message : error,
    );
    redirect("/billing?error=cancel");
  }

  redirect("/billing?canceled=1");
}

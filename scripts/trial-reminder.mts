// The D-3 trial reminder: "your paid period starts on X, cancel before then".
// Money is about to be taken automatically, so this one email is NOT lazy —
// the hosting cron runs this script daily. Idempotent through
// `trial_reminder_sent_at`: safe to run twice, safe to skip a day (the window
// is three days wide). Canceled trials are skipped — no charge is coming.
//
//     DATABASE_URL=… RESEND_API_KEY=… EMAIL_FROM=… APP_URL=… npm run trial:reminder

import { and, eq, gt, isNull, lte } from "drizzle-orm";

import { db, subscriptions, users } from "@/lib/db";
import { appUrl, sendEmail } from "@/lib/email/resend";
import { trialReminderEmail } from "@/lib/email/templates";

const REMINDER_DAYS = 3;

const now = new Date();
const horizon = new Date(now.getTime() + REMINDER_DAYS * 24 * 60 * 60 * 1000);

const due = await db
  .select({
    ownerId: subscriptions.ownerId,
    trialEndsAt: subscriptions.trialEndsAt,
    email: users.email,
    displayName: users.displayName,
  })
  .from(subscriptions)
  .innerJoin(users, eq(users.id, subscriptions.ownerId))
  .where(
    and(
      isNull(subscriptions.trialReminderSentAt),
      gt(subscriptions.trialEndsAt, now),
      lte(subscriptions.trialEndsAt, horizon),
      // still on course to be charged; a canceled trial owes no warning
      eq(subscriptions.status, "active"),
    ),
  );

let sent = 0;

for (const row of due) {
  if (!row.trialEndsAt) continue;

  const ok = await sendEmail(
    row.email,
    trialReminderEmail({
      name: row.displayName,
      firstChargeAt: row.trialEndsAt,
      billingUrl: new URL("/billing", appUrl()).toString(),
    }),
  );

  // the flag is only set on a delivered email: a provider outage retries on
  // tomorrow's run instead of silently swallowing the one warning that counts.
  if (ok) {
    await db
      .update(subscriptions)
      .set({ trialReminderSentAt: new Date(), updatedAt: new Date() })
      .where(eq(subscriptions.ownerId, row.ownerId));
    sent += 1;
  }
}

console.log(`[trial-reminder] ${sent} sent, ${due.length - sent} left for the next run`);
process.exit(0);

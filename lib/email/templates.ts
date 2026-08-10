// Transactional email bodies. Pure functions over their inputs, safe to import
// from any server module; every user-controlled value goes through escapeHtml
// before landing in the HTML part. Inline-styled HTML by hand: a template
// engine would be a dependency for seven emails.

import { PRO_PLAN } from "@/lib/billing/plans";

import type { EmailContent } from "./resend";

const PRICE_LABEL = `€${PRO_PLAN.priceCents / 100}/month`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** "24 August 2026" — dates in emails are moments the user must act before. */
function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function greeting(name: string | null): string {
  return name ? `Hi ${name},` : "Hi,";
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#1c1917;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;padding:32px;">
      <p style="margin:0 0 24px;font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#78716c;">Towncenter</p>
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${title}</h1>
      ${bodyHtml}
    </div>
  </body>
</html>`;
}

function paragraph(html: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${html}</p>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 20px;background:#1c1917;color:#ffffff;border-radius:6px;font-size:15px;text-decoration:none;">${label}</a></p>`;
}

export function passwordResetEmail(input: {
  name: string | null;
  resetUrl: string;
  expiresMinutes: number;
}): EmailContent {
  const subject = "Reset your Towncenter password";
  return {
    subject,
    html: layout(
      subject,
      paragraph(escapeHtml(greeting(input.name))) +
        paragraph(
          "Someone — hopefully you — asked to reset the password on this account. The link below works once and expires in " +
            `${input.expiresMinutes} minutes.`,
        ) +
        button(input.resetUrl, "Choose a new password") +
        paragraph(
          "If you did not ask for this, ignore this email: the password stays as it is.",
        ),
    ),
    text: [
      greeting(input.name),
      "",
      "Someone — hopefully you — asked to reset the password on this account.",
      `The link below works once and expires in ${input.expiresMinutes} minutes.`,
      "",
      input.resetUrl,
      "",
      "If you did not ask for this, ignore this email: the password stays as it is.",
    ].join("\n"),
  };
}

export function welcomeEmail(input: {
  name: string | null;
  /** Days of trial, or null outside the hosted SaaS. */
  trialDays: number | null;
}): EmailContent {
  const subject = "Welcome to Towncenter";
  const trialLine = input.trialDays
    ? `Start your ${input.trialDays}-day free trial from the Billing screen — a card is required but nothing is charged until the trial ends, and you can cancel any time before.`
    : "Draw a zone on the map to survey your first street.";
  return {
    subject,
    html: layout(
      subject,
      paragraph(escapeHtml(greeting(input.name))) +
        paragraph(
          "Your account is ready. Towncenter maps the businesses of a territory so you can work it street by street.",
        ) +
        paragraph(escapeHtml(trialLine)),
    ),
    text: [
      greeting(input.name),
      "",
      "Your account is ready. Towncenter maps the businesses of a territory so you can work it street by street.",
      "",
      trialLine,
    ].join("\n"),
  };
}

export function trialStartedEmail(input: {
  name: string | null;
  firstChargeAt: Date;
  billingUrl: string;
}): EmailContent {
  const subject = "Your Towncenter trial is active";
  const when = formatDate(input.firstChargeAt);
  return {
    subject,
    html: layout(
      subject,
      paragraph(escapeHtml(greeting(input.name))) +
        paragraph(
          `Your 14-day trial has started with the full ${escapeHtml(PRO_PLAN.name)} limits. Nothing was charged today.`,
        ) +
        paragraph(
          `The first payment of ${PRICE_LABEL} runs on <strong>${when}</strong>. Cancel before that date from the Billing screen and you will never be charged.`,
        ) +
        button(input.billingUrl, "Manage your plan"),
    ),
    text: [
      greeting(input.name),
      "",
      `Your 14-day trial has started with the full ${PRO_PLAN.name} limits. Nothing was charged today.`,
      "",
      `The first payment of ${PRICE_LABEL} runs on ${when}. Cancel before that date from the Billing screen and you will never be charged.`,
      "",
      input.billingUrl,
    ].join("\n"),
  };
}

export function trialReminderEmail(input: {
  name: string | null;
  firstChargeAt: Date;
  billingUrl: string;
}): EmailContent {
  const subject = "Your Towncenter paid period starts in 3 days";
  const when = formatDate(input.firstChargeAt);
  return {
    subject,
    html: layout(
      subject,
      paragraph(escapeHtml(greeting(input.name))) +
        paragraph(
          `Your trial ends on <strong>${when}</strong>. From that date your card is charged ${PRICE_LABEL} for the ${escapeHtml(PRO_PLAN.name)} plan.`,
        ) +
        paragraph(
          "To keep going, do nothing. To stop before any payment, cancel from the Billing screen.",
        ) +
        button(input.billingUrl, "Manage your plan"),
    ),
    text: [
      greeting(input.name),
      "",
      `Your trial ends on ${when}. From that date your card is charged ${PRICE_LABEL} for the ${PRO_PLAN.name} plan.`,
      "",
      "To keep going, do nothing. To stop before any payment, cancel from the Billing screen:",
      input.billingUrl,
    ].join("\n"),
  };
}

export function subscriptionActivatedEmail(input: {
  name: string | null;
  periodEnd: Date | null;
}): EmailContent {
  const subject = `Your Towncenter ${PRO_PLAN.name} subscription is active`;
  const renewal = input.periodEnd
    ? ` It renews on ${formatDate(input.periodEnd)}.`
    : "";
  return {
    subject,
    html: layout(
      subject,
      paragraph(escapeHtml(greeting(input.name))) +
        paragraph(
          escapeHtml(
            `Payment received — the ${PRO_PLAN.name} plan (${PRICE_LABEL}) is active on your account.${renewal}`,
          ),
        ),
    ),
    text: [
      greeting(input.name),
      "",
      `Payment received — the ${PRO_PLAN.name} plan (${PRICE_LABEL}) is active on your account.${renewal}`,
    ].join("\n"),
  };
}

export function subscriptionSuspendedEmail(input: {
  name: string | null;
  billingUrl: string;
}): EmailContent {
  const subject = "A Towncenter payment failed — subscription suspended";
  return {
    subject,
    html: layout(
      subject,
      paragraph(escapeHtml(greeting(input.name))) +
        paragraph(
          "A renewal payment failed and your subscription is suspended. Your data is untouched, but surveying stops when the paid period runs out.",
        ) +
        paragraph("Subscribe again from the Billing screen to set up a new mandate.") +
        button(input.billingUrl, "Fix my subscription"),
    ),
    text: [
      greeting(input.name),
      "",
      "A renewal payment failed and your subscription is suspended. Your data is untouched, but surveying stops when the paid period runs out.",
      "",
      "Subscribe again from the Billing screen to set up a new mandate:",
      input.billingUrl,
    ].join("\n"),
  };
}

export function subscriptionCanceledEmail(input: {
  name: string | null;
  accessUntil: Date | null;
}): EmailContent {
  const subject = "Your Towncenter subscription is canceled";
  const until = input.accessUntil
    ? `You keep full access until ${formatDate(input.accessUntil)}; nothing more is charged.`
    : "Nothing more is charged.";
  return {
    subject,
    html: layout(
      subject,
      paragraph(escapeHtml(greeting(input.name))) +
        paragraph(escapeHtml(`Your subscription is canceled. ${until}`)) +
        paragraph(
          "Your territory stays readable afterwards — only surveying new ground stops. Resubscribe any time from the Billing screen.",
        ),
    ),
    text: [
      greeting(input.name),
      "",
      `Your subscription is canceled. ${until}`,
      "",
      "Your territory stays readable afterwards — only surveying new ground stops. Resubscribe any time from the Billing screen.",
    ].join("\n"),
  };
}

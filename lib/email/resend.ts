// Thin Resend client over fetch, on the lib/billing/mollie.ts pattern: one
// endpoint does not justify a dependency. Without RESEND_API_KEY and EMAIL_FROM
// the module is inert and every send is logged instead — which is both the
// self-hosted mode and the local dev story (the reset link shows up in the
// server console).
//
// `sendEmail` NEVER throws: a mail provider outage must not fail a signup, a
// reset request, or the Mollie webhook it rides on.

import "server-only";

const API = "https://api.resend.com";

export class ResendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ResendError";
  }
}

// read at call time, never at import: at import a rotated key would only take
// effect on the next restart.
export function emailEnabled(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim(),
  );
}

export type EmailContent = {
  subject: string;
  html: string;
  text: string;
};

// Public origin for links carried in emails. Dev falls back to localhost:
// disabled email only logs the link anyway, and throwing here would take the
// forgot-password form down with it.
export function appUrl(): string {
  const base = process.env.APP_URL?.trim();
  if (base) return base;
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
  throw new Error("APP_URL must be set to build links in emails.");
}

export async function sendEmail(
  to: string,
  content: EmailContent,
): Promise<boolean> {
  if (!emailEnabled()) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[email] disabled in production — skipped to=%s subject=%s",
        to,
        content.subject,
      );
      return false;
    }
    console.log(
      "[email] disabled — would send to=%s subject=%s\n%s",
      to,
      content.subject,
      content.text,
    );
    return false;
  }

  try {
    const response = await fetch(`${API}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM!.trim(),
        to,
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
      cache: "no-store",
      // a hung provider must not hold the Mollie webhook past its retry window.
      signal: AbortSignal.timeout(10_000),
    });

    const payload = (await response.json().catch(() => null)) as {
      id?: string;
      message?: string;
    } | null;

    if (!response.ok) {
      throw new ResendError(
        payload?.message ?? `Resend replied ${response.status}`,
        response.status,
      );
    }

    console.log("[email] sent to=%s id=%s", to, payload?.id ?? "?");
    return true;
  } catch (error) {
    console.error(
      "[email] send failed:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

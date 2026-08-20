"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import {
  createSession,
  destroySession,
  loginAttemptAllowed,
  registerLoginFailure,
  registerLoginSuccess,
} from "@/lib/auth";
import {
  createAccount,
  signupState,
  normalizeEmail,
  verifyCredentials,
} from "@/lib/accounts";
import { mollieEnabled } from "@/lib/billing/mollie";
import { sendEmail } from "@/lib/email/resend";
import { welcomeEmail } from "@/lib/email/templates";
import { internalPath } from "@/lib/internal-route";
import { PASSWORD_MAX, PASSWORD_MIN, checkPasswordShape } from "@/lib/password";
import { LOCALES, type Locale } from "@/lib/types";

// a "use server" module may export only async functions, so the state types
// live next door in state.ts
import type { SignInState, SignupFormState } from "./state";

// Built per call, not at module scope: the messages come from the request's
// locale, which is only available once `getTranslations` has been awaited.
// Root-scoped (no namespace) so both `AuthActions.*` and `Common.*` keys
// are reachable from the same translator.
function signInSchema(t: Awaited<ReturnType<typeof getTranslations>>) {
  return z.object({
    email: z.string().min(1, t("Common.enterEmailAddress")).max(320),
    password: z.string().min(1, t("AuthActions.enterPassword")).max(PASSWORD_MAX),
    next: z.string().max(2048).optional(),
  });
}

function signUpSchema(t: Awaited<ReturnType<typeof getTranslations>>) {
  return z.object({
    email: z
      .string()
      .min(1, t("Common.enterEmailAddress"))
      .max(320)
      // rejects the empty string and the obvious shapes; it does not try to
      // validate an address for real, the only test that counts is that mail lands
      .refine((value) => z.string().email().safeParse(value.trim()).success, {
        message: t("AuthActions.invalidEmail"),
      }),
    password: z.string().min(1, t("AuthActions.choosePassword")).max(PASSWORD_MAX),
    displayName: z
      .string()
      .max(120, t("AuthActions.displayNameTooLong", { max: 120 }))
      .optional(),
    next: z.string().max(2048).optional(),
  });
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

// The password is NOT trimmed: a trailing space is part of the secret, and
// trimming here would let sign-up and sign-in diverge the day one of them
// forgot to.
function rawPassword(form: FormData): string {
  const value = form.get("password");
  return typeof value === "string" ? value : "";
}

export async function signInAction(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const localeRaw = field(formData, "locale");
  const locale = (LOCALES as readonly string[]).includes(localeRaw)
    ? (localeRaw as Locale)
    : undefined;
  const t = locale ? await getTranslations({ locale }) : await getTranslations();
  const email = field(formData, "email");

  const parsed = signInSchema(t).safeParse({
    email,
    password: rawPassword(formData),
    next: field(formData, "next") || undefined,
  });

  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? t("Common.entryRefused"),
      email,
    };
  }

  // rate limited PER ADDRESS: a global counter would shut the gate on everyone
  // after ten deliberate failures on an invented address
  if (!loginAttemptAllowed(parsed.data.email)) {
    return {
      error: t("AuthActions.tooManyAttempts"),
      email,
    };
  }

  let account;
  try {
    account = await verifyCredentials(parsed.data.email, parsed.data.password);
  } catch (error) {
    // database unreachable, AUTH_SECRET missing: a configuration fault, not the
    // user's. Said without revealing what is missing, and logged, because
    // otherwise nobody will ever know why.
    console.error("[signin]", error);
    return { error: t("AuthActions.notConfigured"), email };
  }

  if (!account) {
    registerLoginFailure(parsed.data.email);
    // The SAME refusal for an unknown address and a wrong password. Telling them
    // apart turns the form into an oracle for who uses this instance;
    // verifyCredentials also spends the same time in both cases, otherwise the
    // response latency would say what the message does not.
    return { error: t("AuthActions.wrongEmailOrPassword"), email };
  }

  registerLoginSuccess(parsed.data.email);
  await createSession(account.id);
  redirect(internalPath(parsed.data.next));
}

export async function signUpAction(
  _previous: SignupFormState,
  formData: FormData,
): Promise<SignupFormState> {
  const localeRaw = field(formData, "locale");
  const locale = (LOCALES as readonly string[]).includes(localeRaw)
    ? (localeRaw as Locale)
    : undefined;
  const t = locale ? await getTranslations({ locale }) : await getTranslations();
  const email = field(formData, "email");
  const displayName = field(formData, "displayName");
  const base = { email, displayName, error: null, fields: {} };

  const parsed = signUpSchema(t).safeParse({
    email,
    password: rawPassword(formData),
    displayName: displayName || undefined,
    next: field(formData, "next") || undefined,
  });

  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "_");
      if (!(key in fields)) fields[key] = issue.message;
    }
    return { ...base, fields };
  }

  // The gate is re-checked here, not only on the page: a Server Action is a
  // directly reachable HTTP endpoint whose id is readable in the client bundle,
  // so hiding the form when sign-ups are closed closes nothing.
  const state = await signupState(locale);
  if (!state.open) {
    return { ...base, error: state.reason };
  }

  // the same rules as the live list on screen, and THESE are authoritative
  // (see components/gate/Requirements.tsx)
  const refusal = checkPasswordShape(
    parsed.data.password,
    normalizeEmail(parsed.data.email),
  );
  if (refusal) {
    const message = t(`PasswordRefusal.${refusal.key}`, {
      min: PASSWORD_MIN,
      max: PASSWORD_MAX,
    });
    return { ...base, fields: { password: message } };
  }

  let result;
  try {
    result = await createAccount({
      email: parsed.data.email,
      password: parsed.data.password,
      displayName: parsed.data.displayName ?? null,
      locale,
    });
  } catch (error) {
    console.error("[signup]", error);
    return { ...base, error: t("AuthActions.accountNotCreated") };
  }

  if (!result.ok) {
    const message = "key" in result ? t(`AuthActions.${result.key}`) : result.message;
    if (result.field === "_") return { ...base, error: message };
    return { ...base, fields: { [result.field]: message } };
  }

  // registered BEFORE the redirect throw, runs after the response is sent.
  // sendEmail never throws, so a mail outage cannot fail the signup.
  const account = result.account;
  after(() =>
    sendEmail(
      account.email,
      welcomeEmail({
        name: account.displayName,
        hosted: mollieEnabled(),
      }),
    ),
  );

  await createSession(result.account.id);
  redirect(internalPath(parsed.data.next, "/onboarding"));
}

export async function signOutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

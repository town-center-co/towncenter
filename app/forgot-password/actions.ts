"use server";

import { after } from "next/server";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requestPasswordReset } from "@/lib/passwordReset";

import type { ForgotPasswordState } from "./state";

export async function forgotPasswordAction(
  _previous: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const t = await getTranslations("Common");
  const schema = z.object({
    email: z.string().min(1, t("enterEmailAddress")).max(320),
  });

  const raw = formData.get("email");
  const email = typeof raw === "string" ? raw.trim() : "";

  const parsed = schema.safeParse({ email });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? t("entryRefused"),
      done: false,
      email,
    };
  }

  // ALL the work — lookup, token, email — runs after the response: the reply
  // takes the same time for a known and an unknown address, and the screen
  // says the same thing in both cases. Same oracle-closing intent as the
  // decoy hash in verifyCredentials.
  after(() =>
    requestPasswordReset(parsed.data.email).catch((error) =>
      console.error("[reset] request failed:", error),
    ),
  );

  return { error: null, done: true, email: parsed.data.email };
}

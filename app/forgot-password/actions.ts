"use server";

import { after } from "next/server";
import { z } from "zod";

import { requestPasswordReset } from "@/lib/passwordReset";

import type { ForgotPasswordState } from "./state";

const schema = z.object({
  email: z.string().min(1, "Enter your email address.").max(320),
});

export async function forgotPasswordAction(
  _previous: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const raw = formData.get("email");
  const email = typeof raw === "string" ? raw.trim() : "";

  const parsed = schema.safeParse({ email });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Entry refused.",
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

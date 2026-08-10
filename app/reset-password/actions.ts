"use server";

import { redirect } from "next/navigation";

import { PASSWORD_MAX } from "@/lib/password";
import { resetPassword } from "@/lib/passwordReset";

import type { ResetPasswordState } from "./state";

export async function resetPasswordAction(
  _previous: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const tokenRaw = formData.get("token");
  const token = typeof tokenRaw === "string" ? tokenRaw : "";

  // The password is NOT trimmed: a trailing space is part of the secret, the
  // same rule as sign-in and sign-up.
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";

  if (password === "") return { error: "Choose a password." };
  if (password.length > PASSWORD_MAX) {
    return { error: `${PASSWORD_MAX} characters at most.` };
  }

  const outcome = await resetPassword(token, password);
  if (!outcome.ok) return { error: outcome.message };

  // No auto-login: issuing a session here would race the invalidation instant
  // the reset just wrote. One more sign-in is cheaper than that hole.
  redirect("/login?reset=1");
}

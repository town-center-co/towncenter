"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/password";
import { resetPassword } from "@/lib/passwordReset";

import type { ResetPasswordState } from "./state";

export async function resetPasswordAction(
  _previous: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const t = await getTranslations("AuthActions");
  const tokenRaw = formData.get("token");
  const token = typeof tokenRaw === "string" ? tokenRaw : "";

  // The password is NOT trimmed: a trailing space is part of the secret, the
  // same rule as sign-in and sign-up.
  const passwordRaw = formData.get("password");
  const password = typeof passwordRaw === "string" ? passwordRaw : "";

  if (password === "") return { error: t("choosePassword") };
  if (password.length > PASSWORD_MAX) {
    return { error: t("passwordTooLong", { max: PASSWORD_MAX }) };
  }

  const outcome = await resetPassword(token, password);
  if (!outcome.ok) {
    if (outcome.key === "invalidLink") return { error: t("invalidResetLink") };

    const tRefusal = await getTranslations("PasswordRefusal");
    return {
      error: tRefusal(outcome.key, { min: PASSWORD_MIN, max: PASSWORD_MAX }),
    };
  }

  // No auto-login: issuing a session here would race the invalidation instant
  // the reset just wrote. One more sign-in is cheaper than that hole.
  redirect("/login?reset=1");
}

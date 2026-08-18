"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";

import { Button, Field, FieldLabel, Input } from "@/components/ui";

import { forgotPasswordAction } from "./actions";
import { INITIAL_FORGOT_STATE } from "./state";

import styles from "@/components/gate/gate.module.css";

export function ForgotPassword() {
  const t = useTranslations("ForgotPassword");
  const common = useTranslations("Common");
  const [state, action, inProgress] = useActionState(
    forgotPasswordAction,
    INITIAL_FORGOT_STATE,
  );

  // The SAME screen whether the address exists or not: this form must never
  // become an oracle for who uses this instance.
  if (state.done) {
    return (
      <p className={styles.notice} role="status">
        {t("done")}
      </p>
    );
  }

  return (
    // suppressHydrationWarning: password managers tag the form itself
    // (data-dashlane-rid and similar) before React hydrates.
    <form action={action} noValidate suppressHydrationWarning>
      {state.error ? (
        <p className={styles.alert} role="alert">
          {state.error}
        </p>
      ) : null}

      <div className={styles.fields}>
        <Field>
          <FieldLabel htmlFor="forgot-email">{common("email")}</FieldLabel>
          <Input
            id="forgot-email"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            maxLength={320}
            defaultValue={state.email}
          />
        </Field>
      </div>

      <div style={{ marginTop: "24px" }}>
        <Button type="submit" variant="primary" fullWidth disabled={inProgress}>
          {inProgress ? t("sending") : t("submit")}
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useActionState } from "react";

import { Button, Field, FieldLabel, Input } from "@/components/ui";

import { forgotPasswordAction } from "./actions";
import { INITIAL_FORGOT_STATE } from "./state";

import styles from "@/components/gate/gate.module.css";

export function ForgotPassword() {
  const [state, action, inProgress] = useActionState(
    forgotPasswordAction,
    INITIAL_FORGOT_STATE,
  );

  // The SAME screen whether the address exists or not: this form must never
  // become an oracle for who uses this instance.
  if (state.done) {
    return (
      <p className={styles.notice} role="status">
        If an account uses this address, a reset link is on its way. It works
        once and expires in thirty minutes — check the spam folder too.
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
          <FieldLabel htmlFor="forgot-email">Email</FieldLabel>
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
          {inProgress ? "Sending…" : "Send the reset link"}
        </Button>
      </div>
    </form>
  );
}

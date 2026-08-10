"use client";

import { useState, useActionState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";

import {
  Button,
  Field,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui";

import { signInAction } from "./actions";
import { INITIAL_SIGNIN_STATE } from "./state";

import styles from "@/components/gate/gate.module.css";

export function SignIn() {
  const [state, action, inProgress] = useActionState(
    signInAction,
    INITIAL_SIGNIN_STATE,
  );
  const params = useSearchParams();
  const next = params.get("next") ?? "";
  const justReset = params.get("reset") === "1";
  const [visible, setVisible] = useState(false);

  return (
    // suppressHydrationWarning: password managers tag the form itself
    // (data-dashlane-rid and similar) before React hydrates.
    <form action={action} noValidate suppressHydrationWarning>
      {state.error ? (
        <p className={styles.alert} role="alert">
          {state.error}
        </p>
      ) : null}

      {justReset && !state.error ? (
        <p className={styles.notice} role="status">
          Password changed. Sign in with the new one.
        </p>
      ) : null}

      <div className={styles.fields}>
        <Field>
          <FieldLabel htmlFor="signin-email">Email</FieldLabel>
          <Input
            id="signin-email"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            maxLength={320}
            // echoed back after a refusal, so a wrong password does not also
            // empty the address field
            defaultValue={state.email}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="signin-password">Password</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="signin-password"
              name="password"
              type={visible ? "text" : "password"}
              autoComplete="current-password"
              required
              // the bound also exists server-side; this one is only a convenience
              maxLength={512}
            />
            <InputGroupButton
              onClick={() => setVisible((was) => !was)}
              aria-pressed={visible}
              aria-label={visible ? "Hide password" : "Show password"}
            >
              {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </InputGroupButton>
          </InputGroup>
          <p className={styles.forgot}>
            <Link href="/forgot-password" className={styles.link}>
              Forgot password?
            </Link>
          </p>
        </Field>
      </div>

      {/* Return path. Its safety is checked SERVER-side, never here. */}
      <input type="hidden" name="next" value={next} />

      <div style={{ marginTop: "24px" }}>
        <Button type="submit" variant="primary" fullWidth disabled={inProgress}>
          {inProgress ? "Checking…" : "Enter the field"}
        </Button>
      </div>
    </form>
  );
}

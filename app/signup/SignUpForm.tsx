"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { Requirements } from "@/components/gate/Requirements";
import {
  Button,
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  Input,
  InputGroup,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui";

import { signUpAction } from "../login/actions";
import { INITIAL_SIGNUP_STATE } from "../login/state";

import styles from "@/components/gate/gate.module.css";

export type SignUpProps = {
  /** True when this is the very first account on the instance. */
  isFirstAccount: boolean;
};

export function SignUp({ isFirstAccount }: SignUpProps) {
  const t = useTranslations("SignUp");
  const common = useTranslations("Common");
  const [state, action, inProgress] = useActionState(
    signUpAction,
    INITIAL_SIGNUP_STATE,
  );

  // tracked as you type to feed the live requirements list; they never leave
  // this component, the form posts its own fields
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState(state.email);
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

      {isFirstAccount ? (
        <p className={styles.notice}>{t("firstAccountNotice")}</p>
      ) : null}

      <div className={styles.fields}>
        <Field>
          <FieldLabel htmlFor="signup-email">{common("email")}</FieldLabel>
          <Input
            id="signup-email"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus
            required
            maxLength={320}
            defaultValue={state.email}
            aria-invalid={state.fields.email ? true : undefined}
            aria-describedby={state.fields.email ? "signup-email-error" : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
          <FieldError id="signup-email-error">{state.fields.email}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="signup-name">{t("name")}</FieldLabel>
          <Input
            id="signup-name"
            name="displayName"
            type="text"
            autoComplete="name"
            maxLength={120}
            defaultValue={state.displayName}
            aria-invalid={state.fields.displayName ? true : undefined}
            aria-describedby={`signup-name-hint${state.fields.displayName ? " signup-name-error" : ""}`}
          />
          <FieldDescription id="signup-name-hint">{t("nameHint")}</FieldDescription>
          <FieldError id="signup-name-error">{state.fields.displayName}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="signup-password">{common("password")}</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="signup-password"
              name="password"
              type={visible ? "text" : "password"}
              autoComplete="new-password"
              required
              maxLength={512}
              aria-invalid={state.fields.password ? true : undefined}
              aria-describedby={state.fields.password ? "signup-password-error" : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <InputGroupButton
              onClick={() => setVisible((was) => !was)}
              aria-pressed={visible}
              aria-label={visible ? common("hidePassword") : common("showPassword")}
            >
              {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </InputGroupButton>
          </InputGroup>
          {/* Display only. checkPasswordShape on the server is authoritative. */}
          <Requirements password={password} email={email} />
          <FieldError id="signup-password-error">{state.fields.password}</FieldError>
        </Field>
      </div>

      <div style={{ marginTop: "24px" }}>
        <Button type="submit" variant="primary" fullWidth disabled={inProgress}>
          {inProgress ? t("creating") : isFirstAccount ? t("claim") : t("create")}
        </Button>
      </div>
    </form>
  );
}

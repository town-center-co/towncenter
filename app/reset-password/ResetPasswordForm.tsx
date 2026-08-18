"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { Requirements } from "@/components/gate/Requirements";
import {
  Button,
  Field,
  FieldLabel,
  InputGroup,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui";

import { resetPasswordAction } from "./actions";
import { INITIAL_RESET_STATE } from "./state";

import styles from "@/components/gate/gate.module.css";

export function ResetPassword({ token }: { token: string }) {
  const t = useTranslations("ResetPassword");
  const common = useTranslations("Common");
  const [state, action, inProgress] = useActionState(
    resetPasswordAction,
    INITIAL_RESET_STATE,
  );

  // tracked as you type to feed the live requirements list; it never leaves
  // this component, the form posts its own fields
  const [password, setPassword] = useState("");
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

      <div className={styles.fields}>
        <Field>
          <FieldLabel htmlFor="reset-password">{t("newPassword")}</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="reset-password"
              name="password"
              type={visible ? "text" : "password"}
              autoComplete="new-password"
              autoFocus
              required
              maxLength={512}
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
          {/* Display only. The email rule runs server-side, where the address
              is known; passing it here would print it into the HTML. */}
          <Requirements password={password} email="" />
        </Field>
      </div>

      {/* The token travels with the form; its validity is decided server-side. */}
      <input type="hidden" name="token" value={token} />

      <div style={{ marginTop: "24px" }}>
        <Button type="submit" variant="primary" fullWidth disabled={inProgress}>
          {inProgress ? t("saving") : t("submit")}
        </Button>
      </div>
    </form>
  );
}

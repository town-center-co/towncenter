"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui";
import { INITIAL_PLACES_KEY_STATE } from "./state";
import {
  testPlacesKeyAction,
  savePlacesKeyAction,
} from "./actions";

import styles from "./onboarding.module.css";

export type PlacesKeyFormProps = {
  defaultValue?: string;
};

// two useActionState hooks: one for testing (no side effects), one for saving
// (redirects on success). Each button's formAction is its own dispatch.
export function PlacesKeyForm({ defaultValue }: PlacesKeyFormProps) {
  const t = useTranslations("PlacesKeyForm");
  const [key, setKey] = useState(defaultValue ?? "");

  const [testState, testDispatch, testPending] = useActionState(
    testPlacesKeyAction,
    INITIAL_PLACES_KEY_STATE,
  );

  const [saveState, saveDispatch, savePending] = useActionState(
    savePlacesKeyAction,
    INITIAL_PLACES_KEY_STATE,
  );

  const fieldError = saveState.fieldError ?? testState.fieldError;
  const message = saveState.message ?? testState.message;
  const messageStatus = saveState.status !== "idle" ? saveState.status : testState.status;

  return (
    <form className={styles.keyForm}>
      <label className={styles.keyLabel} htmlFor="places-key">
        {t("label")}
      </label>
      <input
        id="places-key"
        name="key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className={styles.keyInput}
        aria-invalid={fieldError ? true : undefined}
        placeholder="AIza…"
      />
      {fieldError ? (
        <p className={styles.fieldError} role="alert">
          {fieldError}
        </p>
      ) : null}

      {message ? (
        <p
          className={styles.message}
          data-status={messageStatus === "tested" ? "success" : "error"}
          role={messageStatus === "error" ? "alert" : undefined}
        >
          {message}
        </p>
      ) : null}

      <div className={styles.keyActions}>
        <Button
          type="submit"
          variant="secondary"
          size="compact"
          formAction={testDispatch}
          disabled={testPending || savePending || key.length < 20}
        >
          {testPending ? t("checking") : t("check")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          formAction={saveDispatch}
          disabled={savePending || testPending || key.length < 20}
        >
          {savePending ? t("saving") : t("saveAndContinue")}
        </Button>
      </div>
    </form>
  );
}

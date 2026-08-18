"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui";
import { INITIAL_PLACES_KEY_STATE } from "./state";
import { testPlacesKeyAction, savePlacesKeyAction } from "./actions";

import styles from "./settings.module.css";

export type PlacesKeyFormProps = {
  defaultValue?: string;
};

// two useActionState hooks: one for testing (no side effects), one for saving
// (stays on the page and revalidates). Each button's formAction is its own dispatch.
export function PlacesKeyForm({ defaultValue }: PlacesKeyFormProps) {
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
        Google Places API key
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
          data-status={messageStatus === "error" ? "error" : "success"}
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
          {testPending ? "Checking…" : "Check the key"}
        </Button>
        <Button
          type="submit"
          variant="primary"
          formAction={saveDispatch}
          disabled={savePending || testPending || key.length < 20}
        >
          {savePending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

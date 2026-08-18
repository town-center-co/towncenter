"use client";

// Live password requirements: the rules are shown BEFORE the mistake and tick
// as you type. No symbol is required — NIST SP 800-63B 5.1.1.2 advises against
// composition rules; length is what protects.
//
// THIS SCREEN VALIDATES NOTHING, IT EXPLAINS. The same rules are enforced by
// `checkPasswordShape` on the server, and those are the ones that count: a form
// is an HTTP entry point that can be bypassed in one request. The two lists
// must stay in agreement — change one, change the other.

import { useTranslations } from "next-intl";

import styles from "./requirements.module.css";

/**
 * The minimum length, COPIED from `lib/password.ts`.
 *
 * It is not imported: that module is `server-only` (it pulls `node:crypto`) and
 * importing it here would break the browser bundle. This is the only duplicated
 * value in the product.
 */
export const PASSWORD_MIN_CLIENT = 12;

export type RequirementsProps = {
  password: string;
  email: string;
};

type Requirement = {
  /** ASCII key: it drives a `data-*` attribute and is never translated. */
  key: string;
  /** Visible text. */
  label: string;
  met: boolean;
};

export function Requirements({ password, email }: RequirementsProps) {
  const t = useTranslations("Requirements");
  const local = email.split("@")[0]?.trim().toLowerCase() ?? "";

  const requirements: Requirement[] = [
    {
      key: "length",
      label: t("length", { min: PASSWORD_MIN_CLIENT }),
      met: password.length >= PASSWORD_MIN_CLIENT,
    },
    {
      key: "email",
      label: t("noEmail"),
      met:
        password.length > 0 &&
        (local.length < 4 || !password.toLowerCase().includes(local)),
    },
  ];

  return (
    <ul className={styles.list}>
      {requirements.map((requirement) => (
        <li
          key={requirement.key}
          className={styles.row}
          data-met={requirement.met ? "" : undefined}
        >
          <span className={styles.mark} aria-hidden="true">
            {requirement.met ? <Check /> : <Point />}
          </span>
          {requirement.label}
          {/* The label alone tells a screen reader nothing: the glyph carries
              the state, and a shape does not announce itself. */}
          <span className={styles.offScreen}>
            {requirement.met ? t("met") : t("notMet")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

function Point() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
      <circle cx="8" cy="8" r="2.4" />
    </svg>
  );
}

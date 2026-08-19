"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";

import { LOCALES, type Locale } from "@/lib/types";

import { updateLocaleAction } from "./actions";

import styles from "./settings.module.css";

export function LocaleSwitcher({ value }: { value: Locale }) {
  const t = useTranslations("LocaleSwitcher");
  const [isPending, startTransition] = useTransition();

  return (
    <label className={styles.localeSwitcher}>
      <span className="t-body-s">{t("label")}</span>
      <select
        defaultValue={value}
        disabled={isPending}
        onChange={(event) => {
          const locale = event.target.value as Locale;
          startTransition(() => {
            void updateLocaleAction(locale);
          });
        }}
      >
        {LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {t(locale)}
          </option>
        ))}
      </select>
    </label>
  );
}

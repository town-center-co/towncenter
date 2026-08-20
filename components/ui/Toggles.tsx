"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { cx } from "./style";
import {
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  type Theme,
  type ThemePreference,
} from "./theme";

// the keys and the anti-flash script live in `./theme`, which carries no
// directive because `app/layout.tsx` reads them server-side.

function crossfadeColors(): void {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  window.setTimeout(() => root.classList.remove("theme-switching"), 200);
}

// `description` states the DESTINATION, never the current state: icon, label
// and announcement must all say what the click will do, or voice control loses
// the "Label in Name" match.
export function useTheme() {
  const t = useTranslations("ThemeToggle");
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const readPreference = (): ThemePreference => {
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        // Private browsing can make localStorage unavailable.
      }
      return stored === "light" || stored === "dark" ? stored : "system";
    };
    const apply = () => {
      const preference = readPreference();
      const next = preference === "system" ? (media.matches ? "dark" : "light") : preference;
      document.documentElement.dataset.theme = next;
      setTheme(next);
    };

    apply();
    if (readPreference() !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  const toggle = useCallback(() => {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const next: Theme = current === "dark" ? "light" : "dark";
    crossfadeColors();
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // private browsing, storage full: the theme holds for the session.
    }
    setTheme(next);
  }, []);

  const toLight = theme === "dark";

  return {
    theme,
    toggle,
    toLight,
    description: toLight ? t("toLight") : t("toDark"),
  };
}

export function ThemeToggle({ className }: { className?: string }) {
  const { toggle, toLight, description } = useTheme();

  return (
    <button
      type="button"
      className={cx("toggle", "tooltip", "tooltip--below", className)}
      onClick={toggle}
      aria-label={description}
    >
      <ThemeIcon to={toLight ? "light" : "dark"} />
    </button>
  );
}

// the glyph is DRAWN, not typed: sun and moon characters render with the text
// face, differ per platform and shrink to nothing inside the circle.
export function ThemeIcon({ to, className }: { to: Theme; className?: string }) {
  return (
    <svg
      className={cx("toggle__icon", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {to === "dark" ? (
        <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
      ) : (
        <>
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.4v2.2M12 19.4v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.4 12h2.2M19.4 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
        </>
      )}
    </svg>
  );
}

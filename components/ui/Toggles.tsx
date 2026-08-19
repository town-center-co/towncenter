"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { cx } from "./style";
import { THEME_STORAGE_KEY, DEFAULT_THEME, type Theme } from "./theme";

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
  // the first client render must match the server render, so start from the
  // default and read the attribute `THEME_SCRIPT` set once mounted.
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    const applied = document.documentElement.dataset.theme;
    if (applied === "light" || applied === "dark") setTheme(applied);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    crossfadeColors();
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // private browsing, storage full: the theme holds for the session.
    }
    setTheme(next);
  }, [theme]);

  const toLight = theme === "dark";

  return {
    theme,
    toggle,
    toLight,
    description: toLight ? t("toLight") : t("toDark"),
  };
}

export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("ThemeToggle");
  const { toggle, toLight, description } = useTheme();

  return (
    <button
      type="button"
      className={cx("toggle", className)}
      onClick={toggle}
      aria-label={description}
      // the rail hides the label while narrow: without a tooltip, a bare circle.
      title={description}
    >
      <ThemeIcon to={toLight ? "light" : "dark"} />
      <span className="t-label toggle__label">
        {toLight ? t("light") : t("dark")}
      </span>
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

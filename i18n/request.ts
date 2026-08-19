import { getRequestConfig } from "next-intl/server";

import { getSession } from "@/lib/auth";
import { getAccountLocale } from "@/lib/settings";
import { DEFAULT_LOCALE, type Locale } from "@/lib/types";

// No URL routing: the locale is a per-account preference (`/settings`), not
// a segment. Signed-out routes (login/signup/reset-password) have no account
// to read from and fall back to the default.
async function resolveLocale(): Promise<Locale> {
  const session = await getSession();
  if (!session) return DEFAULT_LOCALE;

  return getAccountLocale(session.sub);
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});

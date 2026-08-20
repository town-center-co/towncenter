import type { Route } from "next";

function hasDangerousChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x5c || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function internalPath(
  value: string | undefined | null,
  fallback: Route = "/",
): Route {
  if (!value || hasDangerousChar(value)) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value as Route;
}

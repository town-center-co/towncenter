"use server";

// The settings screen's writes. requireUser() runs on the first line of every
// action: a Server Action is a directly reachable HTTP endpoint.

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireUser } from "@/lib/accounts";
import { db, priceGrids } from "@/lib/db";
import { checkPlacesKey } from "@/lib/sources/places";
import { removePlacesKey, savePlacesKey, saveLocale } from "@/lib/settings";
import { LOCALES, type Locale } from "@/lib/types";

import { getPriceGrid } from "../queries";
import { readGridForm } from "./form";
import type { PlacesKeyState, PriceGridState } from "./state";

function keySchema(t: Awaited<ReturnType<typeof getTranslations<"PlacesKeyValidation">>>) {
  return z.object({
    key: z
      .string()
      .min(20, t("tooShort"))
      .max(2048)
      .refine((v) => !/\s/.test(v), { message: t("hasWhitespace") }),
  });
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

// one billed request: the cheapest honest proof that a key works before it is saved
export async function testPlacesKeyAction(
  _previous: PlacesKeyState,
  formData: FormData,
): Promise<PlacesKeyState> {
  await requireUser();
  const t = await getTranslations("PlacesKeyValidation");

  const parsed = keySchema(t).safeParse({ key: text(formData, "key") });
  if (!parsed.success) {
    return {
      status: "error",
      message: null,
      fieldError: parsed.error.issues[0]?.message ?? t("unreadable"),
    };
  }

  const result = await checkPlacesKey(parsed.data.key);
  if (result.ok) {
    return {
      status: "tested",
      message: t("accepted"),
      fieldError: null,
    };
  }

  return { status: "error", message: result.message, fieldError: null };
}

export async function savePlacesKeyAction(
  _previous: PlacesKeyState,
  formData: FormData,
): Promise<PlacesKeyState> {
  const owner = await requireUser();
  const t = await getTranslations("PlacesKeyValidation");

  const parsed = keySchema(t).safeParse({ key: text(formData, "key") });
  if (!parsed.success) {
    return {
      status: "error",
      message: null,
      fieldError: parsed.error.issues[0]?.message ?? t("unreadable"),
    };
  }

  await savePlacesKey(owner.id, parsed.data.key);
  revalidatePath("/settings");

  return { status: "saved", message: t("keySaved"), fieldError: null };
}

export async function removePlacesKeyAction(): Promise<void> {
  const owner = await requireUser();
  await removePlacesKey(owner.id);
  revalidatePath("/settings");
}

export async function updateLocaleAction(locale: Locale): Promise<void> {
  const owner = await requireUser();
  if (!LOCALES.includes(locale)) return;

  await saveLocale(owner.id, locale);
  // the locale affects every route, not just this one
  revalidatePath("/", "layout");
}

export async function savePriceGridAction(
  _previous: PriceGridState,
  formData: FormData,
): Promise<PriceGridState> {
  const owner = await requireUser();
  const t = await getTranslations("PriceGridForm");

  const { grid, fields } = readGridForm(formData, await getPriceGrid(owner), t);
  if (grid === null) {
    return { error: null, fields, saved: false };
  }

  try {
    await db
      .insert(priceGrids)
      .values({ ownerId: owner.id, grid: grid })
      .onConflictDoUpdate({
        target: priceGrids.ownerId,
        set: { grid: grid, updatedAt: new Date() },
      });
  } catch (error) {
    console.error("[grid]", error);
    return { error: t("saveFailed"), fields: {}, saved: false };
  }

  revalidatePath("/");
  revalidatePath("/settings");

  return { error: null, fields: {}, saved: true };
}

/**
 * Deletes the account's row so it falls back to DEFAULT_PRICE_GRID.
 *
 * The row is ERASED rather than overwritten with the defaults. The difference
 * matters the day the product's defaults change: an account that never decided
 * anything should follow, an account that copied them by hand made a choice.
 */
export async function resetPriceGridAction(
  _previous: PriceGridState,
  _formData: FormData,
): Promise<PriceGridState> {
  const owner = await requireUser();

  try {
    await db.delete(priceGrids).where(eq(priceGrids.ownerId, owner.id));
  } catch (error) {
    console.error("[grid:reset]", error);
    const t = await getTranslations("ResetGrid");
    return { error: t("resetFailed"), fields: {}, saved: false };
  }

  revalidatePath("/");
  revalidatePath("/settings");

  return { error: null, fields: {}, saved: true };
}

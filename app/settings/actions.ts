"use server";

// The settings screen's writes. requireUser() runs on the first line of every
// action: a Server Action is a directly reachable HTTP endpoint.

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/accounts";
import { db, priceGrids } from "@/lib/db";
import { checkPlacesKey } from "@/lib/sources/places";
import { removePlacesKey, savePlacesKey } from "@/lib/settings";

import { getPriceGrid } from "../queries";
import { readGridForm } from "./form";
import type { PlacesKeyState, PriceGridState } from "./state";

const keySchema = z.object({
  key: z
    .string()
    .min(20, "A Google Places key is at least 20 characters.")
    .max(2048)
    .refine((v) => !/\s/.test(v), {
      message: "The key must not contain whitespace.",
    }),
});

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

  const parsed = keySchema.safeParse({ key: text(formData, "key") });
  if (!parsed.success) {
    return {
      status: "error",
      message: null,
      fieldError: parsed.error.issues[0]?.message ?? "Unreadable key.",
    };
  }

  const result = await checkPlacesKey(parsed.data.key);
  if (result.ok) {
    return {
      status: "tested",
      message: "Key accepted by Google. You can save it.",
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

  const parsed = keySchema.safeParse({ key: text(formData, "key") });
  if (!parsed.success) {
    return {
      status: "error",
      message: null,
      fieldError: parsed.error.issues[0]?.message ?? "Unreadable key.",
    };
  }

  await savePlacesKey(owner.id, parsed.data.key);
  revalidatePath("/settings");

  return { status: "saved", message: "Key saved.", fieldError: null };
}

export async function removePlacesKeyAction(): Promise<void> {
  const owner = await requireUser();
  await removePlacesKey(owner.id);
  revalidatePath("/settings");
}

export async function savePriceGridAction(
  _previous: PriceGridState,
  formData: FormData,
): Promise<PriceGridState> {
  const owner = await requireUser();

  const { grid, fields } = readGridForm(formData, await getPriceGrid(owner));
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
    return { error: "Grid not saved. Try again.", fields: {}, saved: false };
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
    return { error: "Grid not reset. Try again.", fields: {}, saved: false };
  }

  revalidatePath("/");
  revalidatePath("/settings");

  return { error: null, fields: {}, saved: true };
}

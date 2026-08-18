// form state types cannot live in a "use server" module: re-exporting an
// imported type there compiles and builds, then dies at the first click.

export type PlacesKeyState = {
  status: "idle" | "tested" | "saved" | "removed" | "error";
  message: string | null;
  fieldError: string | null;
};

export const INITIAL_PLACES_KEY_STATE: PlacesKeyState = {
  status: "idle",
  message: null,
  fieldError: null,
};

export type PriceGridState = {
  error: string | null;
  /** keyed by PriceGrid's own ASCII key, which is also the input `name`. */
  fields: Record<string, string>;
  saved: boolean;
};

export const INITIAL_PRICE_GRID_STATE: PriceGridState = {
  error: null,
  fields: {},
  saved: false,
};

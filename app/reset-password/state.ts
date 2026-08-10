// these types cannot live in a "use server" module: re-exporting an imported
// type there compiles and builds, then dies at the first click.

export type ResetPasswordState = {
  error: string | null;
};

export const INITIAL_RESET_STATE: ResetPasswordState = {
  error: null,
};

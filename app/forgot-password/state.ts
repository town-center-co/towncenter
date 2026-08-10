// these types cannot live in a "use server" module: re-exporting an imported
// type there compiles and builds, then dies at the first click.

export type ForgotPasswordState = {
  error: string | null;
  /** true once accepted: the form gives way to the "check your inbox" line. */
  done: boolean;
  email: string;
};

export const INITIAL_FORGOT_STATE: ForgotPasswordState = {
  error: null,
  done: false,
  email: "",
};
